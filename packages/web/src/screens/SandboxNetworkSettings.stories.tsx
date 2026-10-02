import type { SandboxNetworkSettings } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { SandboxNetworkGroups } from "./SandboxNetworkSettings.tsx";

const trustedHosts = [
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"deb.debian.org",
];

const settings: SandboxNetworkSettings = {
	trustedHosts,
	addedHosts: [
		{
			host: "api.stripe.com",
			addedByName: "Sam Rivera",
			reason: "Run the checkout integration tests against Stripe's test mode",
			addedAt: "2026-10-01T09:30:00.000Z",
		},
		{
			host: "*.internal.example.com",
			addedByName: "Kim Park",
			reason: null,
			addedAt: "2026-10-02T02:10:00.000Z",
		},
	],
};

const meta = preview.meta({
	title: "Views/SandboxNetworkSettings",
	component: SandboxNetworkGroups,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		settings,
		pending: false,
		onAdd: fn(async () => undefined),
		onRemove: fn(),
	},
	decorators: [
		(Story) => (
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Sandboxes" description="Where bots run commands and edit files.">
					<Story />
				</SettingsPage>
			</div>
		),
	],
});

/**
 * Hosts the workspace added: one allowed for an agent's request, with the
 * agent's reason, and one an admin added by hand.
 */
export const AddedHosts = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText("api.stripe.com")).toBeVisible();
		await expect(canvas.getByText(/Allowed by Sam Rivera for an agent/)).toBeVisible();

		await userEvent.type(canvas.getByLabelText("Add host"), "Docs.Example.com");
		await userEvent.click(canvas.getByRole("button", { name: "Add" }));
		await expect(args.onAdd).toHaveBeenCalledWith("docs.example.com");

		await userEvent.click(canvas.getByRole("button", { name: "Remove api.stripe.com" }));
		await expect(args.onRemove).toHaveBeenCalledWith("api.stripe.com");
	},
});

/** Only the trusted hosts, listed once asked for. */
export const TrustedOnly = meta.story({
	args: { settings: { trustedHosts, addedHosts: [] } },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByText("Trusted hosts"));
		await expect(canvas.getByText(/registry\.npmjs\.org/)).toBeVisible();
	},
});

/** A host the API refused, said under the group. */
export const Refused = meta.story({
	args: { error: new Error("Enter a domain name, such as api.example.com or *.example.com") },
});
