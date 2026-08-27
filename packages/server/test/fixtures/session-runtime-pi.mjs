import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
	process.stdout.write("0.84.2\n");
	process.exit(0);
}

const lifecycleMarker = process.env.PI_WEB_FIXTURE_LIFECYCLE_MARKER;
if (lifecycleMarker) {
	fs.appendFileSync(lifecycleMarker, `start:${process.pid}\n`);
}
if (process.env.PI_WEB_FIXTURE_IGNORE_TERM === "1") {
	process.on("SIGTERM", () => {
		if (lifecycleMarker) fs.appendFileSync(lifecycleMarker, `term:${process.pid}\n`);
	});
}

function argument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedFile = argument("--session");
const requestedId = argument("--session-id");
const requestedDir = argument("--session-dir");
const checkpointDir = process.env.PI_WEB_FIXTURE_CHECKPOINT_DIR;

let sessionFile;
let sessionId;
const messages = [];
let failNextState = false;
let delayNextTransitionState = false;
let pendingBash;
let pendingBashTimer;
let startupFloodSent = false;
let initialStateRequest = true;
let getMessagesRequestCount = 0;
let transitionPayloadPostPending = false;
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

if (process.env.PI_WEB_FIXTURE_AGGREGATE_SNAPSHOT_ITEMS === "1") {
	for (let index = 0; index < 6; index += 1) {
		messages.push({
			role: "toolResult",
			toolCallId: `aggregate-${String(index)}`,
			toolName: "fixture",
			content: [{ type: "text", text: "aggregate" }],
			details: Array.from({ length: 5 }, () => Array.from({ length: 9_000 }, () => false)),
			isError: false,
			timestamp: Date.now(),
		});
	}
}
if (process.env.PI_WEB_FIXTURE_LARGE_SETTLED_BASE === "1") {
	messages.push(assistantMessage("b".repeat(512 * 1024)));
}

function state() {
	return {
		sessionId,
		sessionFile,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		autoCompactionEnabled: true,
		messageCount: messages.length,
		pendingMessageCount: 0,
	};
}

function assistantMessage(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

if (requestedFile) {
	sessionFile = path.resolve(requestedFile);
	const firstLine = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0];
	const header = JSON.parse(firstLine);
	sessionId = header.id;
} else {
	sessionId = process.env.PI_WEB_FIXTURE_READY_ID ?? requestedId ?? "fixture-new";
	const sessionDir = path.resolve(requestedDir ?? process.cwd());
	sessionFile = path.join(sessionDir, `2026-08-20T00-00-00-000Z_${sessionId}.jsonl`);
}

if (process.env.PI_WEB_FIXTURE_OPEN_MARKER) {
	fs.writeFileSync(process.env.PI_WEB_FIXTURE_OPEN_MARKER, `${process.pid}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) return;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line) handleLine(line);
	}
});

function send(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function response(command, data) {
	send({
		type: "response",
		id: command.id,
		command: command.type,
		success: true,
		...(data === undefined ? {} : { data }),
	});
}

function errorResponse(command, error) {
	send({
		type: "response",
		id: command.id,
		command: command.type,
		success: false,
		error,
	});
}

function ensurePersisted() {
	if (fs.existsSync(sessionFile)) return;
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: "2026-08-20T00:00:00.000Z",
			cwd: process.cwd(),
		})}\n`,
	);
}

function configuredBytes(name) {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.min(value, 2 * 1024 * 1024) : 0;
}

function configuredCount(name) {
	const value = Number(process.env[name]);
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 512) : 0;
}

