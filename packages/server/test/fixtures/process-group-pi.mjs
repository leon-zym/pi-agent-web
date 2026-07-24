import { spawn } from "node:child_process";

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
	stdio: "ignore",
});
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
					sessionId: "group-session",
					sessionFile: "/tmp/group-session.jsonl",
					thinkingLevel: "off",
					descendantPid: descendant.pid,
				},
			})}\n`,
		);
	}
});
