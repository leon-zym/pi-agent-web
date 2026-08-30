import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
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
} satisfies ProductSessionEventDto;

const futureResponse = {
	type: "response",
	command: "get_messages",
	success: true,
	data: { messages: [futureEvent.message] },
} satisfies SessionCommandResponseDto;

function futureSnapshot(event: SessionReplayFrame<ProductSessionEventDto>): SessionSnapshotDto {
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

describe("Session Runtime canonical payload carriers", () => {
	it("closes future events, Extension requests, responses, replay, and snapshots independently", () => {
		const frame: SessionReplayFrame<ProductSessionEventDto> = {
			type: "event",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 1,
			event: futureEvent,
		};
		const snapshot = futureSnapshot(frame);
		const replay: ReplayResult<ProductSessionEventDto, SessionSnapshotDto> = {
			type: "resync_required",
			runtime: snapshot.runtime,
			reason: "initial",
			snapshot,
		};
		const command: SessionCommandResult<SessionCommandResponseDto> = {
			serverEpoch,
			sessionHandle: "session-a",
			generation: 1,
			barrierSeq: 1,
			response: futureResponse,
		};
		const extensionFrame: SessionReplayFrame<ProductSessionEventDto, ExtensionUiRequestDto> = {
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
		const supervisor: SessionSupervisorMessage<ProductSessionEventDto> = frame;
		const extensionSupervisor: SessionSupervisorMessage<ProductSessionEventDto, ExtensionUiRequestDto> =
			extensionFrame;

		type CanonicalExtension = Extract<
			SessionReplayFrame<ProductSessionEventDto, ExtensionUiRequestDto>,
			{ type: "extension_ui_request" }
		>["request"];
		type CanonicalExtensionResponse = Parameters<
			SessionRuntimeCore<"content_ref">["sendExtensionUiResponse"]
		>[0];
		expectTypeOf<CanonicalExtension>().toEqualTypeOf<ExtensionUiRequestDto>();
		expectTypeOf<CanonicalExtensionResponse>().toEqualTypeOf<ExtensionUiResponseDto>();
		expect(supervisor).toBe(frame);
		expect(extensionSupervisor).toBe(extensionFrame);
		expect(command.response).toBe(futureResponse);
		expect(replay.snapshot).toBe(snapshot);
	});
});
