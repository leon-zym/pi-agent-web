import type {
	ExtensionUiRequestDto,
	FutureProductSessionEventDto,
	FutureSessionCommandResponseDto,
	FutureSessionSnapshotDto,
	ProductSessionEventDto,
	SessionCommandResponseDto,
	SessionSnapshotDto,
} from "@pi-agent-web/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	ReplayResult,
	SessionCommandResult,
	SessionReplayFrame,
	SessionSupervisorMessage,
} from "../src/session-runtime-types.js";

const serverEpoch = "runtime-types-epoch";
const externalText = {
	type: "external_text",
	ref: {
		type: "content_ref",
		serverEpoch,
		sha256: "a".repeat(64),
		byteLength: 256 * 1024,
		encoding: "utf-8",
	},
} as const;

const futureEvent = {
	type: "message_end",
	message: {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [{ type: "text", text: externalText }],
		isError: false,
		timestamp: 1,
	},
} satisfies FutureProductSessionEventDto;

const futureResponse = {
	type: "response",
	command: "get_messages",
	success: true,
	data: { messages: [futureEvent.message] },
} satisfies FutureSessionCommandResponseDto;

function futureSnapshot(event: SessionReplayFrame<FutureProductSessionEventDto>): FutureSessionSnapshotDto {
	if (event.type !== "event") throw new Error("fixture event expected");
	return {
		type: "session_snapshot",
		snapshotId: "snapshot-a",
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		generation: 1,
		baseSeq: 0,
		asOfSeq: 1,
		runtime: {
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			nativeSessionId: "native-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp/workspace-a",
			generation: 1,
			lastSeq: 1,
			state: "idle",
			lastActivityAt: 1,
			recoverable: true,
		},
		settledMessages: [futureEvent.message],
		projectionEvents: [event],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	};
}

describe("Session Runtime current-defaulted payload carriers", () => {
	it("keeps zero-parameter aliases on the exact protocol 1.2 event, response, and snapshot types", () => {
		type CurrentEvent = Extract<SessionReplayFrame, { type: "event" }>["event"];
		type CurrentResponse = SessionCommandResult["response"];
		type CurrentSnapshot = Extract<ReplayResult, { type: "resync_required" }>["snapshot"];

		expectTypeOf<CurrentEvent>().toEqualTypeOf<ProductSessionEventDto>();
		expectTypeOf<CurrentResponse>().toEqualTypeOf<SessionCommandResponseDto>();
		expectTypeOf<CurrentSnapshot>().toEqualTypeOf<SessionSnapshotDto>();

		const currentFrame: SessionReplayFrame = {
			type: "event",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 1,
			// @ts-expect-error A future external-text event must not enter the default 1.2 carrier.
			event: futureEvent,
		};
		expect(currentFrame.type).toBe("event");
	});

	it("carries future events, responses, replay, and snapshots without widening Extension UI", () => {
		const frame: SessionReplayFrame<FutureProductSessionEventDto> = {
			type: "event",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 1,
			event: futureEvent,
		};
		const snapshot = futureSnapshot(frame);
		const replay: ReplayResult<FutureProductSessionEventDto, FutureSessionSnapshotDto> = {
			type: "resync_required",
			runtime: snapshot.runtime,
			reason: "initial",
			snapshot,
		};
		const command: SessionCommandResult<FutureSessionCommandResponseDto> = {
			serverEpoch,
			sessionHandle: "session-a",
			generation: 1,
			barrierSeq: 1,
			response: futureResponse,
		};
		const supervisor: SessionSupervisorMessage<FutureProductSessionEventDto> = frame;

		type FutureExtension = Extract<
			SessionReplayFrame<FutureProductSessionEventDto>,
			{ type: "extension_ui_request" }
		>["request"];
		expectTypeOf<FutureExtension>().toEqualTypeOf<ExtensionUiRequestDto>();
		expect(supervisor).toBe(frame);
		expect(command.response).toBe(futureResponse);
		expect(replay.snapshot).toBe(snapshot);
	});
});
