import { expect, test } from "../fixtures/test";

test.use({
	viewport: { width: 1920, height: 1080 },
	harnessOptions: {
		seedHistoricalSession: {
			userText: "E2E_REMOTE_HISTORY",
			assistantText: "E2E_REMOTE_REPLY",
			turnCount: 160,
		},
	},
});

for (const scenario of [
	"focused control",
	"moved focus",
	"retry after error",
	"Session navigation",
] as const) {
	test(`remote prepend preserves the visible turn: ${scenario}`, async ({ page, harness }, testInfo) => {
		let release: (() => void) | undefined;
		let requests = 0;
		let failPage: (() => void) | undefined;
		await page.routeWebSocket("**/api/v1/ws", (socket) => {
			const server = socket.connectToServer();
			socket.onMessage((message) => {
				const frame = JSON.parse(message.toString());
				if (frame.type === "session_history_page") requests++;
				server.send(message);
			});
			server.onMessage((message) => {
				const frame = JSON.parse(message.toString());
				if (frame.type === "session_history_page_end" && !release) {
					release = () => socket.send(message);
					failPage = () =>
						socket.send(
							JSON.stringify({
								type: "session_error",
								serverEpoch: frame.serverEpoch,
								sessionHandle: frame.sessionHandle,
								operation: "history_page",
								error: "injected page failure",
								code: "test_history_page_failed",
								retryable: true,
							}),
						);
					return;
				}
				socket.send(message);
			});
		});
		await page.goto(harness.origin);
		await expect(page.locator("textarea")).toBeEnabled();
		if (scenario === "Session navigation") {
			await page.locator("textarea").fill("E2E_OTHER_SESSION");
			await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
			await expect(page.locator("main")).toContainText("E2E_REPLY:E2E_OTHER_SESSION");
			await page.locator("textarea").fill("Keep focus and draft");
		}
		await page
			.locator("[data-session-row]")
			.filter({ hasText: "E2E_REMOTE_HISTORY" })
			.getByRole("button")
			.first()
			.click();
		const viewport = page.locator('[data-chat-viewport="true"]');
		const turns = page.locator('[data-turn-window="true"]');
		await expect(turns).toHaveAttribute("data-turn-window-total", "48");
		await expect(turns.locator("[data-turn-id]").last()).toContainText("E2E_REMOTE_REPLY");
		await viewport.evaluate((el) => {
			el.scrollTop = 140;
			el.dispatchEvent(new Event("scroll"));
		});
		const button = turns.locator('[data-load-older-turns="true"]');
		await button.evaluate((el) => el.focus({ preventScroll: true }));
		await expect(button).toBeFocused();
		let before = await viewport.evaluate((el) => {
			const { top, bottom } = el.getBoundingClientRect();
			const a = [...el.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
				(e) => e.getBoundingClientRect().bottom > top && e.getBoundingClientRect().top < bottom,
			)!;
			return {
				id: a.dataset.turnId!,
				text: a.textContent?.slice(0, 160),
				offset: a.getBoundingClientRect().top - top,
				scrollTop: el.scrollTop,
				start: el.querySelector("[data-turn-window]")?.getAttribute("data-turn-window-start"),
				end: el.querySelector("[data-turn-window]")?.getAttribute("data-turn-window-end"),
			};
		});
		expect(requests).toBe(0);

		if (scenario === "focused control") {
			await page.screenshot({ path: testInfo.outputPath("before-prepend.png") });
		}
		await page.keyboard.press("Enter");
		await expect.poll(() => Boolean(release)).toBe(true);
		await expect.soft(button).toBeFocused();
		await expect.soft(button).toHaveAttribute("aria-disabled", "true");
		await button.evaluate((el) => (el as HTMLButtonElement).click());
		expect(requests).toBe(1);
		if (scenario === "moved focus") {
			await page.locator("textarea").focus();
		}
		if (scenario === "retry after error") {
			const staleRelease = release!;
			failPage!();
			await expect(button).toHaveAttribute("aria-busy", "false");
			await expect(turns.getByRole("status")).toBeVisible();
			// Move to a different visible turn before retrying; the failed operation's anchor is obsolete.
			before = await viewport.evaluate((el) => {
				el.scrollTop = 500;
				el.dispatchEvent(new Event("scroll"));
				const { top, bottom } = el.getBoundingClientRect();
				const a = [...el.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
					(e) => e.getBoundingClientRect().bottom > top && e.getBoundingClientRect().top < bottom,
				)!;
				return {
					id: a.dataset.turnId!,
					text: a.textContent?.slice(0, 160),
					offset: a.getBoundingClientRect().top - top,
					scrollTop: el.scrollTop,
					start: el.querySelector("[data-turn-window]")?.getAttribute("data-turn-window-start"),
					end: el.querySelector("[data-turn-window]")?.getAttribute("data-turn-window-end"),
				};
			});
			release = undefined;
			await button.evaluate((el) => (el as HTMLButtonElement).click());
			await expect.poll(() => Boolean(release)).toBe(true);
			staleRelease();
			await expect(turns).toHaveAttribute("data-turn-window-total", "48");
		}
		if (scenario === "Session navigation") {
			const other = page
				.locator("[data-session-row]")
				.filter({ hasText: "E2E_OTHER_SESSION" })
				.getByRole("button")
				.first();
			await other.click();
			await expect(page.locator("textarea")).toHaveValue("Keep focus and draft");
			await expect(page.locator("textarea")).toBeEnabled();
			await page.locator("textarea").focus();
			await expect(page.locator("textarea")).toBeFocused();
			release!();
			await page.evaluate(
				() =>
					new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
			);
			await expect(page.locator("textarea")).toBeFocused();
			await expect(page.locator("textarea")).toHaveValue("Keep focus and draft");
			await expect(turns).toHaveAttribute("data-turn-window-total", "1");
			await page
				.locator("[data-session-row]")
				.filter({ hasText: "E2E_REMOTE_HISTORY" })
				.getByRole("button")
				.first()
				.click();
			await expect(turns).toHaveAttribute("data-turn-window-total", "112");
			await expect(button).not.toBeFocused();
			expect(await turns.locator("[data-turn-id]").count()).toBeLessThanOrEqual(64);
			expect(requests).toBe(1);
			return;
		}
		release!();
		await expect(turns).toHaveAttribute("data-turn-window-total", "112");
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
		);
		const after = await viewport.evaluate((el, id) => {
			const ids = [...el.querySelectorAll<HTMLElement>("[data-turn-id]")].map((e) => e.dataset.turnId);
			const a = [...el.querySelectorAll<HTMLElement>("[data-turn-id]")].find((e) => e.dataset.turnId === id);
			const b = el.querySelector<HTMLButtonElement>('[data-load-older-turns="true"]')!;
			return {
				id: a?.dataset.turnId ?? null,
				offset: a ? a.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
				scrollTop: el.scrollTop,
				start: el.querySelector("[data-turn-window]")?.getAttribute("data-turn-window-start"),
				end: el.querySelector("[data-turn-window]")?.getAttribute("data-turn-window-end"),
				mounted: ids.length,
				first: ids[0],
				last: ids.at(-1),
				focused: document.activeElement === b,
				activeTag: document.activeElement?.tagName,
				tocIndex: [...document.querySelectorAll<HTMLElement>("[data-toc-tick]")].findIndex(
					(e) => e.dataset.tocTick === id,
				),
			};
		}, before.id);

		expect.soft(after.id).toBe(before.id);
		if (scenario === "moved focus") await expect(page.locator("textarea")).toBeFocused();
		else expect.soft(after.focused).toBe(true);
		expect.soft(after.mounted).toBeLessThanOrEqual(64);
		expect.soft(after.offset).not.toBeNull();
		if (after.offset !== null) expect.soft(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(2);
		expect(requests).toBe(scenario === "retry after error" ? 2 : 1);
		await testInfo.attach("anchor-geometry", {
			body: JSON.stringify({ before, after }),
			contentType: "application/json",
		});
		if (scenario === "focused control")
			await page.screenshot({ path: testInfo.outputPath("remote-prepend.png") });
	});
}

