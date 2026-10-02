export * as PodSandboxes from "./pod-sandboxes.ts";

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer, Semaphore } from "effect";
import { Database, query, serviceOperations } from "../database/database.ts";
import { sandboxLease, sandbox as sandboxTable } from "../database/schema.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/** How long a lease holds a sandbox awake unless it is renewed. */
export const LEASE = Duration.seconds(90);
/** How often a turn renews its lease, well inside {@link LEASE}. */
export const LEASE_RENEWAL = Duration.seconds(30);
/** How long a sandbox sits with no turn using it before it is paused. */
export const IDLE_BEFORE_PAUSE = Duration.minutes(5);
/** How often the sweep looks for idle sandboxes to pause. */
const PAUSE_SWEEP_INTERVAL = Duration.minutes(1);

/**
 * The only writer of `sandbox` and `sandbox_lease`: each pod's one sandbox,
 * made the first time an agent there needs it, then opened, and resumed, on
 * every later use. A turn using it holds a lease, and a sandbox no turn has
 * held for {@link IDLE_BEFORE_PAUSE} is paused, so it stops costing compute.
 * A turn waiting for a person's approval has ended its run and holds no
 * lease, so nobody pays for a sandbox while a person is away.
 */
export interface Interface {
	/**
	 * The pod's sandbox at `provider`, the workspace's enabled one, ready to
	 * run commands, with a lease for `holder` that keeps it awake until
	 * released or expired.
	 */
	readonly open: (
		pod: Pod,
		provider: SandboxProviderRepository.Configured,
		holder: string,
	) => Effect.Effect<Opened, Sandboxes.Unavailable>;
	/** Extends `holder`'s leases. Nothing happens if it has none. */
	readonly renew: (holder: string) => Effect.Effect<void>;
	/** Ends `holder`'s leases, starting the idle time of the sandboxes it held. */
	readonly release: (holder: string) => Effect.Effect<void>;
	/** Pauses every sandbox nobody has used for {@link IDLE_BEFORE_PAUSE}. */
	readonly pauseIdle: Effect.Effect<void>;
	/**
	 * Destroys every sandbox `provider` made and forgets them, so the provider
	 * can be removed without leaving machines running at it.
	 */
	readonly destroyAllMadeBy: (
		workspaceId: string,
		provider: SandboxProviderRepository.Configured,
	) => Effect.Effect<void, Sandboxes.Unavailable>;
	/** Whether `providerId` has made any sandbox that still exists. */
	readonly anyMadeBy: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/PodSandboxes") {}

export const make = Effect.gen(function* () {
	const sandboxes = yield* Sandboxes.Service;
	const providers = yield* SandboxProviderRepository.Service;
	const operation = yield* serviceOperations<Interface>("PodSandboxes");
	// One change to a pod's sandbox at a time: two turns' first commands make
	// one sandbox, and the sweep never pauses one a turn is opening.
	const changes = new Map<string, Semaphore.Semaphore>();
	const oneAtATime = (podId: string) => {
		let semaphore = changes.get(podId);
		if (!semaphore) {
			semaphore = Semaphore.makeUnsafe(1);
			changes.set(podId, semaphore);
		}
		return semaphore.withPermits(1);
	};

	const recorded = (pod: Pod) =>
		query((db) =>
			db
				.select()
				.from(sandboxTable)
				.where(
					and(eq(sandboxTable.podId, pod.podId), eq(sandboxTable.workspaceId, pod.workspaceId)),
				)
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	const forget = (podId: string) =>
		query((db) => db.delete(sandboxTable).where(eq(sandboxTable.podId, podId)));

	const made = (pod: Pod, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const sandbox = yield* sandboxes.forConnection(provider.connection).create({
				labels: { "sugabots.workspace": pod.workspaceId, "sugabots.pod": pod.podId },
			});
			yield* query((db) =>
				db.insert(sandboxTable).values({
					workspaceId: pod.workspaceId,
					podId: pod.podId,
					sandboxProviderId: provider.id,
					providerSandboxId: sandbox.id,
				}),
			);
			return sandbox;
		});

	/**
	 * Destroys the pod's sandbox at a provider the workspace no longer uses.
	 * A provider that can't be reached leaves it running there, which is
	 * logged rather than blocking the pod's work at its new provider.
	 */
	const leaveOldProvider = (workspaceId: string, providerId: string, id: Sandboxes.SandboxId) =>
		Effect.gen(function* () {
			const old = yield* providers.connection(workspaceId, providerId);
			if (!old) return;
			yield* sandboxes
				.forConnection(old.connection)
				.destroy(id)
				.pipe(
					Effect.catchTag("SandboxUnavailable", (failure) =>
						Effect.logWarning(
							"Could not destroy a sandbox at a provider no longer in use",
							failure,
						),
					),
				);
		});

	const opened = (pod: Pod, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const row = yield* recorded(pod);
			const replaced = (sandbox: Sandboxes.Sandbox): Opened => ({ sandbox, arrival: "replaced" });
			if (!row) return { sandbox: yield* made(pod, provider), arrival: "made" } satisfies Opened;
			if (row.sandboxProviderId !== provider.id) {
				yield* leaveOldProvider(pod.workspaceId, row.sandboxProviderId, row.providerSandboxId);
				yield* forget(pod.podId);
				return replaced(yield* made(pod, provider));
			}
			const at = sandboxes.forConnection(provider.connection);
			return yield* at.open(row.providerSandboxId).pipe(
				Effect.map(
					({ sandbox, resumed }): Opened => ({
						sandbox,
						arrival: !resumed
							? "running"
							: at.capabilities.pauseKeeps === "disk"
								? "rebooted"
								: "resumed",
					}),
				),
				Effect.catchTag("SandboxMissing", () =>
					forget(pod.podId).pipe(Effect.andThen(made(pod, provider)), Effect.map(replaced)),
				),
			);
		});

	/** Takes or extends `holder`'s lease on the pod's sandbox, and marks it running. */
	const lease = (pod: Pod, holder: string) =>
		Effect.gen(function* () {
			const row = yield* recorded(pod);
			if (!row) return;
			const now = yield* DateTime.now;
			const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
			yield* query((db) =>
				db
					.insert(sandboxLease)
					.values({ sandboxId: row.id, holder, expiresAt })
					.onConflictDoUpdate({
						target: [sandboxLease.sandboxId, sandboxLease.holder],
						set: { expiresAt },
					}),
			);
			yield* query((db) =>
				db.update(sandboxTable).set({ pausedAt: null }).where(eq(sandboxTable.id, row.id)),
			);
		});

	/** Pauses one idle sandbox, unless a turn took it since it was found idle. */
	const pauseIfStillIdle = (row: typeof sandboxTable.$inferSelect, idleSince: Date, now: Date) =>
		oneAtATime(row.podId)(
			Effect.gen(function* () {
				const [still] = yield* query((db) =>
					db
						.select({ id: sandboxTable.id })
						.from(sandboxTable)
						.where(
							and(
								eq(sandboxTable.id, row.id),
								isNull(sandboxTable.pausedAt),
								lt(sandboxTable.lastUsedAt, idleSince),
								noLiveLease(now),
							),
						),
				);
				if (!still) return;
				const configured = yield* providers.connection(row.workspaceId, row.sandboxProviderId);
				if (!configured) return;
				yield* sandboxes
					.forConnection(configured.connection)
					.pause(row.providerSandboxId)
					.pipe(
						Effect.andThen(
							query((db) =>
								db.update(sandboxTable).set({ pausedAt: now }).where(eq(sandboxTable.id, row.id)),
							),
						),
						Effect.catchTags({
							// Gone at the provider: the next use makes a new one.
							SandboxMissing: () => forget(row.podId),
							SandboxUnavailable: (failure) =>
								Effect.logWarning("Could not pause an idle sandbox; trying again later", failure),
						}),
					);
			}),
		);

	const madeBy = (workspaceId: string, providerId: string) =>
		query((db) =>
			db
				.select()
				.from(sandboxTable)
				.where(
					and(
						eq(sandboxTable.workspaceId, workspaceId),
						eq(sandboxTable.sandboxProviderId, providerId),
					),
				),
		);

	return Service.of({
		open: (pod, provider, holder) =>
			operation(
				"open",
				oneAtATime(pod.podId)(Effect.tap(opened(pod, provider), () => lease(pod, holder))),
			),

		renew: (holder) =>
			operation(
				"renew",
				Effect.gen(function* () {
					const now = yield* DateTime.now;
					const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
					yield* query((db) =>
						db.update(sandboxLease).set({ expiresAt }).where(eq(sandboxLease.holder, holder)),
					);
				}),
			),

		release: (holder) =>
			operation(
				"release",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					const released = yield* query((db) =>
						db
							.delete(sandboxLease)
							.where(eq(sandboxLease.holder, holder))
							.returning({ sandboxId: sandboxLease.sandboxId }),
					);
					for (const { sandboxId } of released) {
						yield* query((db) =>
							db
								.update(sandboxTable)
								.set({ lastUsedAt: now })
								.where(eq(sandboxTable.id, sandboxId)),
						);
					}
				}),
			),

		pauseIdle: operation(
			"pauseIdle",
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const idleSince = DateTime.toDateUtc(DateTime.subtractDuration(now, IDLE_BEFORE_PAUSE));
				const idle = yield* query((db) =>
					db
						.select()
						.from(sandboxTable)
						.where(
							and(
								isNull(sandboxTable.pausedAt),
								lt(sandboxTable.lastUsedAt, idleSince),
								noLiveLease(DateTime.toDateUtc(now)),
							),
						),
				);
				for (const row of idle) {
					yield* pauseIfStillIdle(row, idleSince, DateTime.toDateUtc(now));
				}
			}),
		),

		destroyAllMadeBy: (workspaceId, provider) =>
			operation(
				"destroyAllMadeBy",
				Effect.gen(function* () {
					const at = sandboxes.forConnection(provider.connection);
					for (const row of yield* madeBy(workspaceId, provider.id)) {
						yield* oneAtATime(row.podId)(
							at.destroy(row.providerSandboxId).pipe(Effect.andThen(forget(row.podId))),
						);
					}
				}),
			),

		anyMadeBy: (workspaceId, providerId) =>
			operation(
				"anyMadeBy",
				Effect.map(madeBy(workspaceId, providerId), (rows) => rows.length > 0),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Sandboxes.layer, SandboxProviderRepository.layer]),
);

