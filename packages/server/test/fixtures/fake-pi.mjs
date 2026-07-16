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
				data: { sessionId, sessionFile, thinkingLevel: "off" },
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
		case "get_last_assistant_text":
			send({ type: "response", command: command.type, success: true, data: { text: "missing id" } });
			return;
		default:
			send({ type: "response", id: command.id, command: command.type, success: true });
	}
}
