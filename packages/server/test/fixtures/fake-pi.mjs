import fs from "node:fs";

if (process.argv.includes("--version")) {
	process.stdout.write("0.84.2\n");
	process.exit(0);
}

let buffer = "";
let sessionId = "fake-session";
let sessionFile = "/tmp/fake-session.jsonl";

if (process.env.PI_WEB_FAKE_ARGV_MARKER) {
	fs.writeFileSync(process.env.PI_WEB_FAKE_ARGV_MARKER, JSON.stringify(process.argv.slice(2)));
}

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
		messageCount: 0,
		pendingMessageCount: 0,
	};
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
			send({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: state(),
			});
			return;
		case "get_commands":
			send({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: { commands: [] },
			});
			return;
		case "get_messages": {
			const configuredBytes = Number(process.env.PI_WEB_FAKE_SNAPSHOT_BYTES);
			const text =
				Number.isSafeInteger(configuredBytes) && configuredBytes > 0 ? "x".repeat(configuredBytes) : "";
			send({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: {
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text }],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					],
				},
			});
			return;
		}
		case "new_session":
			sessionId = "fake-session-next";
			sessionFile = "/tmp/fake-session-next.jsonl";
			send({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: { cancelled: false },
			});
			return;
		case "switch_session":
			sessionFile = command.sessionPath;
			sessionId = "fake-session-switched";
			send({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: { cancelled: false },
			});
			return;
		case "prompt":
			if (command.message === "async-decode-exit") {
				process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
				setTimeout(() => process.exit(23), 10);
				return;
			}
			if (command.message === "ordered-async") {
				process.stdout.write(
					[
						{ type: "agent_start" },
						{ type: "response", id: command.id, command: command.type, success: true },
						{ type: "agent_settled" },
					]
						.map((frame) => `${JSON.stringify(frame)}\n`)
						.join(""),
				);
				return;
			}
			if (command.message === "malformed-event") {
				send({ type: "queue_update" });
				return;
			}
			if (command.message === "open-dialog") {
				send({
					type: "extension_ui_request",
					id: "fake-dialog",
					method: "confirm",
					title: "Confirm",
					message: "Fixture dialog",
				});
			}
			if (command.message === "timeout-dialog") {
				send({
					type: "extension_ui_request",
					id: "fake-timeout-dialog",
					method: "confirm",
					title: "Timed confirm",
					message: "Fixture timeout dialog",
					timeout: 20,
				});
			}
			send({ type: "response", id: command.id, command: command.type, success: true });
			return;
		case "get_last_assistant_text":
			if (command.id === "same-id") return;
			send({ type: "response", command: command.type, success: true, data: { text: "missing id" } });
			return;
		default:
			send({ type: "response", id: command.id, command: command.type, success: true });
	}
}
