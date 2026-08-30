import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
	GATEWAY_CONTENT_REF_CAPABILITY,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	SESSION_PAYLOAD_BUDGET,
	type SessionAttachmentRefDto,
	type SessionCommandDto,
	type SessionRuntimeDto,
	type SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type ServerHandle, startServer } from "../src/main.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
const IMAGE_BYTES = 1024 * 1024 + 257;
const PROMPT = "payload-reference-large-image-events";
const roots: string[] = [];
const handles: ServerHandle[] = [];
const clients: ClientProbe[] = [];

type GatewayFrame = GatewayServerHelloDto | SessionWsServerMessage;
type LeaseFrame = Extract<SessionWsServerMessage, { type: "lease_status" }>;
type ResponseFrame = Extract<SessionWsServerMessage, { type: "response" }>;

class ClientProbe {
	readonly frames: GatewayFrame[] = [];

	constructor(readonly ws: WebSocket) {
		ws.on("message", (raw) => this.frames.push(JSON.parse(raw.toString()) as GatewayFrame));
	}

	mark(): number {
		return this.frames.length;
	}

	sendRaw(message: GatewayClientHelloDto): void {
		this.ws.send(JSON.stringify(message));
	}

	send(message: unknown): void {
		this.ws.send(JSON.stringify(message));
	}

	waitFor<T extends GatewayFrame>(predicate: (frame: GatewayFrame) => frame is T, from = 0): Promise<T> {
		return eventually(() => this.frames.slice(from).find(predicate));
	}
}

function crc32(input: Buffer): number {
	let crc = 0xffff_ffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
	}
	return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.allocUnsafe(12 + data.byteLength);
	chunk.writeUInt32BE(data.byteLength, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
	return chunk;
}

/** A parser-valid 1x1 RGBA PNG padded by one private ancillary chunk. */
function largePng(byteLength = IMAGE_BYTES): Buffer {
	const signature = Buffer.from("89504e470d0a1a0a", "hex");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const idat = pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0])));
	const fixed = [signature, pngChunk("IHDR", ihdr), idat, pngChunk("IEND", Buffer.alloc(0))];
	const fixedBytes = fixed.reduce((total, part) => total + part.byteLength, 0);
	const paddingBytes = byteLength - fixedBytes - 12;
	if (paddingBytes < 1) throw new Error("large PNG fixture is too small");
	return Buffer.concat([
		fixed[0]!,
		fixed[1]!,
		pngChunk("paWa", Buffer.alloc(paddingBytes, 0x61)),
		...fixed.slice(2),
	]);
}

function refsIn(value: unknown): SessionAttachmentRefDto[] {
	const refs: SessionAttachmentRefDto[] = [];
	const stack = [value];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (!Array.isArray(current) && (current as { type?: unknown }).type === "attachment_ref") {
			refs.push(current as SessionAttachmentRefDto);
			continue;
		}
		stack.push(...(Array.isArray(current) ? current : Object.values(current)));
	}
	return refs;
}

