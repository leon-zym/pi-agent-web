#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackHost, startServer } from "@pi-agent-web/server";

export interface CliOptions {
	piPath?: string;
	host: string;
	port: number;
	openInBrowser: boolean;
	help: boolean;
}

const HELP = `Pi Agent Web

Usage: pi-web [options]

Options:
  --pi-path <path>  Path to a Pi executable or rpc-entry.js
  --host <host>     Loopback host (127.0.0.1, localhost, or ::1)
  --port <port>     Listening port (default: 3000; 0 selects a free port)
  --no-open         Do not open a browser automatically
  --help, -h        Show this help message
`;

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseCliArgs(args: string[]): CliOptions {
	const options: CliOptions = { host: "127.0.0.1", port: 3000, openInBrowser: true, help: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--":
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--no-open":
				options.openInBrowser = false;
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

export function resolveStaticDir(): string {
	const require = createRequire(import.meta.url);
	const packagePath = require.resolve("@pi-agent-web/ui/package.json");
	return path.join(path.dirname(packagePath), "dist");
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
	const options = parseCliArgs(args);
	if (options.help) {
		console.log(HELP);
		return;
	}
	const handle = await startServer({
		config: { host: options.host, port: options.port },
		...(options.piPath ? { piPath: options.piPath } : {}),
		staticDir: resolveStaticDir(),
		openInBrowser: options.openInBrowser,
		handleSignals: false,
	});
	let closing = false;
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			if (closing) return;
			closing = true;
			void handle.close().then(
				() => process.exit(0),
				(error: unknown) => {
					console.error(error);
					process.exit(1);
				},
			);
		});
	}
}

function isCliEntryPoint(invokedPath: string | undefined): boolean {
	if (!invokedPath) return false;
	try {
		return fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(invokedPath));
	} catch {
		return false;
	}
}

if (isCliEntryPoint(process.argv[1])) {
	void runCli().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
