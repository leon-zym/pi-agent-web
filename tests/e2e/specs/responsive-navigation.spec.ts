import { observePageErrors, pageOverflow } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

const B_PROMPT = "E2E_B_RESPONSIVE";
const COMPLEX_PROMPT = "E2E_COMPLEX_DEMO";
const SLOW_PROMPT = "E2E_A_SLOW_RESPONSIVE";

test.use({ hasTouch: true });

async function expectMinimumHitTarget(
	control: import("@playwright/test").Locator,
	minimum = 40,
): Promise<void> {
	await expect(control).toBeVisible();
	const box = await control.boundingBox();
	expect(box).not.toBeNull();
	if (!box) return;
	expect(box.width).toBeGreaterThanOrEqual(minimum);
	expect(box.height).toBeGreaterThanOrEqual(minimum);
}

async function sendPrompt(page: import("@playwright/test").Page, prompt: string): Promise<void> {
	await page.locator("textarea").fill(prompt);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

for (const viewport of [
	{ name: "phone", width: 375, height: 812 },
	{ name: "tablet", width: 768, height: 900 },
]) {
	test(`${viewport.name} can switch Sessions and inspect tools through accessible drawers`, async ({
		page,
		harness,
	}) => {
		const errors = observePageErrors(page);
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
		await expect(page.locator("textarea")).toBeEnabled();

		const sessionsTrigger = page.getByRole("button", {
			name: /^(Open sessions|打开会话列表)$/,
		});
		const branchTrigger = page.locator("header").getByRole("button", {
			name: /^(Branch tree|分支树)$/,
		});
		const moreTrigger = page.locator("header").getByRole("button", {
			name: /^(More session actions|更多会话操作)$/,
		});
		const sendButton = page.getByRole("button", { name: /^(Send|发送)$/ });
		const commandButton = page.getByRole("button", { name: /^(Command menu|命令菜单)$/ });
		const imageButton = page.getByRole("button", { name: /^(Add image|添加图片)$/ });
		const modelButton = page.getByRole("button", { name: /^(Configure model|配置模型)$/ });
		const contextButton = page.getByRole("button", {
			name: /^(Context unavailable|上下文占用不可用)$/,
		});
		const rail = page.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ });
		const railNewSession = rail.getByRole("button", { name: /^(New session|新建会话)$/ });
		const railAddWorkspace = rail.getByRole("button", { name: /^(Add workspace|添加工作区)$/ });
		for (const control of [
			sessionsTrigger,
			railNewSession,
			railAddWorkspace,
			branchTrigger,
			moreTrigger,
			commandButton,
			imageButton,
			modelButton,
			contextButton,
			sendButton,
		]) {
			await expectMinimumHitTarget(control);
		}

		await branchTrigger.click();
		const detailsDrawer = page.getByRole("dialog", {
			name: /^(Session details|会话详情)$/,
		});
		await expect(detailsDrawer).toBeVisible();
		const closeDetails = detailsDrawer.getByRole("button", {
			name: /^(Collapse details panel|收起详情面板)$/,
		});
		await expectMinimumHitTarget(closeDetails);
		await closeDetails.click();
		await expect(detailsDrawer).toBeHidden();
		await expect(branchTrigger).toBeFocused();

		await sessionsTrigger.click();
		const sessionDrawer = page.getByRole("dialog", { name: /^(Sessions|会话)$/ });
		await expect(sessionDrawer).toBeVisible();
		await expectMinimumHitTarget(sessionDrawer.getByRole("button", { name: /^(Add workspace|添加工作区)$/ }));
		await expect
			.poll(() => sessionDrawer.evaluate((element) => element.contains(document.activeElement)))
			.toBe(true);
		const workspaceActions = sessionDrawer.getByRole("button", {
			name: /^(Workspace actions|工作区操作)$/,
		});
		await expectMinimumHitTarget(workspaceActions);
		await workspaceActions.click();
		await page.getByRole("menuitem", { name: /^(Remove workspace|移除工作区)$/ }).click();
		const removeWorkspaceDialog = page.getByRole("alertdialog", {
			name: /^(Remove workspace|移除工作区)$/,
		});
		await expect(removeWorkspaceDialog).toBeVisible();
		await removeWorkspaceDialog.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
		await expect(removeWorkspaceDialog).toBeHidden();
		await page.keyboard.press("Escape");
		await expect(sessionDrawer).toBeHidden();
		await expect(sessionsTrigger).toBeFocused();

		await sessionsTrigger.click();
		const drawerNewSession = sessionDrawer.getByRole("button", { name: /^(New session|新建会话)$/ }).first();
		await expectMinimumHitTarget(drawerNewSession);
		await drawerNewSession.click();
		await expect(sessionDrawer).toBeHidden();
		await expect
			.poll(async () => {
				const result = await harness.requestJson<{ sessions: unknown[] }>(
					`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions`,
				);
				return result.sessions.length;
			})
			.toBe(2);

		await sendPrompt(page, B_PROMPT);
		await expect(page.locator("main")).toContainText(`E2E_REPLY:${B_PROMPT}`);

		await sessionsTrigger.click();
		const emptySessionButton = sessionDrawer
			.locator('[data-session-row][data-current="false"]')
			.getByRole("button")
			.first();
		await expectMinimumHitTarget(emptySessionButton);
		await emptySessionButton.click();
		await expect(sessionDrawer).toBeHidden();
		await expect(
			page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ }),
		).toBeVisible();

		await sessionsTrigger.click();
		await sessionDrawer
			.locator("[data-session-row]")
			.filter({ hasText: B_PROMPT })
			.getByRole("button")
			.first()
			.click();
		await expect(sessionDrawer).toBeHidden();
		await expect(page.locator("main")).toContainText(`E2E_REPLY:${B_PROMPT}`);

		await sendPrompt(page, COMPLEX_PROMPT);
		const main = page.locator("main");
		await expect(main.getByRole("heading", { name: "Synthetic change review", level: 2 })).toBeVisible();
		await main.getByRole("button", { name: /edit.*src\/demo\.ts/i }).click();
		const openDetails = main.getByRole("button", {
			name: /^(Open in details panel|在详情面板中查看)$/,
		});
		await openDetails.click();
		await expect(detailsDrawer).toBeVisible();
		await expect(detailsDrawer.getByText("Synthetic edit completed", { exact: true })).toBeVisible();
		await expectMinimumHitTarget(closeDetails);
		await closeDetails.click();
		await expect(detailsDrawer).toBeHidden();
		await expect(openDetails).toBeFocused();

		await openDetails.click();
		await expect(detailsDrawer).toBeVisible();
		await expect(detailsDrawer.getByText("Synthetic edit completed", { exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(detailsDrawer).toBeHidden();
		await expect(openDetails).toBeFocused();

		await sendPrompt(page, SLOW_PROMPT);
		await expect(page.locator("header").getByText(/^(Running|运行中)$/)).toBeVisible();
		const stopButton = page.getByRole("button", { name: /^(Stop|停止)$/ });
		await expectMinimumHitTarget(stopButton);
		harness.releasePrompt(SLOW_PROMPT);
		await expect(page.locator("header").getByText(/^(Ready|就绪)$/)).toBeVisible();

		const overflow = await pageOverflow(page);
		expect(overflow.htmlScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
			overflow.viewportWidth,
		);
		expect(overflow.bodyScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
			overflow.viewportWidth,
		);
		expect(errors.console).toEqual([]);
		expect(errors.page).toEqual([]);
	});
}