/** Runs `pauseIdle` every minute for as long as the layer's scope is open. */
export const pauseSweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const podSandboxes = yield* Service;
		const database = yield* Database;
		const pass = podSandboxes.pauseIdle.pipe(
			Effect.provideService(Database, database),
			Effect.catchCause((cause) => Effect.logError("Pausing idle sandboxes failed", cause)),
		);
		yield* Effect.forkScoped(
			pass.pipe(
				Effect.delay(PAUSE_SWEEP_INTERVAL),
				Effect.forever,
				Effect.withTracerEnabled(false),
			),
		);
	}),
).pipe(Layer.provide(layer));

/** No lease on the sandbox that is still in force at `now`. */
function noLiveLease(now: Date) {
	return sql`not exists (select 1 from ${sandboxLease} where ${sandboxLease.sandboxId} = ${sandboxTable.id} and ${sandboxLease.expiresAt} > ${now})`;
}

export interface Pod {
	readonly workspaceId: string;
	readonly podId: string;
}

export interface Opened {
	readonly sandbox: Sandboxes.Sandbox;
	/**
	 * How the sandbox came to be ready, which decides what the agent is told:
	 * - `made`: new, with nothing in it.
	 * - `running`: as the pod left it.
	 * - `resumed`: paused, and back with its programs still running.
	 * - `rebooted`: paused, and back with its files but no running programs.
	 * - `replaced`: new, because the pod's earlier one is gone: its provider
	 *   lost it, or the workspace changed provider.
	 */
	readonly arrival: "made" | "running" | "resumed" | "rebooted" | "replaced";
}
