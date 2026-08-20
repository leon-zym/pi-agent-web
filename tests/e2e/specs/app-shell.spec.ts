import { bootstrapBrowserSession, observePageErrors, pageOverflow } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

test("packaged app bootstraps and renders the workbench without browser errors", async ({
	page,
	harness,
}) => {
	expect(await bootstrapBrowserSession(page, harness.origin)).toBe(200);
	const errors = observePageErrors(page);
	const bootstrapResponse = page.waitForResponse(
		(response) => response.url() === `${harness.origin}/api/v1/bootstrap`,
	);

	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	expect((await bootstrapResponse).status()).toBe(200);
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("nav")).toBeVisible();
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeVisible();

	const processStatus = await harness.requestJson<{ state: string }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.id)}/process`,
	);
	expect(processStatus.state).toBe("running");
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("375px viewport has no page-level horizontal overflow", async ({ page, harness }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	expect(await bootstrapBrowserSession(page, harness.origin)).toBe(200);
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();

	const overflow = await pageOverflow(page);
	const diagnostic = JSON.stringify(overflow, null, 2);
	expect(overflow.viewportWidth).toBe(375);
	expect(overflow.htmlScrollWidth, diagnostic).toBeLessThanOrEqual(overflow.viewportWidth);
	expect(overflow.bodyScrollWidth, diagnostic).toBeLessThanOrEqual(overflow.viewportWidth);
});
