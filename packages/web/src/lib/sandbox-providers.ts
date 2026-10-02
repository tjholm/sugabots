import type { NewSandboxProvider, SandboxProviderUpdate } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** The sandbox providers the workspace has configured, oldest first. */
export function useSandboxProviders() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["sandbox-providers", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.sandboxProviders.list({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/**
 * Whether the workspace's agents can be given a sandbox. Any member may read
 * it. Its key starts with the providers' key, so changing a provider refetches it.
 */
export function useSandboxAccess() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["sandbox-providers", workspaceId, "access"],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.sandboxProviders.access({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

export function useSandboxProviderActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["sandbox-providers", workspaceId] });
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}

	return {
		create: useMutation({
			mutationFn: (json: NewSandboxProvider) =>
				Effect.runPromise(
					client.api.sandboxProviders.create({
						params: { workspace: requiredWorkspace() },
						payload: json,
					}),
				),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({
				providerId,
				changes,
			}: {
				providerId: string;
				changes: SandboxProviderUpdate;
			}) =>
				Effect.runPromise(
					client.api.sandboxProviders.update({
						params: { workspace: requiredWorkspace(), providerId },
						payload: changes,
					}),
				),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: (providerId: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.remove({
						params: { workspace: requiredWorkspace(), providerId },
					}),
				),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: (providerId: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.test({
						params: { workspace: requiredWorkspace(), providerId },
					}),
				),
			onSettled: refresh,
		}),
	};
}
