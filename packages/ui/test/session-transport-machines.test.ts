import {
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	type GatewayClientHelloDto,
	type PiSessionCommandResponseDto,
	SESSION_PAYLOAD_BUDGET,
	type SessionCommandDto,
	type SessionLeaseStatusDto,
	type SessionResponseFrameDto,
	type SessionRuntimeDto,
	type SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	createSessionCommandMachine,
	type SessionCommandMachineResolvedResponse,
} from "../src/stores/command-machine";
import {
	createSessionConnectionMachine,
	type SessionConnectionMachineOptions,
} from "../src/stores/connection-machine";
import { createSessionControlMachine } from "../src/stores/control-machine";

const identity: SessionRuntimeIdentityDto = {
	serverEpoch: "epoch-a",
	sessionHandle: "session-a",
	workspaceId: "workspace-a",
	generation: 7,
};

const runtime: SessionRuntimeDto = {
	...identity,
	nativeSessionId: "native-session-a",
	sessionFile: "/tmp/session-a.jsonl",
	cwd: "/tmp/workspace-a",
	lastSeq: 4,
	state: "idle",
	lastActivityAt: 100,
	recoverable: true,
};

function identityKey(value: SessionRuntimeIdentityDto): string {
	return JSON.stringify([value.serverEpoch, value.workspaceId, value.sessionHandle, value.generation]);
}

function leaseStatus(
	value: SessionRuntimeIdentityDto,
	leaseRevision: number,
	overrides: Partial<SessionLeaseStatusDto> = {},
): SessionLeaseStatusDto {
	return {
		type: "lease_status",
		serverEpoch: value.serverEpoch,
		sessionHandle: value.sessionHandle,
		generation: value.generation,
		leaseRevision,
		controlState: "free",
		transition: "baseline",
		isController: false,
		...overrides,
	};
}

function commandResponse(
	id: string,
	command: SessionCommandDto["type"] = "get_messages",
): PiSessionCommandResponseDto {
	return command === "get_messages"
		? {
				id,
				type: "response",
				command,
				success: true,
				data: { messages: [] },
			}
		: ({
				id,
				type: "response",
				command,
				success: true,
			} as PiSessionCommandResponseDto);
}

function responseFrame(
	value: SessionRuntimeIdentityDto,
	id: string,
	barrierSeq: number,
	command: SessionCommandDto["type"] = "get_messages",
): SessionResponseFrameDto {
	return {
		type: "response",
		serverEpoch: value.serverEpoch,
		sessionHandle: value.sessionHandle,
		generation: value.generation,
		barrierSeq,
		response: commandResponse(id, command) as SessionResponseFrameDto["response"],
	};
}

function requestEvent(
	value: SessionRuntimeIdentityDto,
	overrides: Partial<
		Extract<Parameters<ReturnType<typeof createSessionCommandMachine>["transition"]>[0], { type: "request" }>
	> = {},
) {
	return {
		type: "request" as const,
		sessionHandle: value.sessionHandle,
		command: { type: "get_messages" as const },
		timeoutMs: 1_000,
		now: 123,
		subscribed: true,
		online: true,
		socketReady: true,
		generation: value.generation,
		currentIdentity: value,
		baselineAuthoritative: true,
		freshLeaseBaseline: value,
		isController: false,
		resolve: () => {},
		reject: () => {},
		...overrides,
	};
}

