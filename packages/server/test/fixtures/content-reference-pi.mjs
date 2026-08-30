import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
	process.stdout.write("0.84.2\n");
	process.exit(0);
}

const INLINE_THRESHOLD = 256 * 1024;
const LARGE_MARKER = "future-l3-large-marker";
const FIXED_TIME = 1_756_492_800_000;
const FIXED_TIMESTAMP = "2025-08-28T00:00:00.000Z";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedFile = argument("--session");
const requestedId = argument("--session-id");
const requestedDir = argument("--session-dir");

let sessionFile;
let sessionId;
if (requestedFile) {
	sessionFile = path.resolve(requestedFile);
	const firstLine = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0];
	sessionId = JSON.parse(firstLine).id;
} else {
	sessionId = requestedId ?? "future-l3-fixture";
	const sessionDir = path.resolve(requestedDir ?? process.cwd());
	sessionFile = path.join(sessionDir, `2025-08-28T00-00-00-000Z_${sessionId}.jsonl`);
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let getMessagesRequestCount = 0;
const messages =
	process.env.PI_WEB_FUTURE_FIXTURE_SMALL_HISTORY === "1" ? [] : [toolResult("history-startup")];

function largeText(label) {
	const prefix = `${LARGE_MARKER}:${label}:`;
	return `${prefix}${"x".repeat(INLINE_THRESHOLD - Buffer.byteLength(prefix))}`;
}

function largeJson(label) {
	return { payload: largeText(label) };
}

function toolResult(label) {
	return {
		role: "toolResult",
		toolCallId: `tool-${label}`,
		toolName: "fixture",
		content: [{ type: "text", text: largeText(`${label}-content`) }],
		details: largeJson(`${label}-details`),
		isError: false,
		timestamp: FIXED_TIME,
	};
}

function entry(label) {
	return {
		type: "message",
		id: `entry-${label}`,
		parentId: null,
		timestamp: FIXED_TIMESTAMP,
		message: toolResult(label),
	};
}

function tree(label) {
	return [{ entry: entry(label), children: [], label: `tree-${label}`, labelTimestamp: FIXED_TIMESTAMP }];
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

function sendLargeToolPayloads() {
	const args = largeJson("tool-args");
	const partialResult = largeJson("tool-partial");
	const result = largeJson("tool-result");
	const message = toolResult("tool-message");

	send({
		type: "message_update",
		usage,
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "tool-l3", name: "fixture", arguments: args },
		},
	});
	send({ type: "tool_execution_start", toolCallId: "tool-l3", toolName: "fixture", args });
	send({
		type: "tool_execution_update",
		toolCallId: "tool-l3",
		toolName: "fixture",
		args,
		partialResult,
	});
	send({
		type: "tool_execution_end",
		toolCallId: "tool-l3",
		toolName: "fixture",
		result,
		isError: false,
	});
	send({ type: "message_end", message });
	messages.push(message);
	send({ type: "agent_end", messages: [message], willRetry: false });
	send({ type: "agent_settled" });
}

function sendLargeExtensionRoots() {
	send({
		type: "extension_ui_request",
		id: "future-l3-editor",
		method: "editor",
		title: "Large editor",
		prefill: largeText("extension-editor"),
	});
	send({
		type: "extension_ui_request",
		id: "future-l3-set-editor-text",
		method: "set_editor_text",
		text: largeText("extension-set-editor-text"),
	});
	send({
		type: "extension_ui_request",
		id: "future-l3-widget",
		method: "setWidget",
		widgetKey: "future-l3-widget",
		widgetLines: [largeText("extension-widget")],
		widgetPlacement: "belowEditor",
	});
}

function sendCacheBoundaryRoots() {
	send({
		type: "extension_ui_request",
		id: "future-l3-cache-editor",
		method: "editor",
		title: "Cache first editor",
		prefill: largeText("cache-first"),
	});
	send({
		type: "extension_ui_request",
		id: "future-l3-cache-widget",
		method: "setWidget",
		widgetKey: "future-l3-cache-widget",
		widgetLines: [largeText("cache-second")],
	});
}

function streamPrompt(command) {
	send({ type: "agent_start" });
	response(command);
	if (command.message === "large-tool-payloads") {
		sendLargeToolPayloads();
		return;
	}
	if (command.message === "large-extension-roots") {
		sendLargeExtensionRoots();
		return;
	}
	if (command.message === "cache-boundary-extension") {
		sendCacheBoundaryRoots();
		return;
	}
	send({
		type: "message_update",
		usage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "small" },
	});
	send({ type: "agent_end", messages: [], willRetry: false });
	send({ type: "agent_settled" });
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
		if (!line) continue;
		let command;
		try {
			command = JSON.parse(line);
		} catch {
			continue;
		}
		if (!command || typeof command.id !== "string") continue;
		switch (command.type) {
			case "get_state":
				response(command, state());
				break;
			case "get_messages":
				getMessagesRequestCount += 1;
				response(command, {
					messages:
						getMessagesRequestCount === 1 && process.env.PI_WEB_FUTURE_FIXTURE_SMALL_HISTORY === "1"
							? []
							: getMessagesRequestCount === 1
								? [toolResult("history-startup")]
								: [toolResult("history-get-messages")],
				});
				break;
			case "get_entries":
				response(command, { entries: [entry("history-get-entries")], leafId: "entry-history-get-entries" });
				break;
			case "get_tree":
				response(command, { tree: tree("history-get-tree"), leafId: "entry-history-get-tree" });
				break;
			case "prompt":
			case "steer":
			case "follow_up":
				streamPrompt(command);
				break;
			case "extension_ui_response":
				break;
			default:
				response(command);
		}
	}
});
