import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiRuntime } from "../src/resolver.js";

const tempRoots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-resolver-"));
	tempRoots.push(dir);
	return dir;
}

function writeFile(filePath: string, executable = false): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "#!/usr/bin/env node\n", "utf8");
	if (executable) fs.chmodSync(filePath, 0o755);
	return filePath;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi runtime resolution", () => {
	it("prefers --pi-path over PI_PATH", async () => {
		const root = tempDir();
		const fromFlag = writeFile(path.join(root, "flag.mjs"));
		const fromEnv = writeFile(path.join(root, "env.mjs"));

		await expect(
			resolvePiRuntime({ piPath: fromFlag, env: { PI_PATH: fromEnv, PATH: "" } }),
		).resolves.toMatchObject({
			source: "pi-path",
			args: [fromFlag],
		});
	});

	it("uses PI_PATH when no explicit flag is given", async () => {
		const root = tempDir();
		const entry = writeFile(path.join(root, "rpc-entry.mjs"));

		await expect(resolvePiRuntime({ env: { PI_PATH: entry, PATH: "" } })).resolves.toMatchObject({
			source: "pi-path",
			args: [entry],
		});
	});

	it("finds an executable pi command on PATH", async () => {
		const root = tempDir();
		const executable = writeFile(path.join(root, "bin", "pi"), true);

		await expect(
			resolvePiRuntime({ env: { PATH: path.dirname(executable) }, homebrewRoots: [] }),
		).resolves.toMatchObject({
			source: "system",
			command: executable,
			args: ["--mode", "rpc"],
		});
	});

	it("uses the package rpc entry as the bundled fallback", async () => {
		const serverDir = path.resolve(import.meta.dirname, "..");
		await expect(
			resolvePiRuntime({ env: { PATH: "" }, baseDir: serverDir, homebrewRoots: [] }),
		).resolves.toMatchObject({ source: "bundled" });
	});

	it("rejects a CLI-only directory and reports a missing runtime", async () => {
		const root = tempDir();
		const cliOnly = path.join(root, "cli-only");
		writeFile(path.join(cliOnly, "dist", "cli.js"));
		await expect(resolvePiRuntime({ piPath: cliOnly, env: { PATH: "" } })).rejects.toThrow("rpc-entry.js");

		const noRuntime = tempDir();
		await expect(
			resolvePiRuntime({ env: { PATH: "" }, baseDir: noRuntime, homebrewRoots: [] }),
		).rejects.toThrow("Unable to locate");
	});
});
