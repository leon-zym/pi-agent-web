import type { SessionErrorDto, SessionLeaseStatusDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
	emptySessionControlRecord,
	selectSessionControlStatus,
	useSessionControlStore,
} from "../src/stores/session-control";
import { emptySessionHistoryState, type SessionChannelState } from "../src/stores/session-transport-contract";

function sessionRuntime(state: SessionRuntimeDto["state"] = "running"): SessionRuntimeDto {
	return {
		serverEpoch: "epoch-a",
		workspaceId: "workspace-a",
		sessionHandle: "session-a",
		generation: 1,
		nativeSessionId: "native-a",
		sessionFile: "/tmp/session-a.jsonl",
		cwd: "/tmp/workspace-a",
		lastSeq: 2,
		state,
		lastActivityAt: 0,
		recoverable: true,
	};
}

function channel(overrides: Partial<SessionChannelState> = {}): SessionChannelState {
	return {
		sessionHandle: "session-a",
		subscribed: true,
		controllerIntent: true,
		runtime: sessionRuntime(),
		generation: 1,
		baselineAuthoritative: true,
		freshLeaseBaseline: sessionRuntime(),
		lastSeq: 2,
		projectedSeq: 2,
		lease: {
			isController: false,
			leaseRevision: 4,
			controlState: "held",
			transition: "baseline",
		},
		pendingExtensionRequests: [],
		resync: null,
		recovery: null,
		history: emptySessionHistoryState(),
		rawEvents: [],
		...overrides,
	};
}

function lease(overrides: Partial<SessionLeaseStatusDto> = {}): SessionLeaseStatusDto {
	return {
		type: "lease_status",
		serverEpoch: "epoch-a",
		sessionHandle: "session-a",
		generation: 1,
		leaseRevision: 4,
		controlState: "held",
		transition: "baseline",
		isController: false,
		...overrides,
	};
}

describe("SessionControlStatus", () => {
	beforeEach(() => {
		useSessionControlStore.setState({ bySession: {} });
	});

	it("derives controller, observer takeover, and reconnecting states from one channel snapshot", () => {
		const controller = channel({ lease: { isController: true, fencingToken: "fence-a", leaseRevision: 4 } });
		expect(
			selectSessionControlStatus({
				connectionState: "online",
				channel: controller,
				sessionHandle: "session-a",
			}).mode,
		).toBe("controller");
		expect(
			selectSessionControlStatus({
				connectionState: "online",
				channel: channel({ controllerIntent: false }),
				sessionHandle: "session-a",
			}).canTakeOver,
		).toBe(true);
		expect(
			selectSessionControlStatus({
				connectionState: "offline",
				channel: channel(),
				sessionHandle: "session-a",
			}).mode,
		).toBe("reconnecting");
	});

	it("keeps takeover unavailable for free or dormant Sessions", () => {
		expect(
			selectSessionControlStatus({
				connectionState: "online",
				channel: channel({ lease: { isController: false, leaseRevision: 4, controlState: "free" } }),
				sessionHandle: "session-a",
			}).canTakeOver,
		).toBe(false);
		expect(
			selectSessionControlStatus({
				connectionState: "online",
				channel: channel({
					runtime: sessionRuntime("dormant"),
				}),
				sessionHandle: "session-a",
			}).canTakeOver,
		).toBe(false);
	});

	it("records one revocation notice per authoritative takeover event", () => {
		useSessionControlStore
			.getState()
			.observeLeaseStatus(lease({ isController: true, fencingToken: "fence-a" }), 10);
		useSessionControlStore
			.getState()
			.observeLeaseStatus(lease({ leaseRevision: 5, transition: "takeover", isController: false }), 20);
		const first = useSessionControlStore.getState().bySession["session-a"];
		useSessionControlStore
			.getState()
			.observeLeaseStatus(lease({ leaseRevision: 5, transition: "takeover", isController: false }), 30);
		const repeated = useSessionControlStore.getState().bySession["session-a"];

		expect(first?.notice).toEqual({
			key: "epoch-a:session-a:1:5:takeover:observer",
			receivedAt: 20,
		});
		expect(repeated?.notice).toEqual(first?.notice);
		expect(repeated?.lastLease?.isController).toBe(false);
	});

	it("keeps control errors isolated by Session and clears them on a fresh baseline", () => {
		const error = {
			type: "session_error",
			serverEpoch: "epoch-a",
			sessionHandle: "session-a",
			operation: "takeover",
			error: "session_lease_revision_stale",
			code: "session_lease_revision_stale",
		} satisfies SessionErrorDto;
		useSessionControlStore.getState().recordSessionError(error, 40);
		useSessionControlStore
			.getState()
			.recordSessionError(
				{ ...error, sessionHandle: "session-b", error: "session_takeover_not_available" },
				50,
			);

		expect(useSessionControlStore.getState().bySession["session-a"]?.error?.receivedAt).toBe(40);
		expect(useSessionControlStore.getState().bySession["session-b"]?.error?.receivedAt).toBe(50);

		useSessionControlStore.getState().observeLeaseStatus(lease({ leaseRevision: 4 }), 60);
		expect(useSessionControlStore.getState().bySession["session-a"]?.error).toBeNull();
		expect(useSessionControlStore.getState().bySession["session-b"]?.error?.receivedAt).toBe(50);
	});

	it("provides a stable empty record for presentation-only selectors", () => {
		expect(emptySessionControlRecord()).toEqual({
			takeoverPending: false,
			lastLease: null,
			error: null,
			notice: null,
		});
	});
});
