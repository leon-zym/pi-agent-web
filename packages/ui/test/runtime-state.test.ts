import { describe, expect, it } from "vitest";
import {
	runtimeIsBusy,
	runtimeIsReady,
	runtimeIsSettled,
	runtimePhase,
	runtimeStateForDisplay,
} from "../src/lib/runtime-state";

function runtime(state: "starting" | "idle" | "running" | "waiting_ui" | "crashed" | "dormant") {
	return { state };
}

describe("runtime-state", () => {
	it("falls back to legacy state when phase is absent", () => {
		expect(runtimePhase(runtime("starting"))).toBe("starting");
		expect(runtimeIsBusy(runtime("starting"))).toBe(true);
		expect(runtimeIsBusy(runtime("running"))).toBe(true);
		expect(runtimeIsReady(runtime("idle"))).toBe(true);
		expect(runtimeIsSettled(runtime("idle"))).toBe(true);
		expect(runtimeIsSettled(runtime("crashed"))).toBe(true);
		expect(runtimeIsSettled(runtime("dormant"))).toBe(true);
	});

	it("uses phase as the authoritative operational signal", () => {
		expect(runtimeIsBusy({ state: "idle", phase: "busy" })).toBe(true);
		expect(runtimeIsReady({ state: "running", phase: "ready" })).toBe(true);
		expect(runtimeIsSettled({ state: "running", phase: "ready" })).toBe(true);
		expect(runtimeIsSettled({ state: "idle", phase: "busy" })).toBe(false);
		expect(runtimeStateForDisplay({ state: "idle", phase: "busy" })).toBe("running");
		expect(runtimeStateForDisplay({ state: "running", phase: "ready" })).toBe("idle");
	});

	it("is conservative and side-effect free for missing runtimes", () => {
		expect(runtimePhase(undefined)).toBeNull();
		expect(runtimeIsBusy(undefined)).toBe(false);
		expect(runtimeIsReady(null)).toBe(false);
		expect(runtimeIsSettled(undefined)).toBe(false);
		expect(runtimeStateForDisplay(null)).toBeUndefined();
	});
});
