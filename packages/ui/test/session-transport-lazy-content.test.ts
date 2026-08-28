import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	type FutureSessionContentRefGuardContext,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	SESSION_PAYLOAD_BUDGET,
	type SessionJsonRootDto,
	type SessionRuntimeDto,
	type SessionRuntimeIdentityDto,
	type SessionWsClientMessage,
	type SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createFutureSessionContentAdapter,
	type FutureSessionContentAdapter,
	type FutureSessionExtensionMaterializer,
	type FutureSessionJsonFieldGuard,
	type FutureSessionJsonRootProjection,
	type FutureSessionTextPayloadProjection,
} from "../src/lib/future-session-content-adapter";
import {
	createSessionTransport,
	type SessionTransportController,
	type SessionWebSocket,
} from "../src/stores/session-transport";

const EPOCH = "lazy-content-epoch";
const WORKSPACE = "lazy-content-workspace";
const CONTENT_BYTES = FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes;

const trustedContext: FutureSessionContentRefGuardContext = Object.freeze({
	serverEpoch: EPOCH,
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
});

class FakeSocket implements SessionWebSocket {
	readyState = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<SessionWsClientMessage | GatewayClientHelloDto> = [];

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("socket is not open");
		this.sent.push(JSON.parse(data) as SessionWsClientMessage | GatewayClientHelloDto);
	}

	open(epoch = EPOCH): void {
		this.readyState = 1;
		this.onopen?.();
		this.serverMessage(serverHello(epoch));
		this.serverMessage({
			type: "hot_runtime_inventory",
			serverEpoch: epoch,
			revision: 0,
			runtimes: [],
		});
	}

	serverMessage(message: SessionWsServerMessage | GatewayServerHelloDto): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	serverClose(): void {
		this.readyState = 3;
		this.onclose?.();
	}

	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
}

interface Harness {
	controller: SessionTransportController;
	sockets: FakeSocket[];
}

const controllers: SessionTransportController[] = [];

function serverHello(serverEpoch: string): GatewayServerHelloDto {
	return {
		type: "server_hello",
		protocol: { major: 1, minor: 2 },
		serverBuild: "lazy-content-test-server",
		serverEpoch,
		piVersion: "0.84.2",
		adapterId: "lazy-content-test-adapter",
		capabilities: [
			"rpc.commands",
			"rpc.events",
			"rpc.extension_ui",
			"session.multiplex",
			GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
			GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
		],
		limits: {
			maxClientFrameBytes: 8 * 1024 * 1024,
			maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
			maxExtensionRequests: 256,
		},
		payloadBudget: SESSION_PAYLOAD_BUDGET,
	};
}

function identity(
	sessionHandle = "session-a",
	generation = 1,
	serverEpoch = EPOCH,
): Readonly<Pick<SessionRuntimeIdentityDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">> {
	return Object.freeze({
		serverEpoch,
		workspaceId: WORKSPACE,
		sessionHandle,
		generation,
	});
}

