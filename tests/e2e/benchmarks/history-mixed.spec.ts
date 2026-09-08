import { createHash } from "node:crypto";
import fs from "node:fs";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import type { SessionWsClientMessage } from "../../../packages/protocol/src/index";
import { observePageErrors } from "../fixtures/page-observation";
import { type ProductionHarness, startProductionHarness } from "../fixtures/production-harness";
import {
	addValueGate,
	benchmarkVariant,
	correctnessFailureCount,
	createTrialObservation,
	type MixedHistoryFacts,
	runBenchmarkScenario,
	scenariosFor,
} from "./benchmark-support";

const PROMPT = "E2E_MIXED_HISTORY";
const REPLY = "E2E_MIXED_REPLY";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const cursorHash = (value: unknown) => (typeof value === "string" ? digest(value) : null);
const stamp = () => performance.now();

const scenarios = scenariosFor("history-mixed").sort(
	(a, b) =>
		a.turns! - b.turns! ||
		a.historyMount!.localeCompare(b.historyMount!) * (benchmarkVariant() === "coalesced" ? 1 : -1),
);
for (const scenario of scenarios) {
	test(scenario.id, async ({ browser }, testInfo) => {
		test.setTimeout(20 * 60_000);
		let page!: Page;
		let harness: ProductionHarness | undefined;
		let browserErrorCount = 0;
		try {
			await runBenchmarkScenario(
				() => page,
				testInfo,
				null,
				scenario,
				async (outcome, trials) => {
					for (let cycle = 0; cycle < scenario.warmups + scenario.samples; cycle++) {
						const context = await browser.newContext({
							permissions: ["clipboard-read", "clipboard-write"],
							reducedMotion: "reduce",
							viewport: { width: 1920, height: 1080 },
						});
						page = await context.newPage();
						const errors = observePageErrors(page);
						const facts: MixedHistoryFacts = {
							failure: null,
							fixtureDigest: "",
							liveTurns: 0,
							liveMounted: 0,
							cycle,
							sourceBytes: 0,
							initialTurns: 0,
							finalTurns: 0,
							mounted: 0,
							getMessagesCount: 0,
							pages: [],
							gc: [],
							actions: [],
							anchor: { beforeId: "", afterId: "", before: 0, after: 0 },
							prepend: {
								requestsBefore: 0,
								requestsAfter: 0,
								inflightBefore: 0,
								inflightAfter: 0,
								requestId: "",
								endRequestId: "",
								beforeTurns: 0,
								afterTurns: 0,
								pageMessages: 0,
								pageUserTurns: 0,
								anchorVisible: false,
								windowBefore: [],
								windowAfter: [],
							},
							times: { cold: 0, warm: 0, settlement: 0, cycle: 0 },
						};
						const started = stamp();
						const deadline = setTimeout(() => void context.close(), 120_000);
						await trials.run(cycle, async () => {
							try {
								harness = await startProductionHarness({
									benchmarkGateway: true,
									seedHistoricalSession: {
										userText: PROMPT,
										assistantText: REPLY,
										turnCount: scenario.turns,
										targetSourceBytes: scenario.sourceBytes,
										mixedHistory: true,
									},
								});
								const source = fs.readFileSync(harness.session.sessionFile!, "utf8");
								facts.sourceBytes = Buffer.byteLength(source);
								// Exclude the private header cwd and only the recipe's terminal byte padding.
								facts.fixtureDigest = digest(
									JSON.stringify(
										source
											.trim()
											.split("\n")
											.slice(1)
											.map((line) => JSON.parse(line)),
										(key, value) =>
											key === "text" && typeof value === "string" ? value.replace(/x+$/, "") : value,
									),
								);
								await page.addInitScript((full) => {
									Reflect.set(globalThis, "__piwebBenchmarkFullHistory", full);
									localStorage.setItem("pi-web-theme", "light");
								}, scenario.historyMount === "full");
								let recording = true;
								let route: WebSocketRoute | undefined;
								let serverRoute: WebSocketRoute | undefined;
								let opened = 0;
								const pageRequests: Array<{
									id: string;
									endId: string;
									messages: number;
									userTurns: number;
								}> = [];
								const inflight = new Map<string, (typeof pageRequests)[number]>();
								let pending: MixedHistoryFacts["pages"][number] | undefined;
								await page.routeWebSocket("**/api/v1/ws", (socket) => {
									route = socket;
									opened++;
									const server = socket.connectToServer();
									serverRoute = server;
									socket.onMessage((message) => {
										const frame = JSON.parse(message.toString()) as SessionWsClientMessage;
										if (
											frame.type === "session_history_page" &&
											frame.sessionHandle === harness?.session.sessionHandle
										) {
											const request = { id: digest(frame.id), endId: "", messages: 0, userTurns: 0 };
											pageRequests.push(request);
											inflight.set(frame.id, request);
										}
										server.send(message);
									});
									server.onMessage((message) => {
										const frame = JSON.parse(message.toString());
										const request = inflight.get(frame.requestId);
										if (request && frame.type === "session_history_page_chunk") {
											request.messages += frame.messages.length;
											request.userTurns += frame.messages.filter(
												(m: { role: string }) => m.role === "user",
											).length;
										}
										if (request && frame.type === "session_history_page_end") {
											request.endId = digest(frame.requestId);
											inflight.delete(frame.requestId);
										}
										if (recording && frame.sessionHandle === harness?.session.sessionHandle) {
											if (
												frame.type === "session_snapshot_begin" ||
												frame.type === "session_history_page_begin"
											)
												pending = { cursor: cursorHash(frame.cursor), next: null, ids: [] };
											if (
												pending &&
												(frame.type === "session_snapshot_chunk" ||
													frame.type === "session_history_page_chunk")
											)
												for (const m of frame.messages)
													pending.ids.push(`${m.timestamp}:${m.role}:${m.stopReason ?? ""}`);
											if (
												pending &&
												(frame.type === "session_snapshot_end" || frame.type === "session_history_page_end")
											) {
												pending.next = cursorHash(frame.nextCursor);
												facts.pages.push(pending);
												pending = undefined;
											}
										}

										socket.send(message);
									});
								});
								await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
								await expect(page.locator("textarea")).toBeEnabled();
								await page.locator("textarea").fill("E2E_B_FAST");
								await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
								await expect(page.locator("main")).toContainText("E2E_REPLY:E2E_B_FAST");
								const cdp = await context.newCDPSession(page);
								const paint = () =>
									page.evaluate(
										() =>
											new Promise<void>((resolve) =>
												requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
											),
									);
								const gc = async (name: string) => {
									const begin = stamp();
									await cdp.send("HeapProfiler.collectGarbage");
									const observation = await page.evaluate(() => ({
										heap: (performance as Performance & { memory: { usedJSHeapSize: number } }).memory
											.usedJSHeapSize,
										dom: document.querySelectorAll("*").length,
									}));
									facts.gc.push({ name, started: begin, finished: stamp(), ...observation });
									if (observation.heap > 1024 ** 3 || observation.dom > 500_000)
										throw new Error("mixed history safety limit");
								};
								const row = page
									.locator("[data-session-row]")
									.filter({ hasText: PROMPT })
									.getByRole("button")
									.first();
								const viewport = page.locator('[data-chat-viewport="true"]');
								const window = viewport.locator('[data-turn-window="true"]');
								const total = async () => Number(await window.getAttribute("data-turn-window-total"));
								await gc("baseline");
								const cold = stamp();
								await row.click();
								await expect(window.locator("[data-turn-id]").last()).toContainText(REPLY);
								const visible = stamp();
								await expect(window.locator('[aria-busy="true"]')).toHaveCount(0);
								await paint();
								facts.times.cold = stamp() - cold;
								facts.times.settlement = stamp() - visible;
								facts.initialTurns = await total();
								const allPages = async () => {
									while ((await total()) < scenario.turns!) {
										const previous = await total();
										// Reveal already-loaded older turns first; only real wire pages enter facts.pages.
										await page.locator("[data-toc-tick]").first().click();
										await window.locator('[data-load-older-turns="true"]').click();
										await expect.poll(total).toBeGreaterThan(previous);
										await expect(window.locator('[aria-busy="true"]')).toHaveCount(0);
									}
								};
								await allPages();
								facts.finalTurns = await total();
								recording = false;
								facts.mounted = await window.locator("[data-turn-id]").count();
								await gc("loaded");
								const action = async (name: string, run: () => Promise<string>) => {
									const begin = stamp();
									const actual = await run();
									await paint();
									facts.actions.push({ name, started: begin, finished: stamp(), actual });
								};
								for (const [name, index] of [
									["oldest", 0],
									["middle", scenario.turns! / 2],
									["latest", scenario.turns! - 1],
								] as const)
									await action(name, async () => {
										await page.locator("[data-toc-tick]").nth(index).click();
										const marker = window.getByText(`${PROMPT} [turn ${index + 1}]`, { exact: true });
										await expect(marker).toBeVisible();
										return (await marker.textContent())!;
									});
								// Use an actual remote prepend for both rendering modes, in a fresh cold page.
								await page.reload({ waitUntil: "domcontentloaded" });
								await expect(page.locator("textarea")).toBeEnabled();
								await row.click();
								await expect(window.locator("[data-turn-id]").last()).toContainText(REPLY);
								const older = window.locator('[data-load-older-turns="true"]');
								await expect.poll(() => inflight.size).toBe(0);
								await expect(window.locator('[aria-busy="true"]')).toHaveCount(0);
								const requestCount = pageRequests.length;
								// Keep the reader above the auto-page threshold without scrolling the focused control into view.
								await viewport.evaluate((element) => {
									element.scrollTop = 140;
								});
								await older.evaluate((node) => (node as HTMLButtonElement).focus({ preventScroll: true }));
								await paint();
								await expect(older).toBeFocused();
								facts.prepend.requestsBefore = pageRequests.length;
								facts.prepend.inflightBefore = inflight.size;
								facts.prepend.beforeTurns = await total();
								const windowRange = () =>
									window.evaluate((node) => [
										Number(node.getAttribute("data-turn-window-start")),
										Number(node.getAttribute("data-turn-window-end")),
									]);
								facts.prepend.windowBefore = await windowRange();
								const before = await viewport.evaluate((element) => {
									const bounds = element.getBoundingClientRect();
									const node = Array.from(element.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
										(n) => {
											const box = n.getBoundingClientRect();
											return box.bottom > bounds.top && box.top < bounds.bottom;
										},
									);
									if (!node || element.scrollTop <= 96)
										throw new Error(
											"prepend requires a visible, stable reading anchor above the auto-page threshold",
										);
									return { id: node.dataset.turnId!, offset: node.getBoundingClientRect().top - bounds.top };
								});
								facts.prepend.anchorVisible = true;
								facts.anchor = { beforeId: before.id, afterId: "", before: before.offset, after: 0 };
								expect(pageRequests.length).toBe(requestCount);
								expect(inflight.size).toBe(0);
								expect(facts.prepend.beforeTurns).toBe(facts.initialTurns);
								await action("prepend", async () => {
									// Native activation uses the real React handler without Playwright's automatic scroll.
									await older.evaluate((node) => (node as HTMLButtonElement).click());
									await expect.poll(() => pageRequests.length).toBe(requestCount + 1);
									await expect.poll(() => inflight.size).toBe(0);
									await expect(window.locator('[aria-busy="true"]')).toHaveCount(0);
									await expect.poll(total).toBeGreaterThan(facts.prepend.beforeTurns);
									await paint();
									const after = await viewport.evaluate((element, id) => {
										const node = element.querySelector<HTMLElement>(`[data-turn-id="${id}"]`);
										return {
											id: node?.dataset.turnId ?? "",
											offset: node
												? node.getBoundingClientRect().top - element.getBoundingClientRect().top
												: 0,
										};
									}, before.id);
									const request = pageRequests[requestCount]!;
									Object.assign(facts.prepend, {
										requestsAfter: pageRequests.length,
										inflightAfter: inflight.size,
										requestId: request.id,
										endRequestId: request.endId,
										pageMessages: request.messages,
										pageUserTurns: request.userTurns,
										afterTurns: await total(),
										windowAfter: await windowRange(),
									});
									expect(pageRequests.length).toBe(requestCount + 1);
									expect(request.endId).toBe(request.id);
									expect(facts.prepend.afterTurns - facts.prepend.beforeTurns).toBe(request.userTurns);
									facts.anchor = {
										beforeId: before.id,
										afterId: after.id,
										before: before.offset,
										after: after.offset,
									};
									return after.id;
								});
								await action("focus", async () =>
									(await older.evaluate((node) => document.activeElement === node)) ? "older" : "lost",
								);
								await allPages();
								await page.locator("[data-toc-tick]").first().click();
								await action("resize", async () => {
									await page.setViewportSize({ width: 1024, height: 700 });
									return String(await page.evaluate(() => innerWidth));
								});
								await action("theme", async () => {
									await page.getByRole("button", { name: /Switch theme|切换主题/ }).click();
									return page
										.locator("html")
										.evaluate((node) => (node.classList.contains("dark") ? "dark" : "light"));
								});
								const firstPrompt = `${PROMPT} [turn 1]`;
								await action("selection", async () =>
									window.getByText(firstPrompt, { exact: true }).evaluate((node) => {
										const range = document.createRange();
										range.selectNodeContents(node);
										const selected = globalThis.getSelection()!;
										selected.removeAllRanges();
										selected.addRange(range);
										return selected.toString();
									}),
								);
								await action("find", async () =>
									page.evaluate((text) => {
										globalThis.getSelection()?.removeAllRanges();
										const found = (
											globalThis as typeof globalThis & { find: (text: string) => boolean }
										).find(text);
										return found ? globalThis.getSelection()!.toString() : "missing";
									}, firstPrompt),
								);
								await action("copy", async () => {
									await window
										.locator("[data-turn-id]")
										.first()
										.getByRole("button", { name: /Copy message|复制消息/ })
										.click();
									return page.evaluate(() => navigator.clipboard.readText());
								});
								await page.setViewportSize({ width: 1920, height: 1080 });
								const other = page
									.locator("[data-session-row]")
									.filter({ hasText: "E2E_B_FAST" })
									.first()
									.getByRole("button")
									.first();
								await action("switch", async () => {
									await other.click();
									await page.locator("textarea").fill("mixed draft");
									return page.locator("textarea").inputValue();
								});
								const warm = stamp();
								await row.click();
								await expect(window).toHaveAttribute("data-turn-window-total", String(scenario.turns));
								await paint();
								facts.times.warm = stamp() - warm;
								await gc("warm");
								await other.click();
								await expect(page.locator("textarea")).toHaveValue("mixed draft");
								await gc("returned");
								await row.click();
								await action("reconnect", async () => {
									const previous = opened;
									// Close the actual upstream socket as well as the intercepted Browser side.
									await serverRoute!.close({ code: 4100, reason: "synthetic reconnect" });
									await route!.close({ code: 4100, reason: "synthetic reconnect" });
									await expect.poll(() => opened).toBeGreaterThan(previous);
									await expect(page.locator("textarea")).toBeEnabled();
									await allPages();
									return String(await total());
								});
								await action("extension", async () => {
									await page.locator("textarea").fill("E2E_EXTENSION_UI_BACKGROUND");
									await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
									const dialog = page.getByRole("dialog", { name: "Extension background checkpoint" });
									await expect(dialog).toBeVisible();
									await expect(page.getByText("E2E_SCOPED_WIDGET_LINE_1")).toBeVisible();
									await dialog.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
									await expect(dialog).toHaveCount(0);
									await expect(window).toContainText("E2E_EXTENSION_UI_SCOPED_CANCELLED");
									facts.liveTurns = await total();
									facts.liveMounted = await window.locator("[data-turn-id]").count();
									return "widget+dialog";
								});
								facts.getMessagesCount = harness
									.piEvents()
									.filter(
										(e) => e.sessionId === "browser-e2e-history" && e.commandType === "get_messages",
									).length;
							} catch (error) {
								facts.failure = error instanceof Error ? error.message : String(error);
							} finally {
								clearTimeout(deadline);
								await harness?.stop();
								harness = undefined;
							}
							facts.times.cycle = stamp() - started;
							browserErrorCount += errors.console.length + errors.page.length;
							const byName = (name: string) => {
								const a = facts.actions.find((a) => a.name === name);
								return a ? a.finished - a.started : 0;
							};
							return {
								metrics: {
									coldOpenMs: facts.times.cold,
									warmOpenMs: facts.times.warm,
									settlementMs: facts.times.settlement,
									cycleMs: facts.times.cycle,
									retainedHeapBytes: facts.gc.find((g) => g.name === "warm")?.heap ?? 0,
									heapDeltaBytes:
										(facts.gc.find((g) => g.name === "warm")?.heap ?? 0) -
										(facts.gc.find((g) => g.name === "baseline")?.heap ?? 0),
									mountedTurnNodes: facts.mounted,
									navigationMs: byName("oldest") + byName("middle") + byName("latest"),
									anchorErrorPx: Math.abs(facts.anchor.after - facts.anchor.before),
									sessionSwitchMs: byName("switch"),
									interactionMs: facts.actions.reduce((sum, a) => sum + a.finished - a.started, 0),
								},
								correctness: {
									mixedHistoryComplete: facts.failure === null,
									complete: facts.failure === null,
								},
								observation: createTrialObservation("history-mixed", errors, facts),
							};
						});
						if (facts.failure) break;
						if (cycle + 1 < scenario.warmups + scenario.samples) await context.close();
					}
					addValueGate(
						outcome,
						"correctnessFailures",
						correctnessFailureCount(outcome.trials),
						"eq",
						0,
						"hard",
						"Every declared mixed-history action and page must complete.",
					);
					addValueGate(
						outcome,
						"browserErrors",
						browserErrorCount,
						"eq",
						0,
						"hard",
						"Raw Browser errors are independently validated.",
					);
					outcome.notes.push(
						"Fixed mode order within each size: coalesced bounded/full; sequential full/bounded. All cycles retain the same action sequence.",
						"Cold = fresh Browser context and Gateway caches, not OS disk cache eviction. Warm = same retained Session store. GC checkpoints include retained Session cache; they are not unload/leak measurements.",
						"Find covers a revealed/mounted target only. Browser find cannot search off-window history. Extension UI is a live state added after native history measurements.",
					);
				},
			);
		} finally {
			await harness?.stop();
			await page?.context().close();
		}
	});
}
