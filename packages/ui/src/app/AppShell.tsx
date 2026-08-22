import { PanelRightOpen } from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MobileSwitcherSheet } from "../components/mobile/MobileSwitcherSheet";
import { MobileTopBar } from "../components/mobile/MobileTopBar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { ConversationColumn } from "../features/conversation/ConversationColumn";
import { DetailsPanel } from "../features/details/DetailsPanel";
import { WorkspaceSidebar } from "../features/sidebar/WorkspaceSidebar";
import { tt } from "../lib/i18n";
import { newSession, openSession } from "../lib/session-controller";
import { cn } from "../lib/utils";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { useSessionTransportStore } from "../stores/session-transport";
import { useViewStore } from "../stores/view";

const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 280;
const DETAILS_MIN = 300;
const DETAILS_MAX = 520;
const DETAILS_DEFAULT = 360;
const CENTER_MIN = 640;
const MOBILE_BREAKPOINT = 768;
const RAIL_BREAKPOINT = 1024;

const STORAGE_KEY = "pi-web-shell-widths";

interface StoredWidths {
	sidebar: number;
	details: number;
}

function loadWidths(): StoredWidths {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<StoredWidths>;
			return {
				sidebar: clamp(parsed.sidebar ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
				details: clamp(parsed.details ?? DETAILS_DEFAULT, DETAILS_MIN, DETAILS_MAX),
			};
		}
	} catch {
		// fall through to defaults
	}
	return { sidebar: SIDEBAR_DEFAULT, details: DETAILS_DEFAULT };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Three-column app shell with the DSH squeeze policy (DESIGN.md):
 * details shrinks to 300, then moves into an overlay, and only then may the
 * center drop below 640. The sidebar can be manually reduced to a 56px rail
 * and does so automatically under 1024px.
 * On <768px viewports, sidebar collapses into MobileTopBar & MobileSwitcherSheet.
 */