describe("Session connection machine", () => {
	it("sends the exact hello, fences stale epochs, reconnects, and terminates on mismatch", () => {
		const clientHello: GatewayClientHelloDto = {
			type: "client_hello",
			protocol: { major: 1, minor: 4 },
			clientBuild: "test-build",
			capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
			limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
		};
		const options: SessionConnectionMachineOptions = {
			clientHello,
			helloTimeoutMs: 500,
			reconnectBaseMs: 25,
			reconnectMaxMs: 100,
		};
		const machine = createSessionConnectionMachine(options);

		let transition = machine.transition({ type: "connect" });
		expect(transition.state).toMatchObject({ phase: "connecting", socketEpoch: 1 });
		expect(transition.intents).toContainEqual({ type: "open_socket", socketEpoch: 1 });
		transition = machine.transition({ type: "socket_open", socketEpoch: 1 });
		expect(transition.state.phase).toBe("awaiting-hello");
		expect(transition.intents).toContainEqual({
			type: "send_client_hello",
			socketEpoch: 1,
			hello: clientHello,
		});
		machine.transition({ type: "server_hello", socketEpoch: 1, serverEpoch: "epoch-a", accepted: true });
		transition = machine.transition({
			type: "initial_inventory",
			socketEpoch: 1,
			serverEpoch: "epoch-a",
			accepted: true,
		});
		expect(transition.state).toMatchObject({
			phase: "ready",
			observableState: "online",
			serverEpoch: "epoch-a",
		});

		transition = machine.transition({ type: "socket_closed", socketEpoch: 1 });
		expect(transition.state).toMatchObject({ phase: "backoff", reconnectAttempt: 1 });
		expect(transition.intents).toContainEqual({ type: "schedule_reconnect", socketEpoch: 1, delayMs: 25 });
		transition = machine.transition({ type: "reconnect_timer", socketEpoch: 1 });
		expect(transition.state).toMatchObject({ phase: "connecting", socketEpoch: 2 });

		machine.transition({ type: "socket_open", socketEpoch: 2 });
		transition = machine.transition({
			type: "server_hello",
			socketEpoch: 2,
			serverEpoch: "epoch-b",
			accepted: false,
		});
		expect(transition.state).toMatchObject({
			phase: "terminal",
			observableState: "incompatible",
			reconnectEnabled: false,
		});
		expect(transition.intents).toContainEqual({ type: "close_socket", socketEpoch: 2 });
		const stale = machine.transition({ type: "socket_closed", socketEpoch: 1 });
		expect(stale.state.phase).toBe("terminal");
		expect(stale.intents).toEqual([]);
	});

	it("terminates when the accepted hello epoch disagrees with initial inventory", () => {
		const machine = createSessionConnectionMachine({
			clientHello: {
				type: "client_hello",
				protocol: { major: 1, minor: 4 },
				clientBuild: "test-build",
				capabilities: [],
				limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
			},
			helloTimeoutMs: 500,
			reconnectBaseMs: 25,
			reconnectMaxMs: 100,
		});
		machine.transition({ type: "connect" });
		machine.transition({ type: "socket_open", socketEpoch: 1 });
		machine.transition({ type: "server_hello", socketEpoch: 1, serverEpoch: "epoch-a", accepted: true });
		const transition = machine.transition({
			type: "initial_inventory",
			socketEpoch: 1,
			serverEpoch: "epoch-b",
			accepted: true,
		});
		expect(transition.state.phase).toBe("terminal");
	});
});

describe("Session control machine", () => {
	it("defers lease state until baseline, gates claims, and preserves takeover CAS fencing", () => {
		const machine = createSessionControlMachine();
		const handle = identity.sessionHandle;
		machine.transition({ type: "subscribe", sessionHandle: handle });
		machine.transition({
			type: "subscription_started",
			sessionHandle: handle,
			expectedIdentity: identityKey(identity),
		});

		const deferred = machine.transition({
			type: "lease_status",
			sessionHandle: handle,
			message: leaseStatus(identity, 0),
			currentIdentity: identity,
			baselineAuthoritative: false,
		});
		expect(deferred.intents).toEqual([]);
		expect(machine.getSession(handle)?.pendingLeaseStatus?.message.leaseRevision).toBe(0);
		const baseline = machine.transition({ type: "baseline_committed", identity });
		expect(machine.getSession(handle)).toMatchObject({
			freshLeaseBaseline: identity,
			lease: { leaseRevision: 0, controlState: "free", isController: false },
			subscriptionBaseline: undefined,
		});
		expect(baseline.intents).toContainEqual({ type: "emit_lease_status", message: leaseStatus(identity, 0) });

		machine.transition({ type: "claim_intent", sessionHandle: handle });
		const claim = machine.transition({
			type: "claim_if_ready",
			sessionHandle: handle,
			online: true,
			baselineAuthoritative: true,
			currentIdentity: identity,
		});
		expect(claim.intents).toContainEqual({
			type: "send",
			message: { type: "session_claim", sessionHandle: handle },
			onFailure: "claim",
		});
		expect(machine.getSession(handle)?.claimPending).toBe(true);
		machine.transition({ type: "claim_send_failed", sessionHandle: handle });

		machine.transition({
			type: "lease_status",
			sessionHandle: handle,
			message: leaseStatus(identity, 1, { controlState: "held", transition: "claim" }),
			currentIdentity: identity,
			baselineAuthoritative: true,
		});
		const takeover = machine.transition({
			type: "takeover",
			sessionHandle: handle,
			online: true,
			baselineAuthoritative: true,
			currentIdentity: identity,
			runtime,
			resync: false,
		});
		expect(takeover.intents).toContainEqual({
			type: "send",
			message: {
				type: "session_takeover",
				sessionHandle: handle,
				expectedGeneration: identity.generation,
				expectedLeaseRevision: 1,
			},
			onFailure: "takeover",
		});

		const conflict = machine.transition({
			type: "lease_status",
			sessionHandle: handle,
			message: leaseStatus(identity, 1),
			currentIdentity: identity,
			baselineAuthoritative: true,
		});
		expect(conflict.leaseAccepted).toBe(false);
		expect(machine.getSession(handle)).toMatchObject({
			freshLeaseBaseline: null,
			claimPending: false,
			takeoverAttempt: null,
			lease: { conflicted: true, isController: false, leaseRevision: 1 },
		});

		machine.transition({
			type: "lease_status",
			sessionHandle: handle,
			message: leaseStatus(identity, 2),
			currentIdentity: identity,
			baselineAuthoritative: true,
		});
		expect(machine.getSession(handle)?.lease.conflicted).toBeUndefined();
	});

	it("records an explicit release without inventing a local fence", () => {
		const machine = createSessionControlMachine();
		const handle = "release-session";
		const releaseIdentity = { ...identity, sessionHandle: handle };
		machine.transition({ type: "subscribe", sessionHandle: handle });
		machine.transition({
			type: "lease_status",
			sessionHandle: handle,
			message: leaseStatus(releaseIdentity, 4),
			currentIdentity: releaseIdentity,
			baselineAuthoritative: true,
		});
		const transition = machine.transition({ type: "release", sessionHandle: handle, online: true });
		expect(transition.intents).toContainEqual({
			type: "send",
			message: { type: "session_release", sessionHandle: handle },
			onFailure: null,
		});
		expect(machine.getSession(handle)).toMatchObject({
			controllerIntent: false,
			released: true,
			freshLeaseBaseline: null,
			lease: { isController: false, leaseRevision: 4 },
		});
	});
});

