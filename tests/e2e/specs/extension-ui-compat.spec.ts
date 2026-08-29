import type { Locator, Page, WebSocket } from "@playwright/test";
import {
	dropControlledWebSockets,
	installWebSocketDropControl,
	observePageErrors,
	pageOverflow,
} from "../fixtures/page-observation";
import type { PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const COMPAT_PROMPT = "E2E_EXTENSION_UI_COMPAT";
const CANCEL_PROMPT = "E2E_EXTENSION_CONFIRM";
const RELOAD_PROMPT = "E2E_EXTENSION_UI_RELOAD";
const BACKGROUND_PROMPT = "E2E_EXTENSION_UI_BACKGROUND";
const TIMEOUT_PROMPT = "E2E_EXTENSION_UI_TIMEOUT";

type ExtensionFixtureEvent = PiFixtureEvent & { method?: string; value?: string };

async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
}

async function sendPrompt(page: Page, message: string): Promise<void> {
	await page.locator("textarea").fill(message);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

function fixtureEvents(harness: ProductionHarness, type: string): ExtensionFixtureEvent[] {
	return harness.piEvents().filter((event) => event.type === type) as ExtensionFixtureEvent[];
}

function doubleClickWithoutWaiting(locator: Locator): Promise<void> {
	return locator.dblclick({ timeout: 10_000 });
}

test("browser renders the Pi Extension UI compatibility surface", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);
	await sendPrompt(page, COMPAT_PROMPT);

	await expect(page.getByText("E2E_NOTIFY_MESSAGE", { exact: true })).toBeVisible();
	const status = page.locator("main").getByText("compat-status", { exact: true }).locator("..");
	await expect(status).toContainText("E2E_STATUS_READY");
	const widget = page.locator("main").getByText("compat-widget", { exact: true }).locator("..");
	await expect(widget).toContainText("E2E_WIDGET_LINE_1");
	await expect(widget).toContainText("E2E_WIDGET_LINE_2");
	await expect(page).toHaveTitle("E2E_EXTENSION_TAB · Pi Agent Web");
	await expect(page.locator("textarea")).toHaveValue("E2E_SET_EDITOR_TEXT");

	const selectDialog = page.getByRole("dialog", { name: "Extension select" });
	await expect(selectDialog).toBeVisible();
	await expect(selectDialog.getByTestId("question-option-0")).toHaveClass(/bg-primary-soft/);
	await expect(selectDialog.getByRole("button", { name: /^(OK|确定)$/ })).toBeEnabled();
	await doubleClickWithoutWaiting(selectDialog.getByRole("button", { name: /^(OK|确定)$/ }));
	await expect(selectDialog).toBeHidden();

	const inputDialog = page.getByRole("dialog", { name: "Extension input" });
	await expect(inputDialog).toBeVisible();
	const input = inputDialog.locator("#ext-input");
	await expect(input).toBeFocused();
	await input.fill("E2E_INPUT_VALUE");
	await input.press("Enter");

	const editorDialog = page.getByRole("dialog", { name: "Extension editor" });
	await expect(editorDialog).toBeVisible();
	const editor = editorDialog.locator("textarea");
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("E2E_EDITOR_PREFILL");
	await editor.fill("E2E_EDITOR_VALUE");
	await editorDialog.getByRole("button", { name: /^(OK|确定)$/ }).click();

	await expect(
		page.locator("main").getByText("E2E_EXTENSION_UI_COMPAT_COMPLETE", { exact: true }),
	).toBeVisible();
	await expect(page.locator("header").getByText(/^(Ready|就绪)$/)).toBeVisible();
	await expect.poll(() => fixtureEvents(harness, "extension_response")).toHaveLength(3);
	await expect
		.poll(() => fixtureEvents(harness, "settled").find((event) => event.text === COMPAT_PROMPT))
		.toMatchObject({ label: "E2E_EXTENSION_UI_COMPAT_COMPLETE" });

	const responses = fixtureEvents(harness, "extension_response");
	expect(responses.map((event) => event.method)).toEqual(["select", "input", "editor"]);
	expect(responses.map((event) => event.value)).toEqual([
		"safe (Recommended)",
		"E2E_INPUT_VALUE",
		"E2E_EDITOR_VALUE",
	]);
	expect(fixtureEvents(harness, "extension_request").map((event) => event.method)).toEqual([
		"select",
		"input",
		"editor",
	]);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);

	const overflow = await pageOverflow(page);
	expect(overflow.htmlScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
		overflow.viewportWidth,
	);
});

