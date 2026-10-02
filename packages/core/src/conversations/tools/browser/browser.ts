import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { UserMessage } from "../../../user-message.ts";
import { type Image, type OpenSandbox, type Place, withImages } from "../sandbox/tools.ts";
import playwrightTools from "./playwright-tools.json" with { type: "json" };

/**
 * The browser tools: Playwright MCP's, run in the pod's sandbox by a browser
 * of the agent's own in each thread, on the agent's own desktop there, so
 * people watching see what it does. The tools are offered from the list the
 * image's server was built with; the browser starts on the first call.
 */

/** What a browser tool gives back: the server's text, and any screenshots. */
export interface BrowserResult {
	text: string;
	images?: readonly Image[];
}

interface Failed {
	status: "failed";
	error: UserMessage;
}

/** A desktop and browser for one agent in one thread, started on first use. */
export interface BrowserSession {
	/** The session's name in the sandbox, which the viewer finds its desktop by. */
	readonly name: string;
	readonly call: (tool: string, input: unknown) => Promise<BrowserResult | Failed>;
	/** Lets go of the connection to the browser. The browser carries on for later turns. */
	readonly close: () => Promise<void>;
}

const SCREENSHOT_TOOL = "browser_take_screenshot";
const NO_BROWSER = UserMessage.of`This sandbox's image has no browser. Its image needs sugabots-desktop, as Sugabots' default image has.`;

/** The session's name for an agent in a thread: one desktop and browser each. */
export function sessionName(turn: { threadId: string; agentId: string }) {
	return `${turn.threadId}-${turn.agentId}`;
}

export function browserSession(
	openSandbox: OpenSandbox,
	place: Place,
	turn: { threadId: string; agentId: string },
): BrowserSession {
	const name = sessionName(turn);
	const directory = `${place.folder}/.browser/${turn.agentId}`;
	let connecting: Promise<{ client: Client; note?: UserMessage } | Failed> | undefined;
	let told = false;

	const connect = async (): Promise<{ client: Client; note?: UserMessage } | Failed> => {
		const { sandbox } = await openSandbox();
		const started = await Effect.runPromise(
			sandbox.exec(`sugabots-desktop session '${name}' '${directory}/profile' '${directory}'`, {
				env: { HOME: place.home },
				timeout: "60 seconds",
				maxOutputCharacters: 2_000,
			}),
		);
		const ports = Object.fromEntries(
			started.stdout.text
				.trim()
				.split(/\s+/)
				.map((pair) => pair.split("=")),
		);
		if (started.exitCode !== 0 || !ports.browser) return { status: "failed", error: NO_BROWSER };
		const endpoint = await Effect.runPromise(sandbox.endpoint(Number(ports.browser)));
		const client = new Client({ name: "sugabots", version: "1" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${endpoint.url}/mcp`), {
				requestInit: { headers: endpoint.headers },
			}),
		);
		return ports.started === "yes"
			? {
					client,
					note: UserMessage.of`Your browser has just started, on your own desktop in the sandbox. Tabs from before, if any, are gone.`,
				}
			: { client };
	};

	return {
		name,
		call: async (toolName, input) => {
			connecting ??= connect().catch((cause: unknown) => {
				connecting = undefined;
				if (cause instanceof Sandboxes.Unavailable)
					return { status: "failed", error: cause.userMessage };
				throw cause;
			});
			const connected = await connecting;
			if ("status" in connected) {
				connecting = undefined;
				return connected;
			}
			const result = await connected.client.callTool({
				name: toolName,
				arguments: input as Record<string, unknown>,
			});
			const note = told ? undefined : connected.note;
			told = true;
			return toBrowserResult(result.content, note);
		},
		close: async () => {
			const connected = await connecting?.catch(() => undefined);
			if (connected && !("status" in connected)) await connected.client.close();
		},
	};
}

function toBrowserResult(content: unknown, note: UserMessage | undefined): BrowserResult {
	const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
	const text = parts
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string);
	const images = parts
		.filter((part) => part.type === "image" && typeof part.data === "string")
		.map((part) => ({
			data: part.data as string,
			mediaType: String(part.mimeType ?? "image/png"),
		}));
	return {
		text: [...(note ? [note] : []), ...text].join("\n\n"),
		...(images.length > 0 ? { images } : {}),
	};
}

/**
 * The browser tools for a turn. A model that can't take images isn't offered
 * screenshots, and is given the text of any other result alone.
 */
export function browserTools(session: BrowserSession, acceptsImages: boolean): ToolSet {
	const tools: ToolSet = {};
	for (const entry of playwrightTools) {
		if (!acceptsImages && entry.name === SCREENSHOT_TOOL) continue;
		tools[entry.name] = tool({
			description: entry.description,
			inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
			execute: (input) => session.call(entry.name, input),
			toModelOutput: ({ output }) => withImages(output, acceptsImages),
		});
	}
	return tools;
}
