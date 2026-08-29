import fs from "node:fs";
import type { BrowserContext, Page, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import type { HarnessSession, PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const DORMANT_PROMPT = "E2E_HOT_DORMANT";
const DORMANT_REPLY = "E2E_HOT_DORMANT_REPLY";
const BACKGROUND_PROMPT = "E2E_STRESS_TRAJECTORY";
const IDLE_PROMPT = "E2E_HOT_IDLE";
const DIALOG_PROMPT = "E2E_EXTENSION_CONFIRM";
const VISIBLE_PROMPT = "E2E_HOT_VISIBLE";

test.use({
	harnessOptions: {
		extraEnv: {
			PI_WEB_E2E_AUTOSTART_UNPERSISTED_HOT: "1",
			PI_WEB_E2E_DEFER_NEW_SESSION_FILE_AFTER_STARTS: "4",
		},
		seedHistoricalSession: {
			userText: DORMANT_PROMPT,
			assistantText: DORMANT_REPLY,
		},
	},
});

interface WireFrame extends Record<string, unknown> {
	type?: string;
}

interface WireEvent {
	direction: "received" | "sent";
	frame: WireFrame;
	at: number;
}

interface SocketWireObservation {
	socket: PlaywrightWebSocket;
	received: WireFrame[];
	receivedAt: number[];
	sent: WireFrame[];
	events: WireEvent[];
	closed: boolean;
	closePromise: Promise<void>;
}

interface WireObservation {
	sockets: SocketWireObservation[];
}

interface HotScenario {
	background: HarnessSession;
	dialog: HarnessSession;
	idle: HarnessSession;
	transients: HarnessSession[];
	visible: HarnessSession;
}

function jsonFrame(payload: string | Buffer): WireFrame | undefined {
	try {
		return JSON.parse(payload.toString()) as WireFrame;
	} catch {
		return undefined;
	}
}

function observeWire(page: Page): WireObservation {
	const observation: WireObservation = { sockets: [] };
	page.on("websocket", (socket: PlaywrightWebSocket) => {
		let close: (() => void) | undefined;
		const socketObservation: SocketWireObservation = {
			socket,
			received: [],
			receivedAt: [],
			sent: [],
			events: [],
			closed: false,
			closePromise: new Promise<void>((resolve) => {
				close = resolve;
			}),
		};
		observation.sockets.push(socketObservation);
		socket.on("framesent", ({ payload }) => {
			const frame = jsonFrame(payload);
			if (frame) {
				socketObservation.sent.push(frame);
				socketObservation.events.push({ direction: "sent", frame, at: Date.now() });
			}
		});
		socket.on("framereceived", ({ payload }) => {
			const frame = jsonFrame(payload);
			if (frame) {
				socketObservation.received.push(frame);
				socketObservation.receivedAt.push(Date.now());
				socketObservation.events.push({ direction: "received", frame, at: Date.now() });
			}
		});
		socket.on("close", () => {
			socketObservation.closed = true;
			close?.();
		});
	});
	return observation;
}

async function waitForSocket(observation: WireObservation, index: number): Promise<SocketWireObservation> {
	await expect.poll(() => observation.sockets.length).toBeGreaterThan(index);
	const socket = observation.sockets[index];
	if (!socket) throw new Error(`WebSocket ${index} was not observed`);
	return socket;
}

async function waitForSocketClose(observation: SocketWireObservation): Promise<void> {
	await expect.poll(() => observation.socket.isClosed()).toBe(true);
}

function gatewayDisconnectCount(logs: string): number {
	return logs.match(/\[pi-web\] ws disconnected \(/g)?.length ?? 0;
}

async function installPagehideSocketClose(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const NativeWebSocket = window.WebSocket;
		const sockets = new Set<WebSocket>();
		class PageScopedWebSocket extends NativeWebSocket {
			constructor(url: string | URL, protocols: string | string[] = []) {
				super(url, protocols);
				sockets.add(this);
				this.addEventListener("close", () => sockets.delete(this));
			}
		}
		window.WebSocket = PageScopedWebSocket;
		const closeForNavigation = () => {
			for (const socket of sockets) socket.close(1000, "navigation");
		};
		window.addEventListener("beforeunload", closeForNavigation);
		window.addEventListener("pagehide", closeForNavigation);
		window.addEventListener("piweb:e2e-close-sockets", () => {
			for (const socket of sockets) socket.close(1000, "e2e reload");
		});
	});
}

function fixtureEvent(
	harness: ProductionHarness,
	predicate: (event: PiFixtureEvent) => boolean,
): PiFixtureEvent | undefined {
	return harness.piEvents().find(predicate);
}

async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
}

