import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionCommandTypeDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import { createPiRpcAdapter, PI_RPC_ADAPTER_ID } from "../src/pi-rpc-adapter.js";
import { compatibilityForPiVersion, PI_COMPATIBILITY_MATRIX } from "../src/resolver.js";

interface CompatibilityFixture {
	version: string;
	status: "current" | "candidate";
	response?: string;
	event?: string;
	extension?: string;
}

interface CompatibilityFixtureManifest {
	versions: CompatibilityFixture[];
}

const fixtureRoot = path.resolve(fileURLToPath(new URL("./fixtures/pi-compatibility/", import.meta.url)));
const manifest = JSON.parse(
	fs.readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"),
) as CompatibilityFixtureManifest;

function readFixture(relativePath: string): unknown {
	const absolutePath = path.resolve(fixtureRoot, relativePath);
	const relativeToRoot = path.relative(fixtureRoot, absolutePath);
	if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
		throw new Error(`fixture escapes compatibility root: ${relativePath}`);
	}
	return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown;
}

function syncValue<T>(value: T | PromiseLike<T>): T {
	if (typeof value === "object" && value !== null && "then" in value) {
		throw new Error("compatibility fixture unexpectedly requires asynchronous externalization");
	}
	return value;
}

describe("Pi compatibility fixtures", () => {
	it("covers every exact matrix version with the declared promotion status", () => {
		expect(manifest.versions.map(({ version }) => version).sort()).toEqual(
			Object.keys(PI_COMPATIBILITY_MATRIX).sort(),
		);
		for (const fixture of manifest.versions) {
			const compatibility = compatibilityForPiVersion(fixture.version);
			expect(compatibility).toMatchObject({
				version: fixture.version,
				status: fixture.status,
				adapterId: PI_RPC_ADAPTER_ID,
			});
			if (!compatibility) continue;
			const adapter = createPiRpcAdapter(fixture.version, compatibility.capabilities);

			if (fixture.response) {
				const response = readFixture(fixture.response) as { command: SessionCommandTypeDto };
				const decoded = syncValue(adapter.decodePiResponse(response, response.command));
				expect(decoded.value).toMatchObject({ command: response.command, success: true });
				expect(decoded.lease).toBeNull();
			}
			if (fixture.event) {
				const decoded = syncValue(adapter.decodePiUnsolicited(readFixture(fixture.event)));
				expect(decoded.value.kind).toBe("event");
				if (fixture.status === "candidate") {
					expect(decoded.value.kind === "event" && decoded.value.event).toMatchObject({
						type: "message_update",
						assistantMessageEvent: { type: "toolcall_start", id: "tool-1", toolName: "read" },
					});
				}
			}
			if (fixture.extension) {
				const decoded = syncValue(adapter.decodePiUnsolicited(readFixture(fixture.extension)));
				expect(decoded.value).toMatchObject({
					kind: "extension_ui_request",
					request: { method: "confirm" },
				});
			}
		}
	});

	it("rejects a malformed fixture before it can become product data", () => {
		const compatibility = compatibilityForPiVersion("0.84.2");
		if (!compatibility) throw new Error("current fixture is missing from the matrix");
		const adapter = createPiRpcAdapter("0.84.2", compatibility.capabilities);
		expect(() =>
			adapter.decodePiUnsolicited({
				type: "message_start",
				message: { role: "user", content: 42, timestamp: 1 },
			}),
		).toThrowError(
			expect.objectContaining({
				name: "PiProtocolIncompatibleError",
				diagnostic: expect.objectContaining({ reason: "malformed_event" }),
			}),
		);
	});
});
