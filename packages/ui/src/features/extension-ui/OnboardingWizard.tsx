import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { api } from "../../lib/api";
import { tt } from "../../lib/i18n";

/**
 * Zero-config onboarding: when no provider has a
 * configured credential, this wizard collects a provider id + API key and
 * writes them to ~/.pi/agent/auth.json (mode 600) via the gateway.
 * After saving, the model directory is re-pulled (auth_changed broadcast).
 */
export function OnboardingWizard() {
	const [open, setOpen] = useState(false);
	const [provider, setProvider] = useState("");
	const [key, setKey] = useState("");
	const [saving, setSaving] = useState(false);

	const check = useCallback(async () => {
		try {
			const { providers } = await api.authStatus();
			const configured = providers.some((entry) => entry.configured);
			setOpen(!configured);
		} catch {
			// keep the wizard closed when the gateway is unreachable
		}
	}, []);

	useEffect(() => {
		void check();
		const onAuthChanged = () => void check();
		window.addEventListener("piweb:auth-changed", onAuthChanged);
		return () => window.removeEventListener("piweb:auth-changed", onAuthChanged);
	}, [check]);

	const save = async () => {
		setSaving(true);
		try {
			await api.saveApiKey(provider.trim(), key.trim());
			toast.success(tt("onboarding.saved"));
			window.dispatchEvent(new CustomEvent("piweb:auth-changed"));
			setProvider("");
			setKey("");
			setOpen(false);
		} catch (error) {
			toast.error(tt("onboarding.saveFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) return; // onboarding cannot be dismissed while unconfigured
			}}
		>
			<DialogContent showCloseButton={false} onInteractOutside={(event) => event.preventDefault()}>
				<DialogHeader>
					<div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary">
						<KeyRound className="size-5" />
					</div>
					<DialogTitle>{tt("onboarding.title")}</DialogTitle>
					<DialogDescription>{tt("onboarding.description")}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="onboarding-provider">Provider ID</Label>
						<Input
							id="onboarding-provider"
							autoFocus
							value={provider}
							placeholder={tt("onboarding.providerPlaceholder")}
							onChange={(event) => setProvider(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="onboarding-key">API Key</Label>
						<Input
							id="onboarding-key"
							type="password"
							value={key}
							placeholder="sk-…"
							className="font-mono"
							onChange={(event) => setKey(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void save();
							}}
						/>
					</div>
					<p className="text-[12px] leading-relaxed text-ink-3">{tt("onboarding.securityNote")}</p>
				</div>
				<DialogFooter>
					<Button onClick={() => void save()} disabled={!provider.trim() || !key.trim() || saving}>
						{saving ? tt("onboarding.saving") : tt("onboarding.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
