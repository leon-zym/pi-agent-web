import {
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	type InlineSessionReplayFrameDto,
	type InlineSessionSnapshotDto,
	isInlineSessionSnapshotDto,
	type PiProductSessionEventDto,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	type SessionRuntimeDto,
	type SessionWsClientMessage,
} from "@pi-agent-web/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionBrowserEffects } from "../src/lib/session-browser-effects";
import {
	SESSION_FRAME_DEFERRED,
	type SessionTransportController,
	type SessionWebSocket,
} from "../src/stores/session-transport";

const SERVER_EPOCH = "pipeline-epoch";
const SESSION_HANDLE = "pipeline-session";
class FakeSocket implements SessionWebSocket {
	readyState = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<SessionWsClientMessage | GatewayClientHelloDto> = [];

	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}

	open(epoch = SERVER_EPOCH): void {
		this.readyState = 1;
		this.onopen?.();
		this.receive({
			type: "server_hello",
			protocol: { major: 1, minor: 4 },
			serverBuild: "test",
			serverEpoch: epoch,
			piVersion: "test",
			adapterId: "test",
			capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES, GATEWAY_SESSION_HISTORY_CAPABILITY],
			limits: {
				maxClientFrameBytes: 8 * 1024 * 1024,
				maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
				maxExtensionRequests: 256,
			},
			payloadBudget: SESSION_PAYLOAD_BUDGET,
			contentRefBudget: SESSION_CONTENT_REF_BUDGET,
		} satisfies GatewayServerHelloDto);
		this.receive({
			type: "hot_runtime_inventory",
			serverEpoch: epoch,
			revision: 0,
			runtimes: [],
		});
	}

	receive(message: object): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	close(): void {
		this.readyState = 3;
	}
}

