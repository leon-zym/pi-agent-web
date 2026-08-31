import type { Browser, BrowserContext, Page, WebSocket } from "@playwright/test";
import {
	dropControlledWebSockets,
	installWebSocketDropControl,
	observePageErrors,
	pageOverflow,
} from "../fixtures/page-observation";
import type { PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const STRESS_PROMPT = "E2E_STRESS_TRAJECTORY";
const FOREGROUND_PROMPT = "E2E_STRESS_FOREGROUND";
const OBSERVER_PROMPT = "E2E_A_SLOW_OBSERVER";
const RECONNECT_PROMPT = "E2E_A_SLOW_RECONNECT";
const EXTENSION_PROMPT = "E2E_EXTENSION_CONFIRM";
const RELOAD_PROMPT = "E2E_RELOAD_ACTIVE_STATE";
const RELOAD_PARTIAL_TEXT = "E2E_RELOAD_PARTIAL_TEXT";
const RELOAD_TOOL_PARTIAL = "E2E_RELOAD_TOOL_PARTIAL";
const RELOAD_TOOL_COMPLETE = "E2E_RELOAD_TOOL_COMPLETE";

async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
}

async function sendPrompt(page: Page, message: string): Promise<void> {
	await page.locator("textarea").fill(message);
	const send = page.getByRole("button", { name: /^(Send|发送)$/ });
	await expect(send).toBeEnabled();
	await send.click({ timeout: 10_000 });
}

function fixtureEvent(
	harness: ProductionHarness,
	predicate: (event: PiFixtureEvent) => boolean,
): PiFixtureEvent | undefined {
	return harness.piEvents().find(predicate);
}

function promptEvents(harness: ProductionHarness, text: string): PiFixtureEvent[] {
	return harness.piEvents().filter((event) => event.type === "prompt" && event.text === text);
}

async function closeContexts(...contexts: BrowserContext[]): Promise<void> {
	await Promise.all(contexts.map(async (context) => context.close()));
}

async function isolatedPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext();
	return { context, page: await context.newPage() };
}

