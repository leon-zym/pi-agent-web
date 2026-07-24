import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WsServerMessage } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor } from "../src/supervisor.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-supervisor-failure-"));

function createSupervisor(fixture: string, messages: WsServerMessage[]): Supervisor {
	return new Supervisor({
		resolved: {
			command: process.execPath,
			args: [path.join(fixtureDir, fixture)],
			source: "pi-path",
			label: fixture,
		},
		sessionRootDir: path.join(tempRoot, "sessions"),
		broadcast: (message) => messages.push(message),
		readyTimeoutMs: 100,
		restartBaseDelayMs: 5,
		maxAutoRestarts: 3,
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

describe("Supervisor failure state machine", () => {
	let supervisor: Supervisor | undefined;

	afterEach(async () => {
		await supervisor?.stopAll();
	});

	it("counts every ready-then-crash in the same restart window", async () => {
		const messages: WsServerMessage[] = [];
		supervisor = createSupervisor("crash-after-ready-pi.mjs", messages);
		supervisor.registerWorkspace("workspace", tempRoot);

		await supervisor.ensureProcess("workspace", tempRoot);
		await waitFor(
			() =>
				messages.filter((message) => message.type === "process_status" && message.state === "starting")
					.length === 4,
		);
		await waitFor(() => supervisor?.getStatus("workspace")?.state === "crashed");

		expect(
			messages.filter((message) => message.type === "process_status" && message.state === "starting"),
		).toHaveLength(4);
		expect(supervisor.getStatus("workspace")).toMatchObject({ state: "crashed" });
	});

	it("retries a ready timeout through the same bounded failure path", async () => {
		const messages: WsServerMessage[] = [];
		supervisor = createSupervisor("never-ready-pi.mjs", messages);
		supervisor.registerWorkspace("workspace", tempRoot);

		await expect(supervisor.ensureProcess("workspace", tempRoot)).rejects.toThrow("ready timeout");
		await waitFor(
			() =>
				messages.filter((message) => message.type === "process_status" && message.state === "starting")
					.length === 4,
		);
		await waitFor(() => supervisor?.getStatus("workspace")?.state === "crashed");

		expect(
			messages.filter((message) => message.type === "process_status" && message.state === "starting"),
		).toHaveLength(4);
		expect(supervisor.getStatus("workspace")).toMatchObject({ state: "crashed" });
	});
});
