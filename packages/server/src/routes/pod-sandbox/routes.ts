import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { PodSandboxSetup } from "@sugabots/core/sandboxes/pod-sandbox-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const podSandboxRoutes = HttpApiBuilder.group(ServerApi, "podSandbox", (handlers) =>
	Effect.gen(function* () {
		const setup = yield* PodSandboxSetup.Service;
		return handlers
			.handle("get", ({ params }) =>
				setup.get(params.podId).pipe(asSessionUser, asHttpError(podSandboxErrors)),
			)
			.handle("reset", ({ params }) =>
				setup.reset(params.podId).pipe(asSessionUser, asHttpError(podSandboxErrors)),
			)
			.handle("upgrade", ({ params }) =>
				setup.upgrade(params.podId).pipe(asSessionUser, asHttpError(podSandboxErrors)),
			);
	}),
);

const podSandboxErrors = {
	...refusals,
	SandboxInUse: Conflict,
	NoSandbox: NotFound,
	UpgradeFailed: Conflict,
	NoSandboxProvider: BadRequest,
	SandboxUnavailable: Conflict,
};