test("a 52-tool trajectory and 64 KiB settled response survive background navigation", async ({
	page,
	harness,
}) => {
	test.slow();
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);
	await expect(page.locator("textarea")).toBeEnabled();
	await sendPrompt(page, FOREGROUND_PROMPT);
	const main = page.locator("main");
	await expect(main.getByText(`E2E_REPLY:${FOREGROUND_PROMPT}`, { exact: true })).toBeVisible();
	const foregroundRow = page.locator("[data-session-row]").filter({ hasText: FOREGROUND_PROMPT });
	await page
		.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();
	const freshCurrent = page.locator('[data-session-row][data-current="true"]');
	await expect(freshCurrent).toHaveCount(1);
	await expect(foregroundRow).toHaveAttribute("data-current", "false");
	await expect(freshCurrent).not.toContainText(FOREGROUND_PROMPT);
	await expect(
		page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ }),
	).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	await sendPrompt(page, STRESS_PROMPT);

	await expect
		.poll(() =>
			fixtureEvent(harness, (event) => event.type === "stress_checkpoint" && event.text === STRESS_PROMPT),
		)
		.toMatchObject({ toolCount: 26 });
	const stressRow = page.locator("[data-session-row]").filter({ hasText: STRESS_PROMPT });
	await expect(stressRow).toHaveCount(1);
	await expect(stressRow).toHaveAttribute("data-current", "true");
	await expect(foregroundRow).toHaveAttribute("data-current", "false");
	const toolRows = main.locator('button[aria-expanded="false"]').filter({ hasText: "synthetic-tool-" });
	await expect(toolRows).toHaveCount(26);
	await foregroundRow.getByRole("button").first().click();
	await expect(main.getByText(`E2E_REPLY:${FOREGROUND_PROMPT}`, { exact: true })).toBeVisible();

	harness.releasePrompt(STRESS_PROMPT);
	await expect
		.poll(() => fixtureEvent(harness, (event) => event.type === "settled" && event.text === STRESS_PROMPT))
		.toMatchObject({
			label: "stress-trajectory",
			toolCount: 52,
			markdownChars: expect.any(Number),
		});
	const settledEvent = fixtureEvent(
		harness,
		(event) => event.type === "settled" && event.text === STRESS_PROMPT,
	);
	expect(settledEvent?.markdownChars).toBeGreaterThanOrEqual(64 * 1024);

	await expect(stressRow).toHaveAttribute("data-unread", "true");
	await stressRow.getByRole("button").first().click();
	await expect(main.getByRole("heading", { name: "Synthetic stress trajectory", level: 2 })).toBeVisible();
	await expect(main.locator("button[aria-expanded]").filter({ hasText: "synthetic-tool-" })).toHaveCount(52);
	await expect(main.locator("table")).toContainText("52 mixed calls");
	await expect(main.locator("pre code")).toContainText("synthetic_line_0000");
	await expect(main.locator("pre code")).toContainText("STRESS_CODE_END");

	const firstTool = main.locator("button[aria-expanded]").filter({ hasText: "synthetic-tool-" }).first();
	await firstTool.click();
	await expect(firstTool).toHaveAttribute("aria-expanded", "true");
	await expect(firstTool.locator("xpath=../following-sibling::div")).toContainText(
		"src/synthetic-tool-000.ts",
	);
	const lastTool = main.locator("button[aria-expanded]").filter({ hasText: "synthetic-tool-" }).last();
	await lastTool.scrollIntoViewIfNeeded();
	await lastTool.click();
	await expect(lastTool).toHaveAttribute("aria-expanded", "true");
	await expect(main.getByRole("region", { name: /^(File changes|文件变更)$/ }).last()).toBeVisible();

	const viewport = page.locator('[data-chat-viewport="true"]');
	const savedScrollTop = await viewport.evaluate((element) => {
		const target = Math.min(1_200, Math.max(0, element.scrollHeight - element.clientHeight - 200));
		element.scrollTo({ top: target, behavior: "auto" });
		element.dispatchEvent(new Event("scroll"));
		return Math.round(element.scrollTop);
	});
	expect(savedScrollTop).toBeGreaterThan(0);
	await foregroundRow.getByRole("button").first().click();
	await expect(main.getByText(`E2E_REPLY:${FOREGROUND_PROMPT}`, { exact: true })).toBeVisible();
	await stressRow.getByRole("button").first().click();
	await expect(main.getByRole("heading", { name: "Synthetic stress trajectory", level: 2 })).toBeVisible();
	await expect
		.poll(async () =>
			Math.abs((await viewport.evaluate((element) => Math.round(element.scrollTop))) - savedScrollTop),
		)
		.toBeLessThanOrEqual(2);

	const overflow = await pageOverflow(page);
	expect(overflow.htmlScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
		overflow.viewportWidth,
	);
	expect(overflow.bodyScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
		overflow.viewportWidth,
	);
	const chatOverflow = await viewport.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(chatOverflow.scrollWidth).toBeLessThanOrEqual(chatOverflow.clientWidth);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("a second BrowserContext observes one Session without acquiring mutation control", async ({
	browser,
	harness,
}) => {
	const owner = await isolatedPage(browser);
	const observer = await isolatedPage(browser);
	const ownerErrors = observePageErrors(owner.page);
	const observerErrors = observePageErrors(observer.page);
	try {
		await openWorkbench(owner.page, harness);
		await sendPrompt(owner.page, OBSERVER_PROMPT);
		await expect
			.poll(() =>
				Boolean(fixtureEvent(harness, (event) => event.type === "delta" && event.text === OBSERVER_PROMPT)),
			)
			.toBe(true);

		await observer.page.goto(harness.origin, { waitUntil: "domcontentloaded" });
		await expect(observer.page.locator("main")).toBeVisible();
		const ownerRow = observer.page.locator("[data-session-row]").filter({ hasText: OBSERVER_PROMPT });
		await expect(ownerRow).toBeVisible();
		await ownerRow.getByRole("button").first().click();
		const observerTurn = observer.page.getByRole("region", { name: /^(Conversation turn|对话轮次)$/ });
		await expect(observerTurn.getByText(OBSERVER_PROMPT, { exact: true })).toBeVisible();
		await expect(observer.page.locator("header").getByText(/^(Running|运行中)$/)).toBeVisible();
		await expect(observer.page.locator("textarea")).toBeDisabled();
		await expect(observer.page.locator("textarea")).toHaveAttribute(
			"placeholder",
			/^(Read-only in this tab|当前标签页为只读模式)$/,
		);
		await expect(
			observer.page
				.getByTestId("composer-session-control")
				.getByText(/(Another page controls this Session|另一个页面正在控制此 Session)/),
		).toBeVisible();
		await expect(
			observer.page
				.getByTestId("composer-session-control")
				.getByRole("button", { name: /^(Take over Session|接管 Session)$/ }),
		).toBeVisible();
		await expect(observer.page.getByRole("button", { name: /^(Steer send|插队发送)$/ })).toBeDisabled();

		harness.releasePrompt(OBSERVER_PROMPT);
		const reply = `E2E_REPLY:${OBSERVER_PROMPT}`;
		await expect(
			owner.page.getByRole("region", { name: /^(Conversation turn|对话轮次)$/ }).getByText(reply, {
				exact: true,
			}),
		).toBeVisible();
		await expect(observerTurn.getByText(reply, { exact: true })).toBeVisible();
		await expect(owner.page.locator("textarea")).toBeEnabled();
		await expect(observer.page.locator("textarea")).toBeDisabled();
		expect(promptEvents(harness, OBSERVER_PROMPT)).toHaveLength(1);
		expect(ownerErrors.console).toEqual([]);
		expect(ownerErrors.page).toEqual([]);
		expect(observerErrors.console).toEqual([]);
		expect(observerErrors.page).toEqual([]);
	} finally {
		await closeContexts(owner.context, observer.context);
	}
});

