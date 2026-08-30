import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	SESSION_PAYLOAD_BUDGET,
} from "@pi-agent-web/protocol";
import { getAgentDir } from "../src/config.js";
import { startServer } from "../src/main.js";

const RUN_REAL_E2E = process.env.PI_WEB_RUN_E2E === "1";
const COMMAND_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const MAX_COPIED_CONFIG_BYTES = 16 * 1024 * 1024;
const PRIVATE_CONFIG_FILES = ["auth.json", "models.json"] as const;
const REAL_EXTENSION_COMPLETE = "PI_WEB_REAL_EXTENSION_COMPLETE";
const REAL_EXTENSION_CANCEL = "PI_WEB_REAL_EXTENSION_CANCEL";
const REAL_EXTENSION_TIMEOUT = "PI_WEB_REAL_EXTENSION_TIMEOUT";
const REAL_EXTENSION_PROCESS_LOSS = "PI_WEB_REAL_EXTENSION_PROCESS_LOSS";
const REAL_EXTENSION_SOURCE = String.raw`
import * as fs from "node:fs";
import path from "node:path";

const COMPLETE = "PI_WEB_REAL_EXTENSION_COMPLETE";
const CANCEL = "PI_WEB_REAL_EXTENSION_CANCEL";
const TIMEOUT = "PI_WEB_REAL_EXTENSION_TIMEOUT";
const PROCESS_LOSS = "PI_WEB_REAL_EXTENSION_PROCESS_LOSS";
const tracePath = path.join(process.cwd(), ".pi-web-real-extension-trace.jsonl");
const pidPath = path.join(process.cwd(), ".pi-web-real-extension.pid");
const providerPath = path.join(process.cwd(), ".pi-web-real-extension-provider");

function record(value) {
	fs.appendFileSync(tracePath, JSON.stringify(value) + "\n", "utf8");
}

export default function (pi) {
	pi.on("before_provider_request", () => {
		fs.writeFileSync(providerPath, "provider-called\n", "utf8");
		record({ kind: "provider" });
	});

	pi.on("input", async (event, ctx) => {
		if (event.text === COMPLETE) {
			ctx.ui.setStatus("real-status", "E2E_REAL_STATUS");
			ctx.ui.setWidget("real-widget", ["E2E_REAL_WIDGET_LINE_1", "E2E_REAL_WIDGET_LINE_2"], {
				placement: "belowEditor",
			});
			ctx.ui.setTitle("E2E_REAL_EXTENSION_TITLE");
			ctx.ui.setEditorText("E2E_REAL_EDITOR_TEXT");
			ctx.ui.notify("E2E_REAL_NOTIFY", "info");
			const selected = await ctx.ui.select("E2E real select", ["safe", "fast"]);
			const confirmed = await ctx.ui.confirm("E2E real confirm", "Continue the real Extension flow?");
			const input = await ctx.ui.input("E2E real input", "real value");
			const edited = await ctx.ui.editor("E2E real editor", "E2E_REAL_EDITOR_PREFILL");
			ctx.ui.setStatus("real-status", undefined);
			ctx.ui.setWidget("real-widget", undefined);
			ctx.ui.setTitle("");
			ctx.ui.setEditorText("");
			record({ kind: "complete", selected, confirmed, input, edited });
			return { action: "handled" };
		}

		if (event.text === CANCEL) {
			const confirmed = await ctx.ui.confirm("E2E real cancellation", "Cancel this real Extension flow?");
			record({ kind: "cancel", confirmed });
			return { action: "handled" };
		}

		if (event.text === TIMEOUT) {
			const confirmed = await ctx.ui.confirm("E2E real timeout", "This dialog expires.", { timeout: 250 });
			record({ kind: "timeout", confirmed });
			return { action: "handled" };
		}

		if (event.text === PROCESS_LOSS) {
			fs.writeFileSync(pidPath, String(process.pid) + "\n", "utf8");
			const confirmed = await ctx.ui.confirm("E2E real process loss", "The process will be terminated.");
			record({ kind: "process_loss", confirmed });
			return { action: "handled" };
		}

		return { action: "continue" };
	});
}
`;

interface RuntimeSnapshot {
	sessionHandle: string;
	workspaceId: string;
	nativeSessionId: string;
	sessionFile: string | null;
	generation: number;
	lastSeq: number;
	state: string;
	recoverable: boolean;
}

interface RpcResult {
	success?: boolean;
	error?: string;
	data?: unknown;
}

interface ResponseEnvelope {
	sessionHandle: string;
	generation: number;
	previousSessionHandle?: string;
	response: RpcResult & { id?: string; command?: string };
}

interface ModelSummary {
	provider: string;
	id: string;
	name?: string;
	input?: unknown;
}

