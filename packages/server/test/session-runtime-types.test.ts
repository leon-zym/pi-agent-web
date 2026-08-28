import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	FutureExtensionUiRequestDto,
	FutureProductSessionEventDto,
	FutureSessionCommandResponseDto,
	FutureSessionSnapshotDto,
	ProductSessionEventDto,
	SessionCommandResponseDto,
	SessionSnapshotDto,
} from "@pi-agent-web/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { SessionRuntimeCore } from "../src/session-runtime.js";
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
		type CurrentExtension = Extract<SessionReplayFrame, { type: "extension_ui_request" }>["request"];
		type CurrentResponse = SessionCommandResult["response"];
		type CurrentSnapshot = Extract<ReplayResult, { type: "resync_required" }>["snapshot"];

		expectTypeOf<CurrentEvent>().toEqualTypeOf<ProductSessionEventDto>();
		expectTypeOf<CurrentExtension>().toEqualTypeOf<ExtensionUiRequestDto>();
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
		const currentExtensionFrame: SessionReplayFrame = {
			type: "extension_ui_request",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 2,
			request: {
				type: "extension_ui_request",
				id: "future-editor",
				method: "editor",
				title: "Edit",
				// @ts-expect-error A future external-text request must not enter the default 1.2 carrier.
				prefill: externalText,
			},
		};
		expect(currentFrame.type).toBe("event");
		expect(currentExtensionFrame.type).toBe("extension_ui_request");
	});

	it("closes future events, Extension requests, responses, replay, and snapshots independently", () => {
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
		const extensionFrame: SessionReplayFrame<FutureProductSessionEventDto, FutureExtensionUiRequestDto> = {
			type: "extension_ui_request",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 2,
			request: {
				type: "extension_ui_request",
				id: "future-editor",
				method: "editor",
				title: "Edit",
				prefill: externalText,
			},
		};
		const supervisor: SessionSupervisorMessage<FutureProductSessionEventDto> = frame;
		const extensionSupervisor: SessionSupervisorMessage<
			FutureProductSessionEventDto,
			FutureExtensionUiRequestDto
		> = extensionFrame;

		type FutureExtension = Extract<
			SessionReplayFrame<FutureProductSessionEventDto, FutureExtensionUiRequestDto>,
			{ type: "extension_ui_request" }
		>["request"];
		type FutureExtensionResponse = Parameters<
			SessionRuntimeCore<"future_content">["sendExtensionUiResponse"]
		>[0];
		expectTypeOf<FutureExtension>().toEqualTypeOf<FutureExtensionUiRequestDto>();
		expectTypeOf<FutureExtensionResponse>().toEqualTypeOf<ExtensionUiResponseDto>();
		expect(supervisor).toBe(frame);
		expect(extensionSupervisor).toBe(extensionFrame);
		expect(command.response).toBe(futureResponse);
		expect(replay.snapshot).toBe(snapshot);
	});
});
