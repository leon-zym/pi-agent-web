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
	root.render(<StrictMode>{children}</StrictMode>);
}
