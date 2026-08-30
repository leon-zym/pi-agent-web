import fs from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";

const captureDirectory = process.env.PI_WEB_E2E_CAPTURE_DIR;

test.use({
	harnessOptions: {
		extraEnv: { PI_WEB_E2E_RECOVERY_FEATURES: "1" },
	},
});

async function capture(page: Page, name: string): Promise<void> {
	if (!captureDirectory) return;
	fs.mkdirSync(captureDirectory, { recursive: true });
	await page.screenshot({ path: `${captureDirectory}/${name}.png`, animations: "disabled" });
}

async function openWorkbench(page: Page, origin: string, locale: "en" | "zh-CN"): Promise<void> {
	await page.addInitScript((storedLocale) => {
		localStorage.setItem("pi-web-locale", storedLocale);
		localStorage.setItem("pi-web-theme", "light");
	}, locale);
	await page.goto(origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();
}

async function minimumTarget(locator: Locator, minimum = 40): Promise<void> {
	await expect(locator).toBeVisible();
	const box = await locator.boundingBox();
	expect(box).not.toBeNull();
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(minimum);
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

test("context details stay inside the wide-screen meter", async ({ page, harness }) => {
	await page.setViewportSize({ width: 640, height: 900 });
	await openWorkbench(page, harness.origin, "en");
	const meter = page.getByTestId("context-meter");
	await expect(meter).toHaveAttribute("data-state", "ready");
	const detail = meter.locator(":scope > span");

	for (const width of [375, 640, 768, 1023]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(detail).toBeHidden();
		const geometry = await meter.evaluate((element) => ({
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
		}));
		expect(geometry.scrollWidth, `${String(width)}px context meter`).toBeLessThanOrEqual(
			geometry.clientWidth,
		);
	}

	await page.setViewportSize({ width: 1024, height: 900 });
	await expect(detail).toBeVisible();
	await expect(meter).toContainText("34%");
	await capture(page, "context-meter-1024-en-light");
});

test("localized long Diff toolbar wraps without clipping", async ({ page, harness }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await openWorkbench(page, harness.origin, "zh-CN");
	await page.locator("textarea").fill("E2E_COMPLEX_LONG_FILE");
	await page.getByRole("button", { name: "发送" }).click();
	await expect(page.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();

	const toolToggle = page
		.locator('main button[aria-expanded="false"]')
		.filter({ hasText: "非常长的目录名称" });
	await toolToggle.click();
	const diff = page.locator('[data-diff-block="true"]');
	await expect(diff).toBeVisible();
	const fileName = diff.locator('[data-diff-file-name="true"]');
	await expect(fileName).toHaveAttribute("title", /用于验证本地化布局不会挤压/);
	const toolbar = diff.locator(":scope > div").first();
	const geometry = await toolbar.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
	}));
	expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
	expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
	for (const button of await diff.getByRole("button").all()) await minimumTarget(button);
	await fileName.scrollIntoViewIfNeeded();
	await capture(page, "diff-toolbar-375-zh-light");
});
