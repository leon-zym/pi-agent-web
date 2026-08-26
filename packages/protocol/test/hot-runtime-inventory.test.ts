import { describe, expect, it } from "vitest";
import {
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	isSessionWsClientMessage,
	isSessionWsServerMessage,
	negotiateHotRuntimeInventory,
	SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES,
	SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS,
	sessionWsServerMessageBytes,
} from "../src/index.js";

const serverEpoch = "gateway-epoch-a";

function entry(index = 0, overrides: Record<string, unknown> = {}) {
	return {
		serverEpoch,
		sessionHandle: `session-${String(index)}`,
		workspaceId: `workspace-${String(index)}`,
		generation: index + 1,
		state: "running",
		...overrides,
	};
}

function inventory(overrides: Record<string, unknown> = {}) {
	return {
		type: "hot_runtime_inventory",
		serverEpoch,
		revision: 4,
		runtimes: [entry()],
		...overrides,
	};
}

function clientHello(overrides: Partial<GatewayClientHelloDto> = {}): GatewayClientHelloDto {
	return {
		type: "client_hello",
		protocol: { major: 1, minor: 1 },
		clientBuild: "client-test",
		capabilities: [GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY],
		limits: { maxServerFrameBytes: SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES },
		...overrides,
	};
}

function serverHello(overrides: Partial<GatewayServerHelloDto> = {}): GatewayServerHelloDto {
	return {
		type: "server_hello",
		protocol: { major: 1, minor: 1 },
		serverBuild: "server-test",
		serverEpoch,
		piVersion: "test",
		adapterId: "test",
		capabilities: [GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY],
		limits: {
			maxClientFrameBytes: 1024,
			maxSnapshotFrameBytes: SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES,
			maxExtensionRequests: 1,
		},
		...overrides,
	};
}

