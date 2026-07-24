let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) return;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		let command;
		try {
			command = JSON.parse(line);
		} catch {
			continue;
		}
		if (command?.type !== "get_state" || typeof command.id !== "string") continue;
		process.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: command.id,
				command: "get_state",
				success: true,
				data: { sessionId: "crash-session", sessionFile: "/tmp/crash-session.jsonl", thinkingLevel: "off" },
			})}\n`,
		);
		setTimeout(() => process.exit(17), 5).unref();
	}
});
