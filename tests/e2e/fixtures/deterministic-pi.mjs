import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let inputBuffer = "";
let entrySequence = 0;
let activeRun = null;

function argument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedFile = argument("--session");
const requestedId = argument("--session-id");
const requestedDir = argument("--session-dir");
const markerPath = process.env.PI_WEB_E2E_MARKER;
const controlDir = process.env.PI_WEB_E2E_CONTROL_DIR;
const slowDelayMs = positiveNumber(process.env.PI_WEB_E2E_SLOW_DELAY_MS, 5_000);

let sessionId = requestedId ?? `browser-e2e-${String(process.pid)}`;
let sessionFile = requestedFile ? path.resolve(requestedFile) : "";
if (requestedFile) {
	const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
	sessionId = header.id;
} else {
	const sessionRoot = requestedDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? os.tmpdir();
	sessionFile = path.join(path.resolve(sessionRoot), `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
}

fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (!fs.existsSync(sessionFile)) {
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: process.cwd(),
		})}\n`,
		"utf8",
	);
}

const messages = loadMessages(sessionFile);
record("started", { pid: process.pid, sessionId, sessionFile, cwd: process.cwd() });

process.on("SIGTERM", () => {
	record("terminated", { pid: process.pid, sessionId });
	process.exit(0);
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	inputBuffer += chunk;
	for (;;) {
		const newline = inputBuffer.indexOf("\n");
		if (newline === -1) return;
		const line = inputBuffer.slice(0, newline);
		inputBuffer = inputBuffer.slice(newline + 1);
		if (line) handleLine(line);
	}
});

function positiveNumber(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function record(type, detail = {}) {
	if (!markerPath) return;
	fs.appendFileSync(
		markerPath,
		`${JSON.stringify({ type, at: Date.now(), pid: process.pid, sessionId, ...detail })}\n`,
		"utf8",
	);
}

function loadMessages(file) {
	const loaded = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n").slice(1)) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "message" && entry.message) loaded.push(entry.message);
		} catch {
			// A malformed historical line is irrelevant to this deterministic fixture.
		}
	}
	return loaded;
}

function nextEntryId(role) {
	entrySequence += 1;
	return `${sessionId}-${role}-${String(Date.now())}-${String(entrySequence)}`;
}

