import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "../src/config.js";
import { startServer } from "../src/main.js";

const RUN_REAL_E2E = process.env.PI_WEB_RUN_E2E === "1";
const COMMAND_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const MAX_COPIED_CONFIG_BYTES = 16 * 1024 * 1024;
const PRIVATE_CONFIG_FILES = ["auth.json", "models.json"] as const;

interface RuntimeSnapshot {
	sessionHandle: string;
	workspaceId: string;
	nativeSessionId: string;
	sessionFile: string | null;
	generation: number;
	lastSeq: number;
	state: string;
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
				if (ref) ref.error = String(frame.error ?? "unknown Session error");
			}
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
		const ref: SessionRef = { handle, generation: 0, events: [] };
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
	fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
	fs.mkdirSync(isolatedAgentDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(workspacePath, 0o700);
	fs.chmodSync(isolatedAgentDir, 0o700);
	for (const fileName of PRIVATE_CONFIG_FILES) {
		copyOptionalPrivateConfig(realAgentDir, isolatedAgentDir, fileName);
	}
	let handle: Awaited<ReturnType<typeof startServer>> | undefined;
	let ws: import("ws").default | undefined;

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

		const WebSocketCtor = (await import("ws")).default;
		ws = new WebSocketCtor(`ws://127.0.0.1:${String(address.port)}/api/v1/ws`, {
			headers: authHeaders,
		});
		await timeout(
			new Promise<void>((resolve, reject) => {
				ws?.once("open", resolve);
				ws?.once("error", reject);
			}),
			COMMAND_TIMEOUT_MS,
			"WebSocket open",
		);
		const client = new MultiplexClient(ws);
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
			client.command(sessionB, { type: "get_commands" }, "get_commands Session B"),
		]);
		console.log("REAL PI E2E OK");
	} catch (error) {
		process.exitCode = 1;
		console.error("REAL PI E2E ERROR:", error instanceof Error ? error.message : String(error));
	} finally {
		ws?.close();
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
