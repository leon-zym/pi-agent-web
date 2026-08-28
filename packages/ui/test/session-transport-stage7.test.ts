import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	type FutureSessionCommandResponseDto,
	type FutureSessionContentRefGuardContext,
	type FutureSessionEntryDto,
	type FutureSessionMessageDto,
	type FutureSessionReplayFrameDto,
	type FutureSessionResponseFrameDto,
	type FutureSessionSnapshotDto,
	GATEWAY_CONTENT_REF_PROTOCOL_MINOR,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	type GatewayContentRefServerHelloDto,
	SESSION_PAYLOAD_BUDGET,
	SESSION_WS_CLIENT_MAX_BYTES,
	type SessionExternalTextDto,
	type SessionRuntimeDto,
	type SessionSnapshotDto,
	type SessionTextPayloadDto,
	type SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createFutureSessionContentAdapter,
	type FutureSessionContentAdapter,
	type FutureSessionExtensionMaterializer,
} from "../src/lib/future-session-content-adapter";
import {
	createSessionTransport,
	type FutureSessionContentAdapterFactory,
	type SessionTransportController,
	type SessionWebSocket,
} from "../src/stores/session-transport";

const FUTURE_EPOCH = "future-server-epoch";

class FutureSocket implements SessionWebSocket {
	readyState = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	sent: string[] = [];

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("socket is not open");
		this.sent.push(data);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(message: unknown): void {
		this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
	}

	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
}

interface FutureHarness {
	controller: SessionTransportController;
	socket: FutureSocket;
}

const controllers: SessionTransportController[] = [];

function futureServerHello(): GatewayContentRefServerHelloDto {
	return {
		type: "server_hello",
		protocol: { major: GATEWAY_PROTOCOL_VERSION.major, minor: GATEWAY_CONTENT_REF_PROTOCOL_MINOR },
		serverBuild: "future-test-server",
		serverEpoch: FUTURE_EPOCH,
		piVersion: "0.84.2",
		adapterId: "future-test-adapter",
		capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
		limits: {
			maxClientFrameBytes: SESSION_WS_CLIENT_MAX_BYTES,
			maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
			maxExtensionRequests: 256,
		},
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
	};
}

function futureInventory(): Extract<SessionWsServerMessage, { type: "hot_runtime_inventory" }> {
	return { type: "hot_runtime_inventory", serverEpoch: FUTURE_EPOCH, revision: 0, runtimes: [] };
}

