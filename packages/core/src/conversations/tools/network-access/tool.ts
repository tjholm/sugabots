import { sandboxHostSchema } from "@sugabots/contracts";
import { tool } from "ai";
import { Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { SandboxNetwork } from "../../../sandboxes/sandbox-network.ts";

export const REQUEST_NETWORK_ACCESS_TOOL = "request_network_access";

/**
 * The `request_network_access` tool: an agent asking for the workspace's
 * sandboxes to reach another host. Every call waits for someone who manages
 * the workspace's sandboxes to allow it (see `tools/approval-deciders.ts`), so the
 * tool only runs once they have, and then adds the host.
 */
export function requestNetworkAccessTool({
	turnId,
	network,
	run,
}: {
	turnId: string;
	network: Pick<SandboxNetwork.Interface, "grantRequest">;
	run: RunEffect<never>;
}) {
	return tool({
		description:
			"Ask for the sandbox to be allowed to connect to a host it can't reach. A workspace admin decides, and your reply waits until they have; once allowed, every sandbox in the workspace reaches the host. Ask only for a host the task needs, by its name, and use a wildcard such as *.example.com only when the task needs many of a domain's subdomains.",
		inputSchema: Schema.Struct({
			host: sandboxHostSchema.annotate({
				description:
					"The host's name in lowercase, such as api.example.com; *.example.com covers its subdomains but not example.com itself",
			}),
			reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
				description: "What the task needs it for, in a sentence the admin reads when deciding",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ host, reason }, { toolCallId }) => {
			const granted = await run(
				network.grantRequest({ turnId, sdkToolCallId: toolCallId, host, reason }),
			);
			return granted
				? { status: "allowed", host, note: "Sandboxes in this workspace can connect to it now." }
				: { status: "failed", error: "The request wasn't allowed." };
		},
	});
}
