import type { Page, WebSocket } from "@playwright/test";
import {
	dropControlledWebSockets,
	installWebSocketDropControl,
	observePageErrors,
	sendControlledWebSocketFrame,
} from "../fixtures/page-observation";
import {
	type HarnessLifecycleSnapshot,
	type HarnessSession,
	isBoundedHarnessLifecycle,
	MAX_HARNESS_ROOT_ENTRIES,
	type PiFixtureEvent,
} from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	type BenchmarkKind,
	type BenchmarkOutcome,
	type BenchmarkPiMarker,
	type BenchmarkRecoveryAuthorityFact,
	type BenchmarkRecoveryLifecycleFact,
	type BenchmarkRecoveryObservationFacts,
	type BenchmarkRecoveryParentRelation,
	type BenchmarkRecoveryProtocolFacts,
	type BenchmarkRecoveryStaleFact,
	correctnessFailureCount,
	createTrialObservation,
	installBrowserBenchmarkObserver,
	runBenchmarkScenario,
	scenariosFor,
} from "./benchmark-support";

test.use({
	harnessOptions: {
		benchmarkGateway: true,
		extraEnv: { PI_WEB_E2E_RECOVERY_FEATURES: "1" },
	},
});

interface WireFrame extends Record<string, unknown> {
	type?: string;
	seq?: number;
	asOfSeq?: number;
	baseSeq?: number;
	workspaceId?: string;
	barrierSeq?: number;
	serverEpoch?: string;
	sessionHandle?: string;
	previousSessionHandle?: string;
	generation?: number;
	isController?: boolean;
	fencingToken?: string;
	reason?: string;
	runtime?: {
		sessionHandle?: string;
		generation?: number;
		serverEpoch?: string;
		workspaceId?: string;
		nativeSessionId?: string;
		sessionFile?: string | null;
		lastSeq?: number;
	};
	projectionEvents?: Array<{ seq?: number }>;
	response?: {
		id?: string;
		success?: boolean;
		error?: string;
	};
}

interface ControllerLease {
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
	fencingToken: string;
}

function frame(payload: string | Buffer): WireFrame | undefined {
	try {
		return JSON.parse(payload.toString()) as WireFrame;
	} catch {
		return undefined;
	}
}

function piCommandCount(harness: { piEvents: () => PiFixtureEvent[] }, id?: string): number {
	return harness
		.piEvents()
		.filter((event) => event.type === "command" && (id === undefined || event.commandId === id)).length;
}

function staleFact(
	response: WireFrame | undefined,
	piCommandCountBefore: number,
	piCommandCountAfter: number,
	requestId: string,
	responseType = response?.type ?? "missing",
): BenchmarkRecoveryStaleFact {
	return {
		piCommandCountBefore,
		piCommandCountAfter,
		requestId,
		responseError: response?.response?.error ?? null,
		responseSuccess: response?.response?.success === true,
		responseType,
	};
}

function piMarker(event: PiFixtureEvent): BenchmarkPiMarker {
	return {
		at: event.at,
		commandId: event.commandId ?? null,
		pid: event.pid,
		sessionId: event.sessionId,
		text: event.text ?? null,
		type: event.type,
	};
}

function piMarkers(events: PiFixtureEvent[]): BenchmarkPiMarker[] {
	return events.map(piMarker);
}

function lifecycleFact(snapshot: HarnessLifecycleSnapshot, rootPath: string): BenchmarkRecoveryLifecycleFact {
	return {
		activeGatewayCount: snapshot.activeGatewayCount,
		activeGatewayPid: snapshot.activeGatewayPid,
		gatewayStarts: snapshot.gatewayStarts,
		ownedGatewayCount: snapshot.ownedGatewayCount,
		rootPath,
		rootEntryCount: snapshot.rootEntryCount,
		rootExists: snapshot.rootExists,
	};
}

function latestRuntime(
	received: WireFrame[],
	start: number,
	sessionHandle: string,
): NonNullable<WireFrame["runtime"]> | undefined {
	for (const candidate of received.slice(start).reverse()) {
		if (
			candidate.runtime?.sessionHandle === sessionHandle &&
			typeof candidate.runtime.serverEpoch === "string" &&
			Number.isSafeInteger(candidate.runtime.generation) &&
			Number.isSafeInteger(candidate.runtime.lastSeq)
		) {
			return candidate.runtime as NonNullable<WireFrame["runtime"]>;
		}
	}
	return undefined;
}

function cursorBefore(
	received: WireFrame[],
	before: number,
	sessionHandle: string,
	lease: ControllerLease,
): { generation: number; serverEpoch: string; sessionHandle: string; seq: number } {
	const runtime = latestRuntime(received.slice(0, before), 0, sessionHandle);
	if (!runtime) throw new Error(`authoritative runtime cursor is missing for Session ${sessionHandle}`);
	return {
		generation: runtime.generation ?? lease.generation,
		serverEpoch: runtime.serverEpoch ?? lease.serverEpoch,
		sessionHandle,
		seq: runtime.lastSeq ?? 0,
	};
}

