import {
	ConnectionConfig,
	Sandbox as OpenSandbox,
	SandboxApiException,
	SandboxManager,
} from "@alibaba-group/opensandbox";
import { Duration, Effect, Redacted } from "effect";
import { UserMessage } from "../../user-message.ts";
import { Sandboxes } from "../sandboxes.ts";

/**
 * Sandboxes on an OpenSandbox server (github.com/alibaba/OpenSandbox), which
 * runs them as containers on Docker or Kubernetes. It is the provider for
 * local development on any OS, and for self-hosted installs.
 */

const REQUEST_TIMEOUT_SECONDS = 120;

/** How far past its own timeout a command may run before the call gives up on the server. */
const EXEC_GRACE = Duration.seconds(15);

/**
 * The user agents' commands run as, so nothing they run is root. The file API
 * names owners, so it needs a name as well as an id; `-o` lets it share its id
 * with a user the image already has, such as `node` in the Node images.
 */
const AGENT_USER = { name: "agent", id: 1000, home: "/home/agent" } as const;

export const fromOpenSandbox = (
	connection: Sandboxes.OpenSandboxConnection,
): Sandboxes.Provider => {
	const url = new URL(connection.baseUrl);
	const connectionConfig = () =>
		new ConnectionConfig({
			domain: url.host,
			protocol: url.protocol === "https:" ? "https" : "http",
			apiKey: Redacted.value(connection.apiKey),
			requestTimeoutSeconds: REQUEST_TIMEOUT_SECONDS,
		});
	const manager = () => SandboxManager.create({ connectionConfig: connectionConfig() });
	const unavailable = (cause: unknown) =>
		new Sandboxes.Unavailable({ provider: "opensandbox", cause });
	/** The server's 404 for a sandbox id means it no longer has that sandbox. */
	const missingOr = (id: Sandboxes.SandboxId) => (cause: unknown) =>
		isNotFound(cause)
			? new Sandboxes.Missing({ provider: "opensandbox", sandboxId: id })
			: unavailable(cause);

	return {
		// Docker keeps memory across a pause, but Kubernetes keeps only the
		// root filesystem, and the server doesn't say which it runs on.
		capabilities: { pauseKeeps: "disk" },
		check: Effect.tryPromise({
			try: () => manager().listSandboxInfos({ pageSize: 1 }),
			catch: unavailable,
		}).pipe(Effect.asVoid),
		create: (spec) =>
			Effect.tryPromise({
				try: async () => {
					const sandbox = await OpenSandbox.create({
						connectionConfig: connectionConfig(),
						image: connection.image,
						// Kept until Sugabots destroys it: a pod's sandbox outlives any one turn.
						timeoutSeconds: null,
						metadata: { ...spec.labels },
					});
					await prepareAgentUser(sandbox);
					return toSandbox(sandbox);
				},
				catch: unavailable,
			}),
		open: (id) =>
			Effect.tryPromise({
				try: async () => {
					const info = await manager().getSandboxInfo(id);
					const resumed = info.status.state === "Paused";
					const sandbox = resumed
						? await OpenSandbox.resume({ sandboxId: id, connectionConfig: connectionConfig() })
						: await OpenSandbox.connect({ sandboxId: id, connectionConfig: connectionConfig() });
					return { sandbox: toSandbox(sandbox), resumed };
				},
				catch: missingOr(id),
			}),
		info: (id) =>
			Effect.tryPromise({
				try: async (): Promise<Sandboxes.Info> => {
					const info = await manager().getSandboxInfo(id);
					const state = info.status.state;
					return {
						state: state === "Paused" || state === "Pausing" ? "paused" : "running",
						image: String((info.image as { uri?: string } | undefined)?.uri ?? ""),
					};
				},
				catch: missingOr(id),
			}),
		pause: (id) =>
			Effect.tryPromise({
				try: () => manager().pauseSandbox(id),
				catch: missingOr(id),
			}),
		destroy: (id) =>
			Effect.tryPromise({
				try: () =>
					manager()
						.killSandbox(id)
						.catch((cause: unknown) => {
							// Already gone, which is what destroying asks for.
							if (!isNotFound(cause)) throw cause;
						}),
				catch: unavailable,
			}),
	};

	function toSandbox(sandbox: OpenSandbox): Sandboxes.Sandbox {
		return {
			id: Sandboxes.SandboxId(sandbox.id),
			exec: (command, options) =>
				Effect.tryPromise({
					try: (signal) => run(sandbox, command, options, signal),
					catch: unavailable,
				}),
			readFile: (path) =>
				Effect.tryPromise({
					try: () => sandbox.files.readBytes(path),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}),
			writeFile: (path, content) =>
				Effect.tryPromise({
					try: () =>
						sandbox.files.writeFiles([
							{
								path,
								data: content,
								// Octal digits written as a decimal number, as the API reads them.
								mode: 644,
								owner: AGENT_USER.name,
								group: AGENT_USER.name,
							},
						]),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}),
			endpoint: (port) =>
				Effect.tryPromise({
					try: async () => {
						const endpoint = await sandbox.getEndpoint(port);
						const url = endpoint.endpoint.includes("://")
							? endpoint.endpoint
							: `${connection.baseUrl.startsWith("https:") ? "https" : "http"}://${endpoint.endpoint}`;
						return { url: url.replace(/\/$/, ""), headers: { ...endpoint.headers } };
					},
					catch: unavailable,
				}),
		};
	}
};