function runtime(lastSeq: number): SessionRuntimeDto {
	return {
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: SESSION_HANDLE,
		generation: 1,
		nativeSessionId: "native-a",
		sessionFile: "/tmp/a.jsonl",
		cwd: "/tmp",
		lastSeq,
		state: "running",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function frame(
	seq: number,
	event: PiProductSessionEventDto,
): Extract<InlineSessionReplayFrameDto, { type: "event" }> {
	return {
		type: "event",
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: SESSION_HANDLE,
		generation: 1,
		seq,
		event,
	};
}

function snapshot(
	pendingExtensionRequests: InlineSessionSnapshotDto["pendingExtensionRequests"] = [],
): InlineSessionSnapshotDto {
	return {
		type: "session_snapshot",
		snapshotId: "pipeline-snapshot",
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: SESSION_HANDLE,
		generation: 1,
		baseSeq: 0,
		asOfSeq: 2,
		runtime: runtime(2),
		settledMessages: [],
		projectionEvents: [frame(1, { type: "agent_start" }), frame(2, { type: "turn_start" })],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests,
		stickyExtensionState: [],
	};
}

const controllers: SessionTransportController[] = [];
const browserEffects: SessionBrowserEffects[] = [];
const stopRecovery: (() => void)[] = [];

async function setup() {
	vi.resetModules();
	const { createSessionTransport } = await import("../src/stores/session-transport");
	const { api } = await import("../src/lib/api");
	const sockets: FakeSocket[] = [];
	const controller = createSessionTransport({
		reauthenticate: (signal) => api.bootstrap(signal),
		reconnectBaseMs: 500,
		reconnectMaxMs: 500,
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		url: () => "ws://pipeline.test",
		protocolVersion: { major: 1, minor: 4 },
	});
	controllers.push(controller);
	vi.doMock("../src/stores/session-transport", async () => ({
		...(await vi.importActual<typeof import("../src/stores/session-transport")>(
			"../src/stores/session-transport",
		)),
		sessionTransport: controller,
		SESSION_FRAME_DEFERRED,
	}));
	const [{ initPipeline }, { useExtensionUiStore }, { useProjectionStore }] = await Promise.all([
		import("../src/lib/stream-pipeline"),
		import("../src/stores/extension-ui"),
		import("../src/stores/projection"),
	]);
	// Controller, pipeline and effects are loaded from the same post-reset graph.
	const effects = (await import("../src/lib/session-browser-effects")).getSessionBrowserEffects();
	browserEffects.push(effects);
	initPipeline();
	const socket = sockets[0];
	if (!socket) throw new Error("pipeline did not connect");
	socket.open();
	controller.store.getState().subscribeSession(SESSION_HANDLE);
	socket.receive({ type: "runtime_state", runtime: runtime(2) });
	socket.receive({
		type: "resync_required",
		serverEpoch: SERVER_EPOCH,
		sessionHandle: SESSION_HANDLE,
		runtime: runtime(2),
		reason: "gap",
	});
	return { controller, socket, sockets, useExtensionUiStore, useProjectionStore, effects };
}

function disposeHarness() {
	for (const stop of stopRecovery.splice(0)) stop();
	for (const effects of browserEffects.splice(0)) effects.dispose();
	for (const controller of controllers.splice(0)) controller.dispose();
}

afterEach(() => {
	disposeHarness();
	vi.doUnmock("../src/stores/session-transport");
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it.each(["epoch-b", SERVER_EPOCH])(
	"recovers directory reads without user activity after reconnect to %s",
	async (recoveredEpoch) => {
		vi.useFakeTimers();
		const workspace = {
			workspaceHandle: "workspace-a",
			path: "/tmp",
			available: true,
			pinned: false,
			displayName: "Test",
			lastOpenedAt: null,
			sessionCount: 1,
			hasNativeHistory: true,
		};
		const session = {
			sessionHandle: SESSION_HANDLE,
			workspaceHandle: "workspace-a",
			nativeSessionId: "native-a",
			sessionFile: "/tmp/a.jsonl",
			persisted: true,
			createdAt: null,
			modifiedAt: null,
			messageCount: 1,
			firstMessage: "Test",
			runtime: runtime(2),
		};
		let phase = "initial";
		const requests: { url: string; phase: string; status: string }[] = [],
			pending: (() => void)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = String(input),
					record = { url, phase, status: "pending" };
				requests.push(record);
				if (phase === "armed")
					return new Promise((_resolve, reject) =>
						pending.push(() => {
							record.status = "network failure";
							reject(new TypeError("Failed to fetch"));
						}),
					);
				if (phase === "down") {
					record.status = "connection refused";
					return Promise.reject(new TypeError("Failed to fetch"));
				}
				record.status = "200";
				return Promise.resolve(
					new Response(
						JSON.stringify(
							url.endsWith("workspaces")
								? [workspace]
								: url.endsWith("bootstrap")
									? {}
									: { sessions: [session] },
						),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
				);
			}),
		);
		const { controller, socket, sockets, effects } = await setup();
		const { useSessionDirectoryStore: directory } = await import("../src/stores/session-directory");
		const { useComposerStore: composer } = await import("../src/stores/composer");
		directory.setState({
			workspaces: [workspace],
			currentWorkspaceHandle: "workspace-a",
			currentSession: session,
			sessionsByWorkspace: { "workspace-a": [session] },
			selectedSessionByWorkspace: { "workspace-a": SESSION_HANDLE },
		});
		composer.getState().beginSession(SESSION_HANDLE);
		composer.getState().setDraft("Preserve draft");
		const bootstrap = await import("../src/lib/initial-inventory-bootstrap");
		const { loadDirectoryAfterStableHotInventory } = bootstrap;
		expect(
			await loadDirectoryAfterStableHotInventory({
				waitForInitialHotInventory: controller.waitForInitialHotInventory,
				loadWorkspaces: () => directory.getState().loadWorkspaces(),
				readTransportState: () => controller.store.getState(),
				isCancelled: () => false,
			}),
		).toBe(true);
		// Optional only to run this regression unchanged against the pre-fix source.
		const stop = bootstrap.watchDirectoryReconnect?.({
			readTransportState: () => controller.store.getState(),
			subscribeTransportState: (listener) => controller.store.subscribe(listener),
			invalidateDirectoryRequests: () => directory.getState().invalidateDirectoryRequests(),
			loadWorkspaces: (options) => directory.getState().loadWorkspaces(options),
			reloadCurrentSessions: (options) =>
				directory.getState().reloadSessions(undefined, { ...options, force: true }),
		});
		if (stop) stopRecovery.push(stop);
		socket.receive(snapshot());
		await vi.advanceTimersByTimeAsync(0);
		phase = "armed";
		socket.receive(frame(3, { type: "agent_settled" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(effects.pendingTimerCount()).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(100);
		expect(pending).toHaveLength(2);
		expect(directory.getState()).toMatchObject({ loadingWorkspaces: true, loadingSessions: true });
		phase = "down";
		socket.close();
		socket.onclose?.();
		for (const reject of pending) reject();
		await vi.advanceTimersByTimeAsync(500);
		expect(requests.some((r) => r.url.endsWith("bootstrap") && r.status === "connection refused")).toBe(true);
		expect(directory.getState()).toMatchObject({
			error: "Failed to fetch",
			loadingWorkspaces: false,
			loadingSessions: false,
		});
		phase = "restarted";
		await vi.advanceTimersByTimeAsync(500);
		expect(sockets).toHaveLength(2);
		const recoveredSocket = sockets[1];
		if (!recoveredSocket) throw new Error("Missing reconnect socket");
		recoveredSocket.open(recoveredEpoch);
		const freshRuntime = { ...runtime(0), serverEpoch: recoveredEpoch, state: "idle" as const };
		const fresh = {
			...snapshot(),
			snapshotId: "fresh",
			serverEpoch: recoveredEpoch,
			asOfSeq: 0,
			runtime: freshRuntime,
			projectionEvents: [],
		};
		expect(isInlineSessionSnapshotDto(fresh)).toBe(true);
		recoveredSocket.receive({
			type: "hot_runtime_inventory",
			serverEpoch: recoveredEpoch,
			revision: 1,
			runtimes: [
				{
					serverEpoch: recoveredEpoch,
					sessionHandle: SESSION_HANDLE,
					workspaceId: freshRuntime.workspaceId,
					generation: 1,
					state: "idle",
				},
			],
		});
		recoveredSocket.receive({ type: "runtime_state", runtime: freshRuntime });
		recoveredSocket.receive({
			type: "resync_required",
			serverEpoch: recoveredEpoch,
			sessionHandle: SESSION_HANDLE,
			runtime: freshRuntime,
			reason: "gap",
		});
		recoveredSocket.receive(fresh);
		await vi.advanceTimersByTimeAsync(0);
		recoveredSocket.receive({
			type: "lease_status",
			serverEpoch: recoveredEpoch,
			sessionHandle: SESSION_HANDLE,
			generation: 1,
			leaseRevision: 1,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		recoveredSocket.receive({ ...controller.store.getState().hotRuntimeInventory, revision: 2 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.store.getState().sessions[SESSION_HANDLE]?.runtime?.state).toBe("idle");

		expect(controller.store.getState().hotRuntimeInventory?.runtimes).toHaveLength(1);
		expect(effects.pendingTimerCount()).toBe(0);
		expect(controller.store.getState().sessions[SESSION_HANDLE]?.freshLeaseBaseline?.serverEpoch).toBe(
			recoveredEpoch,
		);
		expect(controller.store.getState()).toMatchObject({
			connectionState: "online",
			hotRuntimeInventory: { serverEpoch: recoveredEpoch },
		});
		expect(controller.store.getState().sessions[SESSION_HANDLE]).toMatchObject({
			baselineAuthoritative: true,
		});
		expect(
			requests.some((r) => r.url.endsWith("bootstrap") && r.phase === "restarted" && r.status === "200"),
		).toBe(true);
		expect(requests.filter((r) => r.phase === "armed")).toHaveLength(2);
		expect(
			requests.filter((r) => r.phase === "restarted" && !r.url.endsWith("bootstrap")).map((r) => r.url),
		).toEqual(["/api/v1/workspaces", "/api/v1/workspaces/workspace-a/sessions?refresh=1"]);
		expect(directory.getState()).toMatchObject({
			error: undefined,
			loadingWorkspaces: false,
			loadingSessions: false,
			currentWorkspaceHandle: "workspace-a",
			currentSession: { sessionHandle: SESSION_HANDLE },
			selectedSessionByWorkspace: { "workspace-a": SESSION_HANDLE },
		});
		expect(composer.getState().draft).toBe("Preserve draft");
	},
);
