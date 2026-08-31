import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	startServerWithRuntimeComposition: vi.fn(),
}));

vi.mock("../src/main.js", () => ({
	startServerWithRuntimeComposition: mocks.startServerWithRuntimeComposition,
}));

import { runBenchmarkGateway } from "../src/benchmark-main.js";

const temporaryDirectories: string[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function installConnectedParent(): () => void {
	const connectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected");
	const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
	Object.defineProperty(process, "connected", { configurable: true, value: true, writable: true });
	Object.defineProperty(process, "send", { configurable: true, value: vi.fn(), writable: true });
	return () => {
		if (connectedDescriptor) Object.defineProperty(process, "connected", connectedDescriptor);
		else Reflect.deleteProperty(process, "connected");
		if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
		else Reflect.deleteProperty(process, "send");
	};
}

afterEach(() => {
	mocks.startServerWithRuntimeComposition.mockReset();
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("benchmark Gateway late-start lifecycle", () => {
	it.each(["SIGTERM", "disconnect"])("closes a late-ready product handle after %s", async (event) => {
		const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-benchmark-main-"));
		temporaryDirectories.push(staticDir);
		const previousStaticDir = process.env.PI_WEB_BENCHMARK_STATIC_DIR;
		process.env.PI_WEB_BENCHMARK_STATIC_DIR = staticDir;
		const restoreParent = installConnectedParent();
		const startup = deferred<{ close: () => Promise<void> }>();
		const close = vi.fn().mockResolvedValue(undefined);
		mocks.startServerWithRuntimeComposition.mockReturnValue(startup.promise);
		const listenerCount = process.listenerCount(event);

		try {
			const running = runBenchmarkGateway(["--host", "127.0.0.1", "--port", "0"]);
			await Promise.resolve();
			if (event === "SIGTERM") process.emit("SIGTERM");
			else process.emit("disconnect");
			startup.resolve({ close });
			await running;
			expect(close).toHaveBeenCalledTimes(1);
			expect(process.listenerCount(event)).toBe(listenerCount);
		} finally {
			restoreParent();
			if (previousStaticDir === undefined) delete process.env.PI_WEB_BENCHMARK_STATIC_DIR;
			else process.env.PI_WEB_BENCHMARK_STATIC_DIR = previousStaticDir;
		}
	});
});
