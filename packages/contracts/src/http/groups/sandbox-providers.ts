import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	newSandboxProviderSchema,
	sandboxAccessSchema,
	sandboxProviderSchema,
	sandboxProviderTestResultSchema,
	sandboxProviderUpdateSchema,
} from "../../sandbox-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/workspaces/:workspace/sandbox-providers";
const workspace = { workspace: workspaceIdOrSlugSchema };
const provider = { workspace: workspaceIdOrSlugSchema, providerId: uuidSchema };

export class SandboxProvidersApi extends HttpApiGroup.make("sandboxProviders")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: workspace,
			success: Schema.Array(sandboxProviderSchema),
			error: refused,
		}),
		HttpApiEndpoint.get("access", `${root}/access`, {
			params: workspace,
			success: sandboxAccessSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("create", root, {
			params: workspace,
			payload: newSandboxProviderSchema,
			success: sandboxProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.patch("update", `${root}/:providerId`, {
			params: provider,
			payload: sandboxProviderUpdateSchema,
			success: sandboxProviderSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:providerId`, {
			params: provider,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("test", `${root}/:providerId/test`, {
			params: provider,
			success: sandboxProviderTestResultSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}
