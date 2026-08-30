import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	compatibilityForPiVersion,
	PI_COMPATIBILITY_MATRIX,
	type PiRuntimeDiagnosticError,
	resolvePiRuntime,
} from "../src/resolver.js";

const tempRoots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-resolver-"));
	tempRoots.push(dir);
	return dir;
}

function writeFile(filePath: string, content: string, executable = false): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
	if (executable) fs.chmodSync(filePath, 0o755);
	return filePath;
}

function versionProbe(filePath: string, version: string, executable = false): string {
	return writeFile(
		filePath,
		`#!/usr/bin/env node\nif (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${version}\n`)});\n`,
		executable,
	);
}

function fakePiPackage(
	version: string,
	options: { entry?: string; outputVersion?: string } = {},
): { root: string; entry: string } {
	const root = tempDir();
	const entryTarget = options.entry ?? "./dist/rpc-entry.js";
	writeFile(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version,
			bin: { pi: "dist/cli.js" },
			exports: { "./rpc-entry": { import: entryTarget } },
		}),
	);
	const entry = writeFile(
		path.join(root, entryTarget.replace(/^\.\//, "")),
		"setInterval(() => {}, 1_000);\n",
	);
	versionProbe(path.join(root, "dist", "cli.js"), options.outputVersion ?? version);
	return { root, entry };
}

async function expectDiagnostic(
	promise: Promise<unknown>,
	code: PiRuntimeDiagnosticError["code"],
): Promise<void> {
	await expect(promise).rejects.toMatchObject({ name: "PiRuntimeDiagnosticError", code });
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi runtime resolution", () => {
	it("prefers --pi-path over PI_PATH and probes the explicit runtime", async () => {
		const root = tempDir();
		const fromFlag = versionProbe(path.join(root, "flag.mjs"), "0.84.2");
		const fromEnv = versionProbe(path.join(root, "env.mjs"), "0.84.3");

		await expect(
			resolvePiRuntime({ piPath: fromFlag, env: { PI_PATH: fromEnv, PATH: "" } }),
		).resolves.toMatchObject({
			source: "pi-path",
			args: [fromFlag],
			version: "0.84.2",
			compatibilityStatus: "current",
		});
	});

	it("uses PI_PATH when no explicit flag is given", async () => {
		const root = tempDir();
		const entry = versionProbe(path.join(root, "rpc-entry.mjs"), "0.84.2");

		await expect(resolvePiRuntime({ env: { PI_PATH: entry, PATH: "" } })).resolves.toMatchObject({
			source: "pi-path",
			args: [entry],
			version: "0.84.2",
		});
	});

	it("does not let PATH or baseDir shadow the module-relative bundled export", async () => {
		const root = tempDir();
		const executable = versionProbe(path.join(root, "bin", "pi"), "0.84.3", true);
		const bundled = fakePiPackage("0.84.2");

		await expect(
			resolvePiRuntime({
				env: { PATH: path.dirname(executable) },
				baseDir: root,
				bundledEntryUrl: pathToFileURL(bundled.entry),
				expectedBundledVersion: "0.84.2",
			}),
		).resolves.toMatchObject({
			source: "bundled",
			command: process.execPath,
			args: [bundled.entry],
			version: "0.84.2",
		});
	});

	it("does not silently fall back to a PATH pi when the bundled export is missing", async () => {
		const root = tempDir();
		const executable = versionProbe(path.join(root, "bin", "pi"), "0.84.2", true);
		const missing = path.join(root, "missing-rpc-entry.js");

		await expectDiagnostic(
			resolvePiRuntime({
				env: { PATH: path.dirname(executable) },
				bundledEntryUrl: pathToFileURL(missing),
			}),
			"pi_runtime_missing",
		);
	});

	it("probes the installed package CLI without executing its long-running RPC entry", async () => {
		const resolved = await resolvePiRuntime({ env: { PATH: "" } });
		expect(resolved).toMatchObject({
			source: "bundled",
			version: "0.84.2",
			adapterId: "legacy-rpc-v1",
			compatibilityStatus: "current",
		});
		expect(resolved.adapter).toMatchObject({
			id: "legacy-rpc-v1",
			version: "0.84.2",
			capabilities: resolved.capabilities,
		});
	});

	it("follows a candidate package export instead of its legacy RPC path", async () => {
		const candidate = fakePiPackage("0.84.3", { entry: "./dist/bundle/rpc-entry.js" });
		versionProbe(path.join(candidate.root, "dist", "rpc-entry.js"), "0.84.2");

		await expect(resolvePiRuntime({ piPath: candidate.root, env: { PATH: "" } })).resolves.toMatchObject({
			source: "pi-path",
			args: [candidate.entry],
			version: "0.84.3",
			compatibilityStatus: "candidate",
			capabilities: expect.arrayContaining(["rpc.toolcall_identity"]),
		});
	});

	it("reports missing explicit runtimes with a stable diagnostic", async () => {
		const root = tempDir();
		const cliOnly = path.join(root, "cli-only");
		writeFile(path.join(cliOnly, "dist", "cli.js"), "#!/usr/bin/env node\n");

		await expectDiagnostic(resolvePiRuntime({ piPath: cliOnly, env: { PATH: "" } }), "pi_runtime_missing");
		await expectDiagnostic(
			resolvePiRuntime({ piPath: path.join(root, "absent"), env: { PATH: "" } }),
			"pi_runtime_missing",
		);
	});

	it("rejects a package whose declared version cannot be probed by an in-package CLI", async () => {
		const root = tempDir();
		writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "0.84.2",
				bin: { pi: "../outside.js" },
				exports: { "./rpc-entry": { import: "./dist/rpc-entry.js" } },
			}),
		);
		writeFile(path.join(root, "dist", "rpc-entry.js"), "setInterval(() => {}, 1_000);\n");
		await expectDiagnostic(resolvePiRuntime({ piPath: root, env: { PATH: "" } }), "pi_runtime_missing");
	});
});

describe("Pi runtime version probe", () => {
	it.runIf(process.platform !== "win32")("distinguishes a probe that cannot spawn", async () => {
		const entry = writeFile(path.join(tempDir(), "not-executable"), "#!/bin/sh\nprintf '0.84.2\\n'\n");
		await expectDiagnostic(resolvePiRuntime({ piPath: entry, env: { PATH: "" } }), "pi_probe_spawn_failed");
	});

	it("bounds a hanging probe with a stable timeout diagnostic", async () => {
		const entry = writeFile(path.join(tempDir(), "hang.mjs"), "setInterval(() => {}, 1_000);\n");
		await expectDiagnostic(
			resolvePiRuntime({ piPath: entry, env: { PATH: "" }, probeTimeoutMs: 25 }),
			"pi_probe_timeout",
		);
	});

	it("kills descendants in the bounded version-probe process tree", async () => {
		const root = tempDir();
		const marker = path.join(root, "descendant.pid");
		const entry = writeFile(
			path.join(root, "descendant.mjs"),
			`import fs from "node:fs";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.PI_WEB_PROBE_MARKER, String(child.pid));
