export * as DesktopViewer from "./viewer.ts";

import { Context, Data, Effect, Layer, type Scope } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import type { CurrentActor } from "../../../authorization/current-actor.ts";
import { Visibility } from "../../../authorization/visibility.ts";
import { Ids } from "../../../ids/ids.ts";
import { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import type { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { type UserFacing, UserMessage } from "../../../user-message.ts";
import { sessionName } from "./browser.ts";

/**
 * Watching an agent's desktop in a thread: where the browser it drives is
 * shown. Anyone who can read the thread and see the agent may watch. The
 * sandbox stays awake while somebody does, and nobody's watching starts a
 * desktop that isn't running.
 */
export interface Interface {
	/**
	 * Where the desktop's noVNC WebSocket is, for as long as the scope is
	 * open, which holds the sandbox awake.
	 */
	readonly watch: (input: {
		threadId: string;
		agentId: string;
	}) => Effect.Effect<
		Sandboxes.Endpoint,
		AuthorizationDenied | DesktopNotRunning | Sandboxes.Unavailable,
		CurrentActor.Service | Scope.Scope
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/DesktopViewer",
) {}

export const make = Effect.gen(function* () {
	const visibility = yield* Visibility.Service;
	const authorization = yield* Authorization.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const ids = yield* Ids.Service;

	return Service.of({
		watch: ({ threadId, agentId }) =>
			Effect.gen(function* () {
				const { thread } = yield* visibility.thread(threadId);
				const { agent } = yield* authorization.agent(agentId, "pod.read");
				if (!agent.podId || agent.workspaceId !== thread.workspaceId) {
					return yield* new DesktopNotRunning();
				}
				const holder = `viewer:${yield* ids.random}`;
				yield* Effect.addFinalizer(() => podSandboxes.release(holder));
				const sandbox = yield* podSandboxes.watch(
					{ workspaceId: agent.workspaceId, podId: agent.podId },
					holder,
				);
				if (!sandbox) return yield* new DesktopNotRunning();
				const found = yield* sandbox.exec(
					`sugabots-desktop viewer '${sessionName({ threadId, agentId })}'`,
					{ timeout: "30 seconds", maxOutputCharacters: 200 },
				);
				const port = Number(found.stdout.text.trim());
				if (found.exitCode !== 0 || !Number.isInteger(port)) {
					return yield* new DesktopNotRunning();
				}
				yield* Effect.forkScoped(
					podSandboxes.renew(holder).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
				);
				return yield* sandbox.endpoint(port);
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Visibility.layer, Authorization.layer, PodSandboxes.layer]),
);

/** The agent has no desktop running in this thread: it hasn't used its browser, or the sandbox was paused since. */
export class DesktopNotRunning extends Data.TaggedError("DesktopNotRunning") implements UserFacing {
	get userMessage() {
		return UserMessage.of`This agent's desktop isn't running in this thread. It starts when the agent next uses its browser.`;
	}
}