function protocolFacts(
	received: WireFrame[],
	frameStart: number,
	frameEnd: number,
	sessionHandle: string,
	mode: "replay" | "resync",
	cursor: { generation: number; serverEpoch: string; sessionHandle: string; seq: number },
): BenchmarkRecoveryProtocolFacts {
	const window = received.slice(frameStart, frameEnd);
	const runtime = latestRuntime(received.slice(0, frameEnd), frameStart, sessionHandle);
	if (!runtime) throw new Error(`authoritative runtime watermark is missing for Session ${sessionHandle}`);
	const eventSeqs = window
		.filter(
			(candidate) =>
				candidate.type === "event" &&
				candidate.sessionHandle === sessionHandle &&
				Number.isSafeInteger(candidate.seq),
		)
		.map((candidate) => candidate.seq as number);
	const resync = window.find(
		(candidate) => candidate.type === "resync_required" && candidate.sessionHandle === sessionHandle,
	);
	const snapshot = window.find(
		(candidate) =>
			(candidate.type === "session_snapshot" || candidate.type === "session_snapshot_begin") &&
			candidate.sessionHandle === sessionHandle,
	);
	const barrierRuntime = resync?.runtime ?? snapshot?.runtime;
	return {
		barrier: {
			asOfSeq: Number.isSafeInteger(snapshot?.asOfSeq) ? (snapshot?.asOfSeq as number) : null,
			baseSeq: Number.isSafeInteger(snapshot?.baseSeq) ? (snapshot?.baseSeq as number) : null,
			barrierSeq: Number.isSafeInteger(snapshot?.asOfSeq) ? (snapshot?.asOfSeq as number) : null,
			reason:
				resync?.reason === "initial" ||
				resync?.reason === "epoch_changed" ||
				resync?.reason === "generation_changed" ||
				resync?.reason === "gap" ||
				resync?.reason === "invalid_cursor"
					? resync.reason
					: null,
			required: resync !== undefined,
			runtimeLastSeq: Number.isSafeInteger(barrierRuntime?.lastSeq)
				? (barrierRuntime?.lastSeq as number)
				: null,
			snapshotSeen: snapshot !== undefined,
		},
		cursorBefore: cursor,
		mode,
		observedEventSeqs: eventSeqs,
		rekeyFrameCount: window.filter(
			(candidate) =>
				candidate.type === "session_rekeyed" &&
				candidate.previousSessionHandle !== undefined &&
				candidate.runtime?.sessionHandle === sessionHandle,
		).length,
		resyncFrameCount: window.filter(
			(candidate) => candidate.type === "resync_required" && candidate.sessionHandle === sessionHandle,
		).length,
		snapshotFrameCount: window.filter(
			(candidate) =>
				(candidate.type === "session_snapshot" ||
					candidate.type === "session_snapshot_begin" ||
					candidate.type === "session_snapshot_end") &&
				candidate.sessionHandle === sessionHandle,
		).length,
		watermarkAfter: {
			generation: runtime.generation as number,
			lastSeq: runtime.lastSeq as number,
			serverEpoch: runtime.serverEpoch as string,
			sessionHandle,
		},
	};
}

function persistedAuthority(
	harness: { workspace: { workspaceHandle: string; path: string } },
	lease: ControllerLease,
	session: HarnessSession,
): BenchmarkRecoveryAuthorityFact {
	if (!session.persisted || !session.sessionFile) {
		throw new Error(`Session ${session.sessionHandle} is not a persisted native Session`);
	}
	return {
		fencingToken: lease.fencingToken,
		generation: lease.generation,
		nativeSessionId: session.nativeSessionId,
		persisted: session.persisted,
		serverEpoch: lease.serverEpoch,
		sessionFile: session.sessionFile,
		sessionHandle: lease.sessionHandle,
		workspaceHandle: harness.workspace.workspaceHandle,
		workspacePath: harness.workspace.path,
	};
}

function parentRelation(
	parentLease: ControllerLease,
	parentSession: HarnessSession,
	childLease: ControllerLease,
	childSession: HarnessSession,
	previousSessionHandle: string,
): BenchmarkRecoveryParentRelation {
	if (!parentSession.sessionFile || !childSession.sessionFile) {
		throw new Error("rekey fixture omitted a persisted parent or child session file");
	}
	return {
		childNativeSessionId: childSession.nativeSessionId,
		childSessionFile: childSession.sessionFile,
		childSessionHandle: childLease.sessionHandle,
		parentNativeSessionId: parentSession.nativeSessionId,
		parentSessionFile: parentSession.sessionFile,
		parentSessionHandle: parentLease.sessionHandle,
		previousSessionHandle,
	};
}