function sendStartupExtensionState() {
	const stickyCount = configuredCount("PI_WEB_FIXTURE_STICKY_COUNT");
	for (let index = 0; index < stickyCount; index += 1) {
		send({
			type: "extension_ui_request",
			id: `sticky-${String(index)}`,
			method: "setStatus",
			statusKey: `status-${String(index)}`,
			statusText: `value-${String(index)}`,
		});
	}
	if (process.env.PI_WEB_FIXTURE_CLEAR_FIRST_STICKY === "1" && stickyCount > 0) {
		send({
			type: "extension_ui_request",
			id: "sticky-clear",
			method: "setStatus",
			statusKey: "status-0",
			statusText: undefined,
		});
	}
	const replacementBytes = configuredBytes("PI_WEB_FIXTURE_STICKY_REPLACEMENT_BYTES");
	if (replacementBytes > 0) {
		send({
			type: "extension_ui_request",
			id: "sticky-replacement-small",
			method: "setStatus",
			statusKey: "replacement",
			statusText: "small",
		});
		send({
			type: "extension_ui_request",
			id: "sticky-replacement-large",
			method: "setStatus",
			statusKey: "replacement",
			statusText: "x".repeat(replacementBytes),
		});
	}
	const dialogCount = configuredCount("PI_WEB_FIXTURE_DIALOG_COUNT");
	for (let index = 0; index < dialogCount; index += 1) {
		send({
			type: "extension_ui_request",
			id: `startup-dialog-${String(index)}`,
			method: "confirm",
			title: "Confirm",
			message: `dialog-${String(index)}`,
		});
	}
}

function sendStartupProjectionDomains() {
	if (process.env.PI_WEB_FIXTURE_STARTUP_PROJECTION_DOMAINS !== "1") return;
	send({ type: "agent_start" });
	send({
		type: "message_update",
		usage,
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "startup-plan" },
	});
	send({
		type: "message_update",
		usage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "startup-text" },
	});
	send({
		type: "tool_execution_start",
		toolCallId: "startup-tool",
		toolName: "read",
		args: { path: "README.md" },
	});
	send({
		type: "tool_execution_update",
		toolCallId: "startup-tool",
		toolName: "read",
		args: { path: "README.md" },
		partialResult: { text: "partial" },
	});
	send({
		type: "extension_ui_request",
		id: "startup-domain-dialog",
		method: "confirm",
		title: "Confirm",
		message: "startup-domain-dialog",
	});
}

function sendLargeExtensionRequest(id, bytes) {
	if (bytes <= 0) return;
	send({
		type: "extension_ui_request",
		id,
		method: "notify",
		message: "x".repeat(bytes),
		notifyType: "info",
	});
}

function checkpointReleaseFile(stage) {
	if (!checkpointDir) return undefined;
	return path.join(checkpointDir, `${sessionId}-${stage}.release`);
}

function afterCheckpointRelease(stage, callback) {
	const releaseFile = checkpointReleaseFile(stage);
	if (!releaseFile) {
		setTimeout(callback, 250);
		return;
	}
	const poll = () => {
		if (fs.existsSync(releaseFile)) {
			callback();
			return;
		}
		setTimeout(poll, 5);
	};
	poll();
}

function streamSnapshotCheckpoint(command, stage) {
	const stages = ["thinking", "text", "tool", "dialog"];
	const stageIndex = stages.indexOf(stage);
	if (stageIndex === -1) {
		errorResponse(command, "unknown snapshot checkpoint");
		return;
	}
	const toolCallId = `checkpoint-tool-${sessionId}`;
	const toolArgs = { path: "checkpoint.txt" };
	send({ type: "agent_start" });
	response(command);
	send({
		type: "message_update",
		usage,
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "checkpoint-thinking",
		},
	});
	if (stageIndex >= 1) {
		send({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "checkpoint-text" },
		});
	}
	if (stageIndex >= 2) {
		send({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 },
		});
		send({
			type: "message_update",
			usage,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 2,
				delta: JSON.stringify(toolArgs),
			},
		});
		send({
			type: "message_update",
			usage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: toolCallId, name: "read", arguments: toolArgs },
			},
		});
		send({ type: "tool_execution_start", toolCallId, toolName: "read", args: toolArgs });
		send({
			type: "tool_execution_update",
			toolCallId,
			toolName: "read",
			args: toolArgs,
			partialResult: { text: "checkpoint-tool-partial" },
		});
	}
	if (stageIndex >= 3) {
		send({
			type: "extension_ui_request",
			id: `checkpoint-dialog-${sessionId}`,
			method: "confirm",
			title: "Checkpoint dialog",
			message: "checkpoint-dialog",
		});
	}
	afterCheckpointRelease(stage, () => {
		if (stageIndex >= 2) {
			send({
				type: "tool_execution_end",
				toolCallId,
				toolName: "read",
				result: { content: "checkpoint-tool-complete" },
				isError: false,
			});
		}
		send({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "-released" },
		});
		messages.push(assistantMessage(`checkpoint-${stage}-settled`));
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
	});
}

