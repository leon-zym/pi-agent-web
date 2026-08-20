import { observePageErrors, pageOverflow } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

const COMPLEX_PROMPT = "E2E_COMPLEX_DEMO";
const captureDirectory = process.env.PI_WEB_E2E_CAPTURE_DIR;

async function capture(page: import("@playwright/test").Page, name: string): Promise<void> {
	if (!captureDirectory) return;
	await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: "auto" }));
	await page.screenshot({ path: `${captureDirectory}/${name}.png`, animations: "disabled" });
}

test("settled complex turn renders rich content and restores tool context", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	const unsolicitedImageRequests: string[] = [];
	await page.route("https://attacker.invalid/**", async (route) => {
		unsolicitedImageRequests.push(route.request().url());
		await route.abort();
	});
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();

	await page.locator("textarea").fill(COMPLEX_PROMPT);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();

	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();
	await expect(main.getByText("Preserve the public API", { exact: true })).toBeVisible();
	await expect(main.locator("table")).toContainText("Verified");
	await expect(main.locator("pre code")).toContainText("export function formatStatus");
	await expect(main.locator('[data-markdown-image-link="true"]')).toHaveAttribute(
		"href",
		"https://attacker.invalid/leak?secret=SYNTHETIC_TOKEN",
	);
	expect(unsolicitedImageRequests).toEqual([]);
	await expect(main.getByRole("button", { name: /edit.*src\/demo\.ts/i })).toBeVisible();
	await expect(main.getByText("Inspecting synthetic workspace", { exact: true })).toBeVisible();
	await capture(page, "pi-agent-web-demo-desktop");

	const visibleText = await page.locator("body").innerText();
	expect(visibleText).not.toContain("\u001b");
	expect(visibleText).not.toContain("[36m");
	expect(visibleText).not.toContain("[0m");

	const toolRow = main.getByRole("button", { name: /edit.*src\/demo\.ts/i });
	await toolRow.click();
	await expect(main.getByRole("region", { name: /^(File changes|文件变更)$/ })).toBeVisible();
	await expect(main.locator('[data-diff-kind="delete"]')).toContainText("return status");
	await expect(main.locator('[data-diff-kind="add"]')).toContainText("toUpperCase");

	await main.getByRole("button", { name: /^(Open in details panel|在详情面板中查看)$/ }).click();
	const inspectorArgs = page.locator("pre code.language-json").filter({ hasText: "src/demo.ts" }).first();
	await expect(inspectorArgs).toBeVisible();
	expect(await inspectorArgs.innerText()).toContain("\n");
	await expect(inspectorArgs.locator(".hljs-attr").first()).toBeVisible();
	const inspectorOutput = page.getByRole("code").filter({ hasText: "Synthetic edit completed" });
	await expect(inspectorOutput).toHaveText("Synthetic edit completed");
	await capture(page, "pi-agent-web-demo-tool-inspector");
	await page.getByRole("button", { name: /^(Collapse details panel|收起详情面板)$/ }).click();
	await expect(page.getByRole("button", { name: /^(Expand details panel|展开详情面板)$/ })).toBeVisible();
	await page.getByRole("button", { name: /^(Expand details panel|展开详情面板)$/ }).click();
	await expect(inspectorOutput).toHaveText("Synthetic edit completed");

	const viewport = page.locator('[data-chat-viewport="true"]');
	const savedScrollTop = await viewport.evaluate((element) => {
		const target = Math.min(160, Math.max(0, element.scrollHeight - element.clientHeight - 40));
		element.scrollTo({ top: target, behavior: "auto" });
		element.dispatchEvent(new Event("scroll"));
		return Math.round(element.scrollTop);
	});
	expect(savedScrollTop).toBeGreaterThan(0);
	const backToLatest = page.getByRole("button", { name: /^(Back to latest|回到最新消息)$/ });
	await expect(backToLatest).toBeVisible();
	const backToLatestBox = await backToLatest.boundingBox();
	expect(backToLatestBox).not.toBeNull();
	expect(backToLatestBox?.width ?? 0).toBeGreaterThanOrEqual(40);
	expect(backToLatestBox?.height ?? 0).toBeGreaterThanOrEqual(40);
	await page
		.locator("nav")
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();
	await expect(page.locator("[data-session-row]")).toHaveCount(3);
	const originalSession = page.locator("[data-session-row]").filter({ hasText: COMPLEX_PROMPT });
	await originalSession.getByRole("button").first().click();
	await expect(page.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();
	await expect
		.poll(async () => {
			const restored = await viewport.evaluate((element) => Math.round(element.scrollTop));
			return Math.abs(restored - savedScrollTop) <= 8;
		})
		.toBe(true);
	await expect(page.locator("textarea")).toBeEnabled();

	await page.evaluate(() => localStorage.setItem("pi-web-theme", "dark"));
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page
		.locator("[data-session-row]")
		.filter({ hasText: COMPLEX_PROMPT })
		.getByRole("button")
		.first()
		.click();
	await expect(page.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();
	const darkCode = page.locator("pre code.hljs");
	await expect(darkCode).toBeVisible();
	const darkCodeColors = await darkCode.evaluate((element) => {
		const code = getComputedStyle(element);
		const pre = getComputedStyle(element.closest("pre") as HTMLElement);
		return {
			codeBackground: code.backgroundColor,
			codeColor: code.color,
			preBackground: pre.backgroundColor,
		};
	});
	expect(darkCodeColors.codeBackground).toBe("rgba(0, 0, 0, 0)");
	expect(darkCodeColors.codeColor).toBe("rgb(249, 250, 251)");
	expect(darkCodeColors.preBackground).toBe("rgb(34, 34, 36)");

	if (captureDirectory) {
		await capture(page, "pi-agent-web-demo-dark");

		await page.setViewportSize({ width: 375, height: 812 });
		await page.evaluate(() => localStorage.setItem("pi-web-theme", "light"));
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("html")).not.toHaveClass(/dark/);
		await page.getByRole("button", { name: /^(Open sessions|打开会话列表)$/ }).click();
		const sessionDrawer = page.getByRole("dialog", { name: /^(Sessions|会话)$/ });
		await sessionDrawer
			.locator("[data-session-row]")
			.filter({ hasText: COMPLEX_PROMPT })
			.getByRole("button")
			.first()
			.click();
		await expect(page.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();
		await capture(page, "pi-agent-web-demo-375");
	}

	const overflow = await pageOverflow(page);
	expect(overflow.htmlScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
		overflow.viewportWidth,
	);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