describe("hot Runtime inventory protocol", () => {
	it("accepts one bounded epoch-scoped full hot inventory", () => {
		const value = inventory({
			runtimes: [
				entry(0, { state: "starting" }),
				entry(1, { state: "idle" }),
				entry(2, { state: "running" }),
				entry(3, { state: "waiting_ui" }),
			],
		});
		expect(isSessionWsServerMessage(value)).toBe(true);
	});

	it("rejects item and exact UTF-8 byte overflow", () => {
		expect(
			isSessionWsServerMessage(
				inventory({
					runtimes: Array.from({ length: SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS + 1 }, (_, index) =>
						entry(index),
					),
				}),
			),
		).toBe(false);

		const maximumEscaped = "\0".repeat(256);
		const fullMaximumInventory = inventory({
			serverEpoch: "\0".repeat(128),
			runtimes: Array.from({ length: SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS }, (_, index) => {
				const suffix = String.fromCharCode(index);
				return entry(index, {
					serverEpoch: "\0".repeat(128),
					sessionHandle: `${maximumEscaped.slice(0, -1)}${suffix}`,
					workspaceId: `${suffix}${maximumEscaped.slice(1)}`,
					generation: Number.MAX_SAFE_INTEGER,
					state: "waiting_ui",
				});
			}),
		});
		expect(sessionWsServerMessageBytes(fullMaximumInventory)).toBeLessThanOrEqual(
			SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES,
		);
		expect(isSessionWsServerMessage(fullMaximumInventory)).toBe(true);

		const byteOverflow = {
			...fullMaximumInventory,
			padding: "x".repeat(SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES),
		};
		expect(sessionWsServerMessageBytes(byteOverflow)).toBeGreaterThan(
			SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES,
		);
		expect(isSessionWsServerMessage(byteOverflow)).toBe(false);
	});

	it("negotiates only from the client and selected Gateway hello intersection", () => {
		expect(negotiateHotRuntimeInventory(clientHello({ capabilities: [] }), serverHello())).toEqual({
			negotiated: false,
			reason: "capability_missing",
		});
		expect(
			negotiateHotRuntimeInventory(clientHello({ protocol: { major: 1, minor: 0 } }), serverHello()),
		).toEqual({ negotiated: false, reason: "protocol_minor_unsupported" });
		expect(
			negotiateHotRuntimeInventory(
				{
					...clientHello(),
					limits: { maxServerFrameBytes: SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES - 1 },
				},
				serverHello({
					limits: {
						maxClientFrameBytes: 1024,
						maxSnapshotFrameBytes: SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES - 1,
						maxExtensionRequests: 1,
					},
				}),
			),
		).toEqual({ negotiated: false, reason: "server_frame_limit_too_small" });
		expect(negotiateHotRuntimeInventory(clientHello(), serverHello({ capabilities: [] }))).toEqual({
			negotiated: false,
			reason: "gateway_capability_missing",
		});
		expect(
			negotiateHotRuntimeInventory(
				clientHello(),
				serverHello({
					limits: {
						maxClientFrameBytes: 1024,
						maxSnapshotFrameBytes: SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES - 1,
						maxExtensionRequests: 1,
					},
				}),
			),
		).toEqual({ negotiated: false, reason: "server_frame_limit_too_small" });
		expect(
			negotiateHotRuntimeInventory(clientHello({ protocol: { major: 2, minor: 1 } }), serverHello()),
		).toEqual({ negotiated: false, reason: "protocol_major_unsupported" });
		expect(
			negotiateHotRuntimeInventory(clientHello(), serverHello({ protocol: { major: 2, minor: 1 } })),
		).toEqual({ negotiated: false, reason: "protocol_major_unsupported" });
		expect(
			negotiateHotRuntimeInventory(clientHello(), serverHello({ protocol: { major: 1, minor: 0 } })),
		).toEqual({ negotiated: false, reason: "protocol_minor_unsupported" });
		expect(
			negotiateHotRuntimeInventory(clientHello(), serverHello({ protocol: { major: 1, minor: 2 } })),
		).toEqual({ negotiated: false, reason: "protocol_selection_invalid" });
		expect(
			negotiateHotRuntimeInventory(
				clientHello(),
				serverHello({
					limits: {
						maxClientFrameBytes: 1024,
						maxSnapshotFrameBytes: SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES + 1,
						maxExtensionRequests: 1,
					},
				}),
			),
		).toEqual({ negotiated: false, reason: "server_frame_selection_invalid" });
		expect(negotiateHotRuntimeInventory(clientHello(), serverHello())).toEqual({ negotiated: true });
	});

	it("rejects duplicates, mixed epochs, dormant states, and malformed revisions", () => {
		expect(isSessionWsServerMessage(inventory({ runtimes: [entry(), entry()] }))).toBe(false);
		expect(
			isSessionWsServerMessage(
				inventory({ runtimes: [entry(0), entry(1, { serverEpoch: "gateway-epoch-b" })] }),
			),
		).toBe(false);
		for (const state of ["crashed", "dormant", "unknown"]) {
			expect(isSessionWsServerMessage(inventory({ runtimes: [entry(0, { state })] }))).toBe(false);
		}
		for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(isSessionWsServerMessage(inventory({ revision }))).toBe(false);
		}
	});

	it("rejects unknown, inherited, accessor, symbol, and exotic inventory values", () => {
		expect(isSessionWsServerMessage(inventory({ unexpected: true }))).toBe(false);
		expect(isSessionWsServerMessage(inventory({ runtimes: [{ ...entry(), unexpected: true }] }))).toBe(false);
		expect(isSessionWsServerMessage(Object.create(inventory()))).toBe(false);

		const accessor = inventory();
		Object.defineProperty(accessor, "revision", { enumerable: true, get: () => 4 });
		expect(isSessionWsServerMessage(accessor)).toBe(false);
		const symbol = inventory();
		Object.defineProperty(symbol, Symbol("hidden"), { enumerable: true, value: true });
		expect(isSessionWsServerMessage(symbol)).toBe(false);
		expect(isSessionWsServerMessage(inventory({ runtimes: new Map([["session", entry()]]) }))).toBe(false);
		expect(isSessionWsServerMessage(inventory({ runtimes: [new Date()] }))).toBe(false);
	});
});

