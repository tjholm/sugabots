export * as PodSandboxes from "./pod-sandboxes.ts";

import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, Semaphore } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import { sandbox as sandboxTable } from "../database/schema.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/**
 * The only writer of `sandbox`: each pod's one sandbox, made the first time
 * an agent there needs it, then opened, and resumed, on every later use.
 */
export interface Interface {
	/** The pod's sandbox at `provider`, the workspace's enabled one, ready to run commands. */
	readonly open: (
		pod: Pod,
		provider: SandboxProviderRepository.Configured,
	) => Effect.Effect<Opened, Sandboxes.Unavailable>;
	/**
	 * Destroys every sandbox `provider` made and forgets them, so the provider
	 * can be removed without leaving machines running at it.
	 */
	readonly destroyAllMadeBy: (
		workspaceId: string,
		provider: SandboxProviderRepository.Configured,
	) => Effect.Effect<void, Sandboxes.Unavailable>;
	/** Whether `providerId` has made any sandbox that still exists. */
	readonly anyMadeBy: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/PodSandboxes") {}

export const make = Effect.gen(function* () {
	const sandboxes = yield* Sandboxes.Service;
	const providers = yield* SandboxProviderRepository.Service;
	const operation = yield* serviceOperations<Interface>("PodSandboxes");
	// One opening per pod at a time, so two turns' first commands make one sandbox.
	const openings = new Map<string, Semaphore.Semaphore>();
	const oneAtATime = (podId: string) => {
		let semaphore = openings.get(podId);
		if (!semaphore) {
			semaphore = Semaphore.makeUnsafe(1);
			openings.set(podId, semaphore);
		}
		return semaphore.withPermits(1);
	};

	const recorded = (pod: Pod) =>
		query((db) =>
			db
				.select()
				.from(sandboxTable)
				.where(
					and(eq(sandboxTable.podId, pod.podId), eq(sandboxTable.workspaceId, pod.workspaceId)),
				)
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	const forget = (podId: string) =>
		query((db) => db.delete(sandboxTable).where(eq(sandboxTable.podId, podId)));

	const made = (pod: Pod, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const sandbox = yield* sandboxes.forConnection(provider.connection).create({
				labels: { "sugabots.workspace": pod.workspaceId, "sugabots.pod": pod.podId },
			});
			yield* query((db) =>
				db.insert(sandboxTable).values({
					workspaceId: pod.workspaceId,
					podId: pod.podId,
					sandboxProviderId: provider.id,
					providerSandboxId: sandbox.id,
				}),
			);
			return sandbox;
		});

	/**
	 * Destroys the pod's sandbox at a provider the workspace no longer uses.
	 * A provider that can't be reached leaves it running there, which is
	 * logged rather than blocking the pod's work at its new provider.
	 */
	const leaveOldProvider = (workspaceId: string, providerId: string, id: Sandboxes.SandboxId) =>
		Effect.gen(function* () {
			const old = yield* providers.connection(workspaceId, providerId);
			if (!old) return;
			yield* sandboxes
				.forConnection(old.connection)
				.destroy(id)
				.pipe(
					Effect.catchTag("SandboxUnavailable", (failure) =>
						Effect.logWarning(
							"Could not destroy a sandbox at a provider no longer in use",
							failure,
						),
					),
				);
		});

	const open = (pod: Pod, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const row = yield* recorded(pod);
			const replaced = (sandbox: Sandboxes.Sandbox): Opened => ({ sandbox, arrival: "replaced" });
			if (!row) return { sandbox: yield* made(pod, provider), arrival: "made" } satisfies Opened;
			if (row.sandboxProviderId !== provider.id) {
				yield* leaveOldProvider(pod.workspaceId, row.sandboxProviderId, row.providerSandboxId);
				yield* forget(pod.podId);
				return replaced(yield* made(pod, provider));
			}
			const at = sandboxes.forConnection(provider.connection);
			return yield* at.open(row.providerSandboxId).pipe(
				Effect.map(
					({ sandbox, resumed }): Opened => ({
						sandbox,
						arrival: !resumed
							? "running"
							: at.capabilities.pauseKeeps === "disk"
								? "rebooted"
								: "resumed",
					}),
				),
				Effect.catchTag("SandboxMissing", () =>
					forget(pod.podId).pipe(Effect.andThen(made(pod, provider)), Effect.map(replaced)),
				),
			);
		});

	const madeBy = (workspaceId: string, providerId: string) =>
		query((db) =>
			db
				.select()
				.from(sandboxTable)
				.where(
					and(
						eq(sandboxTable.workspaceId, workspaceId),
						eq(sandboxTable.sandboxProviderId, providerId),
					),
				),
		);

	return Service.of({
		open: (pod, provider) => operation("open", oneAtATime(pod.podId)(open(pod, provider))),

		destroyAllMadeBy: (workspaceId, provider) =>
			operation(
				"destroyAllMadeBy",
				Effect.gen(function* () {
					const at = sandboxes.forConnection(provider.connection);
					for (const row of yield* madeBy(workspaceId, provider.id)) {
						yield* oneAtATime(row.podId)(
							at.destroy(row.providerSandboxId).pipe(Effect.andThen(forget(row.podId))),
						);
					}
				}),
			),

		anyMadeBy: (workspaceId, providerId) =>
			operation(
				"anyMadeBy",
				Effect.map(madeBy(workspaceId, providerId), (rows) => rows.length > 0),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Sandboxes.layer, SandboxProviderRepository.layer]),
);

export interface Pod {
	readonly workspaceId: string;
	readonly podId: string;
}

export interface Opened {
	readonly sandbox: Sandboxes.Sandbox;
	/**
	 * How the sandbox came to be ready, which decides what the agent is told:
	 * - `made`: new, with nothing in it.
	 * - `running`: as the pod left it.
	 * - `resumed`: paused, and back with its programs still running.
	 * - `rebooted`: paused, and back with its files but no running programs.
	 * - `replaced`: new, because the pod's earlier one is gone: its provider
	 *   lost it, or the workspace changed provider.
	 */
	readonly arrival: "made" | "running" | "resumed" | "rebooted" | "replaced";
}
