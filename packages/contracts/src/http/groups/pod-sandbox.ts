import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { podSandboxSchema } from "../../sandbox-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/pods/:podId/sandbox";
const params = { podId: uuidSchema };

/** A pod's sandbox: how it stands, and starting it afresh or moving its work to the current image. */
export class PodSandboxApi extends HttpApiGroup.make("podSandbox")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: podSandboxSchema, error: refused }),
		HttpApiEndpoint.post("reset", `${root}/reset`, {
			params,
			success: podSandboxSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("upgrade", `${root}/upgrade`, {
			params,
			success: podSandboxSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
	)
	.middleware(Session) {}
