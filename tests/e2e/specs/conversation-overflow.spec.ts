import { expect, test } from "../fixtures/test";

const LONG_PROMPT = `请检查这个不会自动换行的路径：/${"very_long_segment_".repeat(96)}finished.txt`;

test.use({
	harnessOptions: {
		seedHistoricalSession: {
			userText: LONG_PROMPT,
			assistantText: "Long prompt rendered",
		},
	},
});

test("long user prompts stay inside the conversation reading axis", async ({ page, harness }) => {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	const historicalRow = page
		.locator("[data-session-row]")
		.filter({ hasText: "请检查这个不会自动换行的路径" });
	await historicalRow.getByRole("button").first().click();
	await expect(page.getByText("Long prompt rendered", { exact: true })).toBeVisible();

	const metrics = await page.locator('[data-chat-viewport="true"]').evaluate((viewport) => {
		const bubble = viewport.querySelector<HTMLElement>('[data-user-message="true"]');
		if (!bubble) throw new Error("missing user message bubble");
		const viewportRect = viewport.getBoundingClientRect();
		const bubbleRect = bubble.getBoundingClientRect();
		return {
			viewportClientWidth: viewport.clientWidth,
			viewportScrollWidth: viewport.scrollWidth,
			bubbleLeft: bubbleRect.left,
			bubbleRight: bubbleRect.right,
			viewportLeft: viewportRect.left,
			viewportRight: viewportRect.right,
		};
	});

	expect(metrics.viewportScrollWidth).toBeLessThanOrEqual(metrics.viewportClientWidth);
	expect(metrics.bubbleLeft).toBeGreaterThanOrEqual(metrics.viewportLeft);
	expect(metrics.bubbleRight).toBeLessThanOrEqual(metrics.viewportRight);
});