setInterval(() => {}, 1000);
`,
		);
		await expectDiagnostic(
			resolvePiRuntime({
				piPath: entry,
				env: { PATH: "", PI_WEB_PROBE_MARKER: marker },
				probeTimeoutMs: 100,
			}),
			"pi_probe_timeout",
		);
		const descendantPid = Number(fs.readFileSync(marker, "utf8"));
		await expect
			.poll(
				() => {
					try {
						process.kill(descendantPid, 0);
						return true;
					} catch {
						return false;
					}
				},
				{ timeout: 2_000 },
			)
			.toBe(false);
	});

	it.runIf(process.platform !== "win32")(
		"cleans the saved process group after the probe leader exits before an inherited-stdio descendant",
		async () => {
			const root = tempDir();
			const marker = path.join(root, "orphan-descendant.pid");
			const entry = writeFile(
				path.join(root, "exited-leader.mjs"),
				`import fs from "node:fs";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
child.unref();
fs.writeFileSync(process.env.PI_WEB_PROBE_MARKER, String(child.pid));
process.stdout.write("0.84.2\\n");
`,
			);
			await expectDiagnostic(
				resolvePiRuntime({
					piPath: entry,
					env: { PATH: "", PI_WEB_PROBE_MARKER: marker },
					probeTimeoutMs: 100,
				}),
				"pi_probe_timeout",
			);
			const descendantPid = Number(fs.readFileSync(marker, "utf8"));
			await expect
				.poll(
					() => {
						try {
							process.kill(descendantPid, 0);
							return true;
						} catch {
							return false;
						}
					},
					{ timeout: 2_000 },
				)
				.toBe(false);
		},
	);

	it("distinguishes a nonzero probe exit", async () => {
		const entry = writeFile(path.join(tempDir(), "nonzero.mjs"), "process.exit(7);\n");
		await expectDiagnostic(resolvePiRuntime({ piPath: entry, env: { PATH: "" } }), "pi_probe_nonzero_exit");
	});

	it.each(["", "v0.84.2\n", "0.84.2\nnoise\n", " 0.84.2 \n", "not-a-version\n"])(
		"rejects malformed version output %j",
		async (output) => {
			const entry = writeFile(
				path.join(tempDir(), "malformed.mjs"),
				`process.stdout.write(${JSON.stringify(output)});\n`,
			);
			await expectDiagnostic(
				resolvePiRuntime({ piPath: entry, env: { PATH: "" } }),
				"pi_probe_output_invalid",
			);
		},
	);

	it("rejects oversized stdout before parsing", async () => {
		const entry = writeFile(
			path.join(tempDir(), "oversized.mjs"),
			'process.stdout.write("x".repeat(1024));\n',
		);
		await expectDiagnostic(
			resolvePiRuntime({
				piPath: entry,
				env: { PATH: "" },
				probeMaxOutputBytes: 64,
			}),
			"pi_probe_output_oversized",
		);
	});

	it("rejects a package manifest/executable version mismatch", async () => {
		const mismatched = fakePiPackage("0.84.2", { outputVersion: "0.84.3" });
		await expectDiagnostic(
			resolvePiRuntime({ piPath: mismatched.root, env: { PATH: "" } }),
			"pi_version_mismatch",
		);
	});

	it("rejects a bundled package that differs from the distribution manifest", async () => {
		const mismatched = fakePiPackage("0.84.3");
		await expectDiagnostic(
			resolvePiRuntime({
				env: { PATH: "" },
				bundledEntryUrl: pathToFileURL(mismatched.entry),
				expectedBundledVersion: "0.84.2",
			}),
			"pi_version_mismatch",
		);
	});

	it("does not silently promote a bundled candidate", async () => {
		const candidate = fakePiPackage("0.84.3");
		await expectDiagnostic(
			resolvePiRuntime({
				env: { PATH: "" },
				bundledEntryUrl: pathToFileURL(candidate.entry),
				expectedBundledVersion: "0.84.3",
			}),
			"pi_version_not_promoted",
		);
	});

	it("rejects versions absent from the compatibility matrix", async () => {
		const entry = versionProbe(path.join(tempDir(), "unsupported.mjs"), "0.84.4");
		await expectDiagnostic(resolvePiRuntime({ piPath: entry, env: { PATH: "" } }), "pi_version_unsupported");
	});

	it("rejects a runtime that lacks a required capability", async () => {
		const entry = versionProbe(path.join(tempDir(), "current.mjs"), "0.84.2");
		await expectDiagnostic(
			resolvePiRuntime({
				piPath: entry,
				env: { PATH: "" },
				requiredCapabilities: ["rpc.toolcall_identity"],
			}),
			"pi_capability_missing",
		);
	});
});

describe("Pi compatibility matrix", () => {
	it("records the pinned current and next-candidate adapter capabilities", () => {
		expect(PI_COMPATIBILITY_MATRIX["0.84.2"]).toMatchObject({
			status: "current",
			adapterId: "legacy-rpc-v1",
		});
		expect(PI_COMPATIBILITY_MATRIX["0.84.3"]).toMatchObject({
			status: "candidate",
			adapterId: "legacy-rpc-v1",
			capabilities: expect.arrayContaining(["rpc.toolcall_identity"]),
		});
	});

	it("does not treat inherited property names as compatible versions", () => {
		expect(compatibilityForPiVersion("__proto__")).toBeUndefined();
		expect(compatibilityForPiVersion("constructor")).toBeUndefined();
	});
});
