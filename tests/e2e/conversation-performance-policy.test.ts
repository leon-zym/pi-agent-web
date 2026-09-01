import assert from "node:assert/strict";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

export interface ConversationPerformanceSnapshot {
	liveLongTasks: number[];
	liveLongTaskMaxMs: number;
	settlementMs: number | null;
	heapDeltaBytes: number | null;
	turnNodes: number;
}

export function conversationPerformanceDiagnostics(
	fixtureLabel: string,
	metrics: ConversationPerformanceSnapshot,
) {
	return {
		fixture: fixtureLabel,
		liveLongTasks: metrics.liveLongTasks,
		liveLongTaskMaxMs: metrics.liveLongTaskMaxMs,
		liveLongTasksOver50Ms: metrics.liveLongTasks.filter((duration) => duration > 50).length,
		settlementMs: metrics.settlementMs,
		heapDeltaBytes: metrics.heapDeltaBytes,
		turnNodes: metrics.turnNodes,
	};
}

export function assertConversationHardInvariants(
	metrics: ConversationPerformanceSnapshot,
	fixtureLabel: string,
): void {
	if (!(metrics.turnNodes <= 64)) {
		throw new Error(
			`${fixtureLabel} retained turn DOM: expected at most 64, received ${String(metrics.turnNodes)}`,
		);
	}
}

const isDirectExecution =
	process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
	nodeTest("host-sensitive performance observations remain diagnostic", () => {
		const metrics: ConversationPerformanceSnapshot = {
			liveLongTasks: [51, 51, 51, 51, 51],
			liveLongTaskMaxMs: 201,
			settlementMs: 1_501,
			heapDeltaBytes: 64 * 1024 * 1024 + 1,
			turnNodes: 64,
		};
		const diagnostics = conversationPerformanceDiagnostics("source-level", metrics);

		assert.equal(diagnostics.settlementMs, 1_501);
		assert.equal(diagnostics.liveLongTaskMaxMs, 201);
		assert.equal(diagnostics.liveLongTasksOver50Ms, 5);
		assert.equal(diagnostics.heapDeltaBytes, 64 * 1024 * 1024 + 1);
		assert.doesNotThrow(() => assertConversationHardInvariants(metrics, "source-level"));
		assert.throws(
			() => assertConversationHardInvariants({ ...metrics, turnNodes: 65 }, "source-level"),
			/retained turn DOM/,
		);
	});
}
