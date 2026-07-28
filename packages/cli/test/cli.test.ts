import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";

describe("pi-web CLI arguments", () => {
	it("uses a safe loopback default", () => {
		expect(parseCliArgs([])).toEqual({ host: "127.0.0.1", port: 3000, openInBrowser: true, help: false });
		expect(parseCliArgs(["--", "--help"])).toMatchObject({ help: true });
	});

	it("accepts explicit Pi and loopback options", () => {
		expect(parseCliArgs(["--pi-path", "/tmp/rpc-entry.mjs", "--host", "::1", "--port", "0"])).toEqual({
			piPath: "/tmp/rpc-entry.mjs",
			host: "::1",
			port: 0,
			openInBrowser: true,
			help: false,
		});
	});

	it("can suppress browser launching for automation", () => {
		expect(parseCliArgs(["--no-open"])).toMatchObject({ openInBrowser: false });
	});

	it("rejects untrusted listener options", () => {
		expect(() => parseCliArgs(["--host", "0.0.0.0"])).toThrow("PI_WEB_HOST");
		expect(() => parseCliArgs(["--port", "70000"])).toThrow("--port");
		expect(() => parseCliArgs(["--unknown"])).toThrow("Unknown option");
	});
});
