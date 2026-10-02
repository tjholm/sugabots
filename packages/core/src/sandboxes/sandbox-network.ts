export * as SandboxNetwork from "./sandbox-network.ts";

import type { SandboxNetworkSettings } from "@sugabots/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { query, serviceOperations } from "../database/database.ts";
import { sandboxAllowedHost, user } from "../database/schema.ts";
import { addedHostsOf, TRUSTED_HOSTS } from "./allowed-hosts.ts";
import { PodSandboxes } from "./pod-sandboxes.ts";

/**
 * Where a workspace's sandboxes may connect to: {@link TRUSTED_HOSTS}, and
 * the hosts the workspace added. A change reaches its running sandboxes at
 * once, and the others when they are next opened.
 *
 * The settings methods take the current actor's `workspace.providers.manage`
 * on the workspace, named by its id or its slug.
 */
export interface Interface {
	readonly settings: (
		workspace: string,
	) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	readonly addHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	/** Removing a host the workspace never added changes nothing. */
	readonly removeHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SandboxNetwork",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SandboxNetwork");
	const authorization = yield* Authorization.Service;
	const podSandboxes = yield* PodSandboxes.Service;

	const manage = (workspace: string) =>
		authorization.workspace(workspace, "workspace.providers.manage");

	const settingsOf = (workspaceId: string) =>
		Effect.gen(function* () {
			const added = yield* addedHostsOf(workspaceId);
			const names = yield* addersOf(added.flatMap((row) => (row.addedById ? [row.addedById] : [])));
			return {
				trustedHosts: TRUSTED_HOSTS,
				addedHosts: added.map((row) => ({
					host: row.host,
					addedByName: (row.addedById && names.get(row.addedById)) ?? null,
					reason: row.reason,
					addedAt: row.createdAt.toISOString(),
				})),
			} satisfies SandboxNetworkSettings;
		});

	const add = (row: typeof sandboxAllowedHost.$inferInsert) =>
		query((db) => db.insert(sandboxAllowedHost).values(row).onConflictDoNothing()).pipe(
			Effect.andThen(podSandboxes.applyAllowedHosts(row.workspaceId)),
		);

	return Service.of({
		settings: (workspace) =>
			operation(
				"settings",
				Effect.flatMap(manage(workspace), ({ workspaceId }) => settingsOf(workspaceId)),
			),

		addHost: ({ workspace, host }) =>
			operation(
				"addHost",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* manage(workspace);
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* add({ workspaceId, host, addedById: actor.userId });
					}
					return yield* settingsOf(workspaceId);
				}),
			),

		removeHost: ({ workspace, host }) =>
			operation(
				"removeHost",
				Effect.gen(function* () {
					const { workspaceId } = yield* manage(workspace);
					const removed = yield* query((db) =>
						db
							.delete(sandboxAllowedHost)
							.where(
								and(
									eq(sandboxAllowedHost.workspaceId, workspaceId),
									eq(sandboxAllowedHost.host, host),
								),
							)
							.returning({ host: sandboxAllowedHost.host }),
					);
					if (removed.length > 0) yield* podSandboxes.applyAllowedHosts(workspaceId);
					return yield* settingsOf(workspaceId);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, PodSandboxes.layer]));

const addersOf = (userIds: readonly string[]) =>
	Effect.map(
		userIds.length === 0
			? Effect.succeed([])
			: query((db) =>
					db
						.select({ id: user.id, name: user.name })
						.from(user)
						.where(inArray(user.id, [...userIds])),
				),
		(rows) => new Map(rows.map((row) => [row.id, row.name])),
	);
