/**
 * Background tab badge & title indicator (DESIGN.md 8.3).
 * Updates document.title and draws a status indicator dot on the favicon canvas when the tab is hidden.
 */

import { tt } from "./i18n";

export type TabStatus = "running" | "waiting_ui" | "idle" | "done";

let originalTitle: string | null = null;
let originalFaviconHref: string | null = null;
let lastStatus: TabStatus = "idle";
let lastBaseTitle: string | null = null;
let listenerAttached = false;

function statusPrefix(status: TabStatus): string {
	switch (status) {
		case "running":
			return tt("tab.running");
		case "waiting_ui":
			return tt("tab.waitingUi");
		case "done":
			return tt("tab.done");
		default:
			return "";
	}
}

function statusColor(status: TabStatus): string {
	switch (status) {
		case "running":
			return "rgb(65, 118, 230)"; // var(--color-primary)
		case "waiting_ui":
			return "rgb(217, 119, 6)"; // var(--color-warning)
		case "done":
			return "rgb(22, 163, 74)"; // var(--color-success)
		default:
			return "transparent";
	}
}

function getFaviconLink(): HTMLLinkElement | null {
	if (typeof document === "undefined") return null;
	return (
		document.querySelector<HTMLLinkElement>("link[rel*='icon']") ||
		document.querySelector<HTMLLinkElement>("link[rel='shortcut icon']")
	);
}

function renderFaviconDot(color: string): void {
	if (typeof document === "undefined") return;
	const link = getFaviconLink();
	if (!link) return;

	if (originalFaviconHref === null) {
		originalFaviconHref = link.href;
	}

	try {
		const canvas = document.createElement("canvas");
		canvas.width = 32;
		canvas.height = 32;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => {
			ctx.clearRect(0, 0, 32, 32);
			ctx.drawImage(img, 0, 0, 32, 32);

			// Draw notification dot in top right
			ctx.beginPath();
			ctx.arc(24, 8, 6, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			link.href = canvas.toDataURL("image/png");
		};
		img.onerror = () => {
			// Fallback: draw circular icon with dot if base image fails to load
			ctx.clearRect(0, 0, 32, 32);
			ctx.beginPath();
			ctx.arc(16, 16, 14, 0, 2 * Math.PI);
			ctx.fillStyle = "rgb(15, 17, 21)";
			ctx.fill();

			ctx.beginPath();
			ctx.arc(24, 8, 6, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			link.href = canvas.toDataURL("image/png");
		};
		img.src = originalFaviconHref || link.href;
	} catch {
		// Suppress canvas errors in restrictive environments
	}
}

function restoreFavicon(): void {
	if (typeof document === "undefined") return;
	if (originalFaviconHref !== null) {
		const link = getFaviconLink();
		if (link) {
			link.href = originalFaviconHref;
		}
		originalFaviconHref = null;
	}
}

function ensureVisibilityListener(): void {
	if (listenerAttached || typeof document === "undefined") return;
	listenerAttached = true;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			clearTabBadge();
		} else if (lastStatus !== "idle") {
			updateTabBadge(lastStatus, lastBaseTitle ?? undefined);
		}
	});
}

/**
 * Update document title and favicon badge according to Session lifecycle status.
 */
export function updateTabBadge(status: TabStatus, baseTitle?: string): void {
	if (typeof document === "undefined") return;
	ensureVisibilityListener();

	lastStatus = status;
	if (baseTitle !== undefined) {
		lastBaseTitle = baseTitle;
	}

	if (originalTitle === null) {
		originalTitle = document.title;
	}

	const rawTitle = baseTitle ?? originalTitle ?? "Pi Agent Web";

	if (document.visibilityState === "hidden" && status !== "idle") {
		const prefix = statusPrefix(status);
		document.title = prefix ? `${prefix} ${rawTitle}` : rawTitle;
		renderFaviconDot(statusColor(status));
	} else if (status === "idle") {
		clearTabBadge();
	}
}

/**
 * Clear status indicator from document title and restore original favicon.
 */
export function clearTabBadge(): void {
	if (typeof document === "undefined") return;
	restoreFavicon();
	if (originalTitle !== null) {
		document.title = lastBaseTitle ?? originalTitle;
	}
}