async function openObserverWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeVisible();
}

async function sendPrompt(page: Page, text: string): Promise<void> {
	await page.locator("textarea").fill(text);
	const send = page.getByRole("button", { name: /^(Send|发送)$/ });
	await expect(send).toBeEnabled();
	await send.click();
}

async function createHotSession(harness: ProductionHarness): Promise<HarnessSession> {
	const result = await harness.requestJson<{ session: HarnessSession }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions`,
		{ method: "POST", body: "{}" },
	);
	return result.session;
}

async function beginFreshSession(page: Page, previousPrompt: string): Promise<void> {
	const previous = page.locator("[data-session-row]").filter({ hasText: previousPrompt });
	await expect(previous).toHaveCount(1);
	await expect(previous).toHaveAttribute("data-current", "true");
	await page
		.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();
	const current = page.locator('[data-session-row][data-current="true"]');
	await expect(current).toHaveCount(1);
	await expect(previous).toHaveAttribute("data-current", "false");
	await expect(current).not.toContainText(previousPrompt);
	await expect(
		page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ }),
	).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
}

async function listSessions(harness: ProductionHarness): Promise<HarnessSession[]> {
	const result = await harness.requestJson<{ sessions: HarnessSession[] }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions?refresh=1`,
	);
	return result.sessions;
}

async function sessionForPrompt(harness: ProductionHarness, prompt: string): Promise<HarnessSession> {
	let resolved: HarnessSession | undefined;
	await expect
		.poll(async () => {
			const event = fixtureEvent(
				harness,
				(candidate) => candidate.type === "prompt" && candidate.text === prompt,
			);
			if (!event) return false;
			resolved = (await listSessions(harness)).find((session) => session.nativeSessionId === event.sessionId);
			return resolved !== undefined;
		})
		.toBe(true);
	if (!resolved) throw new Error(`Session for ${prompt} did not materialize`);
	return resolved;
}