interface SessionRef {
	handle: string;
	generation: number;
	fencingToken?: string;
	runtime?: RuntimeSnapshot;
	error?: string;
	events: Array<Record<string, unknown>>;
	extensionRequests: Array<Record<string, unknown>>;
	extensionClosed: Array<Record<string, unknown>>;
	extensionResults: Array<Record<string, unknown>>;
	sessionSnapshots: Array<Record<string, unknown>>;
	sessionErrors: Array<Record<string, unknown>>;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function fileFingerprint(filePath: string): string {
	try {
		const linkStat = fs.lstatSync(filePath, { bigint: true });
		const targetStat = fs.statSync(filePath, { bigint: true });
		if (!targetStat.isFile()) throw new Error("not a regular file");
		return JSON.stringify({
			kind: linkStat.isSymbolicLink() ? "symlink" : "file",
			linkDev: linkStat.dev.toString(),
			linkIno: linkStat.ino.toString(),
			linkMode: linkStat.mode.toString(),
			linkSize: linkStat.size.toString(),
			linkMtimeNs: linkStat.mtimeNs.toString(),
			linkTargetDigest: linkStat.isSymbolicLink() ? sha256(fs.readlinkSync(filePath)) : undefined,
			targetDev: targetStat.dev.toString(),
			targetIno: targetStat.ino.toString(),
			targetMode: targetStat.mode.toString(),
			targetSize: targetStat.size.toString(),
			targetMtimeNs: targetStat.mtimeNs.toString(),
			contentDigest: sha256(fs.readFileSync(filePath)),
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw new Error("Unable to fingerprint the real Pi settings file", { cause: error });
	}
}

function copyOptionalPrivateConfig(sourceDir: string, destinationDir: string, fileName: string): void {
	const source = path.join(sourceDir, fileName);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(source, fs.constants.O_RDONLY);
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size > MAX_COPIED_CONFIG_BYTES) {
			throw new Error("unsupported source file");
		}
		const contents = fs.readFileSync(descriptor);
		const destination = path.join(destinationDir, fileName);
		fs.writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
		fs.chmodSync(destination, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error(`Unable to copy Pi ${fileName} into the isolated test configuration`, {
			cause: error,
		});
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function timeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timeout after ${String(timeoutMs)}ms`)),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function capturePromise<T>(
	promise: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; error: unknown }> {
	return promise.then(
		(value) => ({ status: "fulfilled" as const, value }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`${label} timeout after ${String(timeoutMs)}ms`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
		})
		.join("");
}

function messagesFrom(result: RpcResult): Array<{ role?: string; content?: unknown }> {
	const data = result.data as { messages?: unknown } | undefined;
	if (!Array.isArray(data?.messages)) throw new Error("get_messages returned an invalid payload");
	return data.messages as Array<{ role?: string; content?: unknown }>;
}

function hasText(messages: Array<{ content?: unknown }>, marker: string): boolean {
	return messages.some((message) => messageText(message).includes(marker));
}

function chooseImageModel(models: ModelSummary[]): ModelSummary {
	const capable = models.filter(
		(model) => Array.isArray(model.input) && (model.input as unknown[]).includes("image"),
	);
	if (capable.length === 0)
		throw new Error("get_available_models returned no configured image-capable model");

	const requested = process.env.PI_WEB_E2E_IMAGE_MODEL;
	const preferences = [
		requested,
		"commandcode/gpt-5.4",
		"commandcode/gpt-5.4-mini",
		"commandcode/google/gemini-3.1-flash-lite",
		"openai-codex/gpt-5.4-mini",
		"openai-codex/gpt-5.4",
	].filter((value): value is string => Boolean(value));
	for (const preference of preferences) {
		const match = capable.find((model) => `${model.provider}/${model.id}` === preference);
		if (match) return match;
	}
	return capable[0] as ModelSummary;
}

class MultiplexClient {
	private readonly refs = new Map<string, SessionRef>();
	private readonly pending = new Map<string, (envelope: ResponseEnvelope) => void>();
	private sequence = 0;

	constructor(private readonly ws: import("ws").default) {
		ws.on("message", (raw) => this.receive(JSON.parse(raw.toString()) as Record<string, unknown>));
	}

	private receive(frame: Record<string, unknown>): void {
		if (frame.type === "session_rekeyed") {
			const previous = frame.previousSessionHandle;
			const runtime = frame.runtime as RuntimeSnapshot | undefined;
			if (typeof previous !== "string" || !runtime) return;
			const ref = this.refs.get(previous);
			if (!ref) return;
			this.refs.delete(previous);
			ref.handle = runtime.sessionHandle;
			ref.generation = runtime.generation;
			ref.runtime = runtime;
			this.refs.set(ref.handle, ref);
			return;
		}
		if (frame.type === "runtime_state") {
			const runtime = frame.runtime as RuntimeSnapshot | undefined;
			if (!runtime) return;
			const ref = this.refs.get(runtime.sessionHandle);
			if (ref) {
				ref.runtime = runtime;
				ref.generation = runtime.generation;
			}
			return;
		}
		if (frame.type === "lease_status") {
			const handle = frame.sessionHandle;
			if (typeof handle !== "string") return;
			const ref = this.refs.get(handle);
			if (ref && frame.isController === true && typeof frame.fencingToken === "string") {
				ref.fencingToken = frame.fencingToken;
			}
			return;
		}
		if (frame.type === "session_error") {
			const handle = frame.sessionHandle;
			if (typeof handle === "string") {
				const ref = this.refs.get(handle);
				if (ref) {
					ref.sessionErrors.push(frame);
					if (frame.operation === "subscribe" || frame.operation === "claim") {
						ref.error = String(frame.error ?? "unknown Session error");
					}
				}
			}
			return;
		}
		if (frame.type === "extension_ui_request") {
			const handle = frame.sessionHandle;
			const request = frame.request;
			if (typeof handle === "string" && request && typeof request === "object") {
				this.refs.get(handle)?.extensionRequests.push(request as Record<string, unknown>);
			}
			return;
		}
		if (frame.type === "extension_ui_closed") {
			const handle = frame.sessionHandle;
			if (typeof handle === "string") this.refs.get(handle)?.extensionClosed.push(frame);
			return;
		}
		if (frame.type === "extension_ui_result") {
			const handle = frame.sessionHandle;
			if (typeof handle === "string") this.refs.get(handle)?.extensionResults.push(frame);
			return;
		}
		if (frame.type === "session_snapshot") {
			const handle = frame.sessionHandle;
			if (typeof handle === "string") this.refs.get(handle)?.sessionSnapshots.push(frame);
			return;
		}
		if (frame.type === "response") {
			const response = frame.response as ResponseEnvelope["response"] | undefined;
			if (!response?.id) return;
			this.pending.get(response.id)?.({
				sessionHandle: String(frame.sessionHandle),
				generation: Number(frame.generation),
				...(typeof frame.previousSessionHandle === "string"
					? { previousSessionHandle: frame.previousSessionHandle }
					: {}),
				response,
			});
			this.pending.delete(response.id);
			return;
		}
		if (frame.type === "event") {
			const handle = frame.sessionHandle;
			const event = frame.event;
			if (typeof handle === "string" && event && typeof event === "object") {
				this.refs.get(handle)?.events.push(event as Record<string, unknown>);
			}
		}
	}

	async attach(runtime: RuntimeSnapshot): Promise<SessionRef> {
		const ref: SessionRef = {
			handle: runtime.sessionHandle,
			generation: runtime.generation,
			events: [],
			extensionRequests: [],
			extensionClosed: [],
			extensionResults: [],
			sessionSnapshots: [],
			sessionErrors: [],
		};
		this.refs.set(ref.handle, ref);
		this.ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle: ref.handle }));
		await waitUntil(
			() => Boolean(ref.runtime) || Boolean(ref.error),
			COMMAND_TIMEOUT_MS,
			"session subscribe",
		);
		if (ref.error) throw new Error(`session subscribe failed: ${ref.error}`);
		this.ws.send(JSON.stringify({ type: "session_claim", sessionHandle: ref.handle }));
		await waitUntil(
			() => Boolean(ref.fencingToken) || Boolean(ref.error),
			COMMAND_TIMEOUT_MS,
			"session claim",
		);
		if (ref.error) throw new Error(`session claim failed: ${ref.error}`);
		return ref;
	}

	async attachExisting(handle: string): Promise<SessionRef> {
		const ref: SessionRef = {
			handle,
			generation: 0,
			events: [],
			extensionRequests: [],
			extensionClosed: [],
			extensionResults: [],
			sessionSnapshots: [],
			sessionErrors: [],
		};
		this.refs.set(handle, ref);
		this.ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle: handle }));
		await waitUntil(
			() => Boolean(ref.runtime) || Boolean(ref.error),
			COMMAND_TIMEOUT_MS,
			"parent session subscribe",
		);
		if (ref.error) throw new Error(`parent session subscribe failed: ${ref.error}`);
		this.ws.send(JSON.stringify({ type: "session_claim", sessionHandle: handle }));
		await waitUntil(
			() => Boolean(ref.fencingToken) || Boolean(ref.error),
			COMMAND_TIMEOUT_MS,
			"parent session claim",
		);
		if (ref.error) throw new Error(`parent session claim failed: ${ref.error}`);
		return ref;
	}

	async observe(runtime: RuntimeSnapshot): Promise<SessionRef> {
		const ref: SessionRef = {
			handle: runtime.sessionHandle,
			generation: runtime.generation,
			events: [],
			extensionRequests: [],
			extensionClosed: [],
			extensionResults: [],
			sessionSnapshots: [],
			sessionErrors: [],
		};
		this.refs.set(ref.handle, ref);
		this.ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle: ref.handle }));
		await waitUntil(
			() => Boolean(ref.runtime) || Boolean(ref.error),
			COMMAND_TIMEOUT_MS,
			"observer session subscribe",
		);
		if (ref.error) throw new Error(`observer session subscribe failed: ${ref.error}`);
		return ref;
	}

	async sendExtensionUiResponse(
		ref: SessionRef,
		response: Record<string, unknown>,
		label: string,
		expectation: "result" | "error" = "result",
	): Promise<Record<string, unknown>> {
		if (typeof response.id !== "string") throw new Error(`${label} has no Extension UI request id`);
		if (!ref.fencingToken && expectation === "result") {
			throw new Error(`${label} has no controller fencing token`);
		}
		const resultCount = ref.extensionResults.length;
		const errorCount = ref.sessionErrors.length;
		this.ws.send(
			JSON.stringify({
				type: "extension_ui_response",
				sessionHandle: ref.handle,
				expectedGeneration: ref.generation,
				fencingToken: ref.fencingToken ?? "observer-no-lease",
				response: { ...response, type: "extension_ui_response" },
			}),
		);
		await waitUntil(
			() => ref.extensionResults.length > resultCount || ref.sessionErrors.length > errorCount,
			COMMAND_TIMEOUT_MS,
			label,
		);
		const error = ref.sessionErrors
			.slice(errorCount)
			.find((frame) => frame.operation === "extension_ui_response");
		const result = ref.extensionResults.slice(resultCount).find((frame) => frame.requestId === response.id);
		if (expectation === "error") {
			if (!error) throw new Error(`${label} did not produce the expected Session error`);
			return error;
		}
		if (error) throw new Error(`${label} failed: ${String(error.error ?? "unknown Session error")}`);
		if (!result) throw new Error(`${label} did not produce an Extension UI result`);
		return result;
	}

	async command(
		ref: SessionRef,
		payload: Record<string, unknown>,
		label: string,
		timeoutMs = COMMAND_TIMEOUT_MS,
	): Promise<ResponseEnvelope> {
		this.sequence += 1;
		const id = `real-e2e-${String(this.sequence)}`;
		const response = new Promise<ResponseEnvelope>((resolve) => this.pending.set(id, resolve));
		this.ws.send(
			JSON.stringify({
				type: "command",
				sessionHandle: ref.handle,
				expectedGeneration: ref.generation,
				...(ref.fencingToken ? { fencingToken: ref.fencingToken } : {}),
				command: { id, ...payload },
			}),
		);
		let envelope: ResponseEnvelope;
		try {
			envelope = await timeout(response, timeoutMs, label);
		} finally {
			this.pending.delete(id);
		}
		if (envelope.response.success !== true) {
			throw new Error(`${label} failed: ${envelope.response.error ?? "unknown RPC error"}`);
		}
		return envelope;
	}

	async waitForSettled(ref: SessionRef, previousCount: number, label: string): Promise<void> {
		await waitUntil(
			() =>
				ref.events.filter((event) => event.type === "agent_settled").length > previousCount &&
				ref.runtime?.state === "idle",
			TURN_TIMEOUT_MS,
			label,
		);
	}
}

async function connectMultiplexClient(
	port: number,
	authHeaders: Record<string, string>,
): Promise<{ ws: import("ws").default; client: MultiplexClient }> {
	const WebSocketCtor = (await import("ws")).default;
	const ws = new WebSocketCtor(`ws://127.0.0.1:${String(port)}/api/v1/ws`, {
		headers: authHeaders,
	});
	try {
		await timeout(
			new Promise<void>((resolve, reject) => {
				ws.once("open", resolve);
				ws.once("error", reject);
			}),
			COMMAND_TIMEOUT_MS,
			"WebSocket open",
		);
		await timeout(
			new Promise<void>((resolve, reject) => {
				ws.once("message", (raw) => {
					try {
						const frame = JSON.parse(raw.toString()) as { type?: string };
						if (frame.type === "server_hello") resolve();
						else reject(new Error("Gateway rejected real-E2E client hello"));
					} catch (error) {
						reject(error);
					}
				});
				ws.once("error", reject);
				ws.send(
					JSON.stringify({
						type: "client_hello",
						protocol: GATEWAY_PROTOCOL_VERSION,
						clientBuild: "real-e2e",
						capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
						limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
					}),
				);
			}),
			COMMAND_TIMEOUT_MS,
			"WebSocket hello",
		);
		return { ws, client: new MultiplexClient(ws) };
	} catch (error) {
		await closeWebSocket(ws);
		throw error;
	}
}

async function closeWebSocket(ws: import("ws").default): Promise<void> {
	if (ws.readyState === 3) return;
	await new Promise<void>((resolve) => {
		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			resolve();
		};
		ws.once("close", finish);
		ws.once("error", finish);
		ws.close();
		timer = setTimeout(finish, 1_000);
	});
}