function futureRuntime(sessionHandle: string, generation = 1, lastSeq = 0): SessionRuntimeDto {
	return {
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		workspaceId: "workspace-future",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${sessionHandle}.jsonl`,
		cwd: "/tmp/workspace-future",
		generation,
		lastSeq,
		state: "idle",
		lastActivityAt: 100,
		recoverable: true,
	};
}

function futureBaselineSnapshot(sessionHandle: string, generation: number): FutureSessionSnapshotDto {
	const runtimeValue = futureRuntime(sessionHandle, generation, 0);
	return {
		type: "session_snapshot",
		snapshotId: `snapshot-${sessionHandle}`,
		serverEpoch: FUTURE_EPOCH,
		workspaceId: runtimeValue.workspaceId,
		sessionHandle,
		generation,
		baseSeq: 0,
		asOfSeq: 0,
		runtime: runtimeValue,
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	};
}

function futureTextRef(sha256: string): SessionExternalTextDto {
	return {
		type: "external_text",
		ref: {
			type: "content_ref",
			serverEpoch: FUTURE_EPOCH,
			sha256,
			byteLength: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
			encoding: "utf-8",
		},
	};
}

function futureToolResult(): Extract<FutureSessionMessageDto, { role: "toolResult" }> {
	return {
		role: "toolResult",
		toolCallId: "future-call",
		toolName: "future-tool",
		content: [{ type: "text", text: futureTextRef("a".repeat(64)) }],
		isError: false,
		timestamp: 1,
	};
}

function futureCustomEntry(): Extract<FutureSessionEntryDto, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id: "future-entry",
		parentId: null,
		timestamp: "2026-08-28T00:00:00.000Z",
		customType: "future",
		content: [{ type: "text", text: futureTextRef("b".repeat(64)) }],
		display: true,
	};
}

function messagesResponse(
	id: string,
	barrierSeq: number,
	sessionHandle: string,
): FutureSessionResponseFrameDto {
	const response: FutureSessionCommandResponseDto = {
		id,
		type: "response",
		command: "get_messages",
		success: true,
		data: { messages: [futureToolResult()] },
	};
	return {
		type: "response",
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		generation: 1,
		barrierSeq,
		response,
	};
}

function entriesResponse(
	id: string,
	barrierSeq: number,
	sessionHandle: string,
): FutureSessionResponseFrameDto {
	const response: FutureSessionCommandResponseDto = {
		id,
		type: "response",
		command: "get_entries",
		success: true,
		data: { entries: [futureCustomEntry()], leafId: "future-entry" },
	};
	return {
		type: "response",
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		generation: 1,
		barrierSeq,
		response,
	};
}

function treeResponse(id: string, barrierSeq: number, sessionHandle: string): FutureSessionResponseFrameDto {
	const response: FutureSessionCommandResponseDto = {
		id,
		type: "response",
		command: "get_tree",
		success: true,
		data: {
			tree: [{ entry: futureCustomEntry(), children: [] }],
			leafId: "future-entry",
		},
	};
	return {
		type: "response",
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		generation: 1,
		barrierSeq,
		response,
	};
}

function forkResponse(
	id: string,
	barrierSeq: number,
	sessionHandle: string,
	previousSessionHandle: string,
): FutureSessionResponseFrameDto {
	return {
		type: "response",
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		generation: 2,
		barrierSeq,
		previousSessionHandle,
		response: {
			id,
			type: "response",
			command: "fork",
			success: true,
			data: { text: "", cancelled: false },
		},
	};
}

function futureEvent(sessionHandle: string, seq: number): FutureSessionReplayFrameDto {
	return {
		type: "event",
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		workspaceId: "workspace-future",
		generation: 1,
		seq,
		event: { type: "agent_start" },
	};
}

function makeFactory(resolveText: NonNullable<FutureSessionExtensionMaterializer["resolveText"]>): {
	factory: FutureSessionContentAdapterFactory;
	contexts: Readonly<FutureSessionContentRefGuardContext>[];
	dispose: ReturnType<typeof vi.fn>;
} {
	const contexts: Readonly<FutureSessionContentRefGuardContext>[] = [];
	const dispose = vi.fn();
	const factory: FutureSessionContentAdapterFactory = (context) => {
		contexts.push(context);
		const resolver: FutureSessionExtensionMaterializer = {
			materializeExtensionRequest: async (request) => request,
			resolveText,
		};
		const adapter: FutureSessionContentAdapter = createFutureSessionContentAdapter({
			trustedContext: context,
			resolver,
		});
		return { adapter, dispose };
	};
	return { factory, contexts, dispose };
}

function makeFutureHarness(factory: FutureSessionContentAdapterFactory): FutureHarness {
	const socket = new FutureSocket();
	const controller = createSessionTransport({
		createSocket: () => socket,
		url: () => "ws://stage7.test/api/v1/ws",
		futureContentAdapterFactory: factory,
		reconnectBaseMs: 1,
	});
	controllers.push(controller);
	controller.store.getState().connect();
	socket.open();
	socket.receive(futureServerHello());
	socket.receive(futureInventory());
	return { controller, socket };
}

function ingestFuture(
	controller: SessionTransportController,
	message: Parameters<SessionTransportController["ingestFutureFrameMessage"]>[0],
): boolean {
	const rawWireBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
	return controller.ingestFutureFrameMessage(message, rawWireBytes);
}

function prime(harness: FutureHarness, sessionHandle: string): void {
	const { controller } = harness;
	controller.store.getState().subscribeSession(sessionHandle);
	const currentRuntime = futureRuntime(sessionHandle);
	controller.ingestServerMessage({ type: "runtime_state", runtime: currentRuntime });
	controller.ingestServerMessage({
		type: "resync_required",
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		runtime: currentRuntime,
		reason: "initial",
	});
	controller.ingestServerMessage({
		type: "extension_ui_snapshot",
		serverEpoch: FUTURE_EPOCH,
		sessionHandle,
		generation: 1,
		requests: [],
	});
	const snapshot: SessionSnapshotDto = {
		type: "session_snapshot",
		snapshotId: `snapshot-${sessionHandle}`,
		serverEpoch: FUTURE_EPOCH,
		workspaceId: "workspace-future",
		sessionHandle,
		generation: 1,
		baseSeq: 0,
		asOfSeq: 0,
		runtime: currentRuntime,
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	};
	controller.ingestServerMessage(snapshot);
}

function flushPromises(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

describe("Stage 7B future history materialization", () => {
	it.each(["get_messages", "get_entries", "get_tree"] as const)(
		"materializes %s in its own lane and waits for the authoritative barrier",
		async (commandType) => {
			const resolveText = vi.fn(async (_value: SessionTextPayloadDto, signal?: AbortSignal) => {
				if (signal?.aborted) throw new DOMException("aborted", "AbortError");
				return "materialized-history";
			});
			const probe = makeFactory(resolveText);
			const harness = makeFutureHarness(probe.factory);
			prime(harness, "session-history");
			const pending = harness.controller.store
				.getState()
				.sendCommand("session-history", { id: `history-${commandType}`, type: commandType });
			const response =
				commandType === "get_messages"
					? messagesResponse(`history-${commandType}`, 1, "session-history")
					: commandType === "get_entries"
						? entriesResponse(`history-${commandType}`, 1, "session-history")
						: treeResponse(`history-${commandType}`, 1, "session-history");
			harness.socket.receive(response);
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await flushPromises();
			expect(settled).toBe(false);
			expect(harness.controller.store.getState().sessions["session-history"]?.projectedSeq).toBe(0);

			harness.socket.receive(futureEvent("session-history", 1));
			const result = await pending;
			expect(result).toMatchObject({ id: `history-${commandType}`, success: true });
			expect(settled).toBe(true);
			expect(resolveText).toHaveBeenCalledTimes(1);
			if (commandType === "get_messages") {
				expect(result).toMatchObject({
					data: { messages: [{ content: [{ text: "materialized-history" }] }] },
				});
			} else if (commandType === "get_entries") {
				expect(result).toMatchObject({
					data: { entries: [{ content: [{ text: "materialized-history" }] }] },
				});
			} else {
				expect(result).toMatchObject({
					data: { tree: [{ entry: { content: [{ text: "materialized-history" }] } }] },
				});
			}
		},
	);

	it("deduplicates a repeated future response while its exact pending operation is active", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const resolveText = vi.fn(async (_value: SessionTextPayloadDto, signal?: AbortSignal) => {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			await gate;
			return "deduplicated";
		});
		const harness = makeFutureHarness(makeFactory(resolveText).factory);
		prime(harness, "session-dedupe");
		const pending = harness.controller.store
			.getState()
			.sendCommand("session-dedupe", { id: "dedupe-history", type: "get_messages" });
		const response = messagesResponse("dedupe-history", 1, "session-dedupe");
		harness.socket.receive(response);
		await vi.waitFor(() => expect(resolveText).toHaveBeenCalledTimes(1));
		harness.socket.receive(response);
		release();
		await flushPromises();
		harness.socket.receive(response);
		harness.socket.receive(futureEvent("session-dedupe", 1));
		await expect(pending).resolves.toMatchObject({
			data: { messages: [{ content: [{ text: "deduplicated" }] }] },
		});
		expect(resolveText).toHaveBeenCalledTimes(1);
	});

	it("accepts a future fork response after the command rekeys to its child Session", async () => {
		const harness = makeFutureHarness(makeFactory(async () => "child editor").factory);
		prime(harness, "session-parent");
		harness.socket.receive({
			type: "lease_status",
			serverEpoch: FUTURE_EPOCH,
			sessionHandle: "session-parent",
			generation: 1,
			isController: true,
			fencingToken: "parent-token",
		});
		const pending = harness.controller.store.getState().sendCommand("session-parent", {
			id: "future-fork",
			type: "fork",
			entryId: "entry-1",
		});
		harness.controller.ingestServerMessage({
			type: "session_rekeyed",
			serverEpoch: FUTURE_EPOCH,
			previousSessionHandle: "session-parent",
			runtime: futureRuntime("session-child", 2),
		});
		harness.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: FUTURE_EPOCH,
			sessionHandle: "session-child",
			runtime: futureRuntime("session-child", 2),
			reason: "generation_changed",
		});
		expect(
			ingestFuture(harness.controller, forkResponse("future-fork", 0, "session-child", "session-parent")),
		).toBe(true);
		await flushPromises();
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flushPromises();
		expect(settled).toBe(false);

		expect(ingestFuture(harness.controller, futureBaselineSnapshot("session-child", 2))).toBe(true);
		await expect(pending).resolves.toMatchObject({ id: "future-fork", success: true });
	});

	it("rejects exact future history and starts one cursorless recovery on content failure", async () => {
		const notices: string[] = [];
		const resolveText = vi.fn(async () => {
			throw new Error("content 410");
		});
		const probe = makeFactory(resolveText);
		const harness = makeFutureHarness(probe.factory);
		prime(harness, "session-failure");
		let recoveryObserved = false;
		harness.controller.store.subscribe((state) => {
			if (!recoveryObserved && state.sessions["session-failure"]?.resync?.requiresFreshBaseline) {
				recoveryObserved = true;
				notices.push("gap");
			}
		});
		const pending = harness.controller.store
			.getState()
			.sendCommand("session-failure", { id: "failed-history", type: "get_entries" });
		harness.socket.receive(entriesResponse("failed-history", 0, "session-failure"));
		await expect(pending).rejects.toThrow("content 410");
		expect(notices).toHaveLength(1);
		expect(harness.controller.store.getState().sessions["session-failure"]).toMatchObject({
			baselineAuthoritative: false,
			resync: { requiresFreshBaseline: true },
		});
	});

	it.each(["get_messages", "get_entries", "get_tree"] as const)(
		"aborts late %s materialization on an exact generation change",
		async (commandType) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let signal: AbortSignal | undefined;
			const resolveText = vi.fn(async (_value: SessionTextPayloadDto, materializerSignal?: AbortSignal) => {
				signal = materializerSignal;
				await gate;
				if (materializerSignal?.aborted) throw new DOMException("aborted", "AbortError");
				return "late-history";
			});
			const harness = makeFutureHarness(makeFactory(resolveText).factory);
			prime(harness, `session-${commandType}`);
			const sessionHandle = `session-${commandType}`;
			const id = `identity-${commandType}`;
			const pending = harness.controller.store
				.getState()
				.sendCommand(sessionHandle, { id, type: commandType });
			const response =
				commandType === "get_messages"
					? messagesResponse(id, 0, sessionHandle)
					: commandType === "get_entries"
						? entriesResponse(id, 0, sessionHandle)
						: treeResponse(id, 0, sessionHandle);
			harness.socket.receive(response);
			await vi.waitFor(() => expect(signal).toBeDefined());
			harness.controller.ingestServerMessage({
				type: "runtime_state",
				runtime: futureRuntime(sessionHandle, 2),
			});
			expect(signal?.aborted).toBe(true);
			await expect(pending).rejects.toMatchObject({ code: "response_mismatch" });
			release();
			await flushPromises();
			expect(harness.controller.store.getState().sessions[sessionHandle]?.generation).toBe(2);
		},
	);
});

describe("Stage 7D future hello-scoped install", () => {
	it("fails closed when a custom factory returns a malformed installation", () => {
		const socket = new FutureSocket();
		const malformedFactory = (() => undefined) as unknown as FutureSessionContentAdapterFactory;
		const controller = createSessionTransport({
			createSocket: () => socket,
			url: () => "ws://stage7.test/api/v1/ws",
			futureContentAdapterFactory: malformedFactory,
			reconnectBaseMs: 1,
		});
		controllers.push(controller);
		controller.store.getState().connect();
		socket.open();
		socket.receive(futureServerHello());

		expect(controller.store.getState().connectionState).toBe("incompatible");
	});

	it("freezes the negotiated context, installs once, and disposes on disconnect", () => {
		const resolveText = vi.fn(async () => "installed");
		const probe = makeFactory(resolveText);
		const harness = makeFutureHarness(probe.factory);

		expect(probe.contexts).toHaveLength(1);
		const context = probe.contexts[0];
		if (!context) throw new Error("future context was not installed");
		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.isFrozen(context.payloadBudget)).toBe(true);
		expect(Object.isFrozen(context.contentRefBudget)).toBe(true);
		expect(harness.controller.store.getState().connectionState).toBe("online");
		harness.controller.store.getState().disconnect();
		expect(probe.dispose).toHaveBeenCalledTimes(1);
	});
});
