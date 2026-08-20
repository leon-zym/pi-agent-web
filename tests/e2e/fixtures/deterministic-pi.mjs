import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let buffer = "";
const sessionId = "browser-e2e-session";
const sessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR ?? os.tmpdir();
const sessionFile = path.join(sessionRoot, "browser-e2e-session.jsonl");
const markerPath = process.env.PI_WEB_E2E_MARKER;

fs.mkdirSync(sessionRoot, { recursive: true });
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
if (markerPath) fs.writeFileSync(markerPath, `${String(process.pid)}\n`, "utf8");

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

function respond(command, data) {
	send({
		type: "response",
		id: command.id,
		command: command.type,
		success: true,
		...(data === undefined ? {} : { data }),
	});
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
			respond(command, { messages: [] });
			return;
		case "get_session_stats":
			respond(command, {
				messageCount: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				contextUsage: { tokens: null, contextWindow: null, percent: null },
			});
			return;
		default:
			respond(command);
	}
}
