import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTabBadge, updateTabBadge } from "../src/lib/tab-badge";

describe("tab-badge", () => {
	let mockFaviconLink: any;
	let mockDocument: any;
	let visibilityListeners: Array<() => void> = [];

	beforeEach(() => {
		visibilityListeners = [];
		mockFaviconLink = {
			rel: "icon",
			href: "data:image/svg+xml,<svg></svg>",
		};

		const mockCanvas = {
			width: 32,
			height: 32,
			getContext: vi.fn(() => ({
				clearRect: vi.fn(),
				drawImage: vi.fn(),
				beginPath: vi.fn(),
				arc: vi.fn(),
				fill: vi.fn(),
				fillStyle: "",
			})),
			toDataURL: vi.fn(() => "data:image/png;base64,mockFaviconData"),
		};

		class MockImage {
			crossOrigin = "";
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			private _src = "";
			get src() {
				return this._src;
			}
			set src(val: string) {
				this._src = val;
				setTimeout(() => this.onload?.(), 0);
			}
		}

		mockDocument = {
			title: "Pi Agent Web",
			visibilityState: "hidden",
			addEventListener: vi.fn((event: string, cb: () => void) => {
				if (event === "visibilitychange") visibilityListeners.push(cb);
			}),
			querySelector: vi.fn((selector: string) => {
				if (selector.includes("icon")) return mockFaviconLink;
				return null;
			}),
			createElement: vi.fn((tagName: string) => {
				if (tagName.toLowerCase() === "canvas") {
					return mockCanvas;
				}
				return {};
			}),
		};

		vi.stubGlobal("document", mockDocument);
		vi.stubGlobal("Image", MockImage);
	});

	afterEach(() => {
		clearTabBadge();
		vi.unstubAllGlobals();
	});

	it("updates document.title with status prefix when tab is hidden", () => {
		mockDocument.visibilityState = "hidden";

		updateTabBadge("running", "Pi Agent Web");
		expect(mockDocument.title).toContain("Pi Agent Web");
		expect(mockDocument.title).toContain("[运行中]");

		updateTabBadge("waiting_ui", "My Session");
		expect(mockDocument.title).toContain("My Session");
		expect(mockDocument.title).toContain("[待确认]");

		updateTabBadge("done", "My Session");
		expect(mockDocument.title).toContain("My Session");
		expect(mockDocument.title).toContain("[完成]");
	});

	it("updates favicon badge dot when tab is hidden", async () => {
		mockDocument.visibilityState = "hidden";

		updateTabBadge("running", "Pi Agent Web");
		// Wait for mock image load
		await new Promise((r) => setTimeout(r, 10));
		expect(mockFaviconLink.href).toBe("data:image/png;base64,mockFaviconData");
	});

	it("clears tab badge and restores original title and favicon", () => {
		mockDocument.visibilityState = "hidden";
		updateTabBadge("running", "Custom Title");
		expect(mockDocument.title).toContain("[运行中]");

		clearTabBadge();
		expect(mockDocument.title).not.toContain("[运行中]");
	});

	it("does not update title when tab is visible and status is idle", () => {
		mockDocument.visibilityState = "visible";
		updateTabBadge("idle", "Pi Agent Web");
		expect(mockDocument.title).toBe("Pi Agent Web");
	});
});
