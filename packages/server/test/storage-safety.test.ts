import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAuthFilePath, saveApiKey } from "../src/auth-storage.js";

const tempRoots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-storage-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable local storage", () => {
	it("atomically updates auth without discarding other credentials", async () => {
		const agentDir = tempDir();
		const filePath = getAuthFilePath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(filePath, '{"oauth":{"type":"oauth"}}\n', { mode: 0o600 });

		await saveApiKey(agentDir, "openai", "secret");

		expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
			oauth: { type: "oauth" },
			openai: { type: "api_key", key: "secret" },
		});
		expect(fs.readdirSync(agentDir).some((entry) => entry.includes(".tmp"))).toBe(false);
	});

	it("refuses to overwrite malformed auth data", async () => {
		const agentDir = tempDir();
		const filePath = getAuthFilePath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(filePath, "{not-json", { mode: 0o600 });

		await expect(saveApiKey(agentDir, "openai", "secret")).rejects.toThrow("refusing to overwrite");
		expect(fs.readFileSync(filePath, "utf8")).toBe("{not-json");
	});

	it("rejects provider keys that could mutate an object prototype", async () => {
		const agentDir = tempDir();
		await expect(saveApiKey(agentDir, "__proto__", "secret")).rejects.toThrow("provider is not valid");
	});
});
