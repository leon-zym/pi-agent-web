import type { NativeSessionDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import { sessionDeleteCapability } from "../src/lib/session-capabilities";
import { emptySessionHistoryState, type SessionChannelState } from "../src/stores/session-transport";

function runtime(state: SessionRuntimeDto["state"] = "idle", recoverable = true): SessionRuntimeDto {
	return {
		serverEpoch: "test-server-epoch",
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		nativeSessionId: "native-a",
		sessionFile: "/tmp/a.jsonl",
		cwd: "/tmp/workspace",
		generation: 1,
		lastSeq: 0,
		state,
		lastActivityAt: 1,
		recoverable,
	};
}

function session(persisted = true): NativeSessionDto {
	return {
		sessionHandle: "session-a",
		workspaceHandle: "workspace-a",
		nativeSessionId: "native-a",
		sessionFile: persisted ? "/tmp/a.jsonl" : null,
		persisted,
		createdAt: null,
		modifiedAt: null,
		messageCount: 0,
		firstMessage: "",
		runtime: null,
	};
}

function channel(value = runtime()): SessionChannelState {
	return {
		sessionHandle: "session-a",
		subscribed: true,
		controllerIntent: true,
		runtime: value,
		generation: 1,
		baselineAuthoritative: true,
		freshLeaseBaseline: value,
		lastSeq: 0,
		projectedSeq: 0,
		lease: { isController: true, fencingToken: "fence" },
		pendingExtensionRequests: [],
		resync: null,
		recovery: null,
		history: emptySessionHistoryState(),
		rawEvents: [],
	};
}

describe("session deletion capability", () => {
	it("matches the gateway's controlled, persisted, recoverable deletion states", () => {
		expect(sessionDeleteCapability(session(), channel())).toEqual({ allowed: true, reason: null });
		expect(sessionDeleteCapability(session(), channel(runtime("crashed")))).toEqual({
			allowed: true,
			reason: null,
		});
		expect(sessionDeleteCapability(session(), channel(runtime("dormant")))).toEqual({
			allowed: true,
			reason: null,
		});
		expect(sessionDeleteCapability(session(), undefined).reason).toBe("controller_required");
		expect(sessionDeleteCapability(session(false), channel()).reason).toBe("session_unpersisted");
		expect(sessionDeleteCapability(session(), channel(runtime("running"))).reason).toBe("runtime_active");
		expect(
			sessionDeleteCapability(
				session(),
				channel({ ...runtime(), phase: "busy", operationCount: 1, busyReasons: ["command"] }),
			).reason,
		).toBe("runtime_active");
		expect(sessionDeleteCapability(session(), channel(runtime("idle", false))).reason).toBe(
			"runtime_unavailable",
		);
	});
});
