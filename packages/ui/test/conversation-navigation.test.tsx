import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationProjection } from "../src/types/view-models";
import { createEmptyProjection } from "../src/types/view-models";

const storeHarness = vi.hoisted(() => ({
	projection: {
		currentSessionId: null as string | null,
		projections: {} as Record<string, ConversationProjection>,
	},
	directory: {
		currentWorkspaceHandle: null as string | null,
		currentSession: null as null | { sessionHandle: string },
		sessionCreation: null as null | { token: number; workspaceHandle: string },
	},
}));

vi.mock("../src/stores/projection", () => ({
	useProjectionStore: (selector: (state: typeof storeHarness.projection) => unknown) =>
		selector(storeHarness.projection),
}));

vi.mock("../src/stores/session-directory", () => ({
	useSessionDirectoryStore: (selector: (state: typeof storeHarness.directory) => unknown) =>
		selector(storeHarness.directory),
	installSessionDirectoryLifecycleCoordinator: vi.fn(),
}));

import { ChatViewport } from "../src/features/conversation/ChatViewport";

beforeEach(() => {
	storeHarness.projection.currentSessionId = null;
	storeHarness.projection.projections = {};
	storeHarness.directory.currentWorkspaceHandle = null;
	storeHarness.directory.currentSession = null;
	storeHarness.directory.sessionCreation = null;
});

describe("conversation navigation surfaces", () => {
	it("renders a loading skeleton while a selected historical Session has no baseline", () => {
		storeHarness.directory.currentWorkspaceHandle = "workspace-a";
		storeHarness.directory.currentSession = { sessionHandle: "session-hydrating" };
		storeHarness.projection.currentSessionId = "session-hydrating";

		const html = renderToStaticMarkup(createElement(ChatViewport));

		expect(html).toContain('data-conversation-loading="true"');
		expect(html).not.toContain("Start your first turn");
		expect(html).not.toContain("开始你的第一轮对话");
	});

	it("renders the loading skeleton immediately while a new Session is being created", () => {
		storeHarness.directory.currentWorkspaceHandle = "workspace-a";
		storeHarness.directory.sessionCreation = { token: 7, workspaceHandle: "workspace-a" };

		const html = renderToStaticMarkup(createElement(ChatViewport));

		expect(html).toContain('data-conversation-loading="true"');
		expect(html).not.toContain("Select or create a session");
		expect(html).not.toContain("选择或新建一个会话");
	});

	it("shows the first-turn surface only after an empty baseline has been established", () => {
		storeHarness.directory.currentWorkspaceHandle = "workspace-a";
		storeHarness.directory.currentSession = { sessionHandle: "session-hydrating" };
		storeHarness.projection.currentSessionId = "session-hydrating";
		storeHarness.projection.projections = {
			"session-hydrating": createEmptyProjection("session-hydrating"),
		};

		const html = renderToStaticMarkup(createElement(ChatViewport));

		expect(html).not.toContain('data-conversation-loading="true"');
		expect(html).toMatch(/Start your first turn|开始你的第一轮对话/);
	});
});
