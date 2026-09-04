import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "../components/ui/skeleton";
import { Toaster } from "../components/ui/toaster";
import { TooltipProvider } from "../components/ui/tooltip";
import { ExtensionDialogs, OnboardingWizard, SettingsDialog } from "../features/extension-ui";
import { api } from "../lib/api";
import { displayError } from "../lib/format";
import { tt } from "../lib/i18n";
import { loadDirectoryAfterStableHotInventory } from "../lib/initial-inventory-bootstrap";
import { ensureInitialSession } from "../lib/session-controller";
import { initPipeline } from "../lib/stream-pipeline";
import { useTheme } from "../lib/use-theme";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { sessionTransport } from "../stores/session-transport";
import { AppShell } from "./AppShell";

function AppBootstrapSkeleton() {
	return (
		<div role="status" aria-label={tt("common.loading")} className="flex h-full overflow-hidden bg-base">
			<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-sidebar p-3">
				<div className="flex h-10 items-center gap-3 px-1">
					<Skeleton className="size-7 rounded-md" />
					<Skeleton className="h-3 w-24 rounded-full" />
				</div>
				<div className="mt-8 space-y-3">
					<Skeleton className="h-8 w-full rounded-md" />
					<Skeleton className="h-8 w-5/6 rounded-md" />
					<Skeleton className="h-8 w-11/12 rounded-md" />
				</div>
			</aside>
			<main className="flex min-w-0 flex-1 flex-col">
				<div className="flex h-14 items-center justify-between border-b border-border px-6">
					<Skeleton className="h-3 w-32 rounded-full" />
					<Skeleton className="h-8 w-20 rounded-md" />
				</div>
				<div className="mx-auto flex w-full max-w-[748px] flex-1 flex-col gap-5 px-6 py-10">
					<Skeleton className="ml-auto h-16 w-2/3 rounded-xl" />
					<Skeleton className="h-3 w-4/5 rounded-full" />
					<Skeleton className="h-3 w-full rounded-full" />
					<Skeleton className="h-3 w-3/5 rounded-full" />
				</div>
			</main>
			<span className="sr-only">{tt("common.loading")}</span>
		</div>
	);
}

export function App() {
	useTheme();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [bootstrapped, setBootstrapped] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void api
			.bootstrap()
			.then(async () => {
				if (cancelled) return;
				initPipeline();
				const ready = await loadDirectoryAfterStableHotInventory({
					waitForInitialHotInventory: sessionTransport.waitForInitialHotInventory,
					loadWorkspaces: () => useSessionDirectoryStore.getState().loadWorkspaces(),
					readTransportState: () => sessionTransport.store.getState(),
					isCancelled: () => cancelled,
				});
				if (!ready) return;
				const directory = useSessionDirectoryStore.getState();
				const workspace = directory.workspaces.find(
					(candidate) => candidate.workspaceHandle === directory.currentWorkspaceHandle,
				);
				if (workspace?.available) void ensureInitialSession();
				setBootstrapped(true);
			})
			.catch((error) => {
				if (cancelled) return;
				toast.error(tt("bootstrap.failed"), {
					description: displayError(error),
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
			{bootstrapped ? <AppShell /> : <AppBootstrapSkeleton />}
			{bootstrapped ? <ExtensionDialogs /> : null}
			{bootstrapped ? <OnboardingWizard /> : null}
			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
			<Toaster />
		</TooltipProvider>
	);
}
