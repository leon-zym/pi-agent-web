import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "../components/ui/toaster";
import { TooltipProvider } from "../components/ui/tooltip";
import { ExtensionDialogs, OnboardingWizard, SettingsDialog } from "../features/extension-ui";
import { api } from "../lib/api";
import { tt } from "../lib/i18n";
import { initPipeline } from "../lib/stream-pipeline";
import { useTheme } from "../lib/use-theme";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { AppShell } from "./AppShell";

export function App() {
	useTheme();
	const [settingsOpen, setSettingsOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void api
			.bootstrap()
			.then(() => {
				if (cancelled) return;
				initPipeline();
				return useSessionDirectoryStore.getState().loadWorkspaces();
			})
			.catch((error) => {
				if (cancelled) return;
				toast.error(tt("bootstrap.failed"), {
					description: error instanceof Error ? error.message : String(error),
				});
			});
		const openSettings = () => setSettingsOpen(true);
		window.addEventListener("piweb:open-settings", openSettings);
		return () => {
			cancelled = true;
			window.removeEventListener("piweb:open-settings", openSettings);
		};
	}, []);

	return (
		<TooltipProvider delayDuration={500}>
			<AppShell />
			<ExtensionDialogs />
			<OnboardingWizard />
			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
			<Toaster />
		</TooltipProvider>
	);
}
