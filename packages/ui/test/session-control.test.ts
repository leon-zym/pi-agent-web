import { describe, expect, it } from "vitest";
import { useSessionControlStore } from "../src/stores/session-control";
import { emitServerFrame } from "../src/stores/transport";

describe("session controller lease", () => {
	it("tracks the current workspace lease and authoritative session epoch", () => {
		useSessionControlStore.getState().selectWorkspace("workspace-a");
		emitServerFrame({ type: "lease_status", workspaceId: "workspace-a", isController: true });
		emitServerFrame({
			type: "session_state",
			workspaceId: "workspace-a",
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			epoch: 4,
		});

		expect(useSessionControlStore.getState().canControl("workspace-a")).toBe(true);
		expect(useSessionControlStore.getState().session).toEqual({
			id: "session-a",
			file: "/tmp/session-a.jsonl",
			epoch: 4,
		});

		emitServerFrame({ type: "lease_status", workspaceId: "workspace-a", isController: false });
		expect(useSessionControlStore.getState().canControl("workspace-a")).toBe(false);
	});
});