describe("Session command machine", () => {
	it("captures identity and resolves only after the authoritative projection barrier", () => {
		const machine = createSessionCommandMachine();
		const request = machine.transition(
			requestEvent(identity, { command: { type: "get_messages" }, now: 10 }),
		);
		expect(request.accepted).toBe(true);
		const pending = Object.values(machine.getState().pending)[0];
		expect(pending).toMatchObject({
			id: "session-ui-1-a",
			serverEpoch: identity.serverEpoch,
			workspaceId: identity.workspaceId,
			sessionHandle: identity.sessionHandle,
			generation: identity.generation,
		});
		if (!pending) throw new Error("request did not create a pending command");
		const id = pending.id;
		const frame = responseFrame(identity, id, 2);
		machine.transition({ type: "wire_response", message: frame, history: false });
		const materialized: SessionCommandMachineResolvedResponse = {
			type: "response",
			serverEpoch: frame.serverEpoch,
			sessionHandle: frame.sessionHandle,
			generation: frame.generation,
			barrierSeq: frame.barrierSeq,
			response: frame.response as unknown as PiSessionCommandResponseDto,
		};
		machine.transition({ type: "response_materialized", id, token: pending.token, response: materialized });
		const beforeBarrier = machine.transition({
			type: "projection_advanced",
			sessionHandle: identity.sessionHandle,
			currentIdentity: identity,
			baselineAuthoritative: true,
			projectedSeq: 1,
		});
		expect(beforeBarrier.intents).toEqual([]);
		const atBarrier = machine.transition({
			type: "projection_advanced",
			sessionHandle: identity.sessionHandle,
			currentIdentity: identity,
			baselineAuthoritative: true,
			projectedSeq: 2,
		});
		expect(atBarrier.intents).toHaveLength(2);
		expect(atBarrier.intents[1]).toMatchObject({ type: "resolve", id, token: pending.token });
		expect(machine.getPending(id)).toBeUndefined();
	});

	it("rejects at timeout, ignores late responses, and fences stale mutation responses", () => {
		const machine = createSessionCommandMachine();
		const timeoutRequest = machine.transition(
			requestEvent(identity, { command: { type: "get_messages", id: "timeout-id" }, now: 11 }),
		);
		const timeoutPending = machine.getPending("timeout-id");
		if (!timeoutPending) throw new Error("timeout request did not create a pending command");
		const timeout = machine.transition({
			type: "timeout",
			id: timeoutPending.id,
			token: timeoutPending.token,
		});
		expect(timeout.intents.at(-1)).toMatchObject({ type: "reject", error: { code: "timeout" } });
		expect(
			machine.transition({
				type: "wire_response",
				message: responseFrame(identity, "timeout-id", 0),
				history: false,
			}).intents,
		).toEqual([]);
		expect(timeoutRequest.accepted).toBe(true);

		const mutation = machine.transition(
			requestEvent(identity, {
				command: { type: "prompt", message: "hello" },
				isController: true,
				fencingToken: "fence-a",
				now: 12,
			}),
		);
		const mutationSend = mutation.intents.find((intent) => intent.type === "send");
		expect(mutationSend).toMatchObject({ message: { fencingToken: "fence-a" } });
		if (mutationSend?.type !== "send") throw new Error("mutation was not sent");
		const mutationId = mutationSend.id;
		const mutationPending = machine.getPending(mutationId);
		if (!mutationPending) throw new Error("mutation did not create a pending command");
		const stale = machine.transition({
			type: "wire_response",
			message: responseFrame({ ...identity, generation: identity.generation + 1 }, mutationId, 0, "prompt"),
			history: false,
		});
		expect(stale.intents.at(-1)).toMatchObject({ type: "reject", error: { code: "response_mismatch" } });
		expect(machine.getPending(mutationId)).toBeUndefined();

		const gated = machine.transition(
			requestEvent(identity, {
				command: { type: "prompt", message: "blocked" },
				isController: false,
				now: 13,
			}),
		);
		expect(gated.error?.code).toBe("session_read_only");
	});
});
