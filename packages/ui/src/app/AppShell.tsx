import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationColumn } from "../features/conversation/ConversationColumn";
import { DetailsPanel } from "../features/details/DetailsPanel";
import { WorkspaceSidebar } from "../features/sidebar/WorkspaceSidebar";
import { cn } from "../lib/utils";

const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 280;
const DETAILS_MIN = 300;
const DETAILS_MAX = 520;
const DETAILS_DEFAULT = 360;
const CENTER_MIN = 640;
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
 * details shrinks to 300, then closes (subtree stays mounted), and only then
 * may the center drop below 640. The sidebar never yields; under 1024px it
 * becomes a 56px rail.
 */
export function AppShell() {
	const [widths, setWidths] = useState<StoredWidths>(() => loadWidths());
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	const [detailsOpen, setDetailsOpen] = useState(true);
	const dragging = useRef<"sidebar" | "details" | null>(null);

	useEffect(() => {
		const observer = new ResizeObserver(() => setViewportWidth(window.innerWidth));
		observer.observe(document.body);
		return () => observer.disconnect();
	}, []);

	const persist = useCallback((next: StoredWidths) => {
		setWidths(next);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// ignore
		}
	}, []);

	const rail = viewportWidth < RAIL_BREAKPOINT;
	const sidebarWidth = rail ? 56 : widths.sidebar;

	// Squeeze policy: details yields first, then closes; center is last.
	const availableForCenter = viewportWidth - sidebarWidth - (detailsOpen ? widths.details : 0);
	let detailsWidth = detailsOpen ? widths.details : 0;
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

	const gridColumns = sidebarWidth + "px minmax(0, 1fr) " + detailsWidth + "px";

	return (
		<div
			className="grid h-full select-none overflow-hidden bg-base"
			style={{ gridTemplateColumns: gridColumns }}
		>
			<div className="min-w-0 overflow-hidden border-r border-border bg-sidebar">
				<WorkspaceSidebar rail={rail} />
			</div>

			{!rail && (
				<button
					type="button"
					aria-label="调整侧栏宽度"
					className="relative z-10 -ml-px w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30 active:bg-primary/50 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
					style={{ marginRight: -4 } as React.CSSProperties}
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

			<main className="min-w-0 overflow-hidden">
				<ConversationColumn />
			</main>

			{detailsWidth > 0 && (
				<button
					type="button"
					aria-label="调整详情面板宽度"
					className="relative z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30 active:bg-primary/50 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
					style={{ marginLeft: -4 } as React.CSSProperties}
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

			{/* Details stays mounted at zero width so its subtree state survives. */}
			<div className={cn("min-w-0 border-l border-border bg-base", detailsWidth === 0 && "hidden")}>
				<DetailsPanel open={detailsWidth > 0} onToggle={() => setDetailsOpen((open) => !open)} />
			</div>
		</div>
	);
}