test("browser sends one cancellation for a repeated cancel gesture", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);
	await sendPrompt(page, CANCEL_PROMPT);

	const dialog = page.getByRole("dialog", { name: "Synthetic approval" });
	await expect(dialog).toBeVisible();
	await doubleClickWithoutWaiting(dialog.getByRole("button", { name: /^(Cancel|取消)$/ }));
	await expect(dialog).toBeHidden();
	await expect(page.locator("main").getByText("E2E_EXTENSION_CANCELLED", { exact: true })).toBeVisible();
	await expect
		.poll(() => fixtureEvents(harness, "extension_response").filter((event) => event.text === CANCEL_PROMPT))
		.toHaveLength(1);
	await expect
		.poll(() => fixtureEvents(harness, "settled").find((event) => event.text === CANCEL_PROMPT))
		.toMatchObject({ label: "E2E_EXTENSION_CANCELLED" });
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("mobile keeps a blocking Extension UI dialog inside the viewport", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	await page.setViewportSize({ width: 375, height: 844 });
	await openWorkbench(page, harness);
	await sendPrompt(page, CANCEL_PROMPT);

	const dialog = page.getByRole("dialog", { name: "Synthetic approval" });
	await expect(dialog).toBeVisible();
	const box = await dialog.boundingBox();
	if (!box || box.x < 0 || box.x + box.width > 375 || box.y < 0 || box.y + box.height > 844) {
		throw new Error(`mobile Extension dialog escaped its viewport: ${JSON.stringify(box)}`);
	}
	await expect(dialog.getByRole("button", { name: /^(Cancel|取消)$/ })).toBeVisible();
	await dialog.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator("main").getByText("E2E_EXTENSION_CANCELLED", { exact: true })).toBeVisible();
	const overflow = await pageOverflow(page);
	expect(overflow.htmlScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
		overflow.viewportWidth,
	);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("browser closes and cancels an Extension UI request after its timeout", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);
	await sendPrompt(page, TIMEOUT_PROMPT);

	const dialog = page.getByRole("dialog", { name: "Extension timeout checkpoint" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(/(extension set a timeout|扩展设置了超时)/i);
	await expect(dialog).toBeHidden({ timeout: 5_000 });
	await expect(
		page.locator("main").getByText("E2E_EXTENSION_UI_SCOPED_CANCELLED", { exact: true }),
	).toBeVisible();
	await expect
		.poll(() => fixtureEvents(harness, "extension_response").filter((event) => event.text === TIMEOUT_PROMPT))
		.toMatchObject([{ cancelled: true }]);
	await expect
		.poll(() => fixtureEvents(harness, "settled").find((event) => event.text === TIMEOUT_PROMPT))
		.toMatchObject({ label: "E2E_EXTENSION_UI_SCOPED_CANCELLED" });
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("browser resync restores Extension UI and clears sticky state after cancellation", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	await installWebSocketDropControl(page);
	const sockets: WebSocket[] = [];
	page.on("websocket", (socket) => sockets.push(socket));
	await openWorkbench(page, harness);
	await sendPrompt(page, RELOAD_PROMPT);

	const dialog = page.getByRole("dialog", { name: "Extension reload checkpoint" });
	await expect(dialog).toBeVisible();
	await expect(page.getByText("E2E_NOTIFY_WARNING", { exact: true })).toBeVisible();
	await expect(page.getByText("E2E_NOTIFY_ERROR", { exact: true })).toBeVisible();
	await expect(page.locator("main").getByText("scoped-status", { exact: true })).toBeVisible();
	await expect(page.locator("main").getByText("scoped-widget", { exact: true })).toBeVisible();
	await expect(page).toHaveTitle("E2E_SCOPED_TAB · Pi Agent Web");
	await expect(page.locator("textarea")).toHaveValue("E2E_SCOPED_EDITOR_TEXT");

	await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(1);
	await dropControlledWebSockets(page);
	await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
	await expect(dialog).toBeVisible();
	await expect(page.locator("main").getByText("scoped-status", { exact: true })).toBeVisible();
	await expect(page.locator("textarea")).toHaveValue("E2E_SCOPED_EDITOR_TEXT");
	await expect(page.getByText("E2E_NOTIFY_WARNING", { exact: true })).toHaveCount(1);
	await expect(page.getByText("E2E_NOTIFY_ERROR", { exact: true })).toHaveCount(1);

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator("main")).toBeVisible();
	const knownSession = page.locator("[data-session-row]").filter({ hasText: RELOAD_PROMPT });
	await expect(knownSession).toHaveCount(1);
	if ((await knownSession.getAttribute("data-current")) !== "true")
		await knownSession.getByRole("button").first().click();
	await expect(page.getByRole("dialog", { name: "Extension reload checkpoint" })).toBeVisible();
	await expect(page.locator("main").getByText("scoped-widget", { exact: true })).toBeVisible();
	await expect(page.locator("textarea")).toHaveValue("E2E_SCOPED_EDITOR_TEXT");
	await expect(page.getByText("E2E_NOTIFY_WARNING", { exact: true })).toHaveCount(0);
	await expect(page.getByText("E2E_NOTIFY_ERROR", { exact: true })).toHaveCount(0);

	await page
		.getByRole("dialog", { name: "Extension reload checkpoint" })
		.getByRole("button", { name: /^(Cancel|取消)$/ })
		.click();
	await expect(page.getByRole("dialog", { name: "Extension reload checkpoint" })).toBeHidden();
	await expect(
		page.locator("main").getByText("E2E_EXTENSION_UI_SCOPED_CANCELLED", { exact: true }),
	).toBeVisible();
	await expect(page.locator("main").getByText("scoped-status", { exact: true })).toHaveCount(0);
	await expect(page.locator("main").getByText("scoped-widget", { exact: true })).toHaveCount(0);
	await expect(page.locator("textarea")).toHaveValue("");
	await expect(page).toHaveTitle(RELOAD_PROMPT);
	await expect
		.poll(() => fixtureEvents(harness, "extension_response").filter((event) => event.text === RELOAD_PROMPT))
		.toHaveLength(1);
	await expect
		.poll(() => fixtureEvents(harness, "settled").find((event) => event.text === RELOAD_PROMPT))
		.toMatchObject({ label: "E2E_EXTENSION_UI_SCOPED_CANCELLED" });
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("browser keeps Extension UI state isolated while another Session runs in the background", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);
	await sendPrompt(page, BACKGROUND_PROMPT);

	const backgroundSession = page.locator("[data-session-row]").filter({ hasText: BACKGROUND_PROMPT });
	const backgroundDialog = page.getByRole("dialog", { name: "Extension background checkpoint" });
	await expect(backgroundDialog).toBeVisible();
	await expect(backgroundSession).toHaveAttribute("data-current", "true");
	await backgroundDialog.getByRole("button", { name: /^(Minimize to dock|最小化到停靠栏)$/ }).click();
	const backgroundDock = page.getByTestId("chat-dock");
	await expect(backgroundDock).toBeVisible();
	await page
		.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();

	const foregroundSession = page.locator('[data-session-row][data-current="true"]');
	await expect(foregroundSession).not.toContainText(BACKGROUND_PROMPT);
	await expect(page.getByRole("dialog", { name: "Extension background checkpoint" })).toHaveCount(0);
	await expect(page.locator("main").getByText("scoped-status", { exact: true })).toHaveCount(0);
	await expect(page.locator("main").getByText("scoped-widget", { exact: true })).toHaveCount(0);
	await expect(page.locator("textarea")).toHaveValue("");
	await expect(page).not.toHaveTitle("E2E_SCOPED_TAB · Pi Agent Web");

	await sendPrompt(page, "E2E_BACKGROUND_REPLY");
	await expect(
		page.locator("main").getByText("E2E_REPLY:E2E_BACKGROUND_REPLY", { exact: true }),
	).toBeVisible();
	await backgroundSession.getByRole("button").first().click();
	await expect(backgroundDock).toBeVisible();
	await backgroundDock.getByRole("button", { name: /^(Expand dialog|展开对话框)$/ }).click();
	await expect(backgroundDialog).toBeVisible();
	await expect(page.locator("main").getByText("scoped-status", { exact: true })).toBeVisible();
	await expect(page.locator("main").getByText("scoped-widget", { exact: true })).toBeVisible();
	await expect(page.locator("textarea")).toHaveValue("E2E_SCOPED_EDITOR_TEXT");
	await expect(page).toHaveTitle("E2E_SCOPED_TAB · Pi Agent Web");

	await page
		.getByRole("dialog", { name: "Extension background checkpoint" })
		.getByRole("button", { name: /^(Cancel|取消)$/ })
		.click();
	await expect(page.getByText("E2E_EXTENSION_UI_SCOPED_CANCELLED", { exact: true })).toBeVisible();
	await expect(page.locator("main").getByText("scoped-status", { exact: true })).toHaveCount(0);
	await expect(page.locator("main").getByText("scoped-widget", { exact: true })).toHaveCount(0);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
