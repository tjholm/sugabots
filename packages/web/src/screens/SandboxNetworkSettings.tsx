import type { SandboxAddedHost, SandboxNetworkSettings } from "@sugabots/contracts";
import { X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSandboxNetwork } from "@/lib/sandbox-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsControlRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * Where the workspace's sandboxes may connect to: the trusted hosts every
 * workspace has, and the ones this workspace added, by hand here or by
 * allowing an agent's request in a thread.
 */
export function SandboxNetworkSection() {
	const { settings, addHost, removeHost } = useSandboxNetwork();
	if (settings.isPending) return null;
	if (settings.isError) return <Alert>{failureMessage(settings.error)}</Alert>;
	return (
		<SandboxNetworkGroups
			settings={settings.data}
			pending={addHost.isPending || removeHost.isPending}
			error={addHost.error ?? removeHost.error ?? undefined}
			onAdd={(host) => addHost.mutateAsync(host)}
			onRemove={(host) => removeHost.mutate(host)}
		/>
	);
}

export function SandboxNetworkGroups({
	settings,
	pending,
	error,
	onAdd,
	onRemove,
}: {
	settings: SandboxNetworkSettings;
	pending: boolean;
	error?: unknown;
	onAdd: (host: string) => Promise<unknown>;
	onRemove: (host: string) => void;
}) {
	const [showingTrusted, setShowingTrusted] = useState(false);
	return (
		<>
			<SettingsGroup
				label="Network"
				note="Sandboxes connect only to these hosts. When an agent needs another, it asks in its thread, and anyone who manages sandboxes can allow it there."
			>
				{settings.addedHosts.map((added) => (
					<AddedHostRow
						key={added.host}
						added={added}
						disabled={pending}
						onRemove={() => onRemove(added.host)}
					/>
				))}
				<AddHostRow disabled={pending} onAdd={onAdd} />
				<SettingsRow
					label="Trusted hosts"
					sub={
						showingTrusted
							? settings.trustedHosts.join(", ")
							: `${settings.trustedHosts.length} hosts every workspace reaches: GitHub, package registries and Linux mirrors`
					}
					chevron={!showingTrusted}
					onClick={() => setShowingTrusted((showing) => !showing)}
				/>
			</SettingsGroup>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
		</>
	);
}

function AddedHostRow({
	added,
	disabled,
	onRemove,
}: {
	added: SandboxAddedHost;
	disabled: boolean;
	onRemove: () => void;
}) {
	const by = added.addedByName ?? "someone who has left";
	return (
		<SettingsRow
			label={<span className="font-mono text-[13.5px]">{added.host}</span>}
			sub={added.reason ? `Allowed by ${by} for an agent: ${added.reason}` : `Added by ${by}`}
			trailing={
				<IconButton label={`Remove ${added.host}`} disabled={disabled} onClick={onRemove}>
					<X size={16} />
				</IconButton>
			}
		/>
	);
}

function AddHostRow({
	disabled,
	onAdd,
}: {
	disabled: boolean;
	onAdd: (host: string) => Promise<unknown>;
}) {
	const id = useId();
	const [draft, setDraft] = useState("");

	function submit(event: FormEvent) {
		event.preventDefault();
		const host = draft.trim().toLowerCase();
		if (!host) return;
		void onAdd(host).then(() => setDraft(""));
	}

	return (
		<form onSubmit={submit}>
			<SettingsControlRow label="Add host" htmlFor={id}>
				<input
					id={id}
					type="text"
					autoComplete="off"
					spellCheck={false}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="api.example.com or *.example.com"
					className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<button
					type="submit"
					disabled={disabled || draft.trim() === ""}
					className="focus-ring shrink-0 rounded-md font-medium text-link text-sm disabled:opacity-50"
				>
					Add
				</button>
			</SettingsControlRow>
		</form>
	);
}
