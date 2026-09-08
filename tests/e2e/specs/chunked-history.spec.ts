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

test("loads an oversized history page across navigation without losing another draft", async ({
	page,
	harness,
}) => {
	test.slow();
	const errors = observePageErrors(page);
	let pageRequests = 0;
	let releasePage: (() => void) | undefined;
	// Only hold the end marker of this one page; native history is served by the Gateway,
	// so the deterministic Pi prompt gate cannot control this boundary.
	await page.routeWebSocket("**/api/v1/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			if (JSON.parse(message.toString()).type === "session_history_page") pageRequests += 1;
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(message.toString()) as { type?: string };
			if (frame.type === "session_history_page_end" && !releasePage) {
				releasePage = () => socket.send(message);
				return;
			}
			socket.send(message);
		});
	});
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	await page.locator("textarea").fill("E2E_B_FAST");
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect(page.locator("main")).toContainText("E2E_REPLY:E2E_B_FAST");
	await page.locator("textarea").fill("Keep while history loads");
	const otherRow = page.locator("[data-session-row]").filter({ hasText: "E2E_B_FAST" });
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
	await expect.poll(() => Boolean(releasePage)).toBe(true);
	await otherRow.getByRole("button").first().click();
	await expect(page.locator("textarea")).toHaveValue("Keep while history loads");
	expect(pageRequests).toBe(1);
	// Background completion itself is asserted in the real transport/pipeline regression.
	releasePage?.();
	await page
		.locator("[data-session-row]")
		.filter({ hasText: HISTORY_PROMPT })
		.getByRole("button")
		.first()
		.click();
	await expect(turnWindow).toHaveAttribute("data-turn-window-total", String(HISTORY_TURNS), {
		timeout: 30_000,
	});
	await expect(turnWindow.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
	await page.locator("[data-toc-tick]").first().click({ force: true });
	await expect(viewport.getByText(`${HISTORY_PROMPT} [turn 1]`, { exact: true })).toBeVisible();

	await otherRow.getByRole("button").first().click();
	await expect(page.locator("textarea")).toHaveValue("Keep while history loads");
	expect(pageRequests).toBe(1);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