test("an interrupted socket resyncs a completed stream without duplicates or missing frames", async ({
	page,
	harness,
}) => {
	test.slow();
	const errors = observePageErrors(page);
	await installWebSocketDropControl(page);
	const sockets: WebSocket[] = [];
	let closedSocketCount = 0;
	page.on("websocket", (socket) => {
		sockets.push(socket);
		socket.on("close", () => {
			closedSocketCount += 1;
		});
	});
	await openWorkbench(page, harness);
	await sendPrompt(page, RECONNECT_PROMPT);
	await expect
		.poll(() =>
			Boolean(fixtureEvent(harness, (event) => event.type === "delta" && event.text === RECONNECT_PROMPT)),
		)
		.toBe(true);

	await dropControlledWebSockets(page);
	await expect.poll(() => closedSocketCount).toBeGreaterThanOrEqual(1);
	await expect(page.locator("textarea")).toBeDisabled();
	const turn = page.getByRole("region", { name: /^(Conversation turn|对话轮次)$/ });
	await expect(turn.getByText(RECONNECT_PROMPT, { exact: true })).toHaveCount(1);
	harness.releasePrompt(RECONNECT_PROMPT);
	await expect
		.poll(() =>
			Boolean(fixtureEvent(harness, (event) => event.type === "settled" && event.text === RECONNECT_PROMPT)),
		)
		.toBe(true);

	await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
	await expect(page.locator("textarea")).toBeEnabled();
	await expect(turn.getByText(RECONNECT_PROMPT, { exact: true })).toHaveCount(1);
	await expect(turn.getByText(`E2E_REPLY:${RECONNECT_PROMPT}`, { exact: true })).toHaveCount(1);
	expect(promptEvents(harness, RECONNECT_PROMPT)).toHaveLength(1);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("reload restores one known Session across active text and tool checkpoints", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);
	await sendPrompt(page, RELOAD_PROMPT);
	await expect
		.poll(() =>
			fixtureEvent(
				harness,
				(event) => event.type === "reload_text_checkpoint" && event.text === RELOAD_PROMPT,
			),
		)
		.toBeTruthy();

	const main = page.locator("main");
	await expect(main.getByText(RELOAD_PARTIAL_TEXT, { exact: true })).toHaveCount(1);
	await expect(
		main.locator('[data-markdown-streaming="true"]').filter({ hasText: RELOAD_PARTIAL_TEXT }),
	).toHaveCount(1);
	await expect(page.locator("header").getByText(/^(Running|运行中)$/)).toBeVisible();
	await expect(main.locator("button[aria-expanded]").filter({ hasText: "E2E_RELOAD_TOOL" })).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "Reload checkpoint approval" })).toHaveCount(0);
	await expect(main.getByText("E2E_RELOAD_SETTLED", { exact: true })).toHaveCount(0);
	expect(
		fixtureEvent(harness, (event) => event.type === "settled" && event.text === RELOAD_PROMPT),
	).toBeUndefined();

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator("main")).toBeVisible();
	let knownSession = page.locator("[data-session-row]").filter({ hasText: RELOAD_PROMPT });
	await expect(knownSession).toHaveCount(1);
	if ((await knownSession.getAttribute("data-current")) !== "true") {
		await knownSession.getByRole("button").first().click();
	}
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
	await expect(knownSession).toHaveAttribute("data-current", "true");

	let restoredMain = page.locator("main");
	await expect(restoredMain.getByText(RELOAD_PARTIAL_TEXT, { exact: true })).toHaveCount(1);
	await expect(
		restoredMain.locator('[data-markdown-streaming="true"]').filter({ hasText: RELOAD_PARTIAL_TEXT }),
	).toHaveCount(1);
	await expect(page.locator("header").getByText(/^(Running|运行中)$/)).toBeVisible();
	await expect(
		restoredMain.locator("button[aria-expanded]").filter({ hasText: "E2E_RELOAD_TOOL" }),
	).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "Reload checkpoint approval" })).toHaveCount(0);
	await expect(restoredMain.getByText("E2E_RELOAD_SETTLED", { exact: true })).toHaveCount(0);

	harness.releasePrompt(RELOAD_PROMPT);
	await expect
		.poll(() =>
			fixtureEvent(
				harness,
				(event) => event.type === "reload_tool_checkpoint" && event.text === RELOAD_PROMPT,
			),
		)
		.toBeTruthy();

	const checkpointTool = restoredMain.locator("button[aria-expanded]").filter({ hasText: "E2E_RELOAD_TOOL" });
	await expect(checkpointTool).toHaveCount(1);
	await expect(checkpointTool).toContainText(/(Executing|执行中)/);
	let checkpointDialog = page.getByRole("dialog", { name: "Reload checkpoint approval" });
	await expect(checkpointDialog).toHaveCount(1);
	await checkpointDialog.getByRole("button", { name: /^(Minimize to dock|最小化到停靠栏)$/ }).click();
	const checkpointDock = page.getByTestId("chat-dock");
	await expect(checkpointDock).toHaveCount(1);
	await checkpointTool.click();
	await expect(checkpointTool.locator("xpath=../following-sibling::div")).toContainText(RELOAD_TOOL_PARTIAL);
	await checkpointTool.click();
	await checkpointDock.getByRole("button", { name: /^(Expand dialog|展开对话框)$/ }).click();
	checkpointDialog = page.getByRole("dialog", { name: "Reload checkpoint approval" });
	await expect(checkpointDialog).toHaveCount(1);

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator("main")).toBeVisible();
	knownSession = page.locator("[data-session-row]").filter({ hasText: RELOAD_PROMPT });
	await expect(knownSession).toHaveCount(1);
	if ((await knownSession.getAttribute("data-current")) !== "true") {
		await knownSession.getByRole("button").first().click();
	}
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
	await expect(knownSession).toHaveAttribute("data-current", "true");

	restoredMain = page.locator("main");
	await expect(restoredMain.getByText(RELOAD_PARTIAL_TEXT, { exact: true })).toHaveCount(1);
	let restoredDialog = page.getByRole("dialog", { name: "Reload checkpoint approval" });
	await expect(restoredDialog).toHaveCount(1);
	await restoredDialog.getByRole("button", { name: /^(Minimize to dock|最小化到停靠栏)$/ }).click();
	const restoredDock = page.getByTestId("chat-dock");
	await expect(restoredDock).toHaveCount(1);

	const runningTool = restoredMain.locator("button[aria-expanded]").filter({ hasText: "E2E_RELOAD_TOOL" });
	await expect(runningTool).toHaveCount(1);
	await runningTool.click();
	await expect
		.soft(runningTool.locator("xpath=../following-sibling::div"))
		.toContainText(RELOAD_TOOL_PARTIAL, { timeout: 3_000 });
	await expect.soft(runningTool).toContainText(/(Executing|执行中)/, { timeout: 3_000 });
	await expect.soft(runningTool).not.toContainText(/(Interrupted|已中断)/, { timeout: 3_000 });
	expect(
		fixtureEvent(harness, (event) => event.type === "settled" && event.text === RELOAD_PROMPT),
	).toBeUndefined();
	await expect(restoredMain.getByText("E2E_RELOAD_SETTLED", { exact: true })).toHaveCount(0);

	await restoredDock.getByRole("button", { name: /^(Expand dialog|展开对话框)$/ }).click();
	restoredDialog = page.getByRole("dialog", { name: "Reload checkpoint approval" });
	await expect(restoredDialog).toHaveCount(1);
	const confirm = restoredDialog.locator("button").filter({ hasText: /^(Confirm|确认)$/ });
	await expect(confirm).toBeEnabled();
	await confirm.click();
	await expect(restoredDialog).toBeHidden();
	await expect
		.poll(() =>
			fixtureEvent(harness, (event) => event.type === "extension_response" && event.text === RELOAD_PROMPT),
		)
		.toMatchObject({ confirmed: true });
	harness.releasePrompt(RELOAD_PROMPT);
	await expect
		.poll(() => fixtureEvent(harness, (event) => event.type === "settled" && event.text === RELOAD_PROMPT))
		.toMatchObject({ label: "E2E_RELOAD_SETTLED" });
	await expect(restoredMain.getByText("E2E_RELOAD_SETTLED", { exact: true })).toHaveCount(1);
	await expect
		.soft(runningTool.locator("xpath=../following-sibling::div"))
		.toContainText(RELOAD_TOOL_COMPLETE, { timeout: 3_000 });
	await expect
		.soft(runningTool)
		.not.toContainText(/(Executing|执行中|Interrupted|已中断)/, { timeout: 3_000 });
	const lifecycleEvents = harness.piEvents().filter((event) => event.text === RELOAD_PROMPT);
	for (const eventType of ["extension_response", "reload_text_released", "reload_tool_released"] as const) {
		expect(
			lifecycleEvents.filter((event) => event.type === eventType),
			eventType,
		).toHaveLength(1);
	}
	const orderedTypes = [
		"reload_text_released",
		"reload_tool_checkpoint",
		"extension_response",
		"reload_tool_released",
		"settled",
	] as const;
	const orderedIndexes = orderedTypes.map((eventType) =>
		lifecycleEvents.findIndex((event) => event.type === eventType),
	);
	for (let index = 1; index < orderedIndexes.length; index += 1) {
		expect(
			orderedIndexes[index - 1],
			`${orderedTypes[index - 1]} before ${orderedTypes[index]}`,
		).toBeLessThan(orderedIndexes[index] ?? -1);
	}
	expect(promptEvents(harness, RELOAD_PROMPT)).toHaveLength(1);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("a blocking Extension UI confirmation enters waiting_ui and resumes only after response", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);
	await sendPrompt(page, EXTENSION_PROMPT);

	const dialog = page.getByRole("dialog", { name: "Synthetic approval" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Continue the synthetic run?");
	await expect(page.locator("header").getByText(/^(Waiting for input|等待输入)$/)).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	await dialog.getByRole("button", { name: /^(Confirm|确认)$/ }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator("main").getByText("E2E_EXTENSION_CONFIRMED", { exact: true })).toBeVisible();
	await expect(page.locator("header").getByText(/^(Ready|就绪)$/)).toBeVisible();
	await expect
		.poll(() =>
			fixtureEvent(
				harness,
				(event) => event.type === "extension_response" && event.text === EXTENSION_PROMPT,
			),
		)
		.toMatchObject({ confirmed: true });
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
