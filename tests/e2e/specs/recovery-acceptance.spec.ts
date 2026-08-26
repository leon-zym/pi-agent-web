import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { observePageErrors, pageOverflow } from "../fixtures/page-observation";
import type { HarnessSession, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const HISTORICAL_PROMPT = "E2E historical request";
const HISTORICAL_REPLY = "E2E historical reply";
const INSPECT_PROMPT = "E2E_RECOVERY_INSPECT";
const FORK_CHILD_PROMPT = "E2E_FORK_CHILD";
const captureDirectory = process.env.PI_WEB_E2E_CAPTURE_DIR;

test.use({
	harnessOptions: {
		seedHistoricalSession: {
			userText: HISTORICAL_PROMPT,
			assistantText: HISTORICAL_REPLY,
		},
		extraEnv: {
			PI_WEB_E2E_DEFER_NEW_SESSION_FILE: "1",
			PI_WEB_E2E_EXISTING_STATE_DELAY_MS: "450",
			PI_WEB_E2E_RECOVERY_FEATURES: "1",
		},
	},
});

async function capture(page: Page, name: string): Promise<void> {
	if (!captureDirectory) return;
	fs.mkdirSync(captureDirectory, { recursive: true });
	await page.screenshot({
		path: path.join(captureDirectory, `${name}.png`),
		animations: "disabled",
		fullPage: false,
	});
}

async function listSessions(harness: ProductionHarness): Promise<HarnessSession[]> {
	const result = await harness.requestJson<{ sessions: HarnessSession[] }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions?refresh=1`,
	);
	return result.sessions;
}

function historicalRow(page: Page): Locator {
	return page.locator("[data-session-row]").filter({ hasText: HISTORICAL_PROMPT });
}

async function openFreshSurface(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
	await expect(
		page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ }),
	).toBeVisible();
	await expect(page.getByText(/^(Start your first turn|开始你的第一轮对话)$/)).toBeVisible();
	await expect(historicalRow(page)).toHaveAttribute("data-current", "false");
	await expect(page.locator("main")).not.toContainText(HISTORICAL_PROMPT);
	await expect(page.locator("main")).not.toContainText(HISTORICAL_REPLY);
}

async function openHistoricalWithoutEmptyFlash(page: Page): Promise<void> {
	const row = historicalRow(page);
	await row
		.getByRole("button")
		.first()
		.evaluate((button) => {
			const state = window as typeof window & {
				__piwebEmptyFlashSeen?: boolean;
				__piwebEmptyFlashObserver?: MutationObserver;
			};
			state.__piwebEmptyFlashSeen = false;
			let watching = false;
			button.addEventListener(
				"click",
				() => {
					watching = true;
				},
				{ capture: true, once: true },
			);
			state.__piwebEmptyFlashObserver?.disconnect();
			state.__piwebEmptyFlashObserver = new MutationObserver(() => {
				if (!watching) return;
				const text = document.body.innerText;
				if (text.includes("Start your first turn") || text.includes("开始你的第一轮对话")) {
					state.__piwebEmptyFlashSeen = true;
				}
			});
			state.__piwebEmptyFlashObserver.observe(document.body, { childList: true, subtree: true });
		});
	await row.getByRole("button").first().click();
	await expect(page.locator('[data-conversation-loading="true"]')).toBeVisible();
	await expect(page.getByText(/^(Start your first turn|开始你的第一轮对话)$/)).toBeHidden();
	await expect(page.locator("main").getByText(HISTORICAL_REPLY, { exact: true })).toBeVisible();
	const flashed = await page.evaluate(() => {
		const state = window as typeof window & {
			__piwebEmptyFlashSeen?: boolean;
			__piwebEmptyFlashObserver?: MutationObserver;
		};
		state.__piwebEmptyFlashObserver?.disconnect();
		return state.__piwebEmptyFlashSeen ?? false;
	});
	expect(flashed).toBe(false);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
	const overflow = await pageOverflow(page);
	const diagnostic = JSON.stringify(overflow, null, 2);
	expect(overflow.htmlScrollWidth, diagnostic).toBeLessThanOrEqual(overflow.viewportWidth);
	expect(overflow.bodyScrollWidth, diagnostic).toBeLessThanOrEqual(overflow.viewportWidth);
}

test("fresh boot and navigation never select or flash historical content", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	const secondaryPath = path.join(harness.rootDir, "secondary-workspace");
	fs.mkdirSync(secondaryPath, { recursive: true });
	await harness.requestJson("/api/v1/workspaces", {
		method: "POST",
		body: JSON.stringify({ path: secondaryPath, displayName: "Secondary E2E" }),
	});
	await harness.requestJson(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/activate`,
		{ method: "POST" },
	);

	await openFreshSurface(page, harness);
	await capture(page, "recovery-fresh-desktop");
	expect(await listSessions(harness)).toHaveLength(2);

	const activeTitle = page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ });
	const secondary = page.getByRole("button", { name: /Secondary E2E/ }).first();
	await expect(secondary).toHaveAttribute("aria-expanded", "false");
	await secondary.click();
	await expect(secondary).toHaveAttribute("aria-expanded", "true");
	await expect(activeTitle).toBeVisible();
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
	await secondary.click();
	await expect(secondary).toHaveAttribute("aria-expanded", "false");
	await expect(activeTitle).toBeVisible();

	await openHistoricalWithoutEmptyFlash(page);
	await expect
		.poll(async () => (await listSessions(harness)).map((session) => session.sessionHandle))
		.toEqual([harness.session.sessionHandle]);

	let releaseCreate!: () => void;
	let createIntercepted!: () => void;
	const createGate = new Promise<void>((resolve) => {
		releaseCreate = resolve;
	});
	const intercepted = new Promise<void>((resolve) => {
		createIntercepted = resolve;
	});
	await page.route("**/api/v1/workspaces/*/sessions", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		createIntercepted();
		await createGate;
		await route.continue();
	});
	await page
		.locator("nav")
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();
	await intercepted;
	await expect(page.locator('[data-conversation-loading="true"]')).toBeVisible();
	await expect(page.locator("main")).not.toContainText(HISTORICAL_PROMPT);
	await expect(page.locator("main")).not.toContainText(HISTORICAL_REPLY);
	releaseCreate();
	await expect(
		page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ }),
	).toBeVisible();
	await expect(page.getByText(/^(Start your first turn|开始你的第一轮对话)$/)).toBeVisible();
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
	await historicalRow(page).getByRole("button").first().click();
	await expect(page.locator("main").getByText(HISTORICAL_REPLY, { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await listSessions(harness)).map((session) => session.sessionHandle))
		.toEqual([harness.session.sessionHandle]);

	await page
		.locator("nav")
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();
	await expect(
		page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ }),
	).toBeVisible();
	await page.locator("textarea").fill("E2E retained local draft");
	await historicalRow(page).getByRole("button").first().click();
	await expect(page.locator("main").getByText(HISTORICAL_REPLY, { exact: true })).toBeVisible();
	await page
		.locator("nav")
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();
	await expect(page.locator("textarea")).toHaveValue("E2E retained local draft");
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);

	await expectNoPageOverflow(page);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("export, Bash, Inspect, Events, and the conversation tree expose complete structured data", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: harness.origin,
	});
	await openFreshSurface(page, harness);

	await page.locator("textarea").fill(INSPECT_PROMPT);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect(page.locator("main").getByText("E2E_INSPECT_COMPLETE", { exact: true })).toBeVisible();
	const inspectParentRow = page.locator("[data-session-row]").filter({ hasText: INSPECT_PROMPT });
	await expect(inspectParentRow).toHaveCount(1);
	await expect(inspectParentRow).toHaveAttribute("data-current", "true");

	const bashRow = page
		.locator("main")
		.getByRole("button", { name: /bash.*E2E_BASH_COMMAND/i })
		.first();
	await bashRow.click();
	const commandSection = page.getByRole("region", { name: /^(Command|命令)$/ });
	const outputSection = page.getByRole("region", { name: /^(Output|输出)$/ }).first();
	await expect(commandSection).toContainText("printf 'E2E_BASH_COMMAND' && pwd");
	await expect(outputSection).toContainText("E2E_BASH_OUTPUT");
	await expect(commandSection.locator("code.hljs")).toBeVisible();

	await page.getByRole("button", { name: /^(Open in details panel|在详情面板中查看)$/ }).click();
	const argumentCode = page.locator("pre code.language-json").filter({ hasText: "E2E_MODE" }).first();
	await expect(argumentCode).toBeVisible();
	expect(await argumentCode.innerText()).toContain("\n");
	await expect(argumentCode.locator(".hljs-attr").first()).toBeVisible();
	await expect(page.getByText("E2E_BASH_OUTPUT", { exact: false }).last()).toBeVisible();
	await capture(page, "recovery-inspector-desktop");

	await page.getByRole("button", { name: /^(Events|事件)$/ }).click();
	const eventRow = page.getByRole("button", { name: /tool_execution_start/ }).first();
	await eventRow.click();
	const eventPayload = page.locator("[data-event-payload]").first();
	await expect(eventPayload).toContainText("E2E_BASH_COMMAND");
	await expect(eventPayload.locator("code.language-json .hljs-attr").first()).toBeVisible();
	expect(await eventPayload.locator("code").innerText()).toContain("\n");

	await page
		.getByRole("button", { name: /^(Conversation tree|对话树)$/ })
		.last()
		.click();
	await expect(
		page.getByText(/History branches inside this Session|当前 Session 内部的历史分支/),
	).toBeVisible();
	await expect(page.getByText("Root request", { exact: true })).toBeVisible();
	await expect(page.getByText("Earlier alternative", { exact: true })).toBeVisible();
	await expect(page.getByText("Current active reply", { exact: true })).toBeVisible();
	await expect(page.getByText(/^(Current|当前)$/)).toHaveCount(1);
	await expect(page.locator('[data-active-path="true"]')).toHaveCount(2);

	await page.getByRole("button", { name: /^(More session actions|更多会话操作)$/ }).click();
	await page.getByRole("menuitem", { name: /^(Export HTML|导出 HTML)$/ }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^file:\/\//);
	const exportedUrl = await page.evaluate(() => navigator.clipboard.readText());
	expect(new URL(exportedUrl).protocol).toBe("file:");
	expect(decodeURIComponent(exportedUrl)).toMatch(/会话 #[^/]+\.html$/);

	await page
		.getByRole("button", { name: /^(Fork|分叉)$/ })
		.last()
		.click();
	await expect(page.getByText(/Forked a new session|已从该消息分叉出新会话/)).toBeVisible();
	await expect(page.getByText(/^(Fork failed|分叉失败)$/)).toHaveCount(0);
	await expect(page.locator("textarea")).toBeEnabled();
	const inspectDormantParentRow = page
		.locator('[data-session-row][data-current="false"]')
		.filter({ hasText: INSPECT_PROMPT });
	await expect(inspectDormantParentRow).toHaveCount(1);
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);

	await page.locator("textarea").fill(FORK_CHILD_PROMPT);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect(
		page.locator("main").getByText(`E2E_REPLY:${FORK_CHILD_PROMPT}`, { exact: true }),
	).toBeVisible();
	const forkChildRow = page.locator("[data-session-row]").filter({ hasText: FORK_CHILD_PROMPT });
	await expect(forkChildRow).toHaveCount(1);
	await expect(forkChildRow).toHaveAttribute("data-current", "true");
	await expect(inspectDormantParentRow).toHaveCount(1);
	await expect
		.poll(async () => (await listSessions(harness)).filter((session) => session.messageCount > 0).length)
		.toBe(3);

	await expectNoPageOverflow(page);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("slash tokens, model navigation, context ring, and collapsed logo remain keyboard-safe", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	await openFreshSurface(page, harness);

	const context = page.getByTestId("context-meter");
	await expect(context).toHaveAttribute("role", "progressbar");
	await expect(context).toHaveAttribute("aria-valuenow", "34");
	expect(await context.evaluate((element) => element.tagName)).toBe("SPAN");
	expect(await context.locator("svg circle").count()).toBe(2);
	expect(await context.locator("xpath=ancestor::button").count()).toBe(0);
	await expect(page.locator("nav [role='status']")).toHaveCount(0);
	await expect(page.locator("header").getByText(/^(Ready|就绪)$/)).toHaveCount(1);

	const modelTrigger = page.getByRole("button", {
		name: /^(Model and thinking level|模型与思考级别)$/,
	});
	await modelTrigger.click();
	const popover = page.locator('[data-slot="popover-content"]');
	await popover.getByRole("button", { name: /^(Model|模型) / }).click();
	const back = popover.getByRole("button", { name: /^(Back|返回)$/ });
	await expect(back).toBeVisible();
	await back.evaluate(
		(_element) =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);
	const backBefore = await back.boundingBox();
	const modelScroller = popover.locator(".scroll-slim").first();
	await modelScroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
		element.dispatchEvent(new Event("scroll"));
	});
	const backAfter = await back.boundingBox();
	expect(backBefore).not.toBeNull();
	expect(backAfter).not.toBeNull();
	expect(Math.abs((backAfter?.y ?? 0) - (backBefore?.y ?? 0))).toBeLessThanOrEqual(1);
	await popover.getByRole("button", { name: "Deterministic Model 24" }).click();
	await expect(popover).toBeVisible();
	await expect(popover.getByRole("button", { name: /^(Model|模型) Deterministic Model 24$/ })).toBeVisible();
	await popover.getByRole("button", { name: /^(Thinking level|思考级别) / }).click();
	await popover.getByRole("button", { name: /^(High|高)$/ }).click();
	await expect(popover).toBeVisible();
	await expect(popover.getByRole("button", { name: /^(Thinking level High|思考级别 高)$/ })).toBeVisible();
	await page.keyboard.press("Escape");

	const textarea = page.locator("textarea");
	await textarea.fill("/e2");
	await expect(page.getByRole("listbox", { name: /^(Command menu|命令菜单)$/ })).toBeVisible();
	await textarea.press("Tab");
	const removeCommand = page.getByRole("button", {
		name: /^(Remove command \/e2e|移除命令 \/e2e)$/,
	});
	await expect(removeCommand).toBeVisible();
	await expect(page.getByRole("listbox", { name: /^(Command menu|命令菜单)$/ })).toBeHidden();
	await expect(textarea).toHaveValue("");
	await textarea.press("Backspace");
	await expect(removeCommand).toBeHidden();

	await textarea.fill("/e2");
	await textarea.press("Enter");
	await expect(removeCommand).toBeVisible();
	await textarea.fill("atomic argument");
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	const main = page.locator("main");
	await expect(main.getByText("/skill:e2e", { exact: true })).toBeVisible();
	await expect(main.getByText("atomic argument", { exact: true })).toBeVisible();
	await expect(main).not.toContainText("SECRET_SKILL_BODY_MUST_NOT_RENDER");
	await expect(main.getByText("E2E_REPLY:/skill:e2e atomic argument", { exact: true })).toBeVisible();
	await expect(textarea).toBeEnabled();
	await expect(page.locator("header")).not.toContainText("SECRET_SKILL_BODY_MUST_NOT_RENDER");
	const sidebar = page.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ });
	await expect(sidebar).not.toContainText("SECRET_SKILL_BODY_MUST_NOT_RENDER");

	const expandedLogo = sidebar.locator(":scope > div").first().locator(":scope > div").first();
	const expandedBox = await expandedLogo.boundingBox();
	await page.getByRole("button", { name: /^(Collapse sidebar|收起侧栏)$/ }).click();
	const railLogo = page.getByRole("button", { name: /^(Expand sidebar|展开侧栏)$/ });
	const railBox = await railLogo.boundingBox();
	expect(expandedBox).not.toBeNull();
	expect(railBox).not.toBeNull();
	expect(railBox?.width).toBe(expandedBox?.width);
	expect(railBox?.height).toBe(expandedBox?.height);
	expect(Math.abs((railBox?.x ?? 0) - (expandedBox?.x ?? 0))).toBeLessThanOrEqual(1);
	expect(Math.abs((railBox?.y ?? 0) - (expandedBox?.y ?? 0))).toBeLessThanOrEqual(1);
	const logoIcons = railLogo.locator("svg");
	await expect(logoIcons).toHaveCount(2);
	await railLogo.hover();
	await expect
		.poll(() => logoIcons.first().evaluate((element) => getComputedStyle(element).opacity))
		.toBe("0");
	await expect
		.poll(() => logoIcons.last().evaluate((element) => getComputedStyle(element).opacity))
		.toBe("1");
	await railLogo.click();
	await expect(page.getByRole("button", { name: /^(Collapse sidebar|收起侧栏)$/ })).toBeVisible();

	await page.setViewportSize({ width: 375, height: 812 });
	await expectNoPageOverflow(page);
	await capture(page, "recovery-acceptance-375");
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
