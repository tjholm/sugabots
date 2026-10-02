import { Schema } from "effect";
import { providerStatusSchema, providerUrlSchema } from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Sandbox providers: where a workspace's pods get the Linux machines their
 * agents run commands on. Experimental.
 *
 * A workspace may configure several, each from a preset with its own account
 * and key, but at most one is enabled at a time, and that one makes every
 * pod's sandbox. Agents are offered the sandbox tools only while one is.
 */

/**
 * Sugabots' sandbox image, from `docker/sandbox`: published to GHCR, or built
 * locally under the same name with `bun run build:sandbox`.
 */
export const SANDBOX_IMAGE = "ghcr.io/nitrictech/sugabots-sandbox:latest";

/**
 * The E2B template Sugabots builds from {@link SANDBOX_IMAGE} in a
 * workspace's E2B account. E2B makes sandboxes from templates, not images.
 */
export const SANDBOX_E2B_TEMPLATE = "sugabots-sandbox";

export const sandboxProviderPresetIdSchema = Schema.Literals(["opensandbox", "e2b"]);
export type SandboxProviderPresetId = typeof sandboxProviderPresetIdSchema.Type;

export interface SandboxProviderPreset {
	id: SandboxProviderPresetId;
	name: string;
	/** A local preset is a server you run, at an address you give; a remote one has its own. */
	hosting: "remote" | "local";
	/** The address a local preset is usually at. */
	baseUrl?: string;
	/** What sandboxes are made from: an image for OpenSandbox, a template for E2B. */
	imageLabel: string;
	defaultImage: string;
}

export const sandboxProviderCatalog: readonly SandboxProviderPreset[] = [
	{
		id: "opensandbox",
		name: "OpenSandbox",
		hosting: "local",
		baseUrl: "http://localhost:8090",
		imageLabel: "Image",
		defaultImage: SANDBOX_IMAGE,
	},
	{
		id: "e2b",
		name: "E2B",
		hosting: "remote",
		imageLabel: "Template",
		defaultImage: SANDBOX_E2B_TEMPLATE,
	},
];

export function sandboxProviderPreset(id: SandboxProviderPresetId): SandboxProviderPreset {
	const preset = sandboxProviderCatalog.find((candidate) => candidate.id === id);
	if (!preset) {
		throw new Error(`Unknown sandbox provider preset: ${id}`);
	}
	return preset;
}

export const sandboxProviderSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	preset: sandboxProviderPresetIdSchema,
	name: Schema.String,
	/**
	 * The server's address. OpenSandbox always has one; for E2B it is E2B
	 * Embed's API address, and null means E2B Cloud.
	 */
	baseUrl: Schema.NullOr(providerUrlSchema),
	/** E2B Embed's address for reaching sandboxes; null for E2B Cloud and for OpenSandbox. */
	sandboxUrl: Schema.NullOr(providerUrlSchema),
	/** What sandboxes are made from, when not the preset's default; null follows the default. */
	image: Schema.NullOr(Schema.String),
	/** Whether this provider makes the workspace's sandboxes. At most one is. */
	enabled: Schema.Boolean,
	status: providerStatusSchema,
	hasApiKey: Schema.Boolean,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
});

export type SandboxProvider = typeof sandboxProviderSchema.Type;

const apiKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const imageSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512));

export const newSandboxProviderSchema = Schema.Struct({
	preset: sandboxProviderPresetIdSchema,
	/** Enabling it disables whichever provider was enabled before. */
	enabled: Schema.optional(Schema.Boolean),
	apiKey: Schema.optional(apiKeySchema),
	baseUrl: Schema.optional(providerUrlSchema),
	sandboxUrl: Schema.optional(providerUrlSchema),
	image: Schema.optional(imageSchema),
});

export type NewSandboxProvider = typeof newSandboxProviderSchema.Type;

export const sandboxProviderUpdateSchema = Schema.Struct({
	/** Enabling it disables whichever provider was enabled before. */
	enabled: Schema.optional(Schema.Boolean),
	/** Absent leaves the stored key alone; null removes it. */
	apiKey: Schema.optional(Schema.NullOr(apiKeySchema)),
	baseUrl: Schema.optional(Schema.NullOr(providerUrlSchema)),
	sandboxUrl: Schema.optional(Schema.NullOr(providerUrlSchema)),
	/** Null goes back to the preset's default. */
	image: Schema.optional(Schema.NullOr(imageSchema)),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type SandboxProviderUpdate = typeof sandboxProviderUpdateSchema.Type;

/**
 * Whether the workspace's agents can be given a sandbox: true while it has an
 * enabled sandbox provider with everything it needs.
 */
export const sandboxAccessSchema = Schema.Struct({ enabled: Schema.Boolean });
export type SandboxAccess = typeof sandboxAccessSchema.Type;

export const sandboxProviderTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	error: Schema.optional(Schema.String),
});

export type SandboxProviderTestResult = typeof sandboxProviderTestResultSchema.Type;

/** A pod's sandbox as the pod's settings show it. */
export const podSandboxStateSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("none") }),
	Schema.Struct({
		kind: Schema.Literal("present"),
		/** `lost`: the provider no longer has it. `unreachable`: its provider didn't answer. */
		state: Schema.Literals(["running", "paused", "lost", "unreachable"]),
		/** What it was made from, as its provider names it; null when the provider didn't answer. */
		image: Schema.NullOr(Schema.String),
		providerName: Schema.String,
		createdAt: isoTimestampSchema,
		lastUsedAt: isoTimestampSchema,
		turnsUsing: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		peopleWatching: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		/** Whether the workspace's enabled provider would make it from another image, or is another provider. */
		upgradeAvailable: Schema.Boolean,
	}),
]);

export type PodSandboxState = typeof podSandboxStateSchema.Type;

export const podSandboxSchema = Schema.Struct({
	sandbox: podSandboxStateSchema,
	/** Whether the workspace has a sandbox provider enabled, without which nothing new is made. */
	providerEnabled: Schema.Boolean,
	/** Whether the person asking may reset or upgrade it. */
	canManage: Schema.Boolean,
});

export type PodSandbox = typeof podSandboxSchema.Type;

/**
 * How a provider's template stands, for a provider that builds its sandboxes
 * from one (E2B): `missing` until Sugabots' is prepared in the workspace's
 * account. Null for a provider that takes images as they are.
 */
export const sandboxTemplateSchema = Schema.Struct({
	state: Schema.NullOr(Schema.Literals(["missing", "building", "ready", "failed"])),
});

export type SandboxTemplate = typeof sandboxTemplateSchema.Type;
