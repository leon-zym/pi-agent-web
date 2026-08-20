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
	const stressRow = page.locator("[data-session-row]").filter({ hasNotText: FOREGROUND_PROMPT });
	await expect(stressRow).toHaveCount(1);
	await stressRow.getByRole("button").first().click();
	await expect(page.locator("textarea")).toBeEnabled();
	await sendPrompt(page, STRESS_PROMPT);

	await expect
		.poll(() =>
			fixtureEvent(harness, (event) => event.type === "stress_checkpoint" && event.text === STRESS_PROMPT),
		)
		.toMatchObject({ toolCount: 26 });
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
			observer.page.getByText(/^(Another tab controls this Session|另一标签页正在控制此会话)/),
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
