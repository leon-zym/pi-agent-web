import { observePageErrors, pageOverflow } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

async function expectVisibleControlsInsideViewport(
	controls: import("@playwright/test").Locator,
	viewportWidth: number,
): Promise<void> {
	for (const control of await controls.locator("button:visible").all()) {
		const label = (await control.getAttribute("aria-label")) ?? (await control.innerText());
		const box = await control.boundingBox();
		expect(box, label).not.toBeNull();
		if (!box) continue;
		expect(box.x, label).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width, label).toBeLessThanOrEqual(viewportWidth);
	}
}

test("packaged app bootstraps and renders the workbench without browser errors", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	const bootstrapResponse = page.waitForResponse(
		(response) => response.url() === `${harness.origin}/api/v1/bootstrap`,
	);

	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	expect((await bootstrapResponse).status()).toBe(200);
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("nav")).toBeVisible();
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	await expect(page.getByRole("button", { name: /^(Expand details panel|展开详情面板)$/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /^(Inspect|检查)$/ })).toBeHidden();
	await expect(page.getByRole("button", { name: /^(Configure model|配置模型)$/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /^(Context unavailable|上下文占用不可用)$/ })).toBeVisible();
	await page.getByRole("button", { name: /^(Configure model|配置模型)$/ }).click();
	const modelPopover = page.locator('[data-slot="popover-content"]');
	await modelPopover.getByRole("button", { name: /^(Model No models|模型 没有可用模型)$/ }).click();
	await modelPopover.getByRole("button", { name: /^(Configure model|配置模型)$/ }).click();
	const settingsDialog = page.getByRole("dialog", { name: /^(Settings|设置)$/ });
	await expect(settingsDialog).toBeVisible();
	await expect(
		settingsDialog.getByRole("switch", { name: /^(Automatic compaction|上下文自动压缩)$/ }),
	).toBeVisible();
	await expect(
		settingsDialog.locator(
			'[role="switch"][aria-label="Automatic retry on API failures"], [role="switch"][aria-label="API 故障自动重试"]',
		),
	).toHaveCount(0);
	await settingsDialog
		.getByRole("button", { name: /^(Close|关闭)$/ })
		.first()
		.click();
	const overflow = await pageOverflow(page);
	expect(overflow.htmlScrollWidth, JSON.stringify(overflow, null, 2)).toBeLessThanOrEqual(
		overflow.viewportWidth,
	);

	const processStatus = await harness.requestJson<{ state: string }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions/${encodeURIComponent(harness.session.sessionHandle)}/process`,
	);
	expect(processStatus.state).toBe("idle");
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("375px viewport has no page-level horizontal overflow", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("nav")).toBeVisible();
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	await page.locator("textarea").fill("Draft");
	const mainBox = await page.locator("main").boundingBox();
	expect(mainBox?.width ?? 0).toBeGreaterThan(250);

	const toolbar = page.getByTestId("composer-toolbar");
	await expect(toolbar).toBeVisible();
	await expectVisibleControlsInsideViewport(page.getByTestId("composer-card"), 375);
	await expect(page.getByRole("button", { name: /^(Send|发送)$/ })).toBeVisible();
	await expect(
		page.locator("header").getByRole("button", { name: /^(Empty session|空会话)$/ }),
	).toBeVisible();
	await expect(page.locator("header").getByText(/^(Ready|就绪)$/)).toBeVisible();
	await expect(page.getByRole("button", { name: /^(More session actions|更多会话操作)$/ })).toBeVisible();
	await page.getByRole("button", { name: /^(More session actions|更多会话操作)$/ }).click();
	await expect(page.getByRole("menuitem", { name: /^(Export HTML|导出 HTML)$/ })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /^(Delete session|删除会话)$/ })).toBeVisible();
	await page.keyboard.press("Escape");

	await page.locator("textarea").fill("E2E_A_SLOW");
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect(page.locator("header").getByText(/^(Running|运行中)$/)).toBeVisible();
	await page.getByRole("button", { name: /^(More session actions|更多会话操作)$/ }).click();
	const activeDelete = page.getByRole("menuitem", { name: /^(Delete session|删除会话)$/ });
	await expect(activeDelete).toBeDisabled();
	await expect(
		page.getByText(
			/^(Stop the running or waiting Session before deleting it\.|Session 正在运行或等待输入，停止后才能删除。)$/,
		),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.locator("textarea").fill("Queued draft");
	await expectVisibleControlsInsideViewport(page.getByTestId("composer-card"), 375);
	harness.releasePrompt("E2E_A_SLOW");
	await expect(page.locator("header").getByText(/^(Ready|就绪)$/)).toBeVisible();

	const moreActions = page.getByRole("button", {
		name: /^(More session actions|更多会话操作)$/,
	});
	await moreActions.click();
	await page.getByRole("menuitem", { name: /^(Delete session|删除会话)$/ }).click();
	const deleteDialog = page.getByRole("alertdialog", { name: /^(Delete session|删除会话)$/ });
	await expect(deleteDialog).toBeVisible();
	await expect(deleteDialog).toContainText(/recoverable trash|可恢复回收区/);
	await deleteDialog.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
	await expect(deleteDialog).toBeHidden();
	await expect
		.poll(async () => {
			const result = await harness.requestJson<{ sessions: unknown[] }>(
				`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions?refresh=1`,
			);
			return result.sessions.length;
		})
		.toBe(1);
	await moreActions.click();
	await page.getByRole("menuitem", { name: /^(Delete session|删除会话)$/ }).click();
	await deleteDialog.getByRole("button", { name: /^(Delete|删除)$/ }).click();
	await expect
		.poll(async () => {
			const result = await harness.requestJson<{ sessions: unknown[] }>(
				`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions?refresh=1`,
			);
			return result.sessions.length;
		})
		.toBe(0);

	const overflow = await pageOverflow(page);
	const diagnostic = JSON.stringify(overflow, null, 2);
	expect(overflow.viewportWidth).toBe(375);
	expect(overflow.htmlScrollWidth, diagnostic).toBeLessThanOrEqual(overflow.viewportWidth);
	expect(overflow.bodyScrollWidth, diagnostic).toBeLessThanOrEqual(overflow.viewportWidth);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