test.describe("last remote page", () => {
	test.use({
		harnessOptions: {
			seedHistoricalSession: {
				userText: "E2E_REMOTE_LAST",
				assistantText: "E2E_REMOTE_LAST_REPLY",
				turnCount: 60,
			},
		},
	});
	for (const moveFocus of [false, true]) {
		test(`partial final page preserves anchor and ${moveFocus ? "moved focus" : "focuses the conversation"}`, async ({
			page,
			harness,
		}) => {
			let release: (() => void) | undefined;
			let requests = 0;
			await page.routeWebSocket("**/api/v1/ws", (socket) => {
				const server = socket.connectToServer();
				socket.onMessage((message) => {
					if (JSON.parse(message.toString()).type === "session_history_page") requests++;
					server.send(message);
				});
				server.onMessage((message) => {
					if (JSON.parse(message.toString()).type === "session_history_page_end") {
						release = () => socket.send(message);
						return;
					}
					socket.send(message);
				});
			});
			await page.goto(harness.origin);
			await expect(page.locator("textarea")).toBeEnabled();
			await page
				.locator("[data-session-row]")
				.filter({ hasText: "E2E_REMOTE_LAST" })
				.getByRole("button")
				.first()
				.click();
			const viewport = page.locator('[data-chat-viewport="true"]');
			const turns = viewport.locator('[data-turn-window="true"]');
			await expect(turns).toHaveAttribute("data-turn-window-total", "48");
			await expect(turns.locator("[data-turn-id]").last()).toContainText("E2E_REMOTE_LAST_REPLY");
			await viewport.evaluate((el) => {
				el.scrollTop = 140;
				el.dispatchEvent(new Event("scroll"));
			});
			const button = turns.locator('[data-load-older-turns="true"]');
			await button.evaluate((el) => el.focus({ preventScroll: true }));
			const before = await viewport.evaluate((el) => {
				const rect = el.getBoundingClientRect();
				const a = [...el.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
					(e) => e.getBoundingClientRect().bottom > rect.top && e.getBoundingClientRect().top < rect.bottom,
				)!;
				return { id: a.dataset.turnId!, offset: a.getBoundingClientRect().top - rect.top };
			});
			expect(requests).toBe(0);
			await button.evaluate((el) => (el as HTMLButtonElement).click());
			await expect.poll(() => Boolean(release)).toBe(true);
			await expect(button).toBeFocused();
			if (moveFocus) await page.locator("textarea").focus();
			release!();
			await expect(turns).toHaveAttribute("data-turn-window-total", "60");
			await expect(button).toHaveCount(0);
			await expect(moveFocus ? page.locator("textarea") : viewport).toBeFocused();
			const anchor = turns.locator(`[data-turn-id="${before.id}"]`);
			await expect(anchor).toBeVisible();
			const offset = await anchor.evaluate(
				(el) =>
					el.getBoundingClientRect().top - el.closest("[data-chat-viewport]")!.getBoundingClientRect().top,
			);
			expect(Math.abs(offset - before.offset)).toBeLessThanOrEqual(2);
			expect(await turns.locator("[data-turn-id]").count()).toBeLessThanOrEqual(64);
			expect(requests).toBe(1);
		});
	}
});