async function run(
	sandbox: OpenSandbox,
	command: string,
	options: Sandboxes.ExecOptions,
	signal: AbortSignal,
): Promise<Sandboxes.Execution> {
	const stdout = Sandboxes.outputTail(options.maxOutputCharacters);
	const stderr = Sandboxes.outputTail(options.maxOutputCharacters);
	const timeout = Duration.fromInputUnsafe(options.timeout);
	const execution = await sandbox.commands.run(
		command,
		{
			workingDirectory: options.cwd ?? Sandboxes.WORKSPACE_DIRECTORY,
			timeoutSeconds: Math.ceil(Duration.toSeconds(timeout)),
			uid: AGENT_USER.id,
			gid: AGENT_USER.id,
			envs: { HOME: AGENT_USER.home, ...options.env },
		},
		// Output arrives a line at a time with its line break taken off.
		{
			onStdout: (message) => stdout.append(`${message.text}\n`),
			onStderr: (message) => stderr.append(`${message.text}\n`),
		},
		AbortSignal.any([
			signal,
			AbortSignal.timeout(Duration.toMillis(Duration.sum(timeout, EXEC_GRACE))),
		]),
	);
	const exitCode = execution.exitCode;
	return {
		// Negative when the server stopped the command at its timeout.
		exitCode: exitCode === undefined || exitCode === null || exitCode < 0 ? null : exitCode,
		stdout: stdout.captured(),
		stderr: stderr.captured(),
	};
}

/**
 * Makes the agents' user and the directories it works in. The image's own
 * default user is often root, which agents never are.
 */
async function prepareAgentUser(sandbox: OpenSandbox) {
	const { name, id, home } = AGENT_USER;
	const directories = `${Sandboxes.WORKSPACE_DIRECTORY} ${home}`;
	const prepared = await sandbox.commands.run(
		[
			`getent group ${name} >/dev/null || groupadd -o -g ${id} ${name}`,
			`id -u ${name} >/dev/null 2>&1 || useradd -o -u ${id} -g ${id} -M -d ${home} -s /bin/bash ${name}`,
			`mkdir -p ${directories}`,
			`chown ${id}:${id} ${directories}`,
		].join(" && "),
	);
	if (prepared.exitCode !== 0) {
		const stderr = prepared.logs.stderr.map((line) => line.text).join("\n");
		throw new Error(`Could not prepare the agents' user: ${stderr}`);
	}
}

function isNotFound(cause: unknown) {
	return cause instanceof SandboxApiException && cause.statusCode === 404;
}

/** A refusal about the file itself, which the agent can do something about. */
function fileFailure(path: string, cause: unknown): Sandboxes.FileFailed | undefined {
	if (!(cause instanceof SandboxApiException)) return undefined;
	if (cause.statusCode === 404) {
		return new Sandboxes.FileFailed({ path, reason: UserMessage.of`No such file` });
	}
	if (cause.statusCode === 400 || cause.statusCode === 403) {
		return new Sandboxes.FileFailed({
			path,
			reason: UserMessage.of`The path is a directory, or can't be written`,
		});
	}
	return undefined;
}
