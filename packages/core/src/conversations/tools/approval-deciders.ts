import type { ToolApprovalDeciders } from "@sugabots/contracts";
import { REQUEST_NETWORK_ACCESS_TOOL } from "./network-access/tool.ts";

/**
 * Who decides a call to `tool` that waits for approval. A request for network
 * access changes what every pod's sandbox may reach, so those who manage the
 * workspace's sandboxes decide it; the pod decides everything else.
 */
export function decidersOf(tool: string): ToolApprovalDeciders {
	return tool === REQUEST_NETWORK_ACCESS_TOOL ? "sandbox-managers" : "pod";
}
