import type { NativeSessionDto, NativeWorkspaceDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/stores/session-directory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/stores/session-directory")>();
	function liveSelector<T>(
		selector: (state: ReturnType<typeof actual.useSessionDirectoryStore.getState>) => T,
	): T {
		return selector(actual.useSessionDirectoryStore.getState());
	}
	const liveStore = Object.assign(liveSelector, actual.useSessionDirectoryStore);
	return { ...actual, useSessionDirectoryStore: liveStore };
});

import { WorkspaceSidebar } from "../src/features/sidebar/WorkspaceSidebar";
import { useSessionDirectoryStore } from "../src/stores/session-directory";

const originalDirectory = useSessionDirectoryStore.getState();

function runtime(
	sessionHandle: string,
	workspaceHandle = "workspace-a",
	recoverable = false,
): SessionRuntimeDto {
	return {
		serverEpoch: "epoch-sidebar",
		sessionHandle,
		workspaceId: workspaceHandle,
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: recoverable ? `/tmp/${sessionHandle}.jsonl` : null,
		cwd: `/tmp/${workspaceHandle}`,
		generation: 1,
		lastSeq: 3,
		state: "running",
		lastActivityAt: 1,
		recoverable,
	};
}

function session(
	sessionHandle: string,
	firstMessage: string,
	persisted: boolean,
	workspaceHandle = "workspace-a",
): NativeSessionDto {
	return {
		sessionHandle,
		workspaceHandle,
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: persisted ? `/tmp/${sessionHandle}.jsonl` : null,
		persisted,
		createdAt: null,
		modifiedAt: null,
		messageCount: persisted ? 1 : 0,
		firstMessage,
		runtime: runtime(sessionHandle, workspaceHandle, persisted),
	};
}

afterEach(() => {
	useSessionDirectoryStore.setState(originalDirectory, true);
});

describe("WorkspaceSidebar hot runtime overlay", () => {
	it("renders every hot-only Session beside durable history in the normal workspace tree", () => {
		const workspace: NativeWorkspaceDto = {
			workspaceHandle: "workspace-a",
			path: "/tmp/workspace-a",
			available: true,
			pinned: false,
			displayName: "Workspace A",
			lastOpenedAt: null,
			sessionCount: 1,
			hasNativeHistory: true,
		};
		const durable = session("durable", "Durable history", true);
		const hotA = session("hot-a", "Recovered hot A", false);
		const hotB = session("hot-b", "Recovered hot B", false);
		useSessionDirectoryStore.setState({
			workspaces: [workspace],
			currentWorkspaceHandle: workspace.workspaceHandle,
			currentSession: durable,
			sessionsByWorkspace: { [workspace.workspaceHandle]: [durable] },
			hotSessionsByWorkspace: { [workspace.workspaceHandle]: [hotA, hotB] },
			hotRuntimeStateBySession: { "hot-a": "running", "hot-b": "running" },
			searchQuery: "",
		});
		const html = renderToStaticMarkup(createElement(WorkspaceSidebar, { rail: false }));

		expect(html).toContain("Durable history");
		expect(html).toContain("Recovered hot A");
		expect(html).toContain("Recovered hot B");
		expect(html).toMatch(/Workspace A<\/span><span[^>]*>3<\/span>/);
	});

	it("keeps unloaded durable totals while only adding definitely unpersisted hot Sessions", () => {
		const transientWorkspace: NativeWorkspaceDto = {
			workspaceHandle: "workspace-transient",
			path: "/tmp/workspace-transient",
			available: true,
			pinned: false,
			displayName: "Unloaded transient workspace",
			lastOpenedAt: null,
			sessionCount: 10,
			hasNativeHistory: true,
		};
		const persistedWorkspace: NativeWorkspaceDto = {
			...transientWorkspace,
			workspaceHandle: "workspace-persisted",
			path: "/tmp/workspace-persisted",
			displayName: "Unloaded persisted workspace",
		};
		const transientHot = session(
			"hot-transient",
			"Unpersisted hot",
			false,
			transientWorkspace.workspaceHandle,
		);
		const persistedHot = session("hot-persisted", "Persisted hot", true, persistedWorkspace.workspaceHandle);
		useSessionDirectoryStore.setState({
			workspaces: [transientWorkspace, persistedWorkspace],
			currentWorkspaceHandle: null,
			currentSession: null,
			sessionsByWorkspace: {},
			hotSessionsByWorkspace: {
				[transientWorkspace.workspaceHandle]: [transientHot],
				[persistedWorkspace.workspaceHandle]: [persistedHot],
			},
			hotRuntimeStateBySession: { "hot-transient": "running", "hot-persisted": "running" },
			searchQuery: "",
		});
		const html = renderToStaticMarkup(createElement(WorkspaceSidebar, { rail: false }));

		expect(html).toMatch(/Unloaded transient workspace<\/span><span[^>]*>11<\/span>/);
		expect(html).toMatch(/Unloaded persisted workspace<\/span><span[^>]*>10<\/span>/);
	});
});
