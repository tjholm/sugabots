import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** How the pod's sandbox stands, and whether the person may reset or upgrade it. */
export function usePodSandbox(podId: string | undefined) {
	return useQuery({
		queryKey: ["pod-sandbox", podId],
		queryFn: podId
			? ({ signal }) =>
					Effect.runPromise(client.api.podSandbox.get({ params: { podId } }), { signal })
			: skipToken,
		// Turns come and go; the panel keeps up without a page reload.
		refetchInterval: 15_000,
	});
}

export function usePodSandboxActions(podId: string) {
	const queryClient = useQueryClient();
	const settle = {
		onSuccess: (data: unknown) => queryClient.setQueryData(["pod-sandbox", podId], data),
	};
	return {
		reset: useMutation({
			mutationFn: () => Effect.runPromise(client.api.podSandbox.reset({ params: { podId } })),
			...settle,
		}),
		upgrade: useMutation({
			mutationFn: () => Effect.runPromise(client.api.podSandbox.upgrade({ params: { podId } })),
			...settle,
		}),
	};
}
