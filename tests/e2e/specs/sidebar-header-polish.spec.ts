import { expect, test } from "../fixtures/test";

test.use({
	harnessOptions: {
		seedHistoricalSession: {
			userText: "E2E sidebar geometry history",
			assistantText: "E2E sidebar geometry reply",
		},
	},
});

test("sidebar geometry stays fixed and relative time exposes an exact timestamp", async ({
	page,
	harness,
}) => {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();

	const theme = page.getByRole("button", { name: /^(Switch theme|切换主题)$/ });
	const expandedTheme = await theme.evaluate((button) => {
		const rect = button.getBoundingClientRect();
		return {
			centerX: rect.left + rect.width / 2,
			bottomGap: window.innerHeight - rect.bottom,
			color: getComputedStyle(button).color,
		};
	});
	const brand = page.locator('[data-sidebar-brand-slot="true"]');
	const newSession = page
		.locator("nav")
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first();
	const headerGap = await brand.evaluate(
		(element, nextButton) => {
			return (nextButton as HTMLElement).getBoundingClientRect().top - element.getBoundingClientRect().bottom;
		},
		await newSession.elementHandle(),
	);
	expect(headerGap).toBeGreaterThanOrEqual(8);

	await page.getByRole("button", { name: /^(Collapse sidebar|收起侧栏)$/ }).click();
	const collapsedTheme = await theme.evaluate((button) => {
		const rect = button.getBoundingClientRect();
		return {
			centerX: rect.left + rect.width / 2,
			bottomGap: window.innerHeight - rect.bottom,
			color: getComputedStyle(button).color,
		};
	});
	expect(Math.abs(collapsedTheme.centerX - expandedTheme.centerX)).toBeLessThanOrEqual(0.5);
	expect(collapsedTheme.bottomGap).toBeCloseTo(expandedTheme.bottomGap, 4);
	expect(collapsedTheme.color).toBe(expandedTheme.color);

	await page.getByRole("button", { name: /^(Expand sidebar|展开侧栏)$/ }).click();
	await page
		.locator("[data-session-row]")
		.filter({ hasText: "E2E sidebar geometry history" })
		.getByRole("button")
		.first()
		.click();
	const relativeTime = page.locator("header time");
	const expectedExactTime = await relativeTime.evaluate((element) => {
		const date = new Date((element as HTMLTimeElement).dateTime);
		const pad = (value: number) => value.toString().padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	});
	await relativeTime.hover();
	await expect(page.getByRole("tooltip")).toContainText(expectedExactTime);
});