describe("exact hot Runtime subscription identity", () => {
	function subscribe(overrides: Record<string, unknown> = {}) {
		return {
			type: "session_subscribe",
			sessionHandle: "session-1",
			expectedHotRuntime: {
				serverEpoch,
				sessionHandle: "session-1",
				workspaceId: "workspace-1",
				generation: 2,
			},
			...overrides,
		};
	}

	it("accepts observation-only subscription to one exact hot incarnation", () => {
		expect(isSessionWsClientMessage(subscribe())).toBe(true);
		expect(isSessionWsClientMessage(subscribe({ cursor: { serverEpoch, generation: 2, seq: 9 } }))).toBe(
			true,
		);
	});

	it("retains stale cursors so replay reports the exact epoch or generation change", () => {
		for (const cursor of [
			{ serverEpoch: "gateway-epoch-b", generation: 2, seq: 9 },
			{ serverEpoch, generation: 3, seq: 9 },
		]) {
			expect(isSessionWsClientMessage(subscribe({ cursor }))).toBe(true);
		}
		expect(
			isSessionWsClientMessage(
				subscribe({ cursor: { serverEpoch, generation: 2, seq: 9, sessionHandle: "session-other" } }),
			),
		).toBe(false);
		expect(isSessionWsClientMessage(subscribe({ cursor: { serverEpoch, generation: -1, seq: 9 } }))).toBe(
			false,
		);
	});

	it("rejects mismatched target handles and authority fields", () => {
		expect(
			isSessionWsClientMessage(
				subscribe({
					expectedHotRuntime: {
						serverEpoch,
						sessionHandle: "session-other",
						workspaceId: "workspace-1",
						generation: 2,
					},
				}),
			),
		).toBe(false);
		expect(isSessionWsClientMessage(subscribe({ fencingToken: "must-not-cross" }))).toBe(false);
	});

	it("rejects unknown, inherited, and exotic exact identity records", () => {
		expect(
			isSessionWsClientMessage(
				subscribe({
					expectedHotRuntime: {
						serverEpoch,
						sessionHandle: "session-1",
						workspaceId: "workspace-1",
						generation: 2,
						unexpected: true,
					},
				}),
			),
		).toBe(false);
		const inherited = Object.create({
			serverEpoch,
			sessionHandle: "session-1",
			workspaceId: "workspace-1",
			generation: 2,
		});
		expect(isSessionWsClientMessage(subscribe({ expectedHotRuntime: inherited }))).toBe(false);
		expect(isSessionWsClientMessage(subscribe({ expectedHotRuntime: new Map() }))).toBe(false);
	});

	it("rejects exact identity fields inherited from Object.prototype", () => {
		const inheritedFields = {
			serverEpoch,
			sessionHandle: "session-1",
			workspaceId: "workspace-1",
			generation: 2,
		};
		const previous = new Map(
			Object.keys(inheritedFields).map((key) => [
				key,
				Object.getOwnPropertyDescriptor(Object.prototype, key),
			]),
		);
		try {
			for (const [key, value] of Object.entries(inheritedFields)) {
				Object.defineProperty(Object.prototype, key, { configurable: true, value });
			}
			expect(isSessionWsClientMessage(subscribe({ expectedHotRuntime: {} }))).toBe(false);
		} finally {
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
				else Reflect.deleteProperty(Object.prototype, key);
			}
		}
	});

	it("rejects a required subscribe handle inherited from Object.prototype", () => {
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "sessionHandle");
		try {
			Object.defineProperty(Object.prototype, "sessionHandle", {
				configurable: true,
				value: "session-1",
			});
			const value = subscribe();
			Reflect.deleteProperty(value, "sessionHandle");
			expect(isSessionWsClientMessage(value)).toBe(false);
		} finally {
			if (previous) Object.defineProperty(Object.prototype, "sessionHandle", previous);
			else Reflect.deleteProperty(Object.prototype, "sessionHandle");
		}
	});
});
