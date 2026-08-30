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

	const toolToggle = page.locator("main button[aria-expanded]").filter({ hasText: "非常长的目录名称" });
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

test("conversation controls keep touch targets and complete reasoning access", async ({ page, harness }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await openWorkbench(page, harness.origin, "en");
	await page.locator("textarea").fill("E2E_COMPLEX_DEMO");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(page.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();

	const reasoningToggle = page
		.locator("main button[aria-expanded]")
		.filter({ hasText: "Comparing the implementation with the requested behavior." });
	const reasoningInspect = page.getByRole("button", { name: "Open reasoning in details panel" });
	const toolToggle = page.locator("main button[aria-expanded]").filter({ hasText: "src/demo.ts" });
	const toolInspect = page.getByRole("button", { name: "Open in details panel" });
	const turnCopy = page.getByRole("button", { name: "Copy" }).last();
	const turnFork = page.getByRole("button", { name: "Fork" }).last();
	const userCopy = page.getByRole("button", { name: "Copy message" });
	const controls = [reasoningToggle, reasoningInspect, toolToggle, toolInspect, turnCopy, turnFork, userCopy];

	for (const control of controls) await minimumTarget(control);
	await reasoningToggle.focus();
	await page.keyboard.press("Tab");
	await expect(reasoningInspect).toBeFocused();
	const focusedStyle = await reasoningInspect.evaluate((element) => {
		const style = getComputedStyle(element);
		return { boxShadow: style.boxShadow, opacity: style.opacity };
	});
	expect(focusedStyle.opacity).toBe("1");
	expect(focusedStyle.boxShadow).not.toBe("none");

	await reasoningToggle.click();
	const fullReasoning = page
		.locator("p")
		.filter({ hasText: "Comparing the implementation with the requested behavior." });
	await expect(fullReasoning).toBeVisible();
	await expect(fullReasoning).toContainText("Inspecting synthetic workspace");

	await page.setViewportSize({ width: 768, height: 900 });
	for (const control of [reasoningInspect, toolToggle, toolInspect, turnCopy, turnFork, userCopy]) {
		await minimumTarget(control);
	}
	await page.setViewportSize({ width: 375, height: 812 });
	await reasoningToggle.scrollIntoViewIfNeeded();
	await capture(page, "conversation-controls-375-en-light");
});

test("wide conversation content hides the TOC from sight and focus", async ({ page, harness }) => {
	await page.setViewportSize({ width: 1600, height: 900 });
	await openWorkbench(page, harness.origin, "en");
	await page.locator("textarea").fill("E2E_COMPLEX_LONG_FILE");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(page.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();

	const toc = page.locator('[data-conversation-toc="true"]');
	await expect(toc).toBeVisible();
	await expect(toc).toHaveAttribute("aria-hidden", "false");
	const toolToggle = page.locator("main button[aria-expanded]").filter({ hasText: "非常长的目录名称" });
	await toolToggle.click();
	await expect(page.locator('[data-diff-block="true"]')).toBeVisible();
	await expect(toc).toHaveAttribute("data-toc-wide-content", "true");
	await expect(toc).toHaveAttribute("aria-hidden", "true");
	await expect(toc).toBeHidden();
	await capture(page, "toc-hidden-for-wide-content-1600-en-light");

	await toolToggle.click();
	await expect(toc).toHaveAttribute("data-toc-wide-content", "false");
	await expect(toc).toHaveAttribute("aria-hidden", "false");
	await expect(toc).toBeVisible();
});

test("audio chime preference is discoverable and persists", async ({ page, harness }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await openWorkbench(page, harness.origin, "en");
	await page.getByRole("button", { name: "Settings", exact: true }).click();

	const settings = page.getByRole("dialog", { name: "Settings" });
	const audio = settings.getByRole("switch", { name: "Audio chime" });
	await expect(settings).toBeVisible();
	await expect(audio).toBeChecked();
	await expect(settings.getByText("Sound enabled", { exact: true })).toBeVisible();

	await audio.focus();
	await page.keyboard.press("Space");
	await expect(audio).not.toBeChecked();
	await expect(settings.getByText("Sound muted", { exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("piweb:audio-muted"))).toBe("true");

	await settings.getByRole("button", { name: "Close" }).last().click();
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Settings" }).getByRole("switch", {
			name: "Audio chime",
		}),
	).not.toBeChecked();
});

test("audio chime preference keeps localized dark-mode context", async ({ page, harness }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.addInitScript(() => {
		localStorage.setItem("pi-web-locale", "zh-CN");
		localStorage.setItem("pi-web-theme", "dark");
		localStorage.setItem("piweb:audio-muted", "true");
	});
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page.getByRole("button", { name: "设置", exact: true }).click();

	const settings = page.getByRole("dialog", { name: "设置" });
	await expect(settings.getByRole("switch", { name: "提示音" })).not.toBeChecked();
	await expect(settings.getByText("提示音已静音", { exact: true })).toBeVisible();
	await capture(page, "settings-audio-muted-1280-zh-dark");
});
