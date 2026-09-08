import { expect, test } from "../fixtures/test";

test.use({
	viewport: { width: 1920, height: 1080 },
	harnessOptions: {
		seedHistoricalSession: {
			userText: "REVIEW_PENDING_SCROLL",
			assistantText: "REVIEW_REPLY",
			turnCount: 160,
		},
	},
});
test("ordinary scroll during remote loading keeps the user's new reading anchor", async ({
	page,
	harness,
}, testInfo) => {
	const events: unknown[] = [];
	let release: (() => void) | undefined;
	let requests = 0;
	await page.routeWebSocket("**/api/v1/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((m) => {
			const f = JSON.parse(m.toString());
			if (f.type === "session_history_page") {
				requests++;
				events.push({ stage: "request", id: f.id, time: Date.now() });
			}
			server.send(m);
		});
		server.onMessage((m) => {
			const f = JSON.parse(m.toString());
			if (f.type === "session_history_page_end" && !release) {
				events.push({ stage: "held-end", id: f.requestId, time: Date.now() });
				release = () => {
					events.push({ stage: "release-end", id: f.requestId, time: Date.now() });
					socket.send(m);
				};
				return;
			}
			socket.send(m);
		});
	});
	await page.goto(harness.origin);
	await expect(page.locator("textarea")).toBeEnabled();
	await page
		.locator("[data-session-row]")
		.filter({ hasText: "REVIEW_PENDING_SCROLL" })
		.getByRole("button")
		.first()
		.click();
	const viewport = page.locator('[data-chat-viewport="true"]');
	const turns = viewport.locator('[data-turn-window="true"]');
	const button = turns.locator('[data-load-older-turns="true"]');
	await expect(turns).toHaveAttribute("data-turn-window-total", "48");
	await expect(turns.locator("[data-turn-id]").last()).toContainText("REVIEW_REPLY");
	const read = () =>
		viewport.evaluate((el) => {
			const top = el.getBoundingClientRect().top,
				bottom = el.getBoundingClientRect().bottom;
			const a = [...el.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
				(e) => e.getBoundingClientRect().bottom > top && e.getBoundingClientRect().top < bottom,
			)!;
			return {
				id: a.dataset.turnId!,
				offset: a.getBoundingClientRect().top - top,
				scrollTop: el.scrollTop,
				start: el.querySelector("[data-turn-window]")?.getAttribute("data-turn-window-start"),
				text: a.textContent?.slice(0, 100),
			};
		});
	await viewport.evaluate((el) => {
		el.scrollTop = 140;
		el.dispatchEvent(new Event("scroll"));
	});
	await button.evaluate((el) => el.focus({ preventScroll: true }));
	const initial = await read();
	await page.keyboard.press("Enter");
	await expect.poll(() => Boolean(release)).toBe(true);
	await expect(button).toHaveAttribute("aria-busy", "true");
	await viewport.hover();
	await page.mouse.wheel(0, 500);
	await expect.poll(async () => (await read()).scrollTop).toBeGreaterThan(500);
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
	const before = await read();
	events.push({ stage: "user-scrolled", ...before, time: Date.now() });
	await page.screenshot({ path: testInfo.outputPath("pending-scroll-before.png") });
	release!();
	await expect(turns).toHaveAttribute("data-turn-window-total", "112");
	await expect(button).toHaveAttribute("aria-busy", "false");
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
	const after = await read();
	const original = await viewport.evaluate((el, id) => {
		const n = [...el.querySelectorAll<HTMLElement>("[data-turn-id]")].find((e) => e.dataset.turnId === id);
		return n ? { id, offset: n.getBoundingClientRect().top - el.getBoundingClientRect().top } : null;
	}, before.id);
	events.push({ stage: "settled", ...after, original, time: Date.now() });
	await page.screenshot({ path: testInfo.outputPath("pending-scroll-after.png") });
	await testInfo.attach("pending-scroll-result", {
		body: JSON.stringify({ initial, before, after, original, events, requests }),
		contentType: "application/json",
	});
	expect(await turns.locator("[data-turn-id]").count()).toBeLessThanOrEqual(64);
	await expect(button).toBeFocused();
	expect(requests).toBe(1);
	expect.soft(after.id).toBe(before.id);
	expect.soft(original).not.toBeNull();
	if (original) expect.soft(Math.abs(original.offset - before.offset)).toBeLessThanOrEqual(2);
});