async function runtimeState(harness: ProductionHarness, sessionHandle: string): Promise<string> {
	const result = await harness.requestJson<{ state: string }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions/${encodeURIComponent(sessionHandle)}/process`,
	);
	return result.state;
}

async function createUnpersistedRunningSession(harness: ProductionHarness): Promise<HarnessSession> {
	const session = await createHotSession(harness);
	expect(session.persisted).toBe(false);
	expect(session.sessionFile).not.toBeNull();
	if (session.sessionFile) expect(fs.existsSync(session.sessionFile)).toBe(false);
	expect(session.messageCount).toBe(0);
	await expect
		.poll(() =>
			fixtureEvent(
				harness,
				(event) => event.type === "unpersisted_hot_checkpoint" && event.text === session.nativeSessionId,
			),
		)
		.toMatchObject({ text: session.nativeSessionId });
	await expect.poll(() => runtimeState(harness, session.sessionHandle)).toBe("running");
	if (session.sessionFile) expect(fs.existsSync(session.sessionFile)).toBe(false);
	return session;
}

async function establishSevenHotRuntimes(page: Page, harness: ProductionHarness): Promise<HotScenario> {
	await openWorkbench(page, harness);
	expect(
		harness.piEvents().some((event) => event.type === "started" && event.sessionId === "browser-e2e-history"),
	).toBe(false);

	await sendPrompt(page, BACKGROUND_PROMPT);
	await expect
		.poll(() =>
			fixtureEvent(
				harness,
				(event) => event.type === "stress_checkpoint" && event.text === BACKGROUND_PROMPT,
			),
		)
		.toMatchObject({ toolCount: 26 });
	const background = await sessionForPrompt(harness, BACKGROUND_PROMPT);

	await beginFreshSession(page, BACKGROUND_PROMPT);
	await sendPrompt(page, IDLE_PROMPT);
	await expect(page.getByText(`E2E_REPLY:${IDLE_PROMPT}`, { exact: true })).toBeVisible();
	const idle = await sessionForPrompt(harness, IDLE_PROMPT);

	await beginFreshSession(page, IDLE_PROMPT);
	await sendPrompt(page, DIALOG_PROMPT);
	const dialogBox = page.getByRole("dialog", { name: "Synthetic approval" });
	await expect(dialogBox).toBeVisible();
	const dialog = await sessionForPrompt(harness, DIALOG_PROMPT);
	await dialogBox.getByRole("button", { name: /^(Minimize to dock|最小化到停靠栏)$/ }).click();
	await expect(page.getByTestId("chat-dock")).toBeVisible();

	await beginFreshSession(page, DIALOG_PROMPT);
	await sendPrompt(page, VISIBLE_PROMPT);
	await expect(page.getByText(`E2E_REPLY:${VISIBLE_PROMPT}`, { exact: true })).toBeVisible();
	const visible = await sessionForPrompt(harness, VISIBLE_PROMPT);
	const transients = [
		await createUnpersistedRunningSession(harness),
		await createUnpersistedRunningSession(harness),
		await createUnpersistedRunningSession(harness),
	];

	await expect.poll(() => runtimeState(harness, background.sessionHandle)).toBe("running");
	await expect.poll(() => runtimeState(harness, idle.sessionHandle)).toBe("idle");
	await expect.poll(() => runtimeState(harness, dialog.sessionHandle)).toBe("waiting_ui");
	await expect.poll(() => runtimeState(harness, visible.sessionHandle)).toBe("idle");
	for (const session of [background, idle, dialog, visible]) {
		expect(session.sessionFile).not.toBeNull();
		expect(session.persisted).toBe(true);
		expect(session.messageCount).toBeGreaterThan(0);
	}
	for (const session of transients) {
		expect(session.persisted).toBe(false);
		expect(session.sessionFile).not.toBeNull();
		if (session.sessionFile) expect(fs.existsSync(session.sessionFile)).toBe(false);
		expect(session.messageCount).toBe(0);
		await expect.poll(() => runtimeState(harness, session.sessionHandle)).toBe("running");
	}

	const started = harness.piEvents().filter((event) => event.type === "started");
	expect(started).toHaveLength(7);
	expect(new Set(started.map((event) => event.pid)).size).toBe(7);
	expect(started.some((event) => event.sessionId === "browser-e2e-history")).toBe(false);
	expect(
		new Set([background, idle, dialog, visible, ...transients].map((session) => session.sessionHandle)).size,
	).toBe(7);
	return { background, dialog, idle, transients, visible };
}

function hotInventoryFrames(observation: SocketWireObservation): WireFrame[] {
	return observation.received.filter((frame) => frame.type === "hot_runtime_inventory");
}

async function waitForInitialFullInventory(
	observation: SocketWireObservation,
	expectedHandles: Set<string>,
): Promise<WireFrame> {
	let inventory: WireFrame | undefined;
	await expect
		.poll(() => {
			inventory = hotInventoryFrames(observation)[0];
			if (!inventory) return false;
			const runtimes = Array.isArray(inventory.runtimes) ? inventory.runtimes : [];
			return (
				runtimes.length === expectedHandles.size &&
				runtimes.every(
					(runtime) =>
						typeof runtime === "object" &&
						runtime !== null &&
						expectedHandles.has(String((runtime as WireFrame).sessionHandle)),
				)
			);
		})
		.toBe(true);
	if (!inventory) throw new Error("initial full hot Runtime inventory was not observed");
	return inventory;
}

function inventoryRuntime(inventory: WireFrame, sessionHandle: string): WireFrame {
	const runtimes = Array.isArray(inventory.runtimes) ? inventory.runtimes : [];
	const runtime = runtimes.find(
		(candidate): candidate is WireFrame =>
			typeof candidate === "object" && candidate !== null && candidate.sessionHandle === sessionHandle,
	);
	if (!runtime) throw new Error(`hot Runtime ${sessionHandle} was not present in the inventory`);
	return runtime;
}

async function expectObservationBaseline(
	observation: SocketWireObservation,
	expectedHandles: Set<string>,
): Promise<WireFrame> {
	const inventory = await waitForInitialFullInventory(observation, expectedHandles);
	const inventoryRuntimes = Array.isArray(inventory.runtimes) ? (inventory.runtimes as WireFrame[]) : [];
	const exactFor = (sessionHandle: string) =>
		observation.sent.filter(
			(frame) =>
				frame.type === "session_subscribe" &&
				frame.sessionHandle === sessionHandle &&
				typeof frame.expectedHotRuntime === "object",
		);
	const snapshotsFor = (sessionHandle: string) =>
		observation.received.filter(
			(frame) => frame.type === "session_snapshot" && frame.sessionHandle === sessionHandle,
		);
	const leasesFor = (sessionHandle: string) =>
		observation.received.filter(
			(frame) => frame.type === "lease_status" && frame.sessionHandle === sessionHandle,
		);

	await expect
		.poll(() => [...expectedHandles].every((sessionHandle) => exactFor(sessionHandle).length === 1))
		.toBe(true);
	await expect
		.poll(() => [...expectedHandles].every((sessionHandle) => snapshotsFor(sessionHandle).length === 1))
		.toBe(true);
	await expect
		.poll(() => [...expectedHandles].every((sessionHandle) => leasesFor(sessionHandle).length >= 1))
		.toBe(true);
	for (const sessionHandle of expectedHandles) {
		const [exact] = exactFor(sessionHandle);
		expect(exactFor(sessionHandle)).toHaveLength(1);
		const inventoryRuntime = inventoryRuntimes.find((runtime) => runtime.sessionHandle === sessionHandle);
		expect(inventoryRuntime).toBeDefined();
		if (!inventoryRuntime || !exact) continue;
		const expectedIdentity = {
			serverEpoch: inventoryRuntime.serverEpoch,
			sessionHandle: inventoryRuntime.sessionHandle,
			workspaceId: inventoryRuntime.workspaceId,
			generation: inventoryRuntime.generation,
		};
		expect(exact.expectedHotRuntime).toEqual(expectedIdentity);
		if (exact.cursor !== undefined) {
			expect(Object.keys(exact.cursor as WireFrame).sort()).toEqual(["generation", "seq", "serverEpoch"]);
			expect(exact.cursor).toMatchObject({
				generation: expect.any(Number),
				seq: expect.any(Number),
				serverEpoch: expect.any(String),
			});
		}
		expect(snapshotsFor(sessionHandle)).toHaveLength(1);
		expect(leasesFor(sessionHandle).length).toBeGreaterThanOrEqual(1);
	}
	const serverHelloIndex = observation.events.findIndex(
		(event) => event.direction === "received" && event.frame.type === "server_hello",
	);
	const inventoryIndex = observation.events.findIndex((event) => event.frame === inventory);
	const firstExactIndex = observation.events.findIndex(
		(event) =>
			event.direction === "sent" &&
			event.frame.type === "session_subscribe" &&
			typeof event.frame.expectedHotRuntime === "object",
	);
	expect(serverHelloIndex).toBeGreaterThanOrEqual(0);
	expect(inventoryIndex).toBeGreaterThan(serverHelloIndex);
	expect(firstExactIndex).toBeGreaterThan(inventoryIndex);
	expect(
		observation.received.filter((frame) => frame.type === "session_error" && frame.operation === "subscribe"),
	).toEqual([]);
	return inventory;
}

function hotHandles(scenario: HotScenario): Set<string> {
	return new Set([
		scenario.background.sessionHandle,
		scenario.idle.sessionHandle,
		scenario.dialog.sessionHandle,
		scenario.visible.sessionHandle,
		...scenario.transients.map((session) => session.sessionHandle),
	]);
}

function expectHotLifecycleWindow(
	observation: SocketWireObservation,
	expectedHandles: Set<string>,
	allowedReleaseHandles: Set<string> = new Set(),
): void {
	const lifecycle = observation.sent.filter(
		(frame) =>
			(frame.type === "session_unsubscribe" || frame.type === "session_release") &&
			expectedHandles.has(String(frame.sessionHandle)),
	);
	expect(lifecycle.filter((frame) => frame.type === "session_unsubscribe")).toEqual([]);
	const releases = lifecycle.filter((frame) => frame.type === "session_release");
	expect(releases.every((frame) => allowedReleaseHandles.has(String(frame.sessionHandle)))).toBe(true);
	for (const sessionHandle of allowedReleaseHandles) {
		expect(
			lifecycle.filter((frame) => frame.type === "session_release" && frame.sessionHandle === sessionHandle)
				.length,
		).toBeLessThanOrEqual(1);
	}
}

function expectExactBaselineCounts(observation: SocketWireObservation, expectedHandles: Set<string>): void {
	for (const sessionHandle of expectedHandles) {
		expect(
			observation.sent.filter(
				(frame) =>
					frame.type === "session_subscribe" &&
					frame.sessionHandle === sessionHandle &&
					typeof frame.expectedHotRuntime === "object",
			),
		).toHaveLength(1);
		expect(
			observation.received.filter(
				(frame) => frame.type === "session_snapshot" && frame.sessionHandle === sessionHandle,
			),
		).toHaveLength(1);
	}
	expect(
		observation.received.filter((frame) => frame.type === "session_error" && frame.operation === "subscribe"),
	).toEqual([]);
}

test("hard reload observes every hot Runtime exactly once without activating dormant history", async ({
	page,
	harness,
}) => {
	test.slow();
	await installPagehideSocketClose(page);
	const errors = observePageErrors(page);
	const wire = observeWire(page);
	const scenario = await establishSevenHotRuntimes(page, harness);
	expect(wire.sockets.length).toBeGreaterThan(0);
	const oldSocket = wire.sockets.at(-1);
	if (!oldSocket) throw new Error("initial WebSocket was not observed");
	expect(oldSocket.socket.url()).toContain("/api/v1/ws");
	const expectedHandles = hotHandles(scenario);
	const startedBeforeReload = harness.piEvents().filter((event) => event.type === "started");
	const reloadCreateRequests: number[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST" && /\/api\/v1\/workspaces\/[^/]+\/sessions$/.test(request.url())) {
			reloadCreateRequests.push(Date.now());
		}
	});

	const reloadSocketIndex = wire.sockets.length;
	expect(oldSocket.socket.isClosed(), "old socket must be open before hard reload").toBe(false);
	const disconnectCountBeforeReload = gatewayDisconnectCount(harness.logs());
	const oldSocketDisconnected = expect
		.poll(() => gatewayDisconnectCount(harness.logs()))
		.toBeGreaterThan(disconnectCountBeforeReload);
	await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), oldSocketDisconnected]);
	const reloadSocket = await waitForSocket(wire, reloadSocketIndex);
	await expect(page.locator("main")).toBeVisible();
	const initialInventory = await expectObservationBaseline(reloadSocket, expectedHandles);
	const backgroundRuntime = inventoryRuntime(initialInventory, scenario.background.sessionHandle);
	expect(backgroundRuntime.state).toBe("running");
	expect(backgroundRuntime.phase).toBe("busy");
	expect(backgroundRuntime.operationCount).toEqual(expect.any(Number));
	expect(Number(backgroundRuntime.operationCount)).toBeGreaterThan(0);
	expect(backgroundRuntime.busyReasons).toEqual(expect.arrayContaining(["agent"]));

	const dialogRuntime = inventoryRuntime(initialInventory, scenario.dialog.sessionHandle);
	expect(dialogRuntime.phase).toBe("waiting_ui");
	expect(dialogRuntime.operationCount).toEqual(expect.any(Number));
	expect(Number(dialogRuntime.operationCount)).toBeGreaterThan(0);
	expect(dialogRuntime.busyReasons).toEqual(expect.arrayContaining(["dialog"]));

	for (const session of [scenario.idle, scenario.visible]) {
		const readyRuntime = inventoryRuntime(initialInventory, session.sessionHandle);
		expect(readyRuntime.phase).toBe("ready");
		expect(readyRuntime.operationCount).toBe(0);
		expect(readyRuntime.busyReasons).toEqual([]);
	}
	for (const session of scenario.transients) {
		const transientRuntime = inventoryRuntime(initialInventory, session.sessionHandle);
		expect(transientRuntime.phase).toBe("busy");
		expect(Number(transientRuntime.operationCount)).toBeGreaterThan(0);
		expect(transientRuntime.busyReasons).toEqual(expect.arrayContaining(["agent"]));
	}
	await expect(page.locator("textarea")).toBeVisible();
	const inventoryIndex = reloadSocket.received.indexOf(initialInventory);
	expect(inventoryIndex).toBeGreaterThanOrEqual(0);
	expect(reloadSocket.receivedAt[inventoryIndex]).toBeDefined();
	expect(
		reloadCreateRequests,
		JSON.stringify(
			{
				inventoryReceivedAt: reloadSocket.receivedAt[inventoryIndex],
				reloadCreateRequests,
			},
			null,
			2,
		),
	).toEqual([]);
	expect(
		harness.piEvents().filter((event) => event.type === "started"),
		JSON.stringify(
			{
				initialInventory,
				inventoryReceivedAt: reloadSocket.receivedAt[inventoryIndex],
				reloadCreateRequests,
			},
			null,
			2,
		),
	).toEqual(startedBeforeReload);
	const reloadSent = reloadSocket.sent;
	const reloadClaims = reloadSent.filter((frame) => frame.type === "session_claim");
	expect(reloadClaims).toHaveLength(1);
	expect(expectedHandles.has(String(reloadClaims[0]?.sessionHandle))).toBe(true);
	expect(
		reloadSent.filter((frame) => frame.type === "command" && typeof frame.fencingToken === "string"),
	).toEqual([]);
	expect(reloadSent.filter((frame) => frame.type === "extension_ui_response")).toEqual([]);
	expect(
		reloadSent.filter(
			(frame) => frame.type === "session_subscribe" && frame.sessionHandle === harness.session.sessionHandle,
		),
	).toEqual([]);
	expect(harness.piEvents().filter((event) => event.type === "started")).toEqual(startedBeforeReload);
	for (const transient of scenario.transients) {
		const inventoryRuntime = (initialInventory.runtimes as WireFrame[]).find(
			(runtime) => runtime.sessionHandle === transient.sessionHandle,
		);
		expect(inventoryRuntime?.state).toBe("running");
		const snapshot = reloadSocket.received.find(
			(frame) => frame.type === "session_snapshot" && frame.sessionHandle === transient.sessionHandle,
		);
		expect(snapshot).toBeDefined();
		expect((snapshot?.runtime as WireFrame | undefined)?.recoverable).toBe(false);
		expect((snapshot?.runtime as WireFrame | undefined)?.state).toBe("running");
		expect(JSON.stringify(snapshot)).toContain(`E2E_UNPERSISTED_PARTIAL:${transient.nativeSessionId}`);
	}
	await expect
		.poll(() => {
			const latestInventory = hotInventoryFrames(reloadSocket).at(-1);
			return Array.isArray(latestInventory?.runtimes) ? latestInventory.runtimes.length : 0;
		})
		.toBe(7);
	await expect
		.poll(async () => {
			const latestInventory = hotInventoryFrames(reloadSocket).at(-1);
			return {
				inventoryCount: Array.isArray(latestInventory?.runtimes) ? latestInventory.runtimes.length : 0,
				rowCount: await page.locator("[data-session-row]").count(),
			};
		})
		.toEqual({ inventoryCount: 7, rowCount: 8 });
	expectHotLifecycleWindow(reloadSocket, expectedHandles);

	const recoveredDialog = page.getByRole("dialog", { name: "Synthetic approval" });
	if (await recoveredDialog.isVisible()) {
		await recoveredDialog.getByRole("button", { name: /^(Minimize to dock|最小化到停靠栏)$/ }).click();
	}
	const backgroundRow = page.locator("[data-session-row]").filter({ hasText: BACKGROUND_PROMPT });
	await expect(backgroundRow).toHaveAttribute("data-runtime-state", "running");
	await backgroundRow.getByRole("button").first().click();
	await expect(page.locator("header").getByText(/^(Running|运行中)$/)).toBeVisible();
	await expect
		.poll(
			() =>
				reloadSocket.sent.filter(
					(frame) =>
						frame.type === "session_claim" && frame.sessionHandle === scenario.background.sessionHandle,
				).length,
		)
		.toBe(1);
	await expect(
		page.locator("main").locator("button[aria-expanded]").filter({ hasText: "synthetic-tool-" }),
	).toHaveCount(26);
	const initialClaimHandle = String(reloadClaims[0]?.sessionHandle);
	const allowedReleases =
		initialClaimHandle === scenario.background.sessionHandle
			? new Set<string>()
			: new Set([initialClaimHandle]);
	expectHotLifecycleWindow(reloadSocket, expectedHandles, allowedReleases);
	const initialRevision = Number(initialInventory.revision);

	harness.releasePrompt(BACKGROUND_PROMPT);
	await expect
		.poll(() =>
			fixtureEvent(harness, (event) => event.type === "settled" && event.text === BACKGROUND_PROMPT),
		)
		.toMatchObject({ label: "stress-trajectory", toolCount: 52 });
	await expect.poll(() => runtimeState(harness, scenario.background.sessionHandle)).toBe("idle");
	await expect
		.poll(() =>
			hotInventoryFrames(reloadSocket).some((frame) => {
				if (Number(frame.revision) <= initialRevision || !Array.isArray(frame.runtimes)) return false;
				const background = frame.runtimes.find(
					(runtime) =>
						typeof runtime === "object" &&
						runtime !== null &&
						(runtime as WireFrame).sessionHandle === scenario.background.sessionHandle,
				);
				const backgroundRecord =
					typeof background === "object" && background !== null
						? (background as Record<string, unknown>)
						: null;
				return (
					backgroundRecord !== null &&
					backgroundRecord.state === "idle" &&
					backgroundRecord.phase === "ready" &&
					backgroundRecord.operationCount === 0 &&
					Array.isArray(backgroundRecord.busyReasons) &&
					backgroundRecord.busyReasons.length === 0
				);
			}),
		)
		.toBe(true);
	await expect(
		page.locator("main").getByRole("heading", { name: "Synthetic stress trajectory", level: 2 }),
	).toBeVisible();
	await expect(
		page.locator("main").locator("button[aria-expanded]").filter({ hasText: "synthetic-tool-" }),
	).toHaveCount(52);
	expect(
		harness.piEvents().filter((event) => event.type === "prompt" && event.text === BACKGROUND_PROMPT),
	).toHaveLength(1);
	expectExactBaselineCounts(reloadSocket, expectedHandles);
	expectHotLifecycleWindow(reloadSocket, expectedHandles, allowedReleases);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("a reopened observer restores seven hot Runtimes but only the controller answers the dialog", async ({
	browser,
	page,
	harness,
}) => {
	test.slow();
	const ownerErrors = observePageErrors(page);
	const ownerWire = observeWire(page);
	const scenario = await establishSevenHotRuntimes(page, harness);
	const ownerSocket = await waitForSocket(ownerWire, 0);
	const expectedHandles = hotHandles(scenario);
	const dialogRow = page.locator("[data-session-row]").filter({ hasText: DIALOG_PROMPT });
	await dialogRow.getByRole("button").first().click();
	const ownerDock = page.getByTestId("chat-dock");
	if (await ownerDock.isVisible()) {
		await ownerDock.getByRole("button", { name: /^(Expand dialog|展开对话框)$/ }).click();
	}
	const ownerDialog = page.getByRole("dialog", { name: "Synthetic approval" });
	await expect(ownerDialog).toBeVisible();
	await expect(ownerDialog.getByRole("button", { name: /^(Confirm|确认)$/ })).toBeEnabled();

	const observerContext: BrowserContext = await browser.newContext();
	try {
		let observerPage = await observerContext.newPage();
		await installPagehideSocketClose(observerPage);
		const firstErrors = observePageErrors(observerPage);
		const firstWire = observeWire(observerPage);
		await openObserverWorkbench(observerPage, harness);
		const firstSocket = await waitForSocket(firstWire, 0);
		await expectObservationBaseline(firstSocket, expectedHandles);
		const firstClaims = firstSocket.sent.filter((frame) => frame.type === "session_claim");
		expect(firstClaims).toHaveLength(1);
		expect(expectedHandles.has(String(firstClaims[0]?.sessionHandle))).toBe(true);
		expect(
			firstSocket.sent.filter((frame) => frame.type === "command" && typeof frame.fencingToken === "string"),
		).toEqual([]);
		expect(firstSocket.sent.filter((frame) => frame.type === "extension_ui_response")).toEqual([]);
		expectHotLifecycleWindow(firstSocket, expectedHandles);

		await observerPage.evaluate(() => window.dispatchEvent(new Event("piweb:e2e-close-sockets")));
		await waitForSocketClose(firstSocket);
		await observerPage.close();
		observerPage = await observerContext.newPage();
		await installPagehideSocketClose(observerPage);
		const reopenedErrors = observePageErrors(observerPage);
		const reopenedWire = observeWire(observerPage);
		await openObserverWorkbench(observerPage, harness);
		const reopenedSocket = await waitForSocket(reopenedWire, 0);
		const reopenedInventory = await expectObservationBaseline(reopenedSocket, expectedHandles);
		await expect(observerPage.locator("[data-session-row]")).toHaveCount(8);
		expect(harness.piEvents().filter((event) => event.type === "started")).toHaveLength(7);
		expect(
			reopenedSocket.sent.filter(
				(frame) =>
					frame.type === "session_subscribe" && frame.sessionHandle === harness.session.sessionHandle,
			),
		).toEqual([]);
		expect(
			reopenedSocket.sent.filter(
				(frame) => frame.type === "command" && typeof frame.fencingToken === "string",
			),
		).toEqual([]);
		expectHotLifecycleWindow(reopenedSocket, expectedHandles);

		const observerDialogRow = observerPage.locator("[data-session-row]").filter({ hasText: DIALOG_PROMPT });
		await observerDialogRow.getByRole("button").first().click();
		await expect(observerPage.locator("textarea")).toBeDisabled();
		await expect(observerPage.locator("header").getByText(/^(Waiting for input|等待输入)$/)).toBeVisible();
		await expect(observerPage.getByRole("dialog", { name: "Synthetic approval" })).toHaveCount(0);
		await expect
			.poll(
				() =>
					reopenedSocket.sent.filter(
						(frame) =>
							frame.type === "session_claim" && frame.sessionHandle === scenario.dialog.sessionHandle,
					).length,
			)
			.toBe(1);
		expect(reopenedSocket.sent.filter((frame) => frame.type === "extension_ui_response")).toEqual([]);
		const reopenedInitialClaim = String(
			reopenedSocket.sent.find((frame) => frame.type === "session_claim")?.sessionHandle,
		);
		const reopenedAllowedReleases =
			reopenedInitialClaim === scenario.dialog.sessionHandle
				? new Set<string>()
				: new Set([reopenedInitialClaim]);
		expectHotLifecycleWindow(reopenedSocket, expectedHandles, reopenedAllowedReleases);
		const reopenedRevision = Number(reopenedInventory.revision);

		await ownerDialog.getByRole("button", { name: /^(Confirm|确认)$/ }).click();
		await expect(ownerDialog).toBeHidden();
		await expect(
			observerPage.locator("main").getByText("E2E_EXTENSION_CONFIRMED", { exact: true }),
		).toBeVisible();
		await expect
			.poll(
				() =>
					harness
						.piEvents()
						.filter((event) => event.type === "extension_response" && event.text === DIALOG_PROMPT).length,
			)
			.toBe(1);
		await expect.poll(() => runtimeState(harness, scenario.dialog.sessionHandle)).toBe("idle");
		await expect
			.poll(() =>
				hotInventoryFrames(reopenedSocket).some((frame) => {
					if (Number(frame.revision) <= reopenedRevision || !Array.isArray(frame.runtimes)) return false;
					return frame.runtimes.some(
						(runtime) =>
							typeof runtime === "object" &&
							runtime !== null &&
							(runtime as WireFrame).sessionHandle === scenario.dialog.sessionHandle &&
							(runtime as WireFrame).state === "idle",
					);
				}),
			)
			.toBe(true);
		expect(ownerSocket.sent.filter((frame) => frame.type === "extension_ui_response")).toHaveLength(1);
		expect(reopenedSocket.sent.filter((frame) => frame.type === "extension_ui_response")).toEqual([]);
		expectExactBaselineCounts(reopenedSocket, expectedHandles);
		expectHotLifecycleWindow(reopenedSocket, expectedHandles, reopenedAllowedReleases);
		expect(firstErrors.console).toEqual([]);
		expect(firstErrors.page).toEqual([]);
		expect(reopenedErrors.console).toEqual([]);
		expect(reopenedErrors.page).toEqual([]);
	} finally {
		await observerContext.close();
	}
	expect(ownerErrors.console).toEqual([]);
	expect(ownerErrors.page).toEqual([]);
});
