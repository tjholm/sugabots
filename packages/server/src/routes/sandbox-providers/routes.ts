import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { SandboxProviderSetup } from "@sugabots/core/sandboxes/sandbox-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const sandboxProviderRoutes = HttpApiBuilder.group(
	ServerApi,
	"sandboxProviders",
	(handlers) =>
		Effect.gen(function* () {
			const setup = yield* SandboxProviderSetup.Service;
			return handlers
				.handle("list", ({ params }) =>
					setup.list(params.workspace).pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("access", ({ params }) =>
					setup.access(params.workspace).pipe(
						Effect.map((enabled) => ({ enabled })),
						asSessionUser,
						asHttpError(sandboxProviderErrors),
					),
				)
				.handle("create", ({ params, payload }) =>
					setup
						.create({ workspace: params.workspace, provider: payload })
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("update", ({ params, payload }) =>
					setup
						.update({
							workspace: params.workspace,
							providerId: params.providerId,
							changes: payload,
						})
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("remove", ({ params }) =>
					setup
						.remove({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("test", ({ params }) =>
					setup
						.test({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				);
		}),
);

const sandboxProviderErrors = {
	...refusals,
	SandboxProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	SandboxProviderIncomplete: BadRequest,
	SandboxesNotDestroyed: Conflict,
};