test("1024px boundary keeps details discoverable as an overlay", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	await page.setViewportSize({ width: 1024, height: 800 });
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();
	await expect(page.getByRole("button", { name: /^(Open sessions|打开会话列表)$/ })).toHaveCount(0);

	await page
		.locator("header")
		.getByRole("button", { name: /^(Branch tree|分支树)$/ })
		.click();
	const detailsDrawer = page.getByRole("dialog", { name: /^(Session details|会话详情)$/ });
	await expect(detailsDrawer).toBeVisible();
	await detailsDrawer.getByRole("button", { name: /^(Collapse details panel|收起详情面板)$/ }).click();
	await expect(detailsDrawer).toBeHidden();

	const overflow = await pageOverflow(page);
	expect(overflow.htmlScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
		overflow.viewportWidth,
	);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("reduced motion removes non-essential transitions and animation", async ({ page, harness }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();
	const styles = await page.getByRole("button", { name: /^(Send|发送)$/ }).evaluate((element) => {
		const button = getComputedStyle(element);
		const root = getComputedStyle(document.documentElement);
		return {
			transitionDuration: button.transitionDuration,
			scrollBehavior: root.scrollBehavior,
		};
	});
	expect(styles.transitionDuration).toMatch(/^(0s|0\.001ms|0\.000001s|1e-06s)$/);
	expect(styles.scrollBehavior).toBe("auto");
});
