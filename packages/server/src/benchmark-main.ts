#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackHost } from "./config.js";
import { startServer } from "./main.js";

interface EntryOptions {
	host: string;
	piPath?: string;
	port: number;
	staticDir: string;
}

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
	return value;
}

function staticDirFromEnvironment(): string {
	const value = process.env.PI_WEB_BENCHMARK_STATIC_DIR;
	if (!value || !path.isAbsolute(value)) {
		throw new Error("PI_WEB_BENCHMARK_STATIC_DIR must be an absolute built UI directory");
	}
	const resolved = fs.realpathSync(value);
	if (!fs.statSync(resolved).isDirectory()) {
		throw new Error("PI_WEB_BENCHMARK_STATIC_DIR must resolve to a directory");
	}
	return resolved;
}

function parseArgs(args: string[]): EntryOptions {
	const options: EntryOptions = {
		host: "127.0.0.1",
		port: 3000,
		staticDir: staticDirFromEnvironment(),
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--no-open":
				break;
			case "--pi-path":
				options.piPath = requireValue(args, index, arg);
				index += 1;
				break;
			case "--host":
				options.host = requireValue(args, index, arg);
				index += 1;
				break;
			case "--port": {
				const value = requireValue(args, index, arg);
				const port = Number.parseInt(value, 10);
				if (!/^[0-9]+$/.test(value) || port < 0 || port > 65_535) {
					throw new Error("--port must be an integer between 0 and 65535");
				}
				options.port = port;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	assertLoopbackHost(options.host);
	return options;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The benchmark entry exists solely to serve a run-owned static UI directory. Its parent IPC
 * channel is a lifecycle fence, not a benchmark data or product protocol.
 */
export async function runBenchmarkGateway(args = process.argv.slice(2)): Promise<void> {
	const options = parseArgs(args);
	if (typeof process.send !== "function" || !process.connected) {
		throw new Error("benchmark Gateway requires a connected parent IPC channel");
	}

	let handle: Awaited<ReturnType<typeof startServer>> | undefined;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const detachListeners = () => {
		process.off("SIGINT", requestSignalClose);
		process.off("SIGTERM", requestSignalClose);
		process.off("disconnect", requestDisconnectClose);
	};
	const close = async (exitCode = 0): Promise<void> => {
		if (closePromise) return closePromise;
		closing = true;
		closePromise = (async () => {
			try {
				await handle?.close();
			} finally {
				if (exitCode !== 0) process.exitCode = exitCode;
				detachListeners();
			}
		})();
		return closePromise;
	};
	const requestClose = (exitCode = 0) => {
		void close(exitCode).catch((error: unknown) => {
			console.error(errorText(error));
			process.exitCode = 1;
		});
	};
	const requestSignalClose = () => requestClose();
	const requestDisconnectClose = () => requestClose();

	// Register before the awaited product startup: a late-ready child is always closed.
	process.once("SIGINT", requestSignalClose);
	process.once("SIGTERM", requestSignalClose);
	process.once("disconnect", requestDisconnectClose);
	try {
		handle = await startServer({
			config: { host: options.host, port: options.port },
			...(options.piPath ? { piPath: options.piPath } : {}),
			staticDir: options.staticDir,
			openInBrowser: false,
			handleSignals: false,
		});
		if (closing || !process.connected) {
			await handle.close();
			detachListeners();
		}
	} catch (error) {
		await close(1).catch((closeError: unknown) => {
			console.error(errorText(closeError));
		});
		throw error;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void runBenchmarkGateway().catch((error: unknown) => {
		console.error(errorText(error));
		process.exitCode = 1;
	});
}
