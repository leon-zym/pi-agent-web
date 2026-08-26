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
				data: {
					sessionId: "long-line",
					sessionFile: "/tmp/long-line.jsonl",
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			})}\n`,
		);
		setTimeout(() => process.stdout.write("x".repeat(8 * 1024 * 1024 + 1)), 5).unref();
	}
});
