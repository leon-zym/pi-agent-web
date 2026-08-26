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

let sessionFile;
let sessionId;
const messages = [];
let failNextState = false;
let delayNextTransitionState = false;
let pendingBash;
let pendingBashTimer;
let startupFloodSent = false;
let initialStateRequest = true;
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function streamPrompt(command) {
	const text = command.message;
	messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	if (process.env.PI_WEB_FIXTURE_SKIP_PROMPT_PERSIST !== "1") ensurePersisted();
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
	const previousFile = sessionFile;
	sessionId = `${sessionId}-${command.type}`;
	sessionFile = path.join(path.dirname(previousFile), `2026-08-20T00-00-01-000Z_${sessionId}.jsonl`);
	if (process.env.PI_WEB_FIXTURE_UNPERSISTED_TRANSITION !== "1") ensurePersisted();
	sendLargeExtensionRequest(
		`transition-flood-${sessionId}`,
		configuredBytes("PI_WEB_FIXTURE_TRANSITION_FRAME_BYTES"),
	);
	if (process.env.PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS) delayNextTransitionState = true;
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
			response(command, { messages });
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
