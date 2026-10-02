import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pod, sandbox, user, workspace, workspaceMember } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { PodSandboxes } from "./pod-sandboxes.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/**
 * A pod's one sandbox, against Postgres and a real OpenSandbox server
 * (`docker compose --profile sandboxes up -d`, with OPENSANDBOX_URL and
 * OPENSANDBOX_API_KEY set).
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;
const IMAGE = "debian:bookworm-slim";

describe.skipIf(!configured)("pod sandboxes, against Postgres and OpenSandbox", () => {
	const connection: Sandboxes.OpenSandboxConnection = {
		provider: "opensandbox",
		baseUrl: env.OPENSANDBOX_URL ?? "",
		apiKey: Redacted.make(env.OPENSANDBOX_API_KEY ?? ""),
		image: IMAGE,
	};
	let podSandboxes: PodSandboxes.Interface;
	let providers: SandboxProviderRepository.Interface;
	let direct: Sandboxes.Provider;
	let thePod: PodSandboxes.Pod;
	let ownerId: string;
	const made: Sandboxes.SandboxId[] = [];

	beforeAll(async () => {
		[podSandboxes, providers] = await runOnPostgres(
			Effect.all([PodSandboxes.Service, SandboxProviderRepository.Service]).pipe(
				Effect.provide(Layer.merge(PodSandboxes.layer, SandboxProviderRepository.layer)),
			),
		);
		direct = await Effect.runPromise(
			Effect.map(Sandboxes.Service, (sandboxes) => sandboxes.forConnection(connection)).pipe(
				Effect.provide(Sandboxes.layer),
			),
		);
	});

	afterAll(async () => {
		for (const id of made) await Effect.runPromise(direct.destroy(id));
		await closeDatabase();
	}, SLOW);

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Sandbox ${suffix}`, slug: `sandbox-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `sandbox-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		ownerId = owner.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: owner.id }),
		);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					ownerId: owner.id,
					kind: "shared",
					name: "Builders",
					slug: `builders-${suffix}`,
					createdById: owner.id,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		thePod = { workspaceId: space.id, podId: shared.id };
		await addProvider();
	});

	/** An OpenSandbox provider for the pod's workspace, enabled, which disables any other. */
	const addProvider = () =>
		runOnPostgres(
			providers.create(thePod.workspaceId, {
				createdById: ownerId,
				provider: {
					preset: "opensandbox",
					enabled: true,
					baseUrl: connection.baseUrl,
					apiKey: Redacted.value(connection.apiKey),
					image: IMAGE,
				},
			}),
		);

	const enabledProvider = async () => {
		const provider = await runOnPostgres(providers.enabled(thePod.workspaceId));
		if (!provider) throw new Error("no enabled provider");
		return provider;
	};

	const open = async () => {
		const opened = await runOnPostgres(podSandboxes.open(thePod, await enabledProvider()));
		if (!made.includes(opened.sandbox.id)) made.push(opened.sandbox.id);
		return opened;
	};

	const missing = async (id: Sandboxes.SandboxId) =>
		(await Effect.runPromiseExit(direct.open(id))).toString().includes("SandboxMissing");

	it(
		"makes the pod's sandbox on first use, and opens the same one after",
		async () => {
			const first = await open();
			const second = await open();

			expect(first.arrival).toBe("made");
			expect(second.arrival).toBe("running");
			expect(second.sandbox.id).toBe(first.sandbox.id);
		},
		SLOW,
	);

	it(
		"makes one sandbox when two turns open it at once",
		async () => {
			const [one, other] = await Promise.all([open(), open()]);

			expect(one.sandbox.id).toBe(other.sandbox.id);
		},
		SLOW,
	);

	it(
		"says a paused sandbox came back without its programs",
		async () => {
			const first = await open();
			await Effect.runPromise(direct.pause(first.sandbox.id));

			expect((await open()).arrival).toBe("rebooted");
		},
		SLOW,
	);

	it(
		"replaces a sandbox the provider lost",
		async () => {
			const first = await open();
			await Effect.runPromise(direct.destroy(first.sandbox.id));
			const replaced = await open();

			expect(replaced.arrival).toBe("replaced");
			expect(replaced.sandbox.id).not.toBe(first.sandbox.id);
		},
		SLOW,
	);

	it(
		"moves the pod to a newly enabled provider, destroying its sandbox at the old one",
		async () => {
			const first = await open();
			await addProvider();
			const moved = await open();

			expect(moved.arrival).toBe("replaced");
			expect(moved.sandbox.id).not.toBe(first.sandbox.id);
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"destroys and forgets every sandbox a provider made",
		async () => {
			const first = await open();
			const provider = await enabledProvider();

			await runOnPostgres(podSandboxes.destroyAllMadeBy(thePod.workspaceId, provider));

			expect(await runOnPostgres(podSandboxes.anyMadeBy(thePod.workspaceId, provider.id))).toBe(
				false,
			);
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"lets a workspace with sandboxes be deleted",
		async () => {
			await open();

			await onDatabase((db) => db.delete(workspace).where(eq(workspace.id, thePod.workspaceId)));

			const left = await onDatabase((db) =>
				db.select().from(sandbox).where(eq(sandbox.workspaceId, thePod.workspaceId)),
			);
			expect(left).toHaveLength(0);
		},
		SLOW,
	);
});
