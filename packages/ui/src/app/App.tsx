import { useEffect, useState } from "react";
import { Toaster } from "../components/ui/toaster";
import { TooltipProvider } from "../components/ui/tooltip";
import { ExtensionDialogs, OnboardingWizard, SettingsDialog } from "../features/extension-ui";
import { initPipeline } from "../lib/stream-pipeline";
import { useTheme } from "../lib/use-theme";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { AppShell } from "./AppShell";

export function App() {
	useTheme();
	const [settingsOpen, setSettingsOpen] = useState(false);

	useEffect(() => {
		initPipeline();
		void useSessionDirectoryStore.getState().loadWorkspaces();
		const openSettings = () => setSettingsOpen(true);
		window.addEventListener("piweb:open-settings", openSettings);
		return () => window.removeEventListener("piweb:open-settings", openSettings);
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
