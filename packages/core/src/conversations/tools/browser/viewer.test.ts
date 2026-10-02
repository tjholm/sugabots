import type { ToolSet } from "ai";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import { agent, pod, thread, user, workspace, workspaceMember } from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../../sandboxes/sandbox-provider-repository.ts";
import { SandboxTools } from "../sandbox.ts";
import { DesktopViewer } from "./viewer.ts";

/**
 * Watching an agent's desktop, against Postgres and a real OpenSandbox server
 * running the default image (`docker compose --profile sandboxes up -d` and
 * `bun run build:sandbox`, with OPENSANDBOX_URL and OPENSANDBOX_API_KEY set).
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;

describe.skipIf(!configured)("the desktop viewer, against Postgres and OpenSandbox", () => {
	let tools: ToolSet;
	let viewer: DesktopViewer.Interface;
	let podSandboxes: PodSandboxes.Interface;
	let workspaceId: string;
	let ownerId: string;
	let outsiderId: string;
	let agentId: string;
	let threadId: string;
	const scope = Effect.runSync(Scope.make());

	beforeAll(async () => {
		let sandboxTools: SandboxTools.Interface;
		let providers: SandboxProviderRepository.Interface;
		[sandboxTools, viewer, podSandboxes, providers] = await runOnPostgres(
			Effect.all([
				SandboxTools.Service,
				DesktopViewer.Service,
				PodSandboxes.Service,
				SandboxProviderRepository.Service,
			]).pipe(
				Effect.provide(
					Layer.mergeAll(
						SandboxTools.layer,
						DesktopViewer.layer,
						PodSandboxes.layer,
						SandboxProviderRepository.layer,
					),
				),
			),
		);
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Viewer ${suffix}`, slug: `viewer-${suffix}` })
				.returning(),
		);
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Sam", email: `viewer-sam-${suffix}@example.com` },
					{ name: "Kim", email: `viewer-kim-${suffix}@example.com` },
				])
				.returning(),
		);
		const [owner, outsider] = people;
		if (!space || !owner || !outsider) throw new Error("fixture");
		workspaceId = space.id;
		ownerId = owner.id;
		outsiderId = outsider.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: ownerId },
				{ workspaceId, userId: outsiderId },
			]),
		);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId,
					kind: "personal",
					name: "Sam's",
					slug: "personal",
					createdById: ownerId,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		const [bot] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: shared.id,
					name: "Browser Bot",
					handle: `browser-bot-${suffix}`,
					color: "green",
					face: "pill",
					model: "no-such-model",
					createdById: ownerId,
				})
				.returning(),
		);
		if (!bot) throw new Error("fixture");
		agentId = bot.id;
		const [conversation] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId: shared.id,
					hostAgentId: agentId,
					type: "chat",
					title: "Look something up",
				})
				.returning(),
		);
		if (!conversation) throw new Error("fixture");
		threadId = conversation.id;
		await runOnPostgres(
			providers.create(workspaceId, {
				createdById: ownerId,
				provider: {
					preset: "opensandbox",
					enabled: true,
					baseUrl: env.OPENSANDBOX_URL,
					apiKey: env.OPENSANDBOX_API_KEY,
				},
			}),
		);
		tools = await runOnPostgres(
			Scope.provide(scope)(
				sandboxTools.forTurn({
					pod: { workspaceId, podId: shared.id },
					turnId: "turn-1",
					threadId,
					agentId,
					model: "no-such-model",
				}),
			),
		);
	}, SLOW);

	afterAll(async () => {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		const providers = await runOnPostgres(
			Effect.provide(SandboxProviderRepository.Service, SandboxProviderRepository.layer),
		);
		const provider = await runOnPostgres(providers.enabled(workspaceId));
		if (provider) await runOnPostgres(podSandboxes.destroyAllMadeBy(workspaceId, provider));
		await closeDatabase();
	}, SLOW);

	const watchAs = (userId: string) =>
		runOnPostgres(
			Effect.exit(
				Scope.provide(scope)(viewer.watch({ threadId, agentId })).pipe(
					CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId)),
				),
			),
		);

	it(
		"has nothing to show before the agent uses its browser",
		async () => {
			const exit = await watchAs(ownerId);

			expect(Exit.isFailure(exit) && exit.toString()).toContain("DesktopNotRunning");
		},
		SLOW,
	);

	it(
		"shows the desktop the agent's browser runs on, to someone who can read the thread",
		async () => {
			const navigate = tools.browser_navigate?.execute as (
				input: object,
				options: object,
			) => Promise<unknown>;
			await navigate({ url: "data:text/html,<h1>Watched</h1>" }, { toolCallId: "1", messages: [] });

			const exit = await watchAs(ownerId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());
			const greeting = await firstFrame(`${exit.value.url.replace(/^http/, "ws")}/websockify`);

			expect(greeting.startsWith("RFB")).toBe(true);
		},
		SLOW,
	);

	it(
		"hides it from someone who can't reach the thread's pod",
		async () => {
			const exit = await watchAs(outsiderId);

			expect(Exit.isFailure(exit) && exit.toString()).toContain("ResourceHidden");
		},
		SLOW,
	);
});

/** The first thing a VNC server says: its protocol version. */
function firstFrame(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		socket.onmessage = (event) => {
			resolve(new TextDecoder().decode(event.data as ArrayBuffer));
			socket.close();
		};
		socket.onerror = () => reject(new Error("The viewer's socket failed"));
	});
}
