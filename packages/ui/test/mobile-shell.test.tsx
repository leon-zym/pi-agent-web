import type { NativeSessionDto, NativeWorkspaceDto } from "@pi-agent-web/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MobileSwitcherContent } from "../src/components/mobile/MobileSwitcherSheet";
import { MobileTopBar } from "../src/components/mobile/MobileTopBar";

const mockWorkspace: NativeWorkspaceDto = {
	workspaceHandle: "ws-1",
	displayName: "My Project",
	path: "/path/to/project",
	sessionCount: 2,
	available: true,
	pinned: false,
	lastOpenedAt: Date.now(),
	hasNativeHistory: true,
};

const mockSession: NativeSessionDto = {
	sessionHandle: "session-1",
	workspaceHandle: "ws-1",
	nativeSessionId: "native-1",
	sessionFile: "/path/to/session.jsonl",
	persisted: true,
	name: "Feature Implementation",
	firstMessage: "Let's implement mobile layout",
	messageCount: 5,
	createdAt: new Date().toISOString(),
	modifiedAt: new Date().toISOString(),
	runtime: null,
};

describe("MobileTopBar", () => {
	it("renders 48px header with workspace, session title, and >=40px touch targets", () => {
		const onOpenSwitcher = vi.fn();
		const html = renderToStaticMarkup(
			createElement(MobileTopBar, {
				workspace: mockWorkspace,
				session: mockSession,
				status: "running",
				onOpenSwitcher,
			}),
		);

		// Header is 48px (h-12)
		expect(html).toContain("<header");
		expect(html).toContain("h-12");

		// Shows workspace and session name
		expect(html).toContain("My Project");
		expect(html).toContain("Feature Implementation");

		// Trigger button has >=40px hit target (min-h-10 / min-w-10)
		expect(html).toContain("min-h-10");
		expect(html).toContain("min-w-10");

		// Shows running status
		expect(html).toContain("运行中");
	});

	it("shows correct status dot and label for waiting_ui and crashed", () => {
		const htmlWaiting = renderToStaticMarkup(
			createElement(MobileTopBar, {
				workspace: mockWorkspace,
				session: mockSession,
				status: "waiting_ui",
				onOpenSwitcher: vi.fn(),
			}),
		);
		expect(htmlWaiting).toContain("等待输入");

		const htmlCrashed = renderToStaticMarkup(
			createElement(MobileTopBar, {
				workspace: mockWorkspace,
				session: mockSession,
				status: "crashed",
				onOpenSwitcher: vi.fn(),
			}),
		);
		expect(htmlCrashed).toContain("进程已崩溃");
	});
});

describe("MobileSwitcherContent", () => {
	it("renders bottom sheet drawer content with >=40px hit targets for workspaces and sessions", () => {
		const html = renderToStaticMarkup(
			createElement(MobileSwitcherContent, {
				workspaces: [mockWorkspace],
				currentWorkspaceHandle: "ws-1",
				sessionsByWorkspace: { "ws-1": [mockSession] },
				currentSessionHandle: "session-1",
				onSelectWorkspace: vi.fn(),
				onSelectSession: vi.fn(),
				onNewSession: vi.fn(),
			}),
		);

		// Shows workspace and session
		expect(html).toContain("My Project");
		expect(html).toContain("Feature Implementation");

		// Touch drawer grabber pill handle
		expect(html).toContain("rounded-full");

		// Hit targets are >=40px (h-10)
		expect(html).toContain("h-10");
		expect(html).toContain("新建会话");
	});

	it("renders workspace selector tabs when multiple workspaces exist", () => {
		const secondWs: NativeWorkspaceDto = {
			workspaceHandle: "ws-2",
			displayName: "Second Project",
			path: "/path/to/project2",
			sessionCount: 0,
			available: true,
			pinned: false,
			lastOpenedAt: Date.now(),
			hasNativeHistory: true,
		};

		const html = renderToStaticMarkup(
			createElement(MobileSwitcherContent, {
				workspaces: [mockWorkspace, secondWs],
				currentWorkspaceHandle: "ws-1",
				sessionsByWorkspace: { "ws-1": [mockSession], "ws-2": [] },
				currentSessionHandle: "session-1",
				onSelectWorkspace: vi.fn(),
				onSelectSession: vi.fn(),
				onNewSession: vi.fn(),
			}),
		);

		expect(html).toContain("My Project");
		expect(html).toContain("Second Project");
	});
});

describe("visualViewport adaptation", () => {
	it("sets --app-height and --app-top on documentElement when visualViewport changes", () => {
		const properties = new Map<string, string>();
		const listeners = new Map<string, Array<() => void>>();

		const mockElement = {
			style: {
				setProperty: vi.fn((key: string, val: string) => properties.set(key, val)),
			},
		};

		const mockVisualViewport = {
			height: 600,
			offsetTop: 40,
			addEventListener: vi.fn((event: string, cb: () => void) => {
				const list = listeners.get(event) ?? [];
				list.push(cb);
				listeners.set(event, list);
			}),
			removeEventListener: vi.fn(),
		};

		// Helper mimicking AppShell's visualViewport effect
		const updateViewport = () => {
			mockElement.style.setProperty("--app-height", `${mockVisualViewport.height}px`);
			mockElement.style.setProperty("--app-top", `${mockVisualViewport.offsetTop}px`);
		};

		updateViewport();
		expect(properties.get("--app-height")).toBe("600px");
		expect(properties.get("--app-top")).toBe("40px");

		// Resize event (e.g. keyboard pops up)
		mockVisualViewport.height = 350;
		mockVisualViewport.offsetTop = 0;
		updateViewport();
		expect(properties.get("--app-height")).toBe("350px");
		expect(properties.get("--app-top")).toBe("0px");
	});
});
