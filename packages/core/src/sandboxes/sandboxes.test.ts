import { Cause, Effect, Exit, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandboxes } from "./sandboxes.ts";

/**
 * The same behaviour from every provider, run against the real service.
 *
 * Each provider runs only when its environment is set:
 * - OpenSandbox: `docker compose --profile sandboxes up -d`, then
 *   OPENSANDBOX_URL=http://localhost:8090 and OPENSANDBOX_API_KEY.
 * - E2B: E2B_API_KEY, plus E2B_API_URL and E2B_SANDBOX_URL for E2B Embed.
 */
const env = process.env;

const connections: ReadonlyArray<[string, Sandboxes.Connection | undefined]> = [
	[
		"OpenSandbox",
		env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY
			? {
					provider: "opensandbox",
					baseUrl: env.OPENSANDBOX_URL,
					apiKey: Redacted.make(env.OPENSANDBOX_API_KEY),
					image: "debian:bookworm-slim",
				}
			: undefined,
	],
	[
		"E2B",
		env.E2B_API_KEY
			? {
					provider: "e2b",
					apiKey: Redacted.make(env.E2B_API_KEY),
					template: "base",
					...(env.E2B_API_URL && env.E2B_SANDBOX_URL
						? { endpoints: { apiUrl: env.E2B_API_URL, sandboxUrl: env.E2B_SANDBOX_URL } }
						: {}),
				}
			: undefined,
	],
];

const LABELS = { "sugabots.test": "sandboxes.test.ts" };
const EXEC = { timeout: "30 seconds", maxOutputCharacters: 10_000 } as const;
const SLOW = 180_000;

const run = <A, E>(effect: Effect.Effect<A, E, Sandboxes.Service>) =>
	Effect.runPromise(effect.pipe(Effect.provide(Sandboxes.layer)));

const runExit = <A, E>(effect: Effect.Effect<A, E, Sandboxes.Service>) =>
	Effect.runPromiseExit(effect.pipe(Effect.provide(Sandboxes.layer)));

function failureTag(exit: Exit.Exit<unknown, { _tag: string }>) {
	if (Exit.isSuccess(exit)) return "success";
	const failure = exit.cause.reasons.find(Cause.isFailReason);
	return failure ? failure.error._tag : Cause.pretty(exit.cause);
}

describe.each(connections)("%s sandboxes", (_, connection) => {
	describe.skipIf(!connection)("against the service", () => {
		const provider = Effect.map(Sandboxes.Service, (sandboxes) =>
			sandboxes.forConnection(connection as Sandboxes.Connection),
		);
		let sandbox: Sandboxes.Sandbox;

		beforeAll(async () => {
			sandbox = await run(Effect.flatMap(provider, (p) => p.create({ labels: LABELS })));
		}, SLOW);

		afterAll(async () => {
			if (sandbox) await run(Effect.flatMap(provider, (p) => p.destroy(sandbox.id)));
		}, SLOW);

		it("accepts the key", async () => {
			expect(failureTag(await runExit(Effect.flatMap(provider, (p) => p.check)))).toBe("success");
		});

		it("runs commands in the workspace, as a user who isn't root", async () => {
			const execution = await run(sandbox.exec("pwd; id -u", EXEC));

			expect(execution.exitCode).toBe(0);
			const [directory, userId] = execution.stdout.text.trim().split("\n");
			expect(directory).toBe(Sandboxes.WORKSPACE_DIRECTORY);
			expect(userId).not.toBe("0");
		});

		it("answers a failing command with its exit code and output", async () => {
			const execution = await run(sandbox.exec("echo nope >&2; exit 3", EXEC));

			expect(execution.exitCode).toBe(3);
			expect(execution.stderr.text).toContain("nope");
		});

		it("keeps the end of long output", async () => {
			const execution = await run(sandbox.exec("seq 1 1000", { ...EXEC, maxOutputCharacters: 20 }));

			expect(execution.stdout.text.trim().endsWith("1000")).toBe(true);
			expect(execution.stdout.text.length).toBeLessThanOrEqual(20);
			expect(execution.stdout.droppedCharacters).toBeGreaterThan(0);
		});

		it("stops a command at its timeout, with no exit code", async () => {
			const execution = await run(sandbox.exec("sleep 30", { ...EXEC, timeout: "2 seconds" }));

			expect(execution.exitCode).toBeNull();
		}, 60_000);

		it("passes environment variables to the command", async () => {
			const execution = await run(
				sandbox.exec("echo $GREETING", { ...EXEC, env: { GREETING: "hi" } }),
			);

			expect(execution.stdout.text.trim()).toBe("hi");
		});

		it("writes files the agents' user owns, making their directories", async () => {
			const path = `${Sandboxes.WORKSPACE_DIRECTORY}/notes/today.txt`;
			const content = new TextEncoder().encode("written by a test\n");

			await run(sandbox.writeFile(path, content));

			expect(new TextDecoder().decode(await run(sandbox.readFile(path)))).toBe(
				"written by a test\n",
			);
			const owner = await run(sandbox.exec(`test "$(stat -c %u ${path})" = "$(id -u)"`, EXEC));
			expect(owner.exitCode).toBe(0);
		});

		it("refuses to read a file that doesn't exist", async () => {
			const exit = await runExit(sandbox.readFile(`${Sandboxes.WORKSPACE_DIRECTORY}/missing.txt`));

			expect(failureTag(exit)).toBe("SandboxFileFailed");
		});

		it(
			"keeps files across a pause, and says when opening resumed it",
			async () => {
				await run(sandbox.exec("echo kept > kept.txt", EXEC));

				const running = await run(Effect.flatMap(provider, (p) => p.open(sandbox.id)));
				await run(Effect.flatMap(provider, (p) => p.pause(sandbox.id)));
				const paused = await run(Effect.flatMap(provider, (p) => p.open(sandbox.id)));
				sandbox = paused.sandbox;

				expect(running.resumed).toBe(false);
				expect(paused.resumed).toBe(true);
				expect((await run(sandbox.exec("cat kept.txt", EXEC))).stdout.text.trim()).toBe("kept");
			},
			SLOW,
		);
	});

	describe.skipIf(!connection)("a destroyed sandbox", () => {
		it(
			"is missing, and destroying it again succeeds",
			async () => {
				const sandboxes = Effect.map(Sandboxes.Service, (s) =>
					s.forConnection(connection as Sandboxes.Connection),
				);
				const made = await run(Effect.flatMap(sandboxes, (p) => p.create({ labels: LABELS })));

				await run(Effect.flatMap(sandboxes, (p) => p.destroy(made.id)));

				expect(failureTag(await runExit(Effect.flatMap(sandboxes, (p) => p.open(made.id))))).toBe(
					"SandboxMissing",
				);
				expect(
					failureTag(await runExit(Effect.flatMap(sandboxes, (p) => p.destroy(made.id)))),
				).toBe("success");
			},
			SLOW,
		);
	});
});
