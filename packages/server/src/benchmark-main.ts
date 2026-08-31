#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
	BENCHMARK_GATEWAY_COUNTER_MESSAGE,
	createBenchmarkGatewayCounterPort,
	createInstrumentedRuntimeFactory,
	isBenchmarkGatewayCounterMessage,
} from "./benchmark-gateway.js";
import { assertLoopbackHost } from "./config.js";
import { startServerWithRuntimeComposition } from "./main.js";

interface EntryOptions {
	host: string;
	piPath?: string;
	port: number;
	staticDir: string;
}

const BENCHMARK_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

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

function sendCounterSnapshot(counters: ReturnType<typeof createBenchmarkGatewayCounterPort>): void {
	counters.sampleProcessMemory();
	const message = {
		type: BENCHMARK_GATEWAY_COUNTER_MESSAGE,
		counters: counters.snapshot(),
	};
	if (!isBenchmarkGatewayCounterMessage(message) || typeof process.send !== "function") return;
	try {
		process.send(message);
	} catch {
		// Losing the parent IPC channel must not perturb the measured Gateway.
	}
}

async function run(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const counters = createBenchmarkGatewayCounterPort();
	const handle = await startServerWithRuntimeComposition(
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
	const reporter = setInterval(() => sendCounterSnapshot(counters), 250);
	reporter.unref();
	sendCounterSnapshot(counters);
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		clearInterval(reporter);
		sendCounterSnapshot(counters);
		const forceExit = setTimeout(() => {
			console.error("benchmark Gateway shutdown timed out");
			process.exit(1);
		}, BENCHMARK_GRACEFUL_SHUTDOWN_TIMEOUT_MS);
		forceExit.unref();
		void handle.close().then(
			() => {
				clearTimeout(forceExit);
				process.exit(0);
			},
			(error: unknown) => {
				clearTimeout(forceExit);
				console.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			},
		);
	};
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	process.once("disconnect", close);
}

void run().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
