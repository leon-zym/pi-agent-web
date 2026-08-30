import type { SessionRuntimePhaseDto, SessionRuntimeStateDto } from "@pi-agent-web/protocol";

/** Runtime fields shared by full runtime DTOs and hot-runtime inventory entries. */
export type RuntimeStateSource = {
	state: SessionRuntimeStateDto;
	phase?: SessionRuntimePhaseDto;
};

/** Resolve the operational phase, falling back when an inventory entry has state only. */
export function runtimePhase(runtime: RuntimeStateSource | null | undefined): SessionRuntimePhaseDto | null {
	if (!runtime) return null;
	if (runtime.phase !== undefined) return runtime.phase;

	switch (runtime.state) {
		case "starting":
			return "starting";
		case "idle":
			return "ready";
		case "running":
			return "busy";
		case "waiting_ui":
			return "waiting_ui";
		case "crashed":
			return "crashed";
		case "dormant":
			return "dormant";
	}
}

/** True while the runtime may still consume resources or reject a competing action. */
export function runtimeIsBusy(runtime: RuntimeStateSource | null | undefined): boolean {
	const phase = runtimePhase(runtime);
	return phase === "starting" || phase === "busy" || phase === "waiting_ui";
}

/** True only when the runtime is operationally ready for a new action. */
export function runtimeIsReady(runtime: RuntimeStateSource | null | undefined): boolean {
	return runtimePhase(runtime) === "ready";
}

/** True when no active runtime work remains, including crashed and dormant runtimes. */
export function runtimeIsSettled(runtime: RuntimeStateSource | null | undefined): boolean {
	const phase = runtimePhase(runtime);
	return phase === "ready" || phase === "crashed" || phase === "dormant";
}

/** Map an operational phase back to the state field consumed by existing UI rows. */
export function runtimeStateForDisplay(
	runtime: RuntimeStateSource | null | undefined,
): SessionRuntimeStateDto | undefined {
	if (!runtime) return undefined;
	const phase = runtimePhase(runtime);
	switch (phase) {
		case "starting":
			return "starting";
		case "ready":
			return "idle";
		case "busy":
			return "running";
		case "waiting_ui":
			return "waiting_ui";
		case "crashed":
			return "crashed";
		case "dormant":
			return "dormant";
		default:
			return runtime.state;
	}
}