async function createHarness(): Promise<{
	handle: ServerHandle;
	baseUrl: string;
	cookie: string;
	sessionHandle: string;
}> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-payload-reference-gateway-"));
	roots.push(root);
	const workspacePath = path.join(root, "workspace");
	fs.mkdirSync(workspacePath, { recursive: true });
	const handle = await startServer({
		config: {
			port: 0,
			host: "127.0.0.1",
			agentDir: path.join(root, "agent"),
			sessionRootDir: path.join(root, "sessions"),
			webDataDir: path.join(root, "web-data"),
		},
		piPath: fixturePath,
		handleSignals: false,
	});
	handles.push(handle);
	const address = handle.server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${String(address.port)}`;
	const bootstrap = await fetch(`${baseUrl}/api/v1/bootstrap`, { headers: { Origin: baseUrl } });
	expect(bootstrap.status).toBe(200);
	const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie) throw new Error("payload reference bootstrap omitted its authentication cookie");
	const auth = { Origin: baseUrl, Cookie: cookie };
	const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...auth },
		body: JSON.stringify({ path: workspacePath }),
	});
	expect(workspaceResponse.status).toBe(201);
	const workspace = (await workspaceResponse.json()) as { workspaceHandle: string };
	const sessionResponse = await fetch(`${baseUrl}/api/v1/workspaces/${workspace.workspaceHandle}/sessions`, {
		method: "POST",
		headers: auth,
	});
	expect(sessionResponse.status).toBe(201);
	const session = (await sessionResponse.json()) as { runtime: SessionRuntimeDto };
	return { handle, baseUrl, cookie, sessionHandle: session.runtime.sessionHandle };
}

async function openClient(
	baseUrl: string,
	cookie: string,
): Promise<{
	client: ClientProbe;
	hello: GatewayServerHelloDto;
}> {
	const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/v1/ws`, {
		headers: { Origin: baseUrl, Cookie: cookie },
	});
	const client = new ClientProbe(ws);
	clients.push(client);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client.sendRaw({
		type: "client_hello",
		protocol: { major: 1, minor: 3 },
		clientBuild: "payload-reference-gateway-integration",
		capabilities: [
			"rpc.commands",
			"rpc.events",
			"rpc.extension_ui",
			"session.multiplex",
			GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
			GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
			GATEWAY_CONTENT_REF_CAPABILITY,
		],
		limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
	});
	const hello = await client.waitFor(
		(frame): frame is GatewayServerHelloDto => frame.type === "server_hello",
	);
	return { client, hello };
}

async function subscribe(
	client: ClientProbe,
	sessionHandle: string,
	cursor?: { serverEpoch: string; generation: number; seq: number },
): Promise<{ runtime: SessionRuntimeDto; frames: GatewayFrame[]; lease: LeaseFrame }> {
	const mark = client.mark();
	client.send({ type: "session_subscribe", sessionHandle, ...(cursor ? { cursor } : {}) });
	const lease = await client.waitFor((frame): frame is LeaseFrame => frame.type === "lease_status", mark);
	const frames = client.frames.slice(mark);
	const runtime = frames
		.filter(
			(frame): frame is Extract<SessionWsServerMessage, { type: "runtime_state" }> =>
				frame.type === "runtime_state",
		)
		.at(-1)?.runtime;
	if (!runtime) throw new Error("payload reference subscription omitted runtime state");
	return { runtime, frames, lease };
}

async function claim(client: ClientProbe, sessionHandle: string): Promise<LeaseFrame> {
	const mark = client.mark();
	client.send({ type: "session_claim", sessionHandle });
	return client.waitFor(
		(frame): frame is LeaseFrame =>
			frame.type === "lease_status" && frame.isController && frame.fencingToken !== undefined,
		mark,
	);
}

async function command(
	client: ClientProbe,
	sessionHandle: string,
	expectedGeneration: number,
	fencingToken: string,
	rpcCommand: SessionCommandDto,
): Promise<ResponseFrame> {
	const mark = client.mark();
	client.send({ type: "command", sessionHandle, expectedGeneration, fencingToken, command: rpcCommand });
	return client.waitFor(
		(frame): frame is ResponseFrame => frame.type === "response" && frame.response.id === rpcCommand.id,
		mark,
	);
}

async function eventually<T>(read: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined && value !== false) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("payload reference integration condition timed out");
}

afterEach(async () => {
	for (const client of clients.splice(0).reverse()) client.ws.terminate();
	await new Promise<void>((resolve) => setImmediate(resolve));
	for (const handle of handles.splice(0).reverse()) await handle.close();
	for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true });
});