export function AppShell() {
	const [widths, setWidths] = useState<StoredWidths>(() => loadWidths());
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [navigationOpen, setNavigationOpen] = useState(false);
	const [mobileSwitcherOpen, setMobileSwitcherOpen] = useState(false);

	const workspaces = useSessionDirectoryStore((s) => s.workspaces);
	const currentWorkspaceHandle = useSessionDirectoryStore((s) => s.currentWorkspaceHandle);
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const sessionsByWorkspace = useSessionDirectoryStore((s) => s.sessionsByWorkspace);
	const currentWorkspace = workspaces.find((w) => w.workspaceHandle === currentWorkspaceHandle);
	const channel = useSessionTransportStore((state) =>
		currentSession ? state.sessions[currentSession.sessionHandle] : undefined,
	);

	const detailsOpen = useViewStore((state) => state.rightPanelOpen);
	const setDetailsOpen = useViewStore((state) => state.setRightPanelOpen);
	const dragging = useRef<"sidebar" | "details" | null>(null);
	const navigationDrawer = useRef<HTMLDivElement>(null);
	const navigationTrigger = useRef<HTMLButtonElement>(null);
	const detailsReturnFocus = useRef<HTMLElement>(null);

	useEffect(() => {
		const observer = new ResizeObserver(() => setViewportWidth(window.innerWidth));
		observer.observe(document.body);
		return () => observer.disconnect();
	}, []);

	// visualViewport adaptation to prevent virtual keyboard shift (DESIGN.md 4.3)
	useEffect(() => {
		if (typeof window === "undefined") return;
		const vv = window.visualViewport;
		if (!vv) return;

		const updateViewport = () => {
			document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
			document.documentElement.style.setProperty("--app-top", `${vv.offsetTop}px`);
		};

		updateViewport();
		vv.addEventListener("resize", updateViewport);
		vv.addEventListener("scroll", updateViewport);
		return () => {
			vv.removeEventListener("resize", updateViewport);
			vv.removeEventListener("scroll", updateViewport);
		};
	}, []);

	const persist = useCallback((next: StoredWidths) => {
		setWidths(next);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// ignore
		}
	}, []);
	const updateNavigationOpen = useCallback((open: boolean) => {
		setNavigationOpen(open);
		if (!open) window.requestAnimationFrame(() => navigationTrigger.current?.focus());
	}, []);
	const updateOverlayDetailsOpen = useCallback(
		(open: boolean) => {
			setDetailsOpen(open);
			if (!open) window.requestAnimationFrame(() => detailsReturnFocus.current?.focus());
		},
		[setDetailsOpen],
	);

	const isMobile = viewportWidth < MOBILE_BREAKPOINT;
	const compact = viewportWidth < RAIL_BREAKPOINT;
	useEffect(() => {
		if (!compact) setNavigationOpen(false);
	}, [compact]);
	const sidebarRail = compact || !sidebarOpen;
	const sidebarWidth = isMobile ? 0 : sidebarRail ? 56 : widths.sidebar;

	const canDockDetails = !isMobile && viewportWidth - sidebarWidth >= CENTER_MIN + DETAILS_MIN;
	// Squeeze policy: details yields first. If it cannot retain its minimum
	// width, it moves into an overlay instead of disappearing.
	const availableForCenter = viewportWidth - sidebarWidth - (detailsOpen ? widths.details : 0);
	let detailsWidth = detailsOpen && canDockDetails ? widths.details : 0;
	if (detailsWidth > 0 && availableForCenter < CENTER_MIN) {
		detailsWidth = Math.max(0, viewportWidth - sidebarWidth - CENTER_MIN);
		if (detailsWidth > 0 && detailsWidth < DETAILS_MIN) detailsWidth = 0;
	}

	const startDrag = (which: "sidebar" | "details") => (event: React.PointerEvent) => {
		dragging.current = which;
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const onDrag = (which: "sidebar" | "details") => (event: React.PointerEvent) => {
		if (dragging.current !== which) return;
		if (which === "sidebar") {
			persist({ ...widths, sidebar: clamp(event.clientX, SIDEBAR_MIN, SIDEBAR_MAX) });
		} else {
			const width = viewportWidth - event.clientX;
			persist({ ...widths, details: clamp(width, DETAILS_MIN, DETAILS_MAX) });
		}
	};

	const endDrag = () => {
		dragging.current = null;
	};

	return (
		<div className="flex h-full overflow-hidden bg-base" style={{ height: "var(--app-height, 100%)" }}>
			{!isMobile && (
				<div
					className="min-w-0 overflow-hidden border-r border-border bg-sidebar"
					style={{ width: sidebarWidth, flexShrink: 0 }}
				>
					<WorkspaceSidebar
						rail={sidebarRail}
						onToggleRail={compact ? undefined : () => setSidebarOpen((open) => !open)}
						onOpenNavigation={compact ? () => updateNavigationOpen(true) : undefined}
						navigationTriggerRef={compact ? navigationTrigger : undefined}
					/>
				</div>
			)}

			{!isMobile && !sidebarRail && (
				<button
					type="button"
					aria-label={tt("appShell.sidebarWidth")}
					className="z-10 w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30 active:bg-primary/50 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
					onPointerDown={startDrag("sidebar")}
					onPointerMove={onDrag("sidebar")}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					onKeyDown={(event) => {
						if (event.key === "ArrowLeft") {
							persist({ ...widths, sidebar: clamp(widths.sidebar - 16, SIDEBAR_MIN, SIDEBAR_MAX) });
						} else if (event.key === "ArrowRight") {
							persist({ ...widths, sidebar: clamp(widths.sidebar + 16, SIDEBAR_MIN, SIDEBAR_MAX) });
						}
					}}
				/>
			)}

			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				{isMobile && (
					<MobileTopBar
						workspace={currentWorkspace}
						session={currentSession}
						status={channel?.runtime?.state ?? "dormant"}
						onOpenSwitcher={() => setMobileSwitcherOpen(true)}
					/>
				)}
				<div className="min-h-0 flex-1 overflow-hidden">
					<ConversationColumn hideHeader={isMobile} />
				</div>
			</main>

			{detailsWidth === 0 && canDockDetails && (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("details.expandPanel")}
							className="flex w-10 shrink-0 items-start justify-center border-l border-border pt-3 text-ink-3 transition-[color,background-color,scale] hover:bg-hover hover:text-ink active:scale-95 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
							onClick={() => setDetailsOpen(true)}
						>
							<PanelRightOpen className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="left">{tt("details.expandPanel")}</TooltipContent>
				</Tooltip>
			)}

			{detailsWidth > 0 && (
				<button
					type="button"
					aria-label={tt("appShell.detailsWidth")}
					className="z-10 w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30 active:bg-primary/50 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
					onPointerDown={startDrag("details")}
					onPointerMove={onDrag("details")}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					onKeyDown={(event) => {
						if (event.key === "ArrowLeft") {
							persist({ ...widths, details: clamp(widths.details + 16, DETAILS_MIN, DETAILS_MAX) });
						} else if (event.key === "ArrowRight") {
							persist({ ...widths, details: clamp(widths.details - 16, DETAILS_MIN, DETAILS_MAX) });
						}
					}}
				/>
			)}

			{/* A docked panel stays mounted at zero width so close/open preserves local state. */}
			{!isMobile && (
				<div
					className={cn(
						"min-w-0 shrink-0 overflow-hidden border-l border-border bg-base",
						detailsWidth === 0 && "hidden",
					)}
					style={{ width: detailsWidth }}
				>
					{canDockDetails && (
						<DetailsPanel open={detailsWidth > 0} onToggle={() => setDetailsOpen(!detailsOpen)} />
					)}
				</div>
			)}

			<Sheet open={!isMobile && compact && navigationOpen} onOpenChange={updateNavigationOpen}>
				<SheetContent
					ref={navigationDrawer}
					side="left"
					showCloseButton={false}
					className="w-[calc(100vw-1rem)] max-w-80 bg-sidebar"
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						navigationDrawer.current?.focus();
					}}
				>
					<SheetTitle className="sr-only">{tt("appShell.sessionsTitle")}</SheetTitle>
					<SheetDescription className="sr-only">{tt("appShell.sessionsDescription")}</SheetDescription>
					<WorkspaceSidebar
						rail={false}
						onRequestClose={() => updateNavigationOpen(false)}
						onSessionSelect={() => updateNavigationOpen(false)}
					/>
				</SheetContent>
			</Sheet>

			<Sheet open={!canDockDetails && detailsOpen} onOpenChange={updateOverlayDetailsOpen}>
				<SheetContent
					side="right"
					showCloseButton={false}
					className="w-[calc(100vw-1rem)] max-w-[420px]"
					onOpenAutoFocus={() => {
						if (document.activeElement instanceof HTMLElement) {
							detailsReturnFocus.current = document.activeElement;
						}
					}}
				>
					<SheetTitle className="sr-only">{tt("appShell.detailsTitle")}</SheetTitle>
					<SheetDescription className="sr-only">{tt("appShell.detailsDescription")}</SheetDescription>
					<DetailsPanel open onToggle={() => updateOverlayDetailsOpen(false)} />
				</SheetContent>
			</Sheet>

			{isMobile && (
				<MobileSwitcherSheet
					open={mobileSwitcherOpen}
					onOpenChange={setMobileSwitcherOpen}
					workspaces={workspaces}
					currentWorkspaceHandle={currentWorkspaceHandle}
					sessionsByWorkspace={sessionsByWorkspace}
					currentSessionHandle={currentSession?.sessionHandle}
					onSelectWorkspace={(handle) => void useSessionDirectoryStore.getState().selectWorkspace(handle)}
					onSelectSession={(session) => void openSession(session)}
					onNewSession={() => void newSession()}
				/>
			)}
		</div>
	);
}
