import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiProcess } from "../src/pi-process.js";

const fakePiPath = path.join(import.meta.dirname, "fixtures", "fake-pi.mjs");

describe("PiProcess response correlation", () => {
	let proc: PiProcess | undefined;

	afterEach(async () => {
		await proc?.stop();
	});

	it("drops a response without id and settles the caller through its timeout", async () => {
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			commandTimeoutMs: 50,
		});
		await proc.start();

		await expect(proc.send({ id: "missing-id", type: "get_last_assistant_text" }, 50)).rejects.toThrow(
			"command timed out",
		);
	});

	it("rejects duplicate process-local pending ids instead of overwriting the first request", async () => {
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
		});
		await proc.start();

		const first = proc.send({ id: "same-id", type: "get_last_assistant_text" }, 100);
		await expect(proc.send({ id: "same-id", type: "get_last_assistant_text" }, 100)).rejects.toThrow(
			"duplicate pending command id",
		);
		await expect(first).rejects.toThrow("command timed out");
	});
});