describe("payload reference production Gateway vertical integration", () => {
	it("externalizes one large Pi image across live, replay, snapshot, authenticated GET, and teardown", async () => {
		const harness = await createHarness();
		const image = largePng();
		const expectedRef = {
			type: "attachment_ref",
			serverEpoch: harness.handle.serverEpoch,
			sha256: createHash("sha256").update(image).digest("hex"),
			mediaType: "image/png",
			byteLength: image.byteLength,
		} satisfies SessionAttachmentRefDto;
		const inlinePrefix = image.toString("base64").slice(0, 256);
		const { client: owner, hello } = await openClient(harness.baseUrl, harness.cookie);

		// Activation is intentionally required: no inline compatibility fallback may reach the Browser.
		expect(hello).toMatchObject({
			protocol: { major: 1, minor: 3 },
			serverEpoch: harness.handle.serverEpoch,
			capabilities: expect.arrayContaining([GATEWAY_PAYLOAD_BUDGET_CAPABILITY]),
			payloadBudget: SESSION_PAYLOAD_BUDGET,
		});

		const initial = await subscribe(owner, harness.sessionHandle);
		const lease = await claim(owner, initial.runtime.sessionHandle);
		if (!lease.fencingToken) throw new Error("payload reference integration did not acquire a lease");
		const eventMark = owner.mark();
		const transport = owner.ws as WebSocket & { _socket: { pause(): void; resume(): void } };
		transport._socket.pause();
		const response = command(
			owner,
			initial.runtime.sessionHandle,
			initial.runtime.generation,
			lease.fencingToken,
			{ id: "large-image-events", type: "prompt", message: PROMPT },
		);
		await eventually(() =>
			harness.handle.supervisor
				.listRuntimes()
				.find((runtime) => runtime.state === "idle" && runtime.lastSeq >= initial.runtime.lastSeq + 2),
		);
		transport._socket.resume();
		await expect(response).resolves.toMatchObject({ response: { success: true } });
		const liveEvents = await eventually(() => {
			const matches = owner.frames
				.slice(eventMark)
				.filter(
					(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
						frame.type === "event" &&
						(frame.event.type === "message_start" || frame.event.type === "message_end"),
				);
			return matches.length >= 2 ? matches : undefined;
		});
		for (const event of liveEvents) expect(refsIn(event)).toEqual([expectedRef]);
		expect(JSON.stringify(liveEvents)).not.toContain(inlinePrefix);
		expect(owner.ws.readyState).toBe(WebSocket.OPEN);
		expect(harness.handle.contentStore.usage).toEqual({ bytes: IMAGE_BYTES, items: 1 });

		const latest = harness.handle.supervisor
			.listRuntimes()
			.find((runtime) => runtime.lastSeq >= initial.runtime.lastSeq + 2);
		if (!latest) throw new Error("payload reference runtime did not settle");
		owner.ws.terminate();
		const { client: replayClient } = await openClient(harness.baseUrl, harness.cookie);
		const replay = await subscribe(replayClient, latest.sessionHandle, {
			serverEpoch: harness.handle.serverEpoch,
			generation: latest.generation,
			seq: initial.runtime.lastSeq,
		});
		expect(refsIn(replay.frames)).toEqual(expect.arrayContaining([expectedRef]));
		expect(JSON.stringify(replay.frames)).not.toContain(inlinePrefix);

		replayClient.ws.terminate();
		const { client: freshClient } = await openClient(harness.baseUrl, harness.cookie);
		const fresh = await subscribe(freshClient, latest.sessionHandle);
		const snapshot = fresh.frames.find((frame) => frame.type === "session_snapshot");
		expect(snapshot).toBeDefined();
		expect(refsIn(snapshot)).toEqual(expect.arrayContaining([expectedRef]));
		expect(JSON.stringify(snapshot)).not.toContain(inlinePrefix);

		const attachment = await fetch(
			`${harness.baseUrl}/api/v1/attachments/${expectedRef.serverEpoch}/${expectedRef.sha256}`,
			{ headers: { Origin: harness.baseUrl, Cookie: harness.cookie } },
		);
		expect(attachment.status).toBe(200);
		expect(attachment.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await attachment.arrayBuffer())).toEqual(image);

		await harness.handle.supervisor.stop(latest.sessionHandle);
		expect(await harness.handle.contentStore.gc()).toEqual({ bytes: IMAGE_BYTES, items: 1 });
		expect(harness.handle.contentStore.usage).toEqual({ bytes: 0, items: 0 });
	});
});
