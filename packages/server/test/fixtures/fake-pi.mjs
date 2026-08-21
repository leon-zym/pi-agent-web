let buffer = "";
let sessionId = "fake-session";
let sessionFile = "/tmp/fake-session.jsonl";

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
				data: { sessionId, sessionFile, thinkingLevel: "off", argv: process.argv.slice(2) },
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
				data: { messages: [{ role: "assistant", content: [{ type: "text", text }] }] },
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
			send({ type: "response", command: command.type, success: true, data: { text: "missing id" } });
			return;
		default:
			send({ type: "response", id: command.id, command: command.type, success: true });
	}
}
