export * as SandboxTools from "./sandbox.ts";

import type { ToolSet } from "ai";
import { Cause, Context, Effect, Exit, Layer, type Scope } from "effect";
import { PodSandboxes } from "../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../sandboxes/sandbox-provider-repository.ts";
import {
	openOncePerTurn,
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
	 * The tools for a turn, `holder`, in the pod. The turn's lease on the
	 * sandbox is renewed while the scope is open and released when it closes,
	 * which is when the turn's run ends, or it stops to wait for an approval.
	 */
	readonly forPod: (
		pod: PodSandboxes.Pod,
		holder: string,
	) => Effect.Effect<ToolSet, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/SandboxTools") {}

export const make = Effect.gen(function* () {
	const providers = yield* SandboxProviderRepository.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	return Service.of({
		forPod: (pod, holder) =>
			Effect.gen(function* (): Effect.fn.Return<ToolSet, never, Scope.Scope> {
				const provider = yield* providers.enabled(pod.workspaceId);
				if (!provider) return {};
				yield* Effect.addFinalizer(() => podSandboxes.release(holder));
				yield* Effect.forkScoped(
					podSandboxes.renew(holder).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
				);
				// The tools run as promises; the opening logs through the turn's services.
				const runPromiseExit = Effect.runPromiseExitWith(yield* Effect.context<never>());
				const openSandbox = openOncePerTurn(() =>
					runPromiseExit(podSandboxes.open(pod, provider, holder)).then((exit) => {
						if (Exit.isSuccess(exit)) return exit.value;
						throw Cause.squash(exit.cause);
					}),
				);
				return {
					[RUN_COMMAND_TOOL]: runCommandTool(openSandbox),
					[READ_FILE_TOOL]: readFileTool(openSandbox),
					[WRITE_FILE_TOOL]: writeFileTool(openSandbox),
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([PodSandboxes.layer, SandboxProviderRepository.layer]),
);

/** No sandbox tools, for cases that offer none. */
export const none: Interface = { forPod: () => Effect.succeed({}) };