function streamPrompt(command) {
	const text = command.message;
	if (process.env.PI_WEB_FIXTURE_PROMPT_MARKER) {
		fs.appendFileSync(process.env.PI_WEB_FIXTURE_PROMPT_MARKER, `${String(text)}\n`);
	}
	messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	if (process.env.PI_WEB_FIXTURE_SKIP_PROMPT_PERSIST !== "1") ensurePersisted();
	if (typeof text === "string" && text.startsWith("snapshot-checkpoint:")) {
		streamSnapshotCheckpoint(command, text.slice("snapshot-checkpoint:".length));
		return;
	}
	if (text === "protocol-incompatible") {
		response(command);
		send({ type: "queue_update", steering: "malformed", followUp: [] });
		return;
	}
	if (text === "open-dialog-no-agent" || text === "open-dialog-timeout" || text === "open-dialog-crash") {
		send({
			type: "extension_ui_request",
			id: `dialog-${sessionId}`,
			method: "confirm",
			title: "Confirm",
			message: sessionId,
			...(text === "open-dialog-timeout" ? { timeout: 80 } : {}),
		});
		response(command);
		if (text === "open-dialog-crash") setTimeout(() => process.exit(29), 20);
		return;
	}
	if (text === "response-first") {
		response(command);
		setTimeout(() => send({ type: "agent_start" }), 75);
		setTimeout(() => {
			send({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: sessionId },
			});
			send({ type: "agent_settled" });
		}, 100);
		return;
	}
	send({ type: "agent_start" });
	response(command);
	if (text === "notify-then-event") {
		send({
			type: "extension_ui_request",
			id: `notify-${sessionId}`,
			method: "notify",
			message: "transient-notify",
			notifyType: "info",
		});
		send({ type: "turn_start" });
		messages.push(assistantMessage("notify-settled"));
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
		return;
	}
	if (text === "small-structural-turn") {
		send({ type: "turn_start" });
		messages.push(assistantMessage("small-structural-turn"));
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
		return;
	}
	if (typeof text === "string" && text.startsWith("structural-count:")) {
		const count = Number(text.slice("structural-count:".length));
		for (let index = 0; index < count; index += 1) send({ type: "turn_start" });
		messages.push(assistantMessage(text));
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
		return;
	}
	if (typeof text === "string" && text.startsWith("byte-turn:")) {
		const count = Number(text.slice("byte-turn:".length));
		for (let index = 0; index < count; index += 1) {
			send({
				type: "message_update",
				usage,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: index,
					delta: "x".repeat(512 * 1024),
				},
			});
		}
		messages.push(assistantMessage(text));
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
		return;
	}
	if (text === "live-aggregate-overflow") {
		send({
			type: "extension_ui_request",
			id: `aggregate-dialog-${sessionId}`,
			method: "confirm",
			title: "Aggregate overflow",
			message: "must be synchronously cleared",
			timeout: 300,
		});
		for (let index = 0; index < 6; index += 1) {
			send({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: `live-aggregate-${String(index)}`,
					toolName: "fixture",
					content: [{ type: "text", text: "aggregate" }],
					details: Array.from({ length: 5 }, () => Array.from({ length: 9_000 }, () => false)),
					isError: false,
					timestamp: Date.now(),
				},
			});
		}
		return;
	}
	if (text === "large-events") {
		const bytes = configuredBytes("PI_WEB_FIXTURE_EVENT_BYTES") || 512;
		for (let index = 0; index < 6; index += 1) {
			const payload = `${String(index)}:${"x".repeat(bytes)}`;
			send({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: payload },
			});
		}
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
		return;
	}
	if (text === "structural-burst") {
		for (let index = 0; index < 900; index += 1) send({ type: "turn_start" });
		messages.push(assistantMessage(`structural-burst-${String(messages.length)}`));
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
		return;
	}
	if (text === "overflow-once") {
		const marker = process.env.PI_WEB_FIXTURE_OVERFLOW_MARKER;
		if (marker && !fs.existsSync(marker)) {
			fs.writeFileSync(marker, "overflowed\n");
			for (let index = 0; index < 12; index += 1) send({ type: "turn_start" });
			return;
		}
	}
	if (text === "open-dialog") {
		send({
			type: "extension_ui_request",
			id: `dialog-${sessionId}`,
			method: "confirm",
			title: "Confirm",
			message: sessionId,
		});
		return;
	}
	if (text === "crash-once") {
		const marker = process.env.PI_WEB_FIXTURE_CRASH_MARKER;
		if (marker && !fs.existsSync(marker)) {
			fs.writeFileSync(marker, "crashed\n");
			setTimeout(() => process.exit(17), 5);
			return;
		}
	}
	const delay = text === "slow" ? 250 : 10;
	setTimeout(() => {
		send({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: sessionId },
		});
	}, delay);
	setTimeout(() => {
		messages.push(assistantMessage(sessionId));
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled" });
	}, delay + 10);
}

