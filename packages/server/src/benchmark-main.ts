#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BENCHMARK_GATEWAY_COUNTER_MESSAGE,
	type BenchmarkGatewayCounterPort,
	createBenchmarkGatewayCounterPort,
	createInstrumentedRuntimeFactory,
	GATEWAY_MEMORY_SAMPLE_INTERVAL_MS,
	isBenchmarkGatewayCounterMessage,
	isBenchmarkGatewayTrialControlMessage,
} from "./benchmark-gateway.js";
import { assertLoopbackHost } from "./config.js";
import { startServerWithRuntimeComposition } from "./main.js";

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

function sendCounterSnapshot(counters: BenchmarkGatewayCounterPort, generation: string): void {
	const message = {
		type: BENCHMARK_GATEWAY_COUNTER_MESSAGE,
		generation,
		trial: counters.trial(),
		counters: counters.snapshot(),
	};
	if (
		!isBenchmarkGatewayCounterMessage(message) ||
		typeof process.send !== "function" ||
		!process.connected
	) {
		return;
	}
	try {
		process.send(message);
	} catch {
		// Parent disconnect is handled by the lifecycle fence; an observation send cannot perturb Gateway work.
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The benchmark entry keeps all lifecycle authority private to its forked process. It relies on
 * startServer's bounded product shutdown rather than forcing process exit ahead of Pi cleanup.
 */
export async function runBenchmarkGateway(args = process.argv.slice(2)): Promise<void> {
	const options = parseArgs(args);
	if (typeof process.send !== "function" || !process.connected) {
		throw new Error("benchmark Gateway requires a connected parent IPC channel");
	}
	const counters = createBenchmarkGatewayCounterPort();
	const generation = `gateway-${randomUUID()}`;
	let handle: Awaited<ReturnType<typeof startServerWithRuntimeComposition>> | undefined;
	let reporter: ReturnType<typeof setInterval> | undefined;
	let closing = false;
	let closePromise: Promise<void> | undefined;

	const detachListeners = () => {
		process.off("message", onMessage);
		process.off("SIGINT", requestSignalClose);
		process.off("SIGTERM", requestSignalClose);
		process.off("disconnect", requestDisconnectClose);
	};
	const close = async (exitCode = 0): Promise<void> => {
		if (closePromise) return closePromise;
		closing = true;
		if (reporter) {
			clearInterval(reporter);
			reporter = undefined;
		}
		const active = counters.trial();
		if (active.state === "active" && active.id) {
			try {
				counters.abortTrial(active.id);
			} catch {
				// A malformed lifecycle must not escape the child into product behavior.
			}
		}
		sendCounterSnapshot(counters, generation);
		closePromise = (async () => {
			try {
				await handle?.close();
				if (exitCode !== 0) process.exitCode = exitCode;
			} finally {
				detachListeners();
			}
		})();
		return closePromise;
	};
	const failLifecycle = (message: string) => {
		console.error(message);
		void close(1).catch((error: unknown) => {
			console.error(errorText(error));
			process.exitCode = 1;
		});
	};
	const onMessage = (message: unknown) => {
		if (!isBenchmarkGatewayTrialControlMessage(message)) {
			failLifecycle("benchmark Gateway received malformed or unexpected parent IPC");
			return;
		}
		try {
			switch (message.action) {
				case "begin":
					counters.beginTrial(message.trialId);
					counters.sampleProcessMemory();
					break;
				case "end":
					counters.endTrial(message.trialId);
					break;
				case "abort":
					counters.abortTrial(message.trialId);
					break;
			}
			sendCounterSnapshot(counters, generation);
		} catch (error) {
			failLifecycle(`benchmark Gateway rejected trial lifecycle: ${errorText(error)}`);
		}
	};
	const requestSignalClose = () => {
		void close().catch((error: unknown) => {
			console.error(errorText(error));
			process.exitCode = 1;
		});
	};
	const requestDisconnectClose = () => {
		void close().catch((error: unknown) => {
			console.error(errorText(error));
			process.exitCode = 1;
		});
	};

	// Register cancellation before the awaited product startup so a late-ready Gateway is immediately closed.
	process.on("message", onMessage);
	process.once("SIGINT", requestSignalClose);
	process.once("SIGTERM", requestSignalClose);
	process.once("disconnect", requestDisconnectClose);
	try {
		handle = await startServerWithRuntimeComposition(
			{
				config: { host: options.host, port: options.port },
				...(options.piPath ? { piPath: options.piPath } : {}),
				staticDir: options.staticDir,
				openInBrowser: false,
				handleSignals: false,
			},
			{
				createRuntimeFactory: (services) => createInstrumentedRuntimeFactory(services, counters),
				onPublication: (message) => counters.recordPublication(message),
			},
		);
		if (closing || !process.connected) {
			await handle.close();
			detachListeners();
			return;
		}
		reporter = setInterval(() => {
			counters.sampleProcessMemory();
			sendCounterSnapshot(counters, generation);
		}, GATEWAY_MEMORY_SAMPLE_INTERVAL_MS);
		reporter.unref();
		sendCounterSnapshot(counters, generation);
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
