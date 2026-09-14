import { type ReactNode, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { sessionTransport } from "../stores/session-transport";
import { createRecoveryRecorder, type RecoverySample } from "./benchmark-recovery-recorder";

export function installRecoveryEvidence(): void {
	const recorder = createRecoveryRecorder();
	let trial = -1;
	let handle = "";
	let identity = "";
	let armed = false;
	let previous = "";
	const stateRow = (kind: RecoverySample["kind"], socket = 0, seq?: number): RecoverySample => {
		const channel = sessionTransport.store.getState().sessions[handle];
		const runtime = channel?.runtime;
		if (!runtime || `${runtime.serverEpoch}/${runtime.generation}/${runtime.workspaceId}` !== identity)
			recorder.fail();
		return {
			kind,
			socket,
			seq: seq ?? channel?.lastSeq ?? -1,
			projected: channel?.projectedSeq ?? -1,
			baseline: channel?.baselineAuthoritative === true,
			resync: channel?.resync !== null,
		};
	};
	const safely = (action: () => void): void => {
		try {
			action();
		} catch {
			recorder.fail();
		}
	};
	sessionTransport.frameBus.subscribeAll(({ message }) => {
		if (!armed || !("sessionHandle" in message) || message.sessionHandle !== handle) return;
		safely(() => {
			if ("seq" in message) recorder.record(trial, stateRow("bus", 0, message.seq));
			else if (message.type === "resync_required" || message.type.startsWith("session_snapshot"))
				recorder.fail();
		});
	});
	sessionTransport.store.subscribe(() => {
		if (!armed) return;
		safely(() => {
			const row = stateRow("state");
			const signature = `${row.seq}/${row.projected}/${row.baseline}/${row.resync}`;
			if (signature !== previous) {
				previous = signature;
				recorder.record(trial, row);
			}
		});
	});
	Object.defineProperty(window, "__piwebBenchmarkRecovery", {
		value: {
			start(index: number, sessionHandle: string) {
				safely(() => {
					recorder.start(index);
					trial = index;
					handle = sessionHandle;
					const runtime = sessionTransport.store.getState().sessions[handle]?.runtime;
					identity = `${runtime?.serverEpoch}/${runtime?.generation}/${runtime?.workspaceId}`;
					armed = true;
					previous = "";
					recorder.record(trial, stateRow("start"));
				});
			},
			record(index: number, kind: RecoverySample["kind"], socket: number, seq: number) {
				safely(() => recorder.record(index, stateRow(kind, socket, seq)));
			},
			end(index: number) {
				safely(() => {
					recorder.record(index, stateRow("end"));
					recorder.end(index);
					armed = false;
				});
			},
			read: recorder.read,
			fail: recorder.fail,
		},
	});
}

/**
 * This root exists only in a Vite benchmark build. The normal production entry never imports the
 * module, so benchmark-only build composition does not enter the standard bundle.
 */
export function renderBenchmarkRoot(root: Root, children: ReactNode): void {
	installRecoveryEvidence();
	installProjectionWatermark();
	root.render(<StrictMode>{children}</StrictMode>);
}

/**
 * Measures the gap between a Session's event arriving on the socket and the projection pipeline
 * applying it. `projectedSeq` is the highest sequence the transport synchronously applied, so
 * pairing it with the arrival time of that same sequence yields a real arrival-to-projection lag
 * rather than a socket-arrival timestamp on its own.
 */
function installProjectionWatermark(): void {
	const ARRIVAL_HISTORY = 512;
	const tracked = new Set<string>();
	const baselineProjectedSeq = new Map<string, number>();
	const lastCountedSeq = new Map<string, number>();
	const arrivalAtBySeq = new Map<string, Map<number, number>>();
	const maxProjectionLagMs = new Map<string, number>();
	sessionTransport.store.subscribe(() => {
		const sessions = sessionTransport.store.getState().sessions;
		const now = performance.now();
		for (const sessionHandle of tracked) {
			const projectedSeq = sessions[sessionHandle]?.projectedSeq ?? -1;
			const counted = lastCountedSeq.get(sessionHandle) ?? -1;
			if (projectedSeq <= counted) continue;
			lastCountedSeq.set(sessionHandle, projectedSeq);
			// Coalesced mode applies a whole batch at once, so the watermark jumps across many
			// sequences. Every sequence the batch covered is counted, and the batch's oldest arrival
			// carries the worst wait rather than only the last sequence's.
			const arrivals = arrivalAtBySeq.get(sessionHandle);
			if (!arrivals) continue;
			let oldestArrivalAt: number | null = null;
			for (const [seq, arrivedAt] of arrivals) {
				if (seq > projectedSeq || seq <= counted) continue;
				arrivals.delete(seq);
				if (oldestArrivalAt === null || arrivedAt < oldestArrivalAt) oldestArrivalAt = arrivedAt;
			}
			if (oldestArrivalAt === null) continue;
			const lag = Math.max(0, now - oldestArrivalAt);
			maxProjectionLagMs.set(sessionHandle, Math.max(maxProjectionLagMs.get(sessionHandle) ?? 0, lag));
		}
	});
	Object.defineProperty(window, "__piwebBenchmarkProjection", {
		configurable: true,
		value: {
			recordArrival(sessionHandle: string, seq: number, at: number) {
				const arrivals = arrivalAtBySeq.get(sessionHandle) ?? new Map<number, number>();
				arrivals.set(seq, at);
				while (arrivals.size > ARRIVAL_HISTORY) {
					const oldest = arrivals.keys().next();
					if (oldest.done) break;
					arrivals.delete(oldest.value);
				}
				arrivalAtBySeq.set(sessionHandle, arrivals);
			},
			track(sessionHandles: string[]) {
				tracked.clear();
				baselineProjectedSeq.clear();
				lastCountedSeq.clear();
				maxProjectionLagMs.clear();
				arrivalAtBySeq.clear();
				const sessions = sessionTransport.store.getState().sessions;
				for (const sessionHandle of sessionHandles) {
					const projectedSeq = sessions[sessionHandle]?.projectedSeq ?? -1;
					tracked.add(sessionHandle);
					baselineProjectedSeq.set(sessionHandle, projectedSeq);
					lastCountedSeq.set(sessionHandle, projectedSeq);
					maxProjectionLagMs.set(sessionHandle, 0);
					arrivalAtBySeq.set(sessionHandle, new Map<number, number>());
				}
			},
			snapshot(sessionHandles: string[]) {
				const sessions = sessionTransport.store.getState().sessions;
				const sampledAt = performance.now();
				return sessionHandles.map((sessionHandle) => {
					const channel = sessions[sessionHandle];
					return {
						baselineProjectedSeq: baselineProjectedSeq.get(sessionHandle) ?? -1,
						lastSeq: channel?.lastSeq ?? -1,
						projectionLagMs: maxProjectionLagMs.get(sessionHandle) ?? -1,
						projectedSeq: channel?.projectedSeq ?? -1,
						sampledAt,
					};
				});
			},
		},
	});
}