function transition(command) {
	if (process.env.PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS === "1") {
		send({
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "transition-staged-ref" }],
				timestamp: Date.now(),
			},
		});
		if (process.env.PI_WEB_FIXTURE_TRANSITION_PAYLOAD_PARTIAL === "1") {
			send({
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "transition-staged-invalid-ref" }],
					timestamp: Date.now(),
				},
			});
		}
	}
	if (process.env.PI_WEB_FIXTURE_CANCEL_TRANSITION === "1") {
		if (process.env.PI_WEB_FIXTURE_TRANSITION_STICKY === "1") {
			send({
				type: "extension_ui_request",
				id: `status-${sessionId}`,
				method: "setStatus",
				statusKey: "transition",
				statusText: "cancelled",
			});
		}
		response(command, { cancelled: true });
		return;
	}
	if (process.env.PI_WEB_FIXTURE_TRANSITION_SAME_IDENTITY === "1") {
		response(command, command.type === "fork" ? { text: "forked", cancelled: false } : { cancelled: false });
		return;
	}
	const previousFile = sessionFile;
	sessionId = `${sessionId}-${command.type}`;
	sessionFile = path.join(path.dirname(previousFile), `2026-08-20T00-00-01-000Z_${sessionId}.jsonl`);
	if (process.env.PI_WEB_FIXTURE_UNPERSISTED_TRANSITION !== "1") ensurePersisted();
	sendLargeExtensionRequest(
		`transition-flood-${sessionId}`,
		configuredBytes("PI_WEB_FIXTURE_TRANSITION_FRAME_BYTES"),
	);
	if (process.env.PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS) delayNextTransitionState = true;
	if (process.env.PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS === "1") {
		transitionPayloadPostPending = true;
	}
	if (process.env.PI_WEB_FIXTURE_TRANSITION_STICKY === "1") {
		send({
			type: "extension_ui_request",
			id: `status-${sessionId}`,
			method: "setStatus",
			statusKey: "transition",
			statusText: sessionId,
		});
	}
	if (process.env.PI_WEB_FIXTURE_FAIL_TRANSITION_STATE === "1") {
		failNextState = true;
		send({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: sessionId },
		});
	}
	if (process.env.PI_WEB_FIXTURE_DROP_TRANSITION_RESPONSE === "1") return;
	response(command, command.type === "fork" ? { text: "forked", cancelled: false } : { cancelled: false });
}

