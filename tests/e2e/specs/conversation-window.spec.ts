import { observePageErrors } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

const HISTORY_TURNS = 160;
const HISTORY_PROMPT = "E2E_LONG_HISTORY_PROMPT";

test.use({
	harnessOptions: {
		seedHistoricalSession: {
			userText: HISTORY_PROMPT,
			assistantText: "E2E_LONG_HISTORY_REPLY",
			turnCount: HISTORY_TURNS,
		},
	},
});

test("long history keeps mounted turns bounded and reveals older turns on demand", async ({
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
	await expect(
		viewport.getByText(`E2E_LONG_HISTORY_REPLY ${String(HISTORY_TURNS)}`, { exact: true }),
	).toBeVisible();

	const initial = await turnWindow.evaluate((element) => ({
		total: Number(element.getAttribute("data-turn-window-total")),
		start: Number(element.getAttribute("data-turn-window-start")),
		end: Number(element.getAttribute("data-turn-window-end")),
		mounted: element.querySelectorAll("[data-turn-id]").length,
	}));
	expect(initial.total).toBe(HISTORY_TURNS);
	expect(initial.end).toBe(HISTORY_TURNS);
	expect(initial.mounted).toBeLessThanOrEqual(64);
	expect(initial.start).toBeGreaterThan(0);
	await expect(page.locator("[data-toc-tick]")).toHaveCount(HISTORY_TURNS);
	await expect(viewport.locator('[data-markdown-streaming="true"]')).toHaveCount(0);

	const loadOlder = turnWindow.getByRole("button", { name: /^(Load older messages|加载更早消息)$/ });
	await expect(loadOlder).toBeVisible();
	await loadOlder.focus();
	await expect(loadOlder).toBeFocused();
	const anchorBefore = await viewport.evaluate((element) => {
		const target = Math.min(400, Math.max(0, element.scrollHeight - element.clientHeight - 100));
		element.scrollTo({ top: target, behavior: "auto" });
		element.dispatchEvent(new Event("scroll"));
		const viewportTop = element.getBoundingClientRect().top;
		const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
			(candidate) => candidate.getBoundingClientRect().bottom > viewportTop,
		);
		if (!anchor) throw new Error("missing pre-paging scroll anchor");
		return {
			id: anchor.dataset.turnId,
			offset: anchor.getBoundingClientRect().top - viewportTop,
			scrollTop: element.scrollTop,
			scrollHeight: element.scrollHeight,
		};
	});
	await loadOlder.evaluate((button) => (button as HTMLButtonElement).click());
	await expect
		.poll(async () => Number(await turnWindow.getAttribute("data-turn-window-start")))
		.toBeLessThan(initial.start);
	const anchorAfter = await viewport.evaluate((element, anchorId) => {
		const viewportTop = element.getBoundingClientRect().top;
		const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
			(candidate) => candidate.dataset.turnId === anchorId,
		);
		if (!anchor) throw new Error("missing post-paging scroll anchor");
		return {
			id: anchor.dataset.turnId,
			offset: anchor.getBoundingClientRect().top - viewportTop,
			scrollTop: element.scrollTop,
			scrollHeight: element.scrollHeight,
		};
	}, anchorBefore.id);
	expect(anchorAfter.id).toBe(anchorBefore.id);
	expect(
		Math.abs(anchorAfter.offset - anchorBefore.offset),
		JSON.stringify({ anchorBefore, anchorAfter }),
	).toBeLessThanOrEqual(2);
	const afterPrepend = await turnWindow.evaluate((element) => ({
		start: Number(element.getAttribute("data-turn-window-start")),
		end: Number(element.getAttribute("data-turn-window-end")),
		mounted: element.querySelectorAll("[data-turn-id]").length,
	}));
	expect(afterPrepend.end).toBeLessThan(HISTORY_TURNS);
	expect(afterPrepend.mounted).toBeLessThanOrEqual(64);
	await expect(loadOlder).toBeFocused();

	await page.setViewportSize({ width: 1024, height: 700 });
	await expect(viewport.locator('[data-turn-id="turn-1"]')).toHaveCount(0);
	const resizedAnchor = await viewport.evaluate((element, anchorId) => {
		const viewportTop = element.getBoundingClientRect().top;
		const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
			(candidate) => candidate.dataset.turnId === anchorId,
		);
		if (!anchor) throw new Error("missing resized scroll anchor");
		return {
			id: anchor.dataset.turnId,
			offset: anchor.getBoundingClientRect().top - viewportTop,
		};
	}, anchorBefore.id);
	expect(resizedAnchor.id).toBe(anchorBefore.id);
	expect(resizedAnchor.offset).toBeGreaterThanOrEqual(-2);

	const firstTick = page.locator('[data-toc-tick="turn-1"]');
	await firstTick.evaluate((button) => (button as HTMLButtonElement).click());
	await expect.poll(async () => Number(await turnWindow.getAttribute("data-turn-window-start"))).toBe(0);
	await expect(viewport.locator('[data-turn-id="turn-1"]')).toBeVisible();
	const selectedText = await viewport.evaluate(() => {
		const target = document.querySelector<HTMLElement>('[data-turn-id="turn-1"]');
		if (!target) throw new Error("missing selected turn");
		const selection = window.getSelection();
		if (!selection) throw new Error("selection API unavailable");
		const range = document.createRange();
		range.selectNodeContents(target);
		selection.removeAllRanges();
		selection.addRange(range);
		return selection.toString();
	});
	expect(selectedText).toContain(HISTORY_PROMPT);
	expect(selectedText).toContain("E2E_LONG_HISTORY_REPLY 1");

	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
