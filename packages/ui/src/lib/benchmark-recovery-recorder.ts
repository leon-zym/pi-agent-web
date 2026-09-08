/** Small scalar evidence for the disconnect experiment; never a product event log. */
export interface RecoverySample {
	kind:
		| "attach"
		| "start"
		| "state"
		| "bus"
		| "wire"
		| "forward"
		| "subscribe"
		| "close"
		| "gate"
		| "hold"
		| "release"
		| "end";
	socket: number;
	seq: number;
	projected: number;
	baseline: boolean;
	resync: boolean;
}
export interface RecoveryEvidence {
	trial: number;
	invalid: boolean;
	ended: boolean;
	rows: RecoverySample[];
}
export function createRecoveryRecorder(limit = 512) {
	let current: RecoveryEvidence | null = null;
	let active = false;
	let poisoned = false;
	const fail = () => {
		poisoned = true;
		if (current) current.invalid = true;
	};
	return {
		fail,
		start(trial: number) {
			if (active || poisoned || trial !== (current?.trial ?? -1) + 1) {
				fail();
				return;
			}
			current = { trial, invalid: false, ended: false, rows: [] };
			active = true;
		},
		record(trial: number, row: RecoverySample) {
			if (!active || current?.trial !== trial || current.rows.length >= limit) {
				fail();
				return;
			}
			current.rows.push(row);
		},
		end(trial: number) {
			if (!active || current?.trial !== trial) return fail();
			current.ended = true;
			active = false;
		},
		read() {
			return current;
		},
	};
}