function persistMessage(message, parentId) {
	const id = nextEntryId(message.role);
	fs.appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		})}\n`,
		"utf8",
	);
	return id;
}

function send(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(command, data) {
	send({
		type: "response",
		id: command.id,
		command: command.type,
		success: true,
		...(data === undefined ? {} : { data }),
	});
}

function usageFor(output = 1) {
	return {
		input: 1,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1 + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(text, timestamp = Date.now()) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "e2e",
		model: "deterministic",
		usage: usageFor(Math.max(1, Math.ceil(text.length / 4))),
		stopReason: "stop",
		timestamp,
	};
}

function clearRunTimers(run) {
	for (const timer of run.timers) clearTimeout(timer);
	run.timers.length = 0;
}

function schedule(run, delay, callback) {
	const timer = setTimeout(() => {
		run.timers = run.timers.filter((candidate) => candidate !== timer);
		if (activeRun !== run) return;
		callback();
	}, delay);
	run.timers.push(timer);
}

function scheduleSlowFinish(run, text, callback) {
	if (!controlDir) {
		schedule(run, slowDelayMs, callback);
		return;
	}
	const releaseFile = path.join(controlDir, `${encodeURIComponent(text)}.release`);
	const check = () => {
		schedule(run, 25, () => {
			if (!fs.existsSync(releaseFile)) {
				check();
				return;
			}
			record("release_observed", { commandId: run.command.id, text });
			callback();
		});
	};
	check();
}

function streamPrompt(command) {
	const text = typeof command.message === "string" ? command.message : "";
	const images = Array.isArray(command.images) ? command.images : [];
	const userContent = [
		...(text ? [{ type: "text", text }] : []),
		...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
	];
	const user = { role: "user", content: userContent, timestamp: Date.now() };
	const userEntryId = persistMessage(user, null);
	messages.push(user);

	const label =
		images.length > 0 && !text
			? `E2E_IMAGE_OK:${String(images.length)}:${images[0]?.mimeType ?? "unknown"}`
			: `E2E_REPLY:${text}`;
	const slow = text.includes("E2E_A_SLOW");
	const firstDelay = slow ? Math.min(500, Math.floor(slowDelayMs / 3)) : 25;
	const finishDelay = 90;
	const splitAt = Math.max(1, Math.floor(label.length / 2));
	const firstDelta = label.slice(0, splitAt);
	const finalDelta = label.slice(splitAt);

	const run = { command, label, timers: [], assembled: "", userEntryId };
	activeRun = run;
	record("prompt", {
		commandId: command.id,
		text,
		imageCount: images.length,
		imageMimeTypes: images.map((image) => image.mimeType),
		imageChars: images.reduce((total, image) => total + String(image.data).length, 0),
		slow,
	});

	send({ type: "agent_start" });
	send({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	send({ type: "message_start", message: user });
	send({ type: "message_end", message: user });
	send({ type: "session_info_changed" });
	send({ type: "message_start", message: assistantMessage("") });
	respond(command);

	schedule(run, firstDelay, () => {
		run.assembled += firstDelta;
		const partial = assistantMessage(run.assembled);
		send({
			type: "message_update",
			message: partial,
			usage: partial.usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: firstDelta },
		});
		record("delta", { commandId: command.id, text, deltaIndex: 1 });
	});

	const finish = () => {
		run.assembled += finalDelta;
		const partial = assistantMessage(run.assembled);
		send({
			type: "message_update",
			message: partial,
			usage: partial.usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: finalDelta },
		});
		const final = assistantMessage(label);
		send({ type: "message_end", message: final });
		send({ type: "turn_end", turnIndex: 0, message: final, toolResults: [] });
		messages.push(final);
		persistMessage(final, run.userEntryId);
		send({ type: "agent_end", messages: [user, final], willRetry: false });
		send({ type: "agent_settled" });
		record("settled", { commandId: command.id, text, label });
		activeRun = null;
	};
	if (slow) scheduleSlowFinish(run, text, finish);
	else schedule(run, finishDelay, finish);
}

function abortRun(command) {
	const run = activeRun;
	if (!run) {
		respond(command);
		return;
	}
	clearRunTimers(run);
	const final = { ...assistantMessage(run.assembled), stopReason: "aborted" };
	send({ type: "message_end", message: final });
	send({ type: "turn_end", turnIndex: 0, message: final, toolResults: [] });
	send({ type: "agent_end", messages: [], willRetry: false });
	send({ type: "agent_settled" });
	record("aborted", { commandId: run.command.id });
	activeRun = null;
	respond(command);
}

function handleLine(line) {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	if (!command || typeof command !== "object" || typeof command.type !== "string") return;
	if (typeof command.id !== "string") return;

	record("command", { commandId: command.id, commandType: command.type });
	switch (command.type) {
		case "get_state":
			respond(command, { sessionId, sessionFile, thinkingLevel: "off" });
			return;
		case "get_commands":
			respond(command, { commands: [] });
			return;
		case "get_available_models":
			respond(command, { models: [] });
			return;
		case "get_available_thinking_levels":
			respond(command, { levels: ["off"] });
			return;
		case "get_messages":
			respond(command, { messages });
			return;
		case "get_session_stats":
			respond(command, {
				messageCount: messages.length,
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				cost: 0,
				contextUsage: { tokens: null, contextWindow: null, percent: null },
			});
			return;
		case "prompt":
		case "steer":
		case "follow_up":
			streamPrompt(command);
			return;
		case "abort":
			abortRun(command);
			return;
		default:
			respond(command);
	}
}
