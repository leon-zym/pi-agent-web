import { spawn } from "node:child_process";
import fs from "node:fs";

const exitMarker = process.env.PI_WEB_PROCESS_GROUP_EXIT_MARKER;
const ignoreTerm = process.env.PI_WEB_PROCESS_GROUP_IGNORE_TERM === "1";
const emitProtocolFailure = process.env.PI_WEB_PROCESS_GROUP_PROTOCOL_FAILURE === "1";
const descendantScript = exitMarker
	? `
		const fs = require("node:fs");
		const marker = process.argv[1];
		const leaderPid = process.ppid;
		${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
		const leaderWatch = setInterval(() => {
			try {
				process.kill(leaderPid, 0);
			} catch {
				clearInterval(leaderWatch);
				setTimeout(() => fs.writeFileSync(marker, String(process.pid)), 300);
			}
		}, 10);
		setInterval(() => {}, 1_000);
	`
	: "setInterval(() => {}, 1_000)";
const descendant = spawn(process.execPath, ["-e", descendantScript, ...(exitMarker ? [exitMarker] : [])], {
	stdio: "ignore",
});
if (process.env.PI_WEB_PROCESS_GROUP_PID_MARKER) {
	fs.writeFileSync(
		process.env.PI_WEB_PROCESS_GROUP_PID_MARKER,
		JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }),
	);
}
let buffer = "";
let protocolFailureScheduled = false;

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
		if (typeof command?.id !== "string") continue;
		if (command.type === "get_last_assistant_text" && exitMarker) {
			process.stdout.write(
				`${JSON.stringify({
					type: "response",
					id: command.id,
					command: "get_last_assistant_text",
					success: true,
					data: { text: "leader exiting" },
				})}\n`,
				() => {
					fs.writeFileSync(`${exitMarker}.leader`, String(process.pid));
					process.exit(23);
				},
			);
			continue;
		}
		if (command.type !== "get_state") continue;
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
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			})}\n`,
			() => {
				if (emitProtocolFailure && !protocolFailureScheduled) {
					protocolFailureScheduled = true;
					setTimeout(() => process.stdout.write("x".repeat(8 * 1024 * 1024 + 1)), 5).unref();
				}
			},
		);
	}
});