function runtimeFor(
	value: Readonly<
		Pick<SessionRuntimeIdentityDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">
	>,
	lastSeq = 0,
): SessionRuntimeDto {
	return {
		...value,
		nativeSessionId: `native-${value.sessionHandle}`,
		sessionFile: `/tmp/${value.sessionHandle}.jsonl`,
		cwd: "/tmp/lazy-content",
		lastSeq,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function contentRef(digest: string, serverEpoch = EPOCH) {
	return {
		type: "content_ref" as const,
		serverEpoch,
		sha256: digest.repeat(64),
		byteLength: CONTENT_BYTES,
		encoding: "utf-8" as const,
	};
}

function externalText(digest = "a"): FutureSessionTextPayloadProjection {
	return { kind: "external", value: { type: "external_text", ref: contentRef(digest) } };
}

function externalJson(digest = "b"): FutureSessionJsonRootProjection {
	return { kind: "external", value: { type: "external_json", ref: contentRef(digest) } };
}

function adapter(
	options: {
		resolveText?: NonNullable<FutureSessionExtensionMaterializer["resolveText"]>;
		resolveJson?: NonNullable<FutureSessionExtensionMaterializer["resolveJson"]>;
	} = {},
): FutureSessionContentAdapter {
	return createFutureSessionContentAdapter({
		trustedContext,
		resolver: {
			materializeExtensionRequest: async (request) => request,
			...options,
		},
	});
}

function harness(
	futureContentAdapter?: FutureSessionContentAdapter,
	onResyncRequired?: (message: Extract<SessionWsServerMessage, { type: "resync_required" }>) => void,
): Harness {
	const sockets: FakeSocket[] = [];
	const controller = createSessionTransport({
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		url: () => "ws://lazy-content.test/api/v1/ws",
		reconnectBaseMs: 0,
		protocolVersion: { major: 1, minor: 2 },
		futureContentAdapter,
		onResyncRequired,
	});
	controllers.push(controller);
	return { controller, sockets };
}

function connect(h: Harness, epoch = EPOCH): FakeSocket {
	h.controller.store.getState().connect();
	const socket = h.sockets.at(-1);
	if (!socket) throw new Error("transport did not create a socket");
	socket.open(epoch);
	return socket;
}

function subscribeWithRuntime(
	h: Harness,
	value: Readonly<
		Pick<SessionRuntimeIdentityDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">
	>,
): void {
	h.controller.store.getState().subscribeSession(value.sessionHandle);
	h.controller.ingestServerMessage({ type: "runtime_state", runtime: runtimeFor(value) });
}

function establishBaseline(
	h: Harness,
	value: Readonly<
		Pick<SessionRuntimeIdentityDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">
	>,
): void {
	const runtime = runtimeFor(value);
	h.controller.ingestServerMessage({
		type: "resync_required",
		serverEpoch: value.serverEpoch,
		sessionHandle: value.sessionHandle,
		runtime,
		reason: "initial",
	});
	h.controller.ingestServerMessage({
		type: "session_snapshot",
		snapshotId: `snapshot-${value.sessionHandle}`,
		...value,
		baseSeq: 0,
		asOfSeq: 0,
		runtime,
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	});
}

async function prepareBaseline(
	h: Harness,
	value: Readonly<
		Pick<SessionRuntimeIdentityDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">
	>,
): Promise<void> {
	subscribeWithRuntime(h, value);
	establishBaseline(h, value);
	await Promise.resolve();
}

function isAnswer(value: unknown): value is { answer: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"answer" in value &&
		typeof value.answer === "string"
	);
}

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

describe("Session transport lazy future content facade", () => {
	it("resolves frozen four-field identities without putting runtime data in the facade", async () => {
		const resolveText: NonNullable<FutureSessionExtensionMaterializer["resolveText"]> = vi.fn(
			async (_value, signal) => {
				expect(signal).toBeDefined();
				return "resolved text";
			},
		);
		const resolveJson: NonNullable<FutureSessionExtensionMaterializer["resolveJson"]> = async (
			_value,
			guard,
			signal,
		) => {
			expect(signal).toBeDefined();
			const value: unknown = { answer: "resolved json" };
			if (!guard(value)) throw new Error("test JSON guard rejected its fixture");
			return value;
		};
		const h = harness(adapter({ resolveText, resolveJson }));
		connect(h);
		const captured = identity();
		await prepareBaseline(h, captured);

		await expect(h.controller.resolveFutureText(captured, externalText())).resolves.toBe("resolved text");
		await expect(h.controller.resolveFutureJson(captured, externalJson(), isAnswer)).resolves.toEqual({
			answer: "resolved json",
		});
		expect(resolveText).toHaveBeenCalledTimes(1);
	});

	it("preserves authoritative 404/guard failures, reports once per captured identity, and isolates Sessions", async () => {
		const notFound = new Error("content GET returned 404");
		const guardFailure = new Error("content JSON field guard failed");
		const resolveText: NonNullable<FutureSessionExtensionMaterializer["resolveText"]> = vi.fn(async () => {
			throw notFound;
		});
		const resolveJson: NonNullable<FutureSessionExtensionMaterializer["resolveJson"]> = async <T>(
			_value: SessionJsonRootDto,
			guard: FutureSessionJsonFieldGuard<T>,
		) => {
			const value: unknown = { answer: 42 };
			if (!guard(value)) throw guardFailure;
			throw new Error("test JSON guard unexpectedly accepted its fixture");
		};
		const notices: string[] = [];
		const h = harness(adapter({ resolveText, resolveJson }), (message) => {
			notices.push(message.sessionHandle);
		});
		connect(h);
		const first = identity("session-a");
		const second = identity("session-b");
		const untouched = identity("session-untouched");
		await prepareBaseline(h, first);
		await prepareBaseline(h, second);
		await prepareBaseline(h, untouched);
		notices.length = 0;

		await expect(h.controller.resolveFutureText(first, externalText("a"))).rejects.toBe(notFound);
		await expect(h.controller.resolveFutureJson(second, externalJson("b"), isAnswer)).rejects.toBe(
			guardFailure,
		);
		await expect(h.controller.resolveFutureText(first, externalText("c"))).rejects.toMatchObject({
			name: "AbortError",
		});
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions[first.sessionHandle]?.recovery).not.toBeNull(),
		);

		expect(notices).toEqual([first.sessionHandle, second.sessionHandle]);
		expect(h.controller.store.getState().sessions[first.sessionHandle]?.baselineAuthoritative).toBe(false);
		expect(h.controller.store.getState().sessions[second.sessionHandle]?.baselineAuthoritative).toBe(false);
		expect(h.controller.store.getState().sessions[untouched.sessionHandle]?.baselineAuthoritative).toBe(true);
		expect(resolveText).toHaveBeenCalledTimes(1);
	});

	it("silently aborts before materialization for a missing baseline or stale identity", async () => {
		const materializeText = vi.fn(async () => "must not run");
		const h = harness(
			adapter({
				resolveText: materializeText,
			}),
		);
		connect(h);
		const value = identity();
		subscribeWithRuntime(h, value);

		await expect(h.controller.resolveFutureText(value, externalText())).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(materializeText).not.toHaveBeenCalled();

		await prepareBaseline(h, value);
		const pending = h.controller.resolveFutureText(value, externalText());
		h.controller.ingestServerMessage({
			type: "runtime_state",
			runtime: runtimeFor(identity("session-a", 2)),
		});

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(h.controller.store.getState().sessions["session-a"]?.recovery).toBeNull();
	});

	it.each(["disconnect", "rekey", "generation", "epoch", "dispose"] as const)(
		"aborts a lazy operation on %s and ignores its late settlement without resync",
		async (transition) => {
			let signal: AbortSignal | undefined;
			let release!: () => void;
			const gate = new Promise<string>((resolve) => {
				release = () => resolve("late value");
			});
			const resolveText: NonNullable<FutureSessionExtensionMaterializer["resolveText"]> = async (
				_value,
				callerSignal,
			) => {
				signal = callerSignal;
				return gate;
			};
			const notices: string[] = [];
			const h = harness(adapter({ resolveText }));
			const socket = connect(h);
			const value = identity();
			await prepareBaseline(h, value);
			const pending = h.controller.resolveFutureText(value, externalText());
			await vi.waitFor(() => expect(signal).toBeDefined());

			if (transition === "disconnect") {
				socket.serverClose();
			} else if (transition === "rekey") {
				h.controller.ingestServerMessage({
					type: "session_rekeyed",
					serverEpoch: EPOCH,
					previousSessionHandle: value.sessionHandle,
					runtime: runtimeFor(identity("session-child", 2)),
				});
			} else if (transition === "generation") {
				h.controller.ingestServerMessage({
					type: "runtime_state",
					runtime: runtimeFor(identity(value.sessionHandle, 2)),
				});
			} else if (transition === "epoch") {
				h.controller.ingestServerMessage({
					type: "runtime_state",
					runtime: runtimeFor(identity(value.sessionHandle, 1, "new-lazy-content-epoch")),
				});
			} else {
				h.controller.dispose();
			}

			expect(signal?.aborted).toBe(true);
			release();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			await Promise.resolve();
			expect(notices).toEqual([]);
		},
	);

	it("lets one caller group abort multiple roots and prevents sibling recovery", async () => {
		const signals: AbortSignal[] = [];
		const resolveText: NonNullable<FutureSessionExtensionMaterializer["resolveText"]> = async (
			_value,
			signal,
		) => {
			if (signal === undefined) throw new Error("missing operation signal");
			signals.push(signal);
			return new Promise<string>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => reject(new DOMException("The operation was aborted", "AbortError")),
					{ once: true },
				);
			});
		};
		const h = harness(adapter({ resolveText }));
		connect(h);
		const value = identity();
		await prepareBaseline(h, value);
		const group = new AbortController();
		const first = h.controller.resolveFutureText(value, externalText("a"), group.signal);
		const second = h.controller.resolveFutureText(value, externalText("b"), group.signal);
		await vi.waitFor(() => expect(signals).toHaveLength(2));

		group.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(h.controller.store.getState().sessions[value.sessionHandle]?.recovery).toBeNull();
	});

	it("is default-off without an adapter", async () => {
		const h = harness();
		connect(h);
		const value = identity();
		await prepareBaseline(h, value);

		await expect(
			h.controller.resolveFutureText(value, { kind: "inline", value: "inline" }),
		).rejects.toMatchObject({
			code: "unavailable",
		});
	});
});