function handleLine(line) {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	if (!command || typeof command.id !== "string") return;
	switch (command.type) {
		case "get_state":
			if (!startupFloodSent) {
				startupFloodSent = true;
				sendStartupExtensionState();
				sendStartupProjectionDomains();
				sendLargeExtensionRequest(
					`startup-flood-${sessionId}`,
					configuredBytes("PI_WEB_FIXTURE_STARTUP_FRAME_BYTES"),
				);
			}
			if (failNextState) {
				failNextState = false;
				errorResponse(command, "fixture transition state failure");
				return;
			}
			if (initialStateRequest) {
				initialStateRequest = false;
				const readyDelay = Number(process.env.PI_WEB_FIXTURE_READY_DELAY_MS);
				if (Number.isFinite(readyDelay) && readyDelay > 0) {
					setTimeout(() => response(command, state()), readyDelay);
					return;
				}
			}
			if (delayNextTransitionState) {
				delayNextTransitionState = false;
				const delay = Number(process.env.PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS);
				setTimeout(() => response(command, state()), Number.isFinite(delay) ? delay : 100);
				return;
			}
			response(command, state());
			return;
		case "get_messages":
			getMessagesRequestCount += 1;
			if (process.env.PI_WEB_FIXTURE_GET_MESSAGES_MARKER) {
				fs.appendFileSync(
					process.env.PI_WEB_FIXTURE_GET_MESSAGES_MARKER,
					`${String(getMessagesRequestCount)}\n`,
				);
			}
			if (process.env.PI_WEB_FIXTURE_COMPACTION_RACE === "1" && getMessagesRequestCount === 2) {
				setTimeout(() => send({ type: "turn_start" }), 5);
				setTimeout(() => response(command, { messages }), 30);
				return;
			}
			if (process.env.PI_WEB_FIXTURE_COMPACTION_DELAY_MS && getMessagesRequestCount === 2) {
				setTimeout(
					() => response(command, { messages }),
					Number(process.env.PI_WEB_FIXTURE_COMPACTION_DELAY_MS),
				);
				return;
			}
			if (process.env.PI_WEB_FIXTURE_TRANSITION_DIALOG_AFTER_BASE === "1" && getMessagesRequestCount === 2) {
				send({
					type: "extension_ui_request",
					id: `transition-dialog-${sessionId}`,
					method: "confirm",
					title: "Transition dialog",
					message: "transition-dialog",
					...(process.env.PI_WEB_FIXTURE_TRANSITION_DIALOG_TIMEOUT_MS
						? { timeout: Number(process.env.PI_WEB_FIXTURE_TRANSITION_DIALOG_TIMEOUT_MS) }
						: {}),
				});
			}
			response(command, { messages });
			if (
				process.env.PI_WEB_FIXTURE_TRANSITION_DIALOG_DURING_PARENT_CLEANUP === "1" &&
				getMessagesRequestCount === 2
			) {
				setTimeout(() => {
					send({
						type: "extension_ui_request",
						id: `transition-applying-dialog-${sessionId}`,
						method: "confirm",
						title: "Transition applying dialog",
						message: "transition-applying-dialog",
					});
				}, 20);
			}
			if (transitionPayloadPostPending && getMessagesRequestCount === 2) {
				transitionPayloadPostPending = false;
				setTimeout(() => {
					send({
						type: "message_end",
						message: {
							role: "user",
							content: [{ type: "text", text: "transition-post-rekey-ref" }],
							timestamp: Date.now(),
						},
					});
				}, 20);
			}
			return;
		case "get_commands":
			response(command, { commands: [] });
			return;
		case "set_model":
		case "set_thinking_level":
			if (process.env.PI_WEB_FIXTURE_FAIL_MUTATION === command.type) {
				errorResponse(command, `fixture ${command.type} failure`);
				return;
			}
			if (command.type === "set_model" && command.modelId === "stale-queue-clear") {
				response(command, { id: command.modelId, name: command.modelId, provider: command.provider });
				send({ type: "queue_update", steering: ["queued"], followUp: [] });
				setTimeout(
					() => send({ type: "queue_update", steering: [], followUp: [] }),
					Number(process.env.PI_WEB_FIXTURE_STALE_QUEUE_DELAY_MS ?? 100),
				);
				return;
			}
			response(
				command,
				command.type === "set_model"
					? { id: command.modelId, name: command.modelId, provider: command.provider }
					: undefined,
			);
			return;
		case "prompt":
			streamPrompt(command);
			return;
		case "follow_up":
			if (command.message === "follow-up-failure") {
				errorResponse(command, "fixture follow_up failure");
				return;
			}
			if (command.message === "queued-never-starts") {
				response(command);
				return;
			}
			if (command.message.startsWith("queued-never-starts:")) {
				setTimeout(() => response(command), Number(command.message.split(":")[1]));
				return;
			}
			streamPrompt(command);
			return;
		case "abort":
			if (process.env.PI_WEB_FIXTURE_ABORT_MARKER) {
				fs.appendFileSync(process.env.PI_WEB_FIXTURE_ABORT_MARKER, "abort\n");
			}
			if (process.env.PI_WEB_FIXTURE_ABORT_RESPONSE_DELAY_MS) {
				setTimeout(() => response(command), Number(process.env.PI_WEB_FIXTURE_ABORT_RESPONSE_DELAY_MS));
				return;
			}
			response(command);
			return;
		case "export_html": {
			const outputPath =
				typeof command.outputPath === "string" ? command.outputPath : `pi-session-${sessionId}.html`;
			const resolvedOutputPath = path.resolve(outputPath);
			if (process.env.PI_WEB_FIXTURE_EXPORT_MISSING !== "1") {
				if (process.env.PI_WEB_FIXTURE_EXPORT_DIRECTORY === "1") {
					fs.mkdirSync(resolvedOutputPath, { recursive: true });
				} else {
					fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
					fs.writeFileSync(resolvedOutputPath, "<html><body>fixture export</body></html>\n");
				}
			}
			response(command, { path: outputPath });
			return;
		}
		case "bash":
			if (command.command !== "long") {
				response(command, { output: "ok", exitCode: 0, cancelled: false, truncated: false });
				return;
			}
			pendingBash = command;
			pendingBashTimer = setTimeout(() => {
				response(command, { output: "done", exitCode: 0, cancelled: false, truncated: false });
				pendingBash = undefined;
				pendingBashTimer = undefined;
			}, 1_000);
			return;
		case "abort_bash":
			if (pendingBashTimer) clearTimeout(pendingBashTimer);
			if (pendingBash) {
				response(pendingBash, { output: "", cancelled: true, truncated: false });
				pendingBash = undefined;
				pendingBashTimer = undefined;
			}
			response(command);
			return;
		case "compact": {
			const willRetry = command.customInstructions === "retry";
			send({ type: "compaction_start", reason: "manual" });
			send({
				type: "compaction_end",
				reason: "manual",
				aborted: command.customInstructions === "failure",
				willRetry,
				...(command.customInstructions === "failure" ? { errorMessage: "fixture failure" } : {}),
			});
			response(command, {
				summary: "fixture summary",
				firstKeptEntryId: "fixture-entry",
				tokensBefore: 2,
			});
			if (willRetry) setTimeout(() => send({ type: "agent_settled" }), 100);
			return;
		}
		case "fork":
		case "clone":
			transition(command);
			return;
		case "extension_ui_response":
			return;
		default:
			response(command);
	}
}