async function waitForExtensionRequest(
	ref: SessionRef,
	predicate: (request: Record<string, unknown>) => boolean,
	label: string,
): Promise<Record<string, unknown>> {
	await waitUntil(() => ref.extensionRequests.some(predicate), COMMAND_TIMEOUT_MS, label);
	const request = [...ref.extensionRequests].reverse().find(predicate);
	if (!request) throw new Error(`${label} did not expose a matching request`);
	return request;
}

function extensionRequestId(request: Record<string, unknown>, label: string): string {
	if (typeof request.id !== "string") throw new Error(`${label} request has no id`);
	return request.id;
}

function readSafeProcessId(filePath: string): number | null {
	try {
		const text = fs.readFileSync(filePath, "utf8").trim();
		if (!/^[1-9][0-9]*$/.test(text)) return null;
		const pid = Number(text);
		if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null;
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

async function waitForExtensionClose(
	ref: SessionRef,
	requestId: string,
	reason: string,
	label: string,
): Promise<Record<string, unknown>> {
	await waitUntil(
		() => ref.extensionClosed.some((frame) => frame.requestId === requestId && frame.reason === reason),
		COMMAND_TIMEOUT_MS,
		label,
	);
	const frame = [...ref.extensionClosed]
		.reverse()
		.find((candidate) => candidate.requestId === requestId && candidate.reason === reason);
	if (!frame) throw new Error(`${label} did not expose the expected close frame`);
	return frame;
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

if (!RUN_REAL_E2E) {
	console.log(
		"REAL PI E2E SKIPPED (expected): set PI_WEB_RUN_E2E=1 to use configured provider credentials in isolated temporary Sessions.",
	);
} else {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-real-e2e-"));
	const workspacePath = path.join(tempRoot, "workspace");
	const sessionRootDir = path.join(tempRoot, "sessions");
	const webDataDir = path.join(tempRoot, "web-data");
	const isolatedAgentDir = path.join(tempRoot, "agent");
	const realAgentDir = getAgentDir(process.env);
	const realSettingsPath = path.join(realAgentDir, "settings.json");
	const realSettingsBefore = fileFingerprint(realSettingsPath);
	const extensionDir = path.join(isolatedAgentDir, "extensions");
	const extensionPath = path.join(extensionDir, "real-e2e-extension.ts");
	fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
	fs.mkdirSync(isolatedAgentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(extensionDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(workspacePath, 0o700);
	fs.chmodSync(isolatedAgentDir, 0o700);
	fs.chmodSync(extensionDir, 0o700);
	fs.writeFileSync(extensionPath, REAL_EXTENSION_SOURCE, { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(extensionPath, 0o600);
	for (const fileName of PRIVATE_CONFIG_FILES) {
		copyOptionalPrivateConfig(realAgentDir, isolatedAgentDir, fileName);
	}
	let handle: Awaited<ReturnType<typeof startServer>> | undefined;
	let ws: import("ws").default | undefined;
	const extraSockets: Array<import("ws").default> = [];

	try {
		const started = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: isolatedAgentDir,
				sessionRootDir,
				webDataDir,
			},
			handleSignals: false,
		});
		handle = started;
		const address = started.server.address();
		if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
		const base = `http://127.0.0.1:${String(address.port)}`;
		const bootstrap = await fetch(`${base}/api/v1/bootstrap`, {
			headers: { Origin: base },
			signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
		});
		if (!bootstrap.ok) throw new Error(`bootstrap failed: ${String(bootstrap.status)}`);
		const setCookie = bootstrap.headers.get("set-cookie");
		if (!setCookie) throw new Error("bootstrap did not set a session cookie");
		const cookie = setCookie.split(";", 1)[0] ?? "";
		const authHeaders = { Origin: base, Cookie: cookie };

		const workspaceResponse = await fetch(`${base}/api/v1/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders },
			body: JSON.stringify({ path: workspacePath }),
			signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
		});
		if (!workspaceResponse.ok) {
			throw new Error(`workspace registration failed: ${String(workspaceResponse.status)}`);
		}
		const workspace = (await workspaceResponse.json()) as { workspaceHandle: string };
		const createSession = async (): Promise<RuntimeSnapshot> => {
			const response = await fetch(`${base}/api/v1/workspaces/${workspace.workspaceHandle}/sessions`, {
				method: "POST",
				headers: authHeaders,
				signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`session creation failed: ${String(response.status)}`);
			return ((await response.json()) as { runtime: RuntimeSnapshot }).runtime;
		};

		const [runtimeA, runtimeB] = await Promise.all([createSession(), createSession()]);
		if (runtimeA.sessionHandle === runtimeB.sessionHandle) {
			throw new Error("two Session creations returned the same handle");
		}

		const connected = await connectMultiplexClient(address.port, authHeaders);
		ws = connected.ws;
		const client = connected.client;
		const [sessionA, sessionB] = await Promise.all([client.attach(runtimeA), client.attach(runtimeB)]);

		const available = await client.command(
			sessionA,
			{ type: "get_available_models" },
			"get_available_models",
		);
		const models = (available.response.data as { models?: ModelSummary[] } | undefined)?.models;
		if (!Array.isArray(models)) throw new Error("get_available_models returned no model array");
		const model = chooseImageModel(models);
		console.log(`Real Pi model: ${model.provider}/${model.id} (image input verified by RPC metadata)`);

		await Promise.all(
			[sessionA, sessionB].map(async (session, index) => {
				await client.command(
					session,
					{ type: "set_model", provider: model.provider, modelId: model.id },
					`set_model Session ${index === 0 ? "A" : "B"}`,
				);
				await client.command(
					session,
					{ type: "set_thinking_level", level: "off" },
					`set_thinking_level Session ${index === 0 ? "A" : "B"}`,
				);
			}),
		);
		if (!fs.existsSync(path.join(isolatedAgentDir, "settings.json"))) {
			throw new Error("Pi did not persist runtime choices inside the isolated Agent directory");
		}

		// A valid, tiny synthetic PNG. No user files or historical Sessions are read.
		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
		const markerB = "PI_WEB_PARALLEL_B_7F3A";
		const settledA = sessionA.events.filter((event) => event.type === "agent_settled").length;
		const settledB = sessionB.events.filter((event) => event.type === "agent_settled").length;
		await Promise.all([
			client.command(
				sessionA,
				{
					type: "prompt",
					message: "",
					images: [{ type: "image", data: pngBase64, mimeType: "image/png" }],
					streamingBehavior: "steer",
				},
				"image-only prompt Session A",
			),
			client.command(
				sessionB,
				{
					type: "prompt",
					message: `只回复这个标记，不要解释：${markerB}`,
					streamingBehavior: "steer",
				},
				"parallel prompt Session B",
			),
		]);
		await Promise.all([
			client.waitForSettled(sessionA, settledA, "image-only Session A settlement"),
			client.waitForSettled(sessionB, settledB, "parallel Session B settlement"),
		]);

		const [messagesAAfterImage, messagesB] = await Promise.all([
			client.command(sessionA, { type: "get_messages" }, "get_messages Session A"),
			client.command(sessionB, { type: "get_messages" }, "get_messages Session B"),
		]);
		const listAAfterImage = messagesFrom(messagesAAfterImage.response);
		const listB = messagesFrom(messagesB.response);
		if (!listAAfterImage.some((message) => message.role === "assistant")) {
			throw new Error("image-only prompt did not yield an assistant message");
		}
		if (!listB.some((message) => message.role === "assistant") || !hasText(listB, markerB)) {
			throw new Error("parallel Session B did not preserve its own prompt and assistant response");
		}
		if (hasText(listAAfterImage, markerB)) {
			throw new Error("Session B content leaked into Session A");
		}
		console.log("parallel Sessions + image-only prompt ok");

		const injectedMarker = "PI_WEB_FOLLOW_UP_91C2";
		const beforeInjectedSettle = sessionA.events.filter((event) => event.type === "agent_settled").length;
		await client.command(
			sessionA,
			{
				type: "prompt",
				message: "从 1 数到 20，每个数字单独一行。",
				streamingBehavior: "steer",
			},
			"streaming prompt Session A",
		);
		await client.command(
			sessionA,
			{ type: "follow_up", message: `只回复这个标记：${injectedMarker}` },
			"follow_up while streaming Session A",
		);
		await client.waitForSettled(sessionA, beforeInjectedSettle, "follow_up Session A settlement");
		const messagesAfterInjection = messagesFrom(
			(await client.command(sessionA, { type: "get_messages" }, "get_messages after follow_up")).response,
		);
		if (!hasText(messagesAfterInjection, injectedMarker)) {
			throw new Error("follow_up marker was not delivered into Session A history");
		}
		console.log("follow_up during streaming ok");

		const middleMarker = "PI_WEB_MIDDLE_B_3A71";
		const beforeMiddleSettle = sessionB.events.filter((event) => event.type === "agent_settled").length;
		await client.command(
			sessionB,
			{
				type: "prompt",
				message: `只回复这个标记：${middleMarker}`,
				streamingBehavior: "steer",
			},
			"middle prompt Session B",
		);
		await client.waitForSettled(sessionB, beforeMiddleSettle, "middle Session B settlement");

		const beforeAbortSettle = sessionB.events.filter((event) => event.type === "agent_settled").length;
		await client.command(
			sessionB,
			{
				type: "prompt",
				message: "写一篇至少 3000 字的中文文章，逐节讨论异步运行时设计。",
				streamingBehavior: "steer",
			},
			"abortable prompt Session B",
		);
		await client.command(sessionB, { type: "abort" }, "abort Session B");
		await client.waitForSettled(sessionB, beforeAbortSettle, "abort Session B settlement");
		console.log("abort ok");

		const forkMessages = (
			await client.command(sessionB, { type: "get_fork_messages" }, "get_fork_messages Session B")
		).response.data as { messages?: Array<{ entryId?: string; text?: string }> } | undefined;
		if ((forkMessages?.messages?.length ?? 0) < 3) {
			throw new Error("Session B exposed too few user entries for middle/leaf/root Fork coverage");
		}
		const originalSessionBHandle = sessionB.handle;
		const originalSessionBGeneration = sessionB.generation;
		const middleForkMessage = forkMessages?.messages?.[1];
		if (!middleForkMessage?.entryId) throw new Error("Session B exposed no ordinary middle Fork entry");
		const middleFork = await client.command(
			sessionB,
			{ type: "fork", entryId: middleForkMessage.entryId },
			"fork Session B from an ordinary middle user entry",
		);
		if (
			middleFork.previousSessionHandle !== originalSessionBHandle ||
			middleFork.sessionHandle === originalSessionBHandle ||
			middleFork.generation !== originalSessionBGeneration + 1 ||
			(middleFork.response.data as { cancelled?: boolean } | undefined)?.cancelled !== false ||
			sessionB.runtime?.recoverable !== true ||
			!sessionB.runtime.sessionFile ||
			!fs.existsSync(sessionB.runtime.sessionFile)
		) {
			throw new Error("ordinary middle Fork did not produce a persisted child identity");
		}
		const middleForkHistory = messagesFrom(
			(await client.command(sessionB, { type: "get_messages" }, "get_messages middle Fork child")).response,
		);
		if (!hasText(middleForkHistory, markerB) || hasText(middleForkHistory, middleMarker)) {
			throw new Error("ordinary middle Fork retained the selected user entry or lost its parent history");
		}

		const leafForkParent = await client.attachExisting(originalSessionBHandle);
		const leafForkMessage = forkMessages?.messages?.at(-1);
		if (!leafForkMessage?.entryId) throw new Error("Session B exposed no leaf Fork entry");
		const leafParentGeneration = leafForkParent.generation;
		const leafFork = await client.command(
			leafForkParent,
			{ type: "fork", entryId: leafForkMessage.entryId },
			"fork Session B from its leaf user entry",
		);
		if (
			leafFork.previousSessionHandle !== originalSessionBHandle ||
			leafFork.sessionHandle === originalSessionBHandle ||
			leafFork.generation !== leafParentGeneration + 1 ||
			(leafFork.response.data as { cancelled?: boolean } | undefined)?.cancelled !== false ||
			leafForkParent.runtime?.recoverable !== true ||
			!leafForkParent.runtime.sessionFile ||
			!fs.existsSync(leafForkParent.runtime.sessionFile)
		) {
			throw new Error("leaf Fork did not produce a persisted child identity");
		}
		const leafForkHistory = messagesFrom(
			(await client.command(leafForkParent, { type: "get_messages" }, "get_messages leaf Fork child"))
				.response,
		);
		if (
			!hasText(leafForkHistory, markerB) ||
			!hasText(leafForkHistory, middleMarker) ||
			(typeof leafForkMessage.text === "string" && hasText(leafForkHistory, leafForkMessage.text))
		) {
			throw new Error("leaf Fork did not preserve the exact history prefix before its selected entry");
		}
		console.log("ordinary middle + leaf Fork persistence and history boundaries ok");

		const rootForkParent = await client.attachExisting(originalSessionBHandle);
		const firstForkMessage = forkMessages?.messages?.[0];
		if (!firstForkMessage?.entryId) throw new Error("Session B exposed no first user entry for fork");
		const forkParentHandle = rootForkParent.handle;
		const forkParentGeneration = rootForkParent.generation;
		const rootFork = await client.command(
			rootForkParent,
			{ type: "fork", entryId: firstForkMessage.entryId },
			"fork Session B before its first user entry",
		);
		if (
			rootFork.previousSessionHandle !== forkParentHandle ||
			rootFork.sessionHandle === forkParentHandle ||
			rootFork.generation !== forkParentGeneration + 1 ||
			(rootFork.response.data as { cancelled?: boolean } | undefined)?.cancelled !== false
		) {
			throw new Error("first-user fork did not produce the expected pending child identity");
		}
		if (
			rootForkParent.handle !== rootFork.sessionHandle ||
			rootForkParent.runtime?.recoverable !== false ||
			!rootForkParent.runtime.sessionFile ||
			fs.existsSync(rootForkParent.runtime.sessionFile)
		) {
			throw new Error("first-user fork child was not retained as an unpersisted live Session");
		}

		const rootForkMarker = "PI_WEB_ROOT_FORK_52A9";
		const beforeRootForkSettle = rootForkParent.events.filter(
			(event) => event.type === "agent_settled",
		).length;
		await client.command(
			rootForkParent,
			{
				type: "prompt",
				message: `只回复这个标记：${rootForkMarker}`,
				streamingBehavior: "steer",
			},
			"prompt first-user fork child",
		);
		await client.waitForSettled(rootForkParent, beforeRootForkSettle, "first-user fork child settlement");
		await waitUntil(
			() => rootForkParent.runtime?.recoverable === true,
			COMMAND_TIMEOUT_MS,
			"first-user fork child persistence",
		);
		const rootForkMessages = messagesFrom(
			(await client.command(rootForkParent, { type: "get_messages" }, "get_messages first-user fork child"))
				.response,
		);
		if (!hasText(rootForkMessages, rootForkMarker) || hasText(rootForkMessages, markerB)) {
			throw new Error("first-user fork child did not persist an isolated replacement history");
		}
		console.log("first-user fork pending identity + persistence ok");

		const parentHandle = sessionA.handle;
		const parentGeneration = sessionA.generation;
		const clone = await client.command(sessionA, { type: "clone" }, "clone Session A");
		if (
			clone.previousSessionHandle !== parentHandle ||
			clone.sessionHandle === parentHandle ||
			clone.generation !== parentGeneration + 1 ||
			(clone.response.data as { cancelled?: boolean } | undefined)?.cancelled !== false
		) {
			throw new Error("clone did not produce the expected new handle and generation");
		}
		if (sessionA.handle !== clone.sessionHandle || sessionA.generation !== clone.generation) {
			throw new Error("client did not adopt the authoritative clone rekey");
		}

		const childOnlyMarker = "PI_WEB_CHILD_ONLY_4D8E";
		const beforeChildSettle = sessionA.events.filter((event) => event.type === "agent_settled").length;
		await client.command(
			sessionA,
			{
				type: "prompt",
				message: `只回复这个标记：${childOnlyMarker}`,
				streamingBehavior: "steer",
			},
			"prompt cloned child",
		);
		await client.waitForSettled(sessionA, beforeChildSettle, "cloned child settlement");
		const childMessages = messagesFrom(
			(await client.command(sessionA, { type: "get_messages" }, "get_messages cloned child")).response,
		);
		if (!hasText(childMessages, injectedMarker) || !hasText(childMessages, childOnlyMarker)) {
			throw new Error("cloned child did not inherit parent history and retain its new turn");
		}

		const parent = await client.attachExisting(parentHandle);
		const parentMessages = messagesFrom(
			(await client.command(parent, { type: "get_messages" }, "get_messages original parent")).response,
		);
		if (!hasText(parentMessages, injectedMarker) || hasText(parentMessages, childOnlyMarker)) {
			throw new Error("clone history isolation failed between original parent and child");
		}
		console.log("clone rekey + parent/child history isolation ok");

		await Promise.all([
			client.command(sessionA, { type: "get_session_stats" }, "get_session_stats child"),
			client.command(parent, { type: "get_tree" }, "get_tree parent"),
			client.command(rootForkParent, { type: "get_commands" }, "get_commands Session B root child"),
		]);

		const extensionTracePath = path.join(workspacePath, ".pi-web-real-extension-trace.jsonl");
		const extensionProviderPath = path.join(workspacePath, ".pi-web-real-extension-provider");
		const extensionPidPath = path.join(workspacePath, ".pi-web-real-extension.pid");
		// The same temporary Extension is loaded by every real Pi Session. Clear
		// evidence from the provider-backed checks before starting the local-only
		// Extension UI checks below.
		fs.rmSync(extensionProviderPath, { force: true });
		fs.rmSync(extensionPidPath, { force: true });
		const traceBeforeExtension = readJsonLines(extensionTracePath);
		const providerRecordsBeforeExtension = traceBeforeExtension.filter(
			(entry) => entry.kind === "provider",
		).length;
		// attachExisting replaces the client's reference for a rekeyed handle;
		// rootForkParent is the final live reference for Session B's child.
		const sessionBIsolationRef = rootForkParent;
		const sessionBExtensionRequestCount = sessionBIsolationRef.extensionRequests.length;
		const extensionRuntime = await createSession();
		const extensionSession = await client.attach(extensionRuntime);

		const observerOneConnection = await connectMultiplexClient(address.port, authHeaders);
		extraSockets.push(observerOneConnection.ws);
		const observerOne = await observerOneConnection.client.observe(extensionRuntime);
		const observerTwoConnection = await connectMultiplexClient(address.port, authHeaders);
		extraSockets.push(observerTwoConnection.ws);
		const observerTwo = await observerTwoConnection.client.observe(extensionRuntime);

		const completeCommand = capturePromise(
			client.command(
				extensionSession,
				{ type: "prompt", message: REAL_EXTENSION_COMPLETE, streamingBehavior: "steer" },
				"real Extension complete flow",
				TURN_TIMEOUT_MS,
			),
		);
		const selectRequest = await waitForExtensionRequest(
			extensionSession,
			(request) => request.method === "select" && request.title === "E2E real select",
			"real Extension select request",
		);
		const selectId = selectRequest.id;
		if (typeof selectId !== "string") throw new Error("real Extension select request has no id");
		if (
			!Array.isArray(selectRequest.options) ||
			selectRequest.options.length !== 2 ||
			selectRequest.options[0] !== "safe" ||
			selectRequest.options[1] !== "fast"
		) {
			throw new Error("real Extension select request exposed the wrong options");
		}
		const selectObserverOne = await waitForExtensionRequest(
			observerOne,
			(request) => request.method === "select" && request.id === selectId,
			"first real Extension observer select",
		);
		const selectObserverTwo = await waitForExtensionRequest(
			observerTwo,
			(request) => request.method === "select" && request.id === selectId,
			"second real Extension observer select",
		);
		if (selectObserverOne.id !== selectObserverTwo.id) {
			throw new Error("real Extension observers did not receive the same select request");
		}

		await Promise.all([
			waitForExtensionRequest(
				extensionSession,
				(request) => request.method === "setStatus" && request.statusKey === "real-status",
				"real Extension setStatus request",
			),
			waitForExtensionRequest(
				extensionSession,
				(request) => request.method === "setWidget" && request.widgetKey === "real-widget",
				"real Extension setWidget request",
			),
			waitForExtensionRequest(
				extensionSession,
				(request) => request.method === "setTitle" && request.title === "E2E_REAL_EXTENSION_TITLE",
				"real Extension setTitle request",
			),
			waitForExtensionRequest(
				extensionSession,
				(request) => request.method === "set_editor_text" && request.text === "E2E_REAL_EDITOR_TEXT",
				"real Extension set_editor_text request",
			),
			waitForExtensionRequest(
				extensionSession,
				(request) => request.method === "notify" && request.message === "E2E_REAL_NOTIFY",
				"real Extension notify request",
			),
			waitForExtensionRequest(
				observerOne,
				(request) => request.method === "notify" && request.message === "E2E_REAL_NOTIFY",
				"first real Extension observer notify",
			),
			waitForExtensionRequest(
				observerTwo,
				(request) => request.method === "notify" && request.message === "E2E_REAL_NOTIFY",
				"second real Extension observer notify",
			),
		]);
		const stickyStatus = extensionSession.extensionRequests.find(
			(request) => request.method === "setStatus" && request.statusKey === "real-status",
		);
		const stickyWidget = extensionSession.extensionRequests.find(
			(request) => request.method === "setWidget" && request.widgetKey === "real-widget",
		);
		if (
			stickyStatus?.statusText !== "E2E_REAL_STATUS" ||
			!Array.isArray(stickyWidget?.widgetLines) ||
			stickyWidget.widgetLines.length !== 2 ||
			stickyWidget.widgetLines[0] !== "E2E_REAL_WIDGET_LINE_1" ||
			stickyWidget.widgetLines[1] !== "E2E_REAL_WIDGET_LINE_2" ||
			stickyWidget.widgetPlacement !== "belowEditor"
		) {
			throw new Error("real Extension sticky UI state was not exposed exactly");
		}

		// A reconnecting observer must receive the pending dialog and sticky UI
		// from the authoritative Session snapshot, not from local client memory.
		await closeWebSocket(observerOneConnection.ws);
		const reconnectConnection = await connectMultiplexClient(address.port, authHeaders);
		extraSockets.push(reconnectConnection.ws);
		const reconnectObserver = await reconnectConnection.client.observe(extensionRuntime);
		await waitUntil(
			() => reconnectObserver.sessionSnapshots.length > 0,
			COMMAND_TIMEOUT_MS,
			"real Extension reconnect snapshot",
		);
		const reconnectSnapshot = reconnectObserver.sessionSnapshots.at(-1);
		if (!reconnectSnapshot) throw new Error("real Extension reconnect returned no Session snapshot");
		const pendingFromSnapshot = reconnectSnapshot.pendingExtensionRequests;
		const stickyFromSnapshot = reconnectSnapshot.stickyExtensionState;
		const hasSnapshotRequest = (value: unknown, method: string): boolean =>
			Boolean(value && typeof value === "object" && (value as { method?: unknown }).method === method);
		if (
			!Array.isArray(pendingFromSnapshot) ||
			!pendingFromSnapshot.some(
				(value) =>
					value &&
					typeof value === "object" &&
					(value as { id?: unknown }).id === selectId &&
					(value as { method?: unknown }).method === "select",
			) ||
			!Array.isArray(stickyFromSnapshot) ||
			!["setStatus", "setWidget", "setTitle", "set_editor_text"].every((method) =>
				stickyFromSnapshot.some((value) => hasSnapshotRequest(value, method)),
			) ||
			JSON.stringify(reconnectSnapshot).includes("E2E_REAL_NOTIFY") ||
			(reconnectSnapshot as { runtime?: { state?: unknown } }).runtime?.state !== "waiting_ui"
		) {
			throw new Error("real Extension reconnect snapshot lost pending or sticky UI state");
		}

		const unauthorizedResponse = await reconnectConnection.client.sendExtensionUiResponse(
			reconnectObserver,
			{ id: selectId, value: "safe" },
			"non-controller real Extension response",
			"error",
		);
		if (unauthorizedResponse.operation !== "extension_ui_response") {
			throw new Error("non-controller real Extension response returned the wrong error operation");
		}
		if (reconnectObserver.extensionResults.some((frame) => frame.requestId === selectId)) {
			throw new Error("non-controller real Extension response was incorrectly accepted");
		}

		const answerDialog = async (
			request: Record<string, unknown>,
			response: Record<string, unknown>,
			label: string,
			reason: "answered" | "cancelled" = "answered",
		): Promise<void> => {
			const id = extensionRequestId(request, label);
			const result = await client.sendExtensionUiResponse(extensionSession, { ...response, id }, label);
			if (result.outcome !== "accepted") throw new Error(`${label} was not accepted`);
			await Promise.all([
				waitForExtensionClose(extensionSession, id, reason, `${label} controller close`),
				waitForExtensionClose(observerTwo, id, reason, `${label} observer close`),
				waitForExtensionClose(reconnectObserver, id, reason, `${label} reconnect close`),
			]);
		};

		await answerDialog(selectRequest, { id: selectId, value: "safe" }, "real Extension select response");
		const confirmRequest = await waitForExtensionRequest(
			extensionSession,
			(request) => request.method === "confirm" && request.title === "E2E real confirm",
			"real Extension confirm request",
		);
		const confirmObserver = await waitForExtensionRequest(
			observerTwo,
			(request) => request.method === "confirm" && request.id === confirmRequest.id,
			"real Extension observer confirm",
		);
		if (
			confirmObserver.id !== confirmRequest.id ||
			confirmRequest.message !== "Continue the real Extension flow?"
		) {
			throw new Error("real Extension confirm request was not shared exactly");
		}
		await answerDialog(
			confirmRequest,
			{ id: confirmRequest.id, confirmed: true },
			"real Extension confirm response",
		);

		const inputRequest = await waitForExtensionRequest(
			extensionSession,
			(request) => request.method === "input" && request.title === "E2E real input",
			"real Extension input request",
		);
		if (inputRequest.placeholder !== "real value")
			throw new Error("real Extension input placeholder changed");
		await waitForExtensionRequest(
			observerTwo,
			(request) => request.method === "input" && request.id === inputRequest.id,
			"real Extension observer input",
		);
		await answerDialog(
			inputRequest,
			{ id: inputRequest.id, value: "E2E_REAL_INPUT" },
			"real Extension input response",
		);

		const editorRequest = await waitForExtensionRequest(
			extensionSession,
			(request) => request.method === "editor" && request.title === "E2E real editor",
			"real Extension editor request",
		);
		if (editorRequest.prefill !== "E2E_REAL_EDITOR_PREFILL") {
			throw new Error("real Extension editor prefill changed");
		}
		await waitForExtensionRequest(
			observerTwo,
			(request) => request.method === "editor" && request.id === editorRequest.id,
			"real Extension observer editor",
		);
		await answerDialog(
			editorRequest,
			{ id: editorRequest.id, value: "E2E_REAL_EDITOR" },
			"real Extension editor response",
		);
		const completeOutcome = await completeCommand;
		if (completeOutcome.status === "rejected") throw completeOutcome.error;

		if (
			!extensionSession.extensionRequests.some(
				(request) =>
					request.method === "setStatus" &&
					request.statusKey === "real-status" &&
					request.statusText === undefined,
			) ||
			!extensionSession.extensionRequests.some(
				(request) =>
					request.method === "setWidget" &&
					request.widgetKey === "real-widget" &&
					request.widgetLines === undefined,
			) ||
			!extensionSession.extensionRequests.some(
				(request) => request.method === "setTitle" && request.title === "",
			) ||
			!extensionSession.extensionRequests.some(
				(request) => request.method === "set_editor_text" && request.text === "",
			)
		) {
			throw new Error("real Extension did not clear sticky UI state after the completed flow");
		}
		const completeRecord = await (async () => {
			await waitUntil(
				() => readJsonLines(extensionTracePath).some((entry) => entry.kind === "complete"),
				COMMAND_TIMEOUT_MS,
				"real Extension completion trace",
			);
			return readJsonLines(extensionTracePath).find((entry) => entry.kind === "complete");
		})();
		if (
			completeRecord?.selected !== "safe" ||
			completeRecord.confirmed !== true ||
			completeRecord.input !== "E2E_REAL_INPUT" ||
			completeRecord.edited !== "E2E_REAL_EDITOR"
		) {
			throw new Error("real Extension did not receive the controller responses exactly");
		}

		const cancelCommand = capturePromise(
			client.command(
				extensionSession,
				{ type: "prompt", message: REAL_EXTENSION_CANCEL, streamingBehavior: "steer" },
				"real Extension cancellation flow",
				TURN_TIMEOUT_MS,
			),
		);
		const cancelRequest = await waitForExtensionRequest(
			extensionSession,
			(request) => request.method === "confirm" && request.title === "E2E real cancellation",
			"real Extension cancellation request",
		);
		await waitForExtensionRequest(
			observerTwo,
			(request) => request.method === "confirm" && request.id === cancelRequest.id,
			"real Extension cancellation observer",
		);
		await answerDialog(
			cancelRequest,
			{ id: cancelRequest.id, cancelled: true },
			"real Extension cancellation response",
			"cancelled",
		);
		const cancelOutcome = await cancelCommand;
		if (cancelOutcome.status === "rejected") throw cancelOutcome.error;

		const timeoutCommand = capturePromise(
			client.command(
				extensionSession,
				{ type: "prompt", message: REAL_EXTENSION_TIMEOUT, streamingBehavior: "steer" },
				"real Extension timeout flow",
				TURN_TIMEOUT_MS,
			),
		);
		const timeoutRequest = await waitForExtensionRequest(
			extensionSession,
			(request) => request.method === "confirm" && request.title === "E2E real timeout",
			"real Extension timeout request",
		);
		const timeoutId = extensionRequestId(timeoutRequest, "real Extension timeout");
		if (timeoutRequest.timeout !== 250) throw new Error("real Extension timeout was not forwarded exactly");
		await waitForExtensionRequest(
			observerTwo,
			(request) => request.method === "confirm" && request.id === timeoutRequest.id,
			"real Extension timeout observer",
		);
		await Promise.all([
			waitForExtensionClose(extensionSession, timeoutId, "expired", "real Extension timeout close"),
			waitForExtensionClose(observerTwo, timeoutId, "expired", "real Extension timeout observer close"),
			waitForExtensionClose(
				reconnectObserver,
				timeoutId,
				"expired",
				"real Extension timeout reconnect close",
			),
		]);
		const timeoutOutcome = await timeoutCommand;
		if (timeoutOutcome.status === "rejected") throw timeoutOutcome.error;

		fs.rmSync(extensionPidPath, { force: true });
		const processLossCommand = client
			.command(
				extensionSession,
				{ type: "prompt", message: REAL_EXTENSION_PROCESS_LOSS, streamingBehavior: "steer" },
				"real Extension process-loss flow",
				TURN_TIMEOUT_MS,
			)
			.then(
				() => "resolved" as const,
				() => "rejected" as const,
			);
		const processLossRequest = await waitForExtensionRequest(
			extensionSession,
			(request) => request.method === "confirm" && request.title === "E2E real process loss",
			"real Extension process-loss request",
		);
		const processLossId = extensionRequestId(processLossRequest, "real Extension process-loss");
		await waitUntil(
			() => fs.existsSync(extensionPidPath),
			COMMAND_TIMEOUT_MS,
			"real Extension process pid marker",
		);
		let processPid: number | null = null;
		await waitUntil(
			() => {
				processPid = readSafeProcessId(extensionPidPath);
				return processPid !== null;
			},
			COMMAND_TIMEOUT_MS,
			"real Extension process pid readiness",
		);
		if (processPid === null) throw new Error("real Extension exposed an unsafe process pid");
		try {
			process.kill(processPid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await Promise.all([
			waitForExtensionClose(
				extensionSession,
				processLossId,
				"process_lost",
				"real Extension process-loss close",
			),
			waitForExtensionClose(
				observerTwo,
				processLossId,
				"process_lost",
				"real Extension process-loss observer close",
			),
			waitForExtensionClose(
				reconnectObserver,
				processLossId,
				"process_lost",
				"real Extension process-loss reconnect close",
			),
		]);
		await waitUntil(
			() => extensionSession.runtime?.state === "crashed",
			COMMAND_TIMEOUT_MS,
			"real Extension process-loss runtime state",
		);
		await processLossCommand;

		const traceAfterExtension = readJsonLines(extensionTracePath);
		const providerRecordsAfterExtension = traceAfterExtension.filter(
			(entry) => entry.kind === "provider",
		).length;
		if (
			providerRecordsAfterExtension !== providerRecordsBeforeExtension ||
			fs.existsSync(extensionProviderPath)
		) {
			throw new Error("real Extension UI flow unexpectedly invoked a provider");
		}
		if (
			!traceAfterExtension.some((entry) => entry.kind === "cancel" && entry.confirmed === false) ||
			!traceAfterExtension.some((entry) => entry.kind === "timeout" && entry.confirmed === false)
		) {
			throw new Error("real Extension cancellation or timeout did not complete in Pi");
		}
		const sessionBExtensionRequests = sessionBIsolationRef.extensionRequests.slice(
			sessionBExtensionRequestCount,
		);
		if (sessionBExtensionRequests.length > 0) {
			throw new Error("Extension UI requests leaked from the real Extension Session into Session B");
		}
		const traceText = fs.existsSync(extensionTracePath) ? fs.readFileSync(extensionTracePath, "utf8") : "";
		for (const forbidden of [realAgentDir, realSettingsPath, "auth.json", "models.json"]) {
			if (traceText.includes(forbidden))
				throw new Error("real Extension trace leaked private configuration details");
		}
		console.log("real Pi Extension UI compatibility, observers, recovery, isolation, and provider guard ok");
		console.log("REAL PI E2E OK");
	} catch (error) {
		process.exitCode = 1;
		console.error("REAL PI E2E ERROR:", error instanceof Error ? error.message : String(error));
	} finally {
		for (const socket of extraSockets) await closeWebSocket(socket);
		if (ws) await closeWebSocket(ws);
		try {
			await handle?.close();
		} catch {
			process.exitCode = 1;
			console.error("REAL PI E2E CLEANUP ERROR: gateway shutdown failed");
		}
		try {
			if (fileFingerprint(realSettingsPath) !== realSettingsBefore) {
				process.exitCode = 1;
				console.error("REAL PI E2E ISOLATION ERROR: the real Pi settings file changed");
			}
		} catch {
			process.exitCode = 1;
			console.error("REAL PI E2E ISOLATION ERROR: unable to verify the real Pi settings file");
		}
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}
