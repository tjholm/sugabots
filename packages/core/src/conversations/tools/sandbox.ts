export * as SandboxTools from "./sandbox.ts";

import type { ToolSet } from "ai";
import { Cause, Context, Effect, Exit, Layer, type Scope } from "effect";
import { serviceOperations } from "../../database/database.ts";
import { allowedHostsOf } from "../../sandboxes/allowed-hosts.ts";
import { PodSandboxes } from "../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../sandboxes/sandbox-provider-repository.ts";
import {
	openOncePerTurn,
	placeOf,
	READ_FILE_TOOL,
	RUN_COMMAND_TOOL,
	readFileTool,
	runCommandTool,
	WRITE_FILE_TOOL,
	writeFileTool,
} from "./sandbox/tools.ts";

/**
 * The tools that work in a pod's sandbox: `run_command`, `read_file` and
 * `write_file`. Offered while the workspace has an enabled sandbox provider,
 * looked up on every call, so enabling one applies from the next turn. The
 * sandbox is opened by a turn's first call to one of the tools, not when the
 * turn starts.
 */
export interface Interface {
	/**
	 * The tools for a turn in its agent's pod. The turn's lease on the
	 * sandbox is renewed while the scope is open and released when it closes,
	 * which is when the turn's run ends, or it stops to wait for an approval.
	 */
	readonly forTurn: (turn: Turn) => Effect.Effect<ToolSet, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/SandboxTools") {}

export const make = Effect.gen(function* () {
	const providers = yield* SandboxProviderRepository.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const operation = yield* serviceOperations<Interface>("SandboxTools");
	return Service.of({
		forTurn: ({ pod, turnId, threadId, agentId }) =>
			Effect.gen(function* (): Effect.fn.Return<ToolSet, never, Scope.Scope> {
				const provider = yield* providers.enabled(pod.workspaceId);
				if (!provider) return {};
				const allowedHosts = yield* operation("forTurn", allowedHostsOf(pod));
				yield* Effect.addFinalizer(() => podSandboxes.release(turnId));
				yield* Effect.forkScoped(
					podSandboxes.renew(turnId).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
				);
				// The tools run as promises; the opening logs through the turn's services.
				const runPromiseExit = Effect.runPromiseExitWith(yield* Effect.context<never>());
				const place = placeOf({ threadId, agentId });
				const prepared = podSandboxes.open(pod, provider, turnId).pipe(
					// The folders are made on first use, so any sandbox gains them.
					Effect.tap(({ sandbox }) =>
						sandbox.exec(`mkdir -p '${place.folder}' '${place.home}'`, {
							timeout: "30 seconds",
							maxOutputCharacters: 2_000,
						}),
					),
				);
				const openSandbox = openOncePerTurn(() =>
					runPromiseExit(prepared).then((exit) => {
						if (Exit.isSuccess(exit)) return exit.value;
						throw Cause.squash(exit.cause);
					}),
				);
				return {
					[RUN_COMMAND_TOOL]: runCommandTool(openSandbox, place, allowedHosts),
					[READ_FILE_TOOL]: readFileTool(openSandbox, place),
					[WRITE_FILE_TOOL]: writeFileTool(openSandbox, place),
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([PodSandboxes.layer, SandboxProviderRepository.layer]),
);

/** A turn that may use its pod's sandbox. */
export interface Turn {
	readonly pod: PodSandboxes.Pod;
	/** Holds the sandbox's lease while the turn runs. */
	readonly turnId: string;
	readonly threadId: string;
	readonly agentId: string;
}

/** No sandbox tools, for cases that offer none. */
export const none: Interface = { forTurn: () => Effect.succeed({}) };
