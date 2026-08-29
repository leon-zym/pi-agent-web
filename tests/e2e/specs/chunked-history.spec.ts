import { observePageErrors } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

const HISTORY_TURNS = 110;
const INITIAL_TURNS = 48;
const HISTORY_PROMPT = "E2E_CHUNKED_HISTORY_PROMPT";
const HISTORY_REPLY = `E2E_CHUNKED_HISTORY_REPLY ${"x".repeat(600 * 1024)}`;

test.use({
	harnessOptions: {
		seedHistoricalSession: {
			userText: HISTORY_PROMPT,
			assistantText: HISTORY_REPLY,
			turnCount: HISTORY_TURNS,
		},
	},
});

test("loads an oversized native history in bounded chunks and pages older turns", async ({
	page,
	harness,
}) => {
	test.slow();
	const errors = observePageErrors(page);
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	await page
		.locator("[data-session-row]")
		.filter({ hasText: HISTORY_PROMPT })
		.getByRole("button")
		.first()
		.click();

	const viewport = page.locator('[data-chat-viewport="true"]');
	const turnWindow = viewport.locator('[data-turn-window="true"]');
	await expect(turnWindow).toHaveAttribute("data-turn-window-total", String(INITIAL_TURNS), {
		timeout: 30_000,
	});
	const latestTurn = turnWindow.locator("[data-turn-id]").last();
	await expect(latestTurn).toContainText("E2E_CHUNKED_HISTORY_REPLY", { timeout: 30_000 });
	await expect(turnWindow.locator('[data-load-older-turns="true"]')).toBeVisible({ timeout: 30_000 });

	const getMessages = harness
		.piEvents()
		.filter((event) => event.sessionId === "browser-e2e-history" && event.commandType === "get_messages");
	expect(getMessages).toEqual([]);

	await turnWindow.locator('[data-load-older-turns="true"]').click();
	await expect(turnWindow).toHaveAttribute("data-turn-window-total", String(HISTORY_TURNS), {
		timeout: 30_000,
	});
	await expect(turnWindow.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
	await page.locator("[data-toc-tick]").first().click({ force: true });
	await expect(viewport.getByText(`${HISTORY_PROMPT} [turn 1]`, { exact: true })).toBeVisible();

	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