async function sessionForHandle(
	harness: {
		workspace: { workspaceHandle: string };
		requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>;
	},
	sessionHandle: string,
): Promise<HarnessSession> {
	const directory = await harness.requestJson<{ sessions: HarnessSession[] }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions?refresh=1`,
	);
	const session = directory.sessions.find((candidate) => candidate.sessionHandle === sessionHandle);
	if (!session)
		throw new Error(`unable to resolve Session ${sessionHandle} from the authoritative directory`);
	return session;
}

function recoveryObservation(
	kind: Extract<
		BenchmarkKind,
		"recovery-disconnect" | "recovery-gap" | "recovery-crash" | "recovery-rekey" | "recovery-gateway-restart"
	>,
	browserErrors: { console: string[]; page: string[] },
	facts: BenchmarkRecoveryObservationFacts,
): ReturnType<typeof createTrialObservation> {
	return createTrialObservation(kind, browserErrors, facts);
}

function conversationTurn(page: Page, prompt: string) {
	return page.getByRole("region", { name: /^(Conversation turn|对话轮次)$/ }).filter({ hasText: prompt });
}

function controllerLease(
	received: WireFrame[],
	sessionHandle?: string,
	afterIndex = 0,
): ControllerLease | undefined {
	for (const candidate of received.slice(afterIndex).reverse()) {
		if (
			candidate.type !== "lease_status" ||
			candidate.isController !== true ||
			typeof candidate.serverEpoch !== "string" ||
			typeof candidate.sessionHandle !== "string" ||
			(sessionHandle !== undefined && candidate.sessionHandle !== sessionHandle) ||
			typeof candidate.generation !== "number" ||
			!Number.isSafeInteger(candidate.generation) ||
			typeof candidate.fencingToken !== "string"
		) {
			continue;
		}
		return {
			serverEpoch: candidate.serverEpoch,
			sessionHandle: candidate.sessionHandle,
			generation: candidate.generation,
			fencingToken: candidate.fencingToken,
		};
	}
	return undefined;
}

async function waitForControllerLease(
	page: Page,
	received: WireFrame[],
	sessionHandle?: string,
	afterIndex = 0,
): Promise<ControllerLease> {
	await expect
		.poll(() => controllerLease(received, sessionHandle, afterIndex), { timeout: 30_000 })
		.toBeTruthy();
	const lease = controllerLease(received, sessionHandle, afterIndex);
	if (!lease) throw new Error("current controller lease is missing");
	if (lease.generation < 1) throw new Error("recovery requires a positive Session generation");
	await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
	return lease;
}

async function waitForResponse(received: WireFrame[], id: string): Promise<WireFrame> {
	await expect
		.poll(
			() => received.find((candidate) => candidate.type === "response" && candidate.response?.id === id),
			{ timeout: 30_000 },
		)
		.toBeTruthy();
	const response = received.find(
		(candidate) => candidate.type === "response" && candidate.response?.id === id,
	);
	if (!response) throw new Error(`response ${id} is missing`);
	return response;
}

async function assertStaleGuards(
	page: Page,
	received: WireFrame[],
	harness: { piEvents: () => PiFixtureEvent[] },
	lease: ControllerLease,
	index: number,
	staleEpoch = `benchmark-stale-epoch-${String(index)}`,
	parentLease?: ControllerLease,
): Promise<{
	staleGenerationRejected: boolean;
	staleFenceRejected: boolean;
	staleEpochRejected: boolean;
	oldParentRejected: boolean;
	stale: {
		generation: BenchmarkRecoveryStaleFact;
		fence: BenchmarkRecoveryStaleFact;
		epoch: BenchmarkRecoveryStaleFact;
		parent: BenchmarkRecoveryStaleFact | null;
	};
}> {
	if (lease.generation < 1)
		throw new Error("cannot issue a stale generation below the initial Session generation");
	const generationId = `benchmark-stale-generation-${String(index)}`;
	const generationCommandCountBefore = piCommandCount(harness, generationId);
	await sendControlledWebSocketFrame(page, {
		type: "command",
		sessionHandle: lease.sessionHandle,
		expectedGeneration: lease.generation - 1,
		fencingToken: lease.fencingToken,
		command: { id: generationId, type: "set_session_name", name: `stale-generation-${String(index)}` },
	});
	const generationResponse = await waitForResponse(received, generationId);
	const generationCommandCountAfter = piCommandCount(harness, generationId);

	const fenceId = `benchmark-stale-fence-${String(index)}`;
	const fenceCommandCountBefore = piCommandCount(harness, fenceId);
	await sendControlledWebSocketFrame(page, {
		type: "command",
		sessionHandle: lease.sessionHandle,
		expectedGeneration: lease.generation,
		fencingToken: `stale-fence-${String(index)}`,
		command: { id: fenceId, type: "set_session_name", name: `stale-fence-${String(index)}` },
	});
	const fenceResponse = await waitForResponse(received, fenceId);
	const fenceCommandCountAfter = piCommandCount(harness, fenceId);

	const epochMark = received.length;
	const epochCommandCountBefore = piCommandCount(harness);
	await sendControlledWebSocketFrame(page, {
		type: "session_subscribe",
		sessionHandle: lease.sessionHandle,
		cursor: { serverEpoch: staleEpoch, generation: lease.generation, seq: 0 },
	});
	await expect
		.poll(
			() =>
				received
					.slice(epochMark)
					.find((candidate) => candidate.type === "resync_required" && candidate.reason === "epoch_changed"),
			{ timeout: 30_000 },
		)
		.toBeTruthy();
	const epochResponse = received
		.slice(epochMark)
		.find((candidate) => candidate.type === "resync_required" && candidate.reason === "epoch_changed");
	const epochCommandCountAfter = piCommandCount(harness);

	let parentFact: BenchmarkRecoveryStaleFact | null = null;
	let oldParentRejected = true;
	if (parentLease) {
		const parentId = `benchmark-stale-parent-${String(index)}`;
		const parentCommandCountBefore = piCommandCount(harness, parentId);
		await sendControlledWebSocketFrame(page, {
			type: "command",
			sessionHandle: parentLease.sessionHandle,
			expectedGeneration: parentLease.generation,
			fencingToken: parentLease.fencingToken,
			command: { id: parentId, type: "set_session_name", name: `stale-parent-${String(index)}` },
		});
		const parentResponse = await waitForResponse(received, parentId);
		const parentCommandCountAfter = piCommandCount(harness, parentId);
		parentFact = staleFact(parentResponse, parentCommandCountBefore, parentCommandCountAfter, parentId);
		oldParentRejected =
			parentResponse.response?.success === false && parentCommandCountAfter === parentCommandCountBefore;
	}

	return {
		staleGenerationRejected:
			generationResponse.response?.success === false &&
			(generationResponse.response.error?.includes("session_generation_stale") ?? false),
		staleFenceRejected:
			fenceResponse.response?.success === false &&
			(fenceResponse.response.error?.includes("session_read_only") ?? false),
		staleEpochRejected: received
			.slice(epochMark)
			.some((candidate) => candidate.type === "resync_required" && candidate.reason === "epoch_changed"),
		oldParentRejected,
		stale: {
			generation: staleFact(
				generationResponse,
				generationCommandCountBefore,
				generationCommandCountAfter,
				generationId,
			),
			fence: staleFact(fenceResponse, fenceCommandCountBefore, fenceCommandCountAfter, fenceId),
			epoch: staleFact(
				epochResponse,
				epochCommandCountBefore,
				epochCommandCountAfter,
				staleEpoch,
				epochResponse?.type ?? "missing",
			),
			parent: parentFact,
		},
	};
}

async function assertProjection(
	page: Page,
	prompt: string,
	reply: string,
): Promise<{ promptCount: number; replyCount: number }> {
	const turn = conversationTurn(page, prompt);
	await expect(turn.getByText(prompt, { exact: true })).toHaveCount(1);
	await expect(turn.getByText(reply, { exact: true })).toHaveCount(1);
	return {
		promptCount: await turn.getByText(prompt, { exact: true }).count(),
		replyCount: await turn.getByText(reply, { exact: true }).count(),
	};
}

function attachFrames(page: Page): {
	sockets: WebSocket[];
	received: WireFrame[];
	closedSockets: () => number;
} {
	const sockets: WebSocket[] = [];
	const received: WireFrame[] = [];
	let closed = 0;
	page.on("websocket", (socket: WebSocket) => {
		sockets.push(socket);
		socket.on("close", () => {
			closed += 1;
		});
		socket.on("framereceived", ({ payload }) => {
			const parsed = frame(payload);
			if (parsed) received.push(parsed);
		});
	});
	return { sockets, received, closedSockets: () => closed };
}

async function openBenchmarkPage(page: Page, origin: string): Promise<void> {
	await page.goto(origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
}

function addCommonRecoveryGates(
	outcome: BenchmarkOutcome,
	errors: { console: string[]; page: string[] },
	timingMetric: string,
	timingRationale: string,
): void {
	addValueGate(
		outcome,
		"correctnessFailures",
		correctnessFailureCount(outcome.trials),
		"eq",
		0,
		"hard",
		"Every recovery trial must pass its barrier, projection, duplicate/loss, and stale-authority checks.",
	);
	addValueGate(
		outcome,
		"browserErrors",
		errors.console.length + errors.page.length,
		"eq",
		0,
		"hard",
		"Browser errors invalidate recovery correctness.",
	);
	addSummaryGate(outcome, timingMetric, "p95", "gte", 0, "observe", timingRationale);
}

for (const scenario of scenariosFor("recovery-disconnect")) {
	test(`${scenario.id} recovers a pure WebSocket disconnect`, async ({ page, harness }, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
			const errors = observePageErrors(page);
			await installWebSocketDropControl(page);
			const { sockets, received, closedSockets } = attachFrames(page);
			await installBrowserBenchmarkObserver(page);
			await openBenchmarkPage(page, harness.origin);
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				await trials.run(index, async () => {
					const errorStart = { console: errors.console.length, page: errors.page.length };
					const prompt = `E2E_BENCH_DISCONNECT:${scenario.id}:${String(index)}`;
					const reply = `E2E_REPLY:${prompt}`;
					const beforeLease = await waitForControllerLease(page, received);
					const beforeSession = await sessionForHandle(harness, beforeLease.sessionHandle);
					const lifecycleBefore = lifecycleFact(harness.lifecycle(), harness.rootDir);
					// Capture the marker boundary before issuing the prompt that will cross the disconnect.
					const markersBefore = piMarkers(harness.piEvents());
					const socketsBefore = sockets.length;
					const closesBefore = closedSockets();
					const framesBefore = received.length;
					const sourceCursor = cursorBefore(received, framesBefore, beforeLease.sessionHandle, beforeLease);
					await page.locator("textarea").fill(prompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect
						.poll(() => harness.piEvents().some((event) => event.type === "delta" && event.text === prompt))
						.toBe(true);
					const startedAt = await page.evaluate(() => performance.now());
					await dropControlledWebSockets(page);
					await expect.poll(() => closedSockets()).toBeGreaterThan(closesBefore);
					await expect
						.poll(() => harness.piEvents().some((event) => event.type === "settled" && event.text === prompt))
						.toBe(true);
					await expect.poll(() => sockets.length, { timeout: 30_000 }).toBeGreaterThan(socketsBefore);
					const projection = await assertProjection(page, prompt, reply);
					const lease = await waitForControllerLease(page, received, undefined, framesBefore);
					const finishedAt = await page.evaluate(() => performance.now());
					const events = harness.piEvents();
					const replayFrames = received
						.slice(framesBefore)
						.filter((candidate) => candidate.type === "event").length;
					const recoveryWindowEnd = received.length;
					const protocol = protocolFacts(
						received,
						framesBefore,
						recoveryWindowEnd,
						lease.sessionHandle,
						"replay",
						sourceCursor,
					);
					const stale = await assertStaleGuards(page, received, harness, lease, index);
					const afterSession = await sessionForHandle(harness, lease.sessionHandle);
					const lifecycleAfter = lifecycleFact(harness.lifecycle(), harness.rootDir);
					const markersAfter = piMarkers(harness.piEvents());
					const { stale: staleFacts, oldParentRejected, ...staleChecks } = stale;
					const correctness = {
						recoveryBarrier: lease.sessionHandle.length > 0 && replayFrames > 0,
						zeroDuplicateLostEvents:
							events.filter((event) => event.type === "prompt" && event.text === prompt).length === 1 &&
							events.filter((event) => event.type === "settled" && event.text === prompt).length === 1 &&
							projection.promptCount === 1 &&
							projection.replyCount === 1,
						...staleChecks,
						finalProjectionMatches: projection.promptCount === 1 && projection.replyCount === 1,
						disconnectObserved: sockets.length > socketsBefore,
					};
					return {
						metrics: {
							recoveryMs: finishedAt - startedAt,
							reconnectedSockets: sockets.length - socketsBefore,
							replayFrames,
						},
						correctness,
						observation: recoveryObservation(
							"recovery-disconnect",
							{
								console: errors.console.slice(errorStart.console),
								page: errors.page.slice(errorStart.page),
							},
							{
								identity: {
									before: persistedAuthority(harness, beforeLease, beforeSession),
									after: persistedAuthority(harness, lease, afterSession),
									parentRelation: null,
								},
								lifecycle: {
									before: lifecycleBefore,
									after: lifecycleAfter,
									originBefore: harness.origin,
									originAfter: harness.origin,
								},
								pi: {
									markersBefore,
									markersAfter,
									targetSessionId: afterSession.nativeSessionId,
								},
								protocol,
								projection: { prompt, reply, ...projection },
								socket: { closed: closedSockets() - closesBefore, opened: sockets.length - socketsBefore },
								stale: staleFacts,
							},
						),
					};
				});
			}
			addCommonRecoveryGates(
				outcome,
				errors,
				"recoveryMs",
				"Disconnect recovery latency is diagnostic until a portable reference profile exists.",
			);
			addSummaryGate(
				outcome,
				"reconnectedSockets",
				"max",
				"lte",
				2,
				"hard",
				"A single WebSocket disconnect must not create a reconnect storm.",
			);
			outcome.notes.push(
				"This scenario closes only the Browser WebSocket after a durable turn has begun; it does not emit the explicit non-replayable gap marker.",
			);
		});
	});
}

for (const scenario of scenariosFor("recovery-gap")) {
	test(`${scenario.id} recovers an explicit replay gap`, async ({ page, harness }, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
			const errors = observePageErrors(page);
			await installWebSocketDropControl(page);
			const { sockets, received, closedSockets } = attachFrames(page);
			await installBrowserBenchmarkObserver(page);
			await openBenchmarkPage(page, harness.origin);
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				await trials.run(index, async () => {
					const errorStart = { console: errors.console.length, page: errors.page.length };
					const prompt = `E2E_BENCH_GAP:${scenario.id}:${String(index)}`;
					const reply = `E2E_REPLY:${prompt}`;
					const beforeLease = await waitForControllerLease(page, received);
					const beforeSession = await sessionForHandle(harness, beforeLease.sessionHandle);
					const lifecycleBefore = lifecycleFact(harness.lifecycle(), harness.rootDir);
					// Capture the marker boundary before issuing the prompt that will cross the replay gap.
					const markersBefore = piMarkers(harness.piEvents());
					const socketsBefore = sockets.length;
					const closesBefore = closedSockets();
					const framesBefore = received.length;
					const sourceCursor = cursorBefore(received, framesBefore, beforeLease.sessionHandle, beforeLease);
					await page.locator("textarea").fill(prompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect
						.poll(() => harness.piEvents().some((event) => event.type === "delta" && event.text === prompt))
						.toBe(true);
					const startedAt = await page.evaluate(() => performance.now());
					await dropControlledWebSockets(page);
					harness.triggerReplayGap(prompt);
					await expect.poll(() => closedSockets()).toBeGreaterThan(closesBefore);
					await expect
						.poll(() =>
							harness
								.piEvents()
								.some((event) => event.type === "benchmark_gap_emitted" && event.text === prompt),
						)
						.toBe(true);
					await expect
						.poll(() => harness.piEvents().some((event) => event.type === "settled" && event.text === prompt))
						.toBe(true);
					await expect.poll(() => sockets.length, { timeout: 30_000 }).toBeGreaterThan(socketsBefore);
					await expect
						.poll(
							() =>
								received
									.slice(framesBefore)
									.filter((candidate) => candidate.type === "resync_required" && candidate.reason === "gap")
									.length,
							{ timeout: 30_000 },
						)
						.toBe(1);
					const gapFrames = received
						.slice(framesBefore)
						.filter((candidate) => candidate.type === "resync_required" && candidate.reason === "gap");
					const projection = await assertProjection(page, prompt, reply);
					const lease = beforeLease;
					const finishedAt = await page.evaluate(() => performance.now());
					const events = harness.piEvents();
					const recoveryWindowEnd = received.length;
					const protocol = protocolFacts(
						received,
						framesBefore,
						recoveryWindowEnd,
						lease.sessionHandle,
						"resync",
						sourceCursor,
					);
					const stale = await assertStaleGuards(page, received, harness, lease, index);
					const afterSession = await sessionForHandle(harness, lease.sessionHandle);
					const lifecycleAfter = lifecycleFact(harness.lifecycle(), harness.rootDir);
					const markersAfter = piMarkers(harness.piEvents());
					const { stale: staleFacts, oldParentRejected, ...staleChecks } = stale;
					const correctness = {
						recoveryBarrier: lease.sessionHandle.length > 0 && gapFrames.length === 1,
						zeroDuplicateLostEvents:
							events.filter((event) => event.type === "prompt" && event.text === prompt).length === 1 &&
							events.filter((event) => event.type === "settled" && event.text === prompt).length === 1 &&
							gapFrames.length === 1 &&
							projection.promptCount === 1 &&
							projection.replyCount === 1,
						...staleChecks,
						finalProjectionMatches: projection.promptCount === 1 && projection.replyCount === 1,
						gapResyncObserved: gapFrames.length === 1,
					};
					return {
						metrics: {
							recoveryMs: finishedAt - startedAt,
							reconnectedSockets: sockets.length - socketsBefore,
							gapResyncFrames: gapFrames.length,
						},
						correctness,
						observation: recoveryObservation(
							"recovery-gap",
							{
								console: errors.console.slice(errorStart.console),
								page: errors.page.slice(errorStart.page),
							},
							{
								identity: {
									before: persistedAuthority(harness, beforeLease, beforeSession),
									after: persistedAuthority(harness, lease, afterSession),
									parentRelation: null,
								},
								lifecycle: {
									before: lifecycleBefore,
									after: lifecycleAfter,
									originBefore: harness.origin,
									originAfter: harness.origin,
								},
								pi: {
									markersBefore,
									markersAfter,
									targetSessionId: afterSession.nativeSessionId,
								},
								protocol,
								projection: { prompt, reply, ...projection },
								socket: { closed: closedSockets() - closesBefore, opened: sockets.length - socketsBefore },
								stale: staleFacts,
							},
						),
					};
				});
			}
			addCommonRecoveryGates(
				outcome,
				errors,
				"recoveryMs",
				"Replay-gap recovery latency is diagnostic until a portable reference profile exists.",
			);
			addSummaryGate(
				outcome,
				"gapResyncFrames",
				"max",
				"eq",
				1,
				"hard",
				"Each explicit replay gap must produce exactly one authoritative gap resync.",
			);
			outcome.notes.push(
				"This scenario uses the deterministic non-replayable notify to force one explicit replay gap; the gap workload is counted separately from the pure disconnect scenario.",
			);
		});
	});
}

for (const scenario of scenariosFor("recovery-crash")) {
	test(`${scenario.id} recovers Pi process loss on independent Sessions`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
			const errors = observePageErrors(page);
			await installWebSocketDropControl(page);
			const { received } = attachFrames(page);
			await installBrowserBenchmarkObserver(page);
			await openBenchmarkPage(page, harness.origin);
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				await trials.run(index, async () => {
					const errorStart = { console: errors.console.length, page: errors.page.length };
					const beforePrompt = `E2E_BENCH_BEFORE_CRASH:${scenario.id}:${String(index)}`;
					await page.locator("textarea").fill(beforePrompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect(
						page.locator("main").getByText(`E2E_REPLY:${beforePrompt}`, { exact: true }),
					).toHaveCount(1, { timeout: 30_000 });
					const oldLease = await waitForControllerLease(page, received);
					const beforeSession = await sessionForHandle(harness, oldLease.sessionHandle);
					const lifecycleBefore = lifecycleFact(harness.lifecycle(), harness.rootDir);
					// The crash-triggering prompt is issued immediately after this marker boundary.
					const markersBefore = piMarkers(harness.piEvents());
					const startsBefore = harness.piEvents().filter((event) => event.type === "started").length;
					const recoveryFrameMark = received.length;
					const sourceCursor = cursorBefore(received, recoveryFrameMark, oldLease.sessionHandle, oldLease);
					const crashPrompt = `E2E_BENCH_CRASH:${scenario.id}:${String(index)}`;
					await page.locator("textarea").fill(crashPrompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect
						.poll(() =>
							harness
								.piEvents()
								.some((event) => event.type === "crash_requested" && event.text === crashPrompt),
						)
						.toBe(true);
					const crashEvent = harness
						.piEvents()
						.find((event) => event.type === "crash_requested" && event.text === crashPrompt);
					if (!crashEvent) throw new Error("crash fixture marker is missing");
					await expect
						.poll(
							() =>
								harness
									.piEvents()
									.filter(
										(event) =>
											event.type === "started" &&
											event.sessionId === crashEvent.sessionId &&
											event.pid !== crashEvent.pid &&
											event.at >= crashEvent.at,
									).length,
							{ timeout: 30_000 },
						)
						.toBe(1);
					const currentRow = page.locator('[data-session-row][data-current="true"]');
					await expect(currentRow).toHaveCount(1);
					await currentRow.getByRole("button").first().click();
					const restarted = harness
						.piEvents()
						.find(
							(event) =>
								event.type === "started" &&
								event.sessionId === crashEvent.sessionId &&
								event.pid !== crashEvent.pid &&
								event.at >= crashEvent.at,
						);
					if (!restarted) throw new Error("restarted Pi marker is missing");
					await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
					const currentLease = await waitForControllerLease(
						page,
						received,
						oldLease.sessionHandle,
						recoveryFrameMark,
					);
					const afterSession = await sessionForHandle(harness, currentLease.sessionHandle);
					const afterPrompt = `E2E_BENCH_AFTER_CRASH:${scenario.id}:${String(index)}`;
					await page.locator("textarea").fill(afterPrompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect(
						page.locator("main").getByText(`E2E_REPLY:${afterPrompt}`, { exact: true }),
					).toHaveCount(1, { timeout: 30_000 });
					const main = page.locator("main");
					const crashPromptCount = await main.getByText(crashPrompt, { exact: true }).count();
					const afterReplyCount = await main.getByText(`E2E_REPLY:${afterPrompt}`, { exact: true }).count();
					const events = harness.piEvents();
					const processStarts = events.filter((event) => event.type === "started").length - startsBefore;
					const recoveryBaselineObserved = received
						.slice(recoveryFrameMark)
						.some(
							(candidate) =>
								candidate.type === "runtime_state" &&
								candidate.runtime?.sessionHandle === oldLease.sessionHandle,
						);
					const recoveryWindowEnd = received.length;
					const protocol = protocolFacts(
						received,
						recoveryFrameMark,
						recoveryWindowEnd,
						currentLease.sessionHandle,
						"resync",
						sourceCursor,
					);
					const stale = await assertStaleGuards(page, received, harness, currentLease, index);
					const lifecycleAfter = lifecycleFact(harness.lifecycle(), harness.rootDir);
					const markersAfter = piMarkers(harness.piEvents());
					const { stale: staleFacts, oldParentRejected, ...staleChecks } = stale;
					const correctness = {
						recoveryBarrier:
							currentLease.generation > oldLease.generation &&
							currentLease.sessionHandle === oldLease.sessionHandle &&
							recoveryBaselineObserved,
						zeroDuplicateLostEvents:
							events.filter((event) => event.type === "crash_requested" && event.text === crashPrompt)
								.length === 1 &&
							events.filter((event) => event.type === "prompt" && event.text === afterPrompt).length === 1 &&
							crashPromptCount === 1 &&
							afterReplyCount === 1,
						...staleChecks,
						finalProjectionMatches: crashPromptCount === 1 && afterReplyCount === 1,
						processRestarted: restarted.pid !== crashEvent.pid,
					};
					return {
						metrics: {
							recoveryMs: Date.now() - crashEvent.at,
							processRestartMs: restarted.at - crashEvent.at,
							processStarts,
						},
						correctness,
						observation: recoveryObservation(
							"recovery-crash",
							{
								console: errors.console.slice(errorStart.console),
								page: errors.page.slice(errorStart.page),
							},
							{
								identity: {
									before: persistedAuthority(harness, oldLease, beforeSession),
									after: persistedAuthority(harness, currentLease, afterSession),
									parentRelation: null,
								},
								lifecycle: {
									before: lifecycleBefore,
									after: lifecycleAfter,
									originBefore: harness.origin,
									originAfter: harness.origin,
								},
								pi: {
									markersBefore,
									markersAfter,
									targetSessionId: afterSession.nativeSessionId,
								},
								protocol,
								projection: {
									prompt: afterPrompt,
									reply: `E2E_REPLY:${afterPrompt}`,
									promptCount: crashPromptCount,
									replyCount: afterReplyCount,
								},
								socket: { closed: 0, opened: 0 },
								stale: staleFacts,
							},
						),
					};
				});
				if (index < trialCount - 1) {
					await page
						.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
						.getByRole("button", { name: /^(New session|新建会话)$/ })
						.first()
						.click();
					await expect(page.locator("textarea")).toBeEnabled();
				}
			}
			addCommonRecoveryGates(
				outcome,
				errors,
				"recoveryMs",
				"Pi process recovery latency is diagnostic until a portable reference profile exists.",
			);
			addSummaryGate(
				outcome,
				"processStarts",
				"max",
				"eq",
				1,
				"hard",
				"One Pi process crash must create exactly one replacement process.",
			);
			outcome.notes.push(
				"Each crash trial uses a fresh persisted Session after the prior trial, while stale generation and fence authority are checked against the replacement process.",
			);
		});
	});
}

for (const scenario of scenariosFor("recovery-rekey")) {
	test(`${scenario.id} recovers a fork/clone Session rekey`, async ({ page, harness }, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
			const errors = observePageErrors(page);
			await installWebSocketDropControl(page);
			const { received } = attachFrames(page);
			await installBrowserBenchmarkObserver(page);
			await openBenchmarkPage(page, harness.origin);
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				await trials.run(index, async () => {
					const errorStart = { console: errors.console.length, page: errors.page.length };
					const parentPrompt = `E2E_BENCH_REKEY_PARENT:${scenario.id}:${String(index)}`;
					await page.locator("textarea").fill(parentPrompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect(
						page.locator("main").getByText(`E2E_REPLY:${parentPrompt}`, { exact: true }),
					).toHaveCount(1, { timeout: 30_000 });
					const parentLease = await waitForControllerLease(page, received);
					const beforeSession = await sessionForHandle(harness, parentLease.sessionHandle);
					const lifecycleBefore = lifecycleFact(harness.lifecycle(), harness.rootDir);
					const rekeyStart = Date.now();
					const rekeyFrameMark = received.length;
					const rekeyFramesBefore = received.filter(
						(candidate) =>
							candidate.type === "session_rekeyed" &&
							candidate.previousSessionHandle === parentLease.sessionHandle,
					).length;
					await page
						.getByRole("button", { name: /^(Fork|分叉)$/ })
						.last()
						.click();
					await expect(page.getByText(/Forked a new session|已从该消息分叉出新会话/)).toBeVisible({
						timeout: 30_000,
					});
					await expect
						.poll(
							() =>
								received.find(
									(candidate) =>
										candidate.type === "session_rekeyed" &&
										candidate.previousSessionHandle === parentLease.sessionHandle,
								),
							{ timeout: 30_000 },
						)
						.toBeTruthy();
					const rekey = received.find(
						(candidate) =>
							candidate.type === "session_rekeyed" &&
							candidate.previousSessionHandle === parentLease.sessionHandle,
					);
					const childHandle = rekey?.runtime?.sessionHandle;
					if (!childHandle) throw new Error("fork/clone did not publish a child Session identity");
					await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
					const childLease = await waitForControllerLease(page, received, childHandle, rekeyFrameMark);
					const childSession = await sessionForHandle(harness, childLease.sessionHandle);
					const sourceCursor = cursorBefore(received, rekeyFrameMark, parentLease.sessionHandle, parentLease);
					const childPrompt = `E2E_BENCH_REKEY_CHILD:${scenario.id}:${String(index)}`;
					// Capture the child prompt boundary after rekey and before issuing its prompt.
					const markersBefore = piMarkers(harness.piEvents());
					await page.locator("textarea").fill(childPrompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					const childProjection = await assertProjection(page, childPrompt, `E2E_REPLY:${childPrompt}`);
					const recoveryWindowEnd = received.length;
					const protocol = protocolFacts(
						received,
						rekeyFrameMark,
						recoveryWindowEnd,
						childLease.sessionHandle,
						"resync",
						sourceCursor,
					);
					const stale = await assertStaleGuards(
						page,
						received,
						harness,
						childLease,
						index,
						undefined,
						parentLease,
					);
					const rekeyFrames =
						received.filter(
							(candidate) =>
								candidate.type === "session_rekeyed" &&
								candidate.previousSessionHandle === parentLease.sessionHandle,
						).length - rekeyFramesBefore;
					const finishedAt = Date.now();
					const events = harness.piEvents();
					const lifecycleAfter = lifecycleFact(harness.lifecycle(), harness.rootDir);
					const markersAfter = piMarkers(harness.piEvents());
					const { stale: staleFacts, oldParentRejected, ...staleChecks } = stale;
					const identityChanged =
						parentLease.sessionHandle !== childLease.sessionHandle &&
						beforeSession.nativeSessionId !== childSession.nativeSessionId &&
						beforeSession.sessionFile !== childSession.sessionFile;
					const correctness = {
						recoveryBarrier:
							childLease.sessionHandle === childHandle &&
							childLease.generation > parentLease.generation &&
							rekeyFrames === 1,
						zeroDuplicateLostEvents:
							events.filter((event) => event.type === "prompt" && event.text === parentPrompt).length === 1 &&
							events.filter((event) => event.type === "prompt" && event.text === childPrompt).length === 1 &&
							childProjection.promptCount === 1 &&
							childProjection.replyCount === 1,
						...staleChecks,
						finalProjectionMatches: childProjection.promptCount === 1 && childProjection.replyCount === 1,
						rekeyIdentityChanged: identityChanged && rekeyFrames === 1,
						staleParentRejected: oldParentRejected,
					};
					return {
						metrics: {
							rekeyMs: finishedAt - rekeyStart,
							rekeyFrames,
							childGeneration: childLease.generation,
						},
						correctness,
						observation: recoveryObservation(
							"recovery-rekey",
							{
								console: errors.console.slice(errorStart.console),
								page: errors.page.slice(errorStart.page),
							},
							{
								identity: {
									before: persistedAuthority(harness, parentLease, beforeSession),
									after: persistedAuthority(harness, childLease, childSession),
									parentRelation: parentRelation(
										parentLease,
										beforeSession,
										childLease,
										childSession,
										rekey?.previousSessionHandle ?? parentLease.sessionHandle,
									),
								},
								lifecycle: {
									before: lifecycleBefore,
									after: lifecycleAfter,
									originBefore: harness.origin,
									originAfter: harness.origin,
								},
								pi: {
									markersBefore,
									markersAfter,
									targetSessionId: childSession.nativeSessionId,
								},
								protocol,
								projection: {
									prompt: childPrompt,
									reply: `E2E_REPLY:${childPrompt}`,
									...childProjection,
								},
								socket: { closed: 0, opened: 0 },
								stale: staleFacts,
							},
						),
					};
				});
				if (index < trialCount - 1) {
					await page
						.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
						.getByRole("button", { name: /^(New session|新建会话)$/ })
						.first()
						.click();
					await expect(page.locator("textarea")).toBeEnabled();
				}
			}
			addCommonRecoveryGates(
				outcome,
				errors,
				"rekeyMs",
				"Session rekey recovery latency is diagnostic until a portable reference profile exists.",
			);
			addSummaryGate(
				outcome,
				"rekeyFrames",
				"max",
				"eq",
				1,
				"hard",
				"Each fork/clone trial must publish exactly one Session rekey identity transition.",
			);
			outcome.notes.push(
				"The child identity is produced by the existing deterministic fork command; no benchmark-only rekey endpoint or runtime hook is used.",
			);
		});
	});
}

for (const scenario of scenariosFor("recovery-gateway-restart")) {
	test(`${scenario.id} recovers a Gateway restart with preserved roots`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
			const errors = observePageErrors(page);
			await installWebSocketDropControl(page);
			const { sockets, received, closedSockets } = attachFrames(page);
			await installBrowserBenchmarkObserver(page);
			await openBenchmarkPage(page, harness.origin);
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				await trials.run(index, async () => {
					const errorStart = { console: errors.console.length, page: errors.page.length };
					const beforePrompt = `E2E_BENCH_RESTART_BEFORE:${scenario.id}:${String(index)}`;
					await page.locator("textarea").fill(beforePrompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect(
						page.locator("main").getByText(`E2E_REPLY:${beforePrompt}`, { exact: true }),
					).toHaveCount(1, { timeout: 30_000 });
					const oldLease = await waitForControllerLease(page, received);
					const beforeSession = await sessionForHandle(harness, oldLease.sessionHandle);
					const lifecycleBefore = lifecycleFact(harness.lifecycle(), harness.rootDir);
					// The post-restart prompt is measured against this pre-fault marker boundary.
					const markersBefore = piMarkers(harness.piEvents());
					const rootBefore = harness.rootDir;
					const originBefore = harness.origin;
					const socketsBefore = sockets.length;
					const closesBefore = closedSockets();
					const frameMark = received.length;
					const sourceCursor = cursorBefore(received, frameMark, oldLease.sessionHandle, oldLease);
					const startsBefore = harness.lifecycle().gatewayStarts;
					const documentMarker = await page.evaluate(() => {
						const marker = `restart-document-${String(Math.random())}`;
						document.documentElement.dataset.e2eRestartDocument = marker;
						return marker;
					});
					const startedAt = Date.now();
					await harness.restart(page);
					const restartFinishedAt = Date.now();
					const lifecycleSnapshot = harness.lifecycle();
					await expect.poll(() => closedSockets()).toBeGreaterThan(closesBefore);
					await expect.poll(() => sockets.length, { timeout: 30_000 }).toBeGreaterThan(socketsBefore);
					await expect(page.locator("#root > div")).toBeVisible();
					await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
					await expect(page.locator("html")).toHaveAttribute("data-e2e-restart-document", documentMarker);
					await expect
						.poll(
							() => {
								const frames = received.slice(frameMark);
								return (
									frames.some(
										(candidate) =>
											candidate.type === "runtime_state" &&
											candidate.runtime?.sessionHandle === beforeSession.sessionHandle,
									) &&
									frames.some(
										(candidate) =>
											candidate.type === "resync_required" &&
											(candidate.reason === "initial" || candidate.reason === "epoch_changed"),
									) &&
									frames.some(
										(candidate) =>
											(candidate.type === "session_snapshot" ||
												candidate.type === "session_snapshot_begin") &&
											candidate.sessionHandle === beforeSession.sessionHandle,
									)
								);
							},
							{ timeout: 30_000 },
						)
						.toBe(true);
					await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
					await expect(
						page.locator("main").getByText(`E2E_REPLY:${beforePrompt}`, { exact: true }),
					).toHaveCount(1);
					const currentLease = await waitForControllerLease(
						page,
						received,
						beforeSession.sessionHandle,
						frameMark,
					);
					const afterSession = await sessionForHandle(harness, currentLease.sessionHandle);
					const afterPrompt = `E2E_BENCH_RESTART_AFTER:${scenario.id}:${String(index)}`;
					await page.locator("textarea").fill(afterPrompt);
					await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
					await expect(
						page.locator("main").getByText(`E2E_REPLY:${afterPrompt}`, { exact: true }),
					).toHaveCount(1, { timeout: 30_000 });
					const main = page.locator("main");
					const beforePromptCount = await main.getByText(beforePrompt, { exact: true }).count();
					const afterReplyCount = await main.getByText(`E2E_REPLY:${afterPrompt}`, { exact: true }).count();
					const events = harness.piEvents();
					const gatewayStarts = lifecycleSnapshot.gatewayStarts - startsBefore;
					const stableOrigin = harness.origin === originBefore;
					const recoveryWindowEnd = received.length;
					const protocol = protocolFacts(
						received,
						frameMark,
						recoveryWindowEnd,
						currentLease.sessionHandle,
						"resync",
						sourceCursor,
					);
					const stale = await assertStaleGuards(
						page,
						received,
						harness,
						currentLease,
						index,
						oldLease.serverEpoch,
					);
					const lifecycleAfter = lifecycleFact(harness.lifecycle(), harness.rootDir);
					const markersAfter = piMarkers(harness.piEvents());
					const { stale: staleFacts, oldParentRejected, ...staleChecks } = stale;
					const correctness = {
						recoveryBarrier:
							currentLease.serverEpoch !== oldLease.serverEpoch &&
							currentLease.sessionHandle === beforeSession.sessionHandle,
						zeroDuplicateLostEvents:
							events.filter((event) => event.type === "prompt" && event.text === beforePrompt).length === 1 &&
							events.filter((event) => event.type === "prompt" && event.text === afterPrompt).length === 1 &&
							beforePromptCount === 1 &&
							afterReplyCount === 1,
						...staleChecks,
						finalProjectionMatches: beforePromptCount === 1 && afterReplyCount === 1,
						restartCleanup:
							harness.rootDir === rootBefore &&
							stableOrigin &&
							isBoundedHarnessLifecycle(lifecycleSnapshot) &&
							gatewayStarts === 1,
					};
					return {
						metrics: {
							gatewayRestartMs: restartFinishedAt - startedAt,
							gatewayStarts,
							baselineFrames: received.length - frameMark,
							rootEntryCount: lifecycleSnapshot.rootEntryCount,
							activeGateways: lifecycleSnapshot.activeGatewayCount,
						},
						correctness,
						observation: recoveryObservation(
							"recovery-gateway-restart",
							{
								console: errors.console.slice(errorStart.console),
								page: errors.page.slice(errorStart.page),
							},
							{
								identity: {
									before: persistedAuthority(harness, oldLease, beforeSession),
									after: persistedAuthority(harness, currentLease, afterSession),
									parentRelation: null,
								},
								lifecycle: {
									before: lifecycleBefore,
									after: lifecycleAfter,
									originBefore,
									originAfter: harness.origin,
								},
								pi: {
									markersBefore,
									markersAfter,
									targetSessionId: afterSession.nativeSessionId,
								},
								protocol,
								projection: {
									prompt: afterPrompt,
									reply: `E2E_REPLY:${afterPrompt}`,
									promptCount: beforePromptCount,
									replyCount: afterReplyCount,
								},
								socket: {
									closed: closedSockets() - closesBefore,
									opened: sockets.length - socketsBefore,
								},
								stale: staleFacts,
							},
						),
					};
				});
			}
			addCommonRecoveryGates(
				outcome,
				errors,
				"gatewayRestartMs",
				"Gateway restart and fresh-baseline latency are diagnostic until a portable reference profile exists.",
			);
			addSummaryGate(
				outcome,
				"gatewayStarts",
				"max",
				"eq",
				1,
				"hard",
				"Each restart trial must replace exactly one owned Gateway child.",
			);
			addSummaryGate(
				outcome,
				"activeGateways",
				"max",
				"eq",
				1,
				"hard",
				"Restart cleanup must leave at most one active owned Gateway child.",
			);
			addSummaryGate(
				outcome,
				"rootEntryCount",
				"max",
				"lte",
				MAX_HARNESS_ROOT_ENTRIES,
				"hard",
				"Gateway restart must reuse the bounded run-owned root set.",
			);
			outcome.notes.push(
				"The harness restarts only the Gateway child, reuses its existing agent/session/web-data roots, refreshes the authoritative REST directory, and the Browser waits for a new runtime plus snapshot baseline before control assertions.",
			);
		});
	});
}
