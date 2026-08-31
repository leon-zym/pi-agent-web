import type { Browser, BrowserContext, Page } from "@playwright/test";
import { observeWire, receivedWireFrames } from "../fixtures/content-reference";
import { observePageErrors } from "../fixtures/page-observation";
import type { PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const RUNNING_PROMPT = "E2E_A_SLOW_OBSERVER";
const EXTENSION_PROMPT = "E2E_EXTENSION_CONFIRM";

async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
}

async function sendPrompt(page: Page, message: string): Promise<void> {
	await page.locator("textarea").fill(message);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

function fixtureEvent(
	harness: ProductionHarness,
	predicate: (event: PiFixtureEvent) => boolean,
): PiFixtureEvent | undefined {
	return harness.piEvents().find(predicate);
}

async function isolatedPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext();
	return { context, page: await context.newPage() };
}

async function closeContexts(...contexts: BrowserContext[]): Promise<void> {
	await Promise.all(contexts.map(async (context) => context.close()));
}

test("two Browser contexts characterize the current controller-only Session surface", async ({
	browser,
	harness,
}) => {
	const owner = await isolatedPage(browser);
	const observer = await isolatedPage(browser);
	const ownerErrors = observePageErrors(owner.page);
	const observerErrors = observePageErrors(observer.page);
	const observerWire = observeWire(observer.page);
	try {
		await openWorkbench(owner.page, harness);
		await sendPrompt(owner.page, RUNNING_PROMPT);
		await expect
			.poll(() =>
				Boolean(fixtureEvent(harness, (event) => event.type === "delta" && event.text === RUNNING_PROMPT)),
			)
			.toBe(true);

		await observer.page.goto(harness.origin, { waitUntil: "domcontentloaded" });
		const sessionRow = observer.page.locator("[data-session-row]").filter({ hasText: RUNNING_PROMPT });
		await expect(sessionRow).toBeVisible();
		await sessionRow.getByRole("button").first().click();
		await expect(observer.page.locator("textarea")).toBeDisabled();
		await expect(observer.page.locator("textarea")).toHaveAttribute(
			"placeholder",
			/^(Read-only in this tab|当前标签页为只读模式)$/,
		);
		await expect(observer.page.getByRole("button", { name: /^(Take over|接管)$/ })).toHaveCount(0);

		harness.releasePrompt(RUNNING_PROMPT);
		await expect(owner.page.locator("main")).toContainText(`E2E_REPLY:${RUNNING_PROMPT}`);
		await expect(observer.page.locator("main")).toContainText(`E2E_REPLY:${RUNNING_PROMPT}`);
		await expect(owner.page.locator("textarea")).toBeEnabled();

		const observerExtensionMark = observerWire.events.length;
		await sendPrompt(owner.page, EXTENSION_PROMPT);
		const ownerDialog = owner.page.getByRole("dialog", { name: "Synthetic approval" });
		await expect(ownerDialog).toBeVisible();
		await expect
			.poll(() =>
				receivedWireFrames({
					...observerWire,
					events: observerWire.events.slice(observerExtensionMark),
				}).some((frame) => {
					if (frame.type !== "extension_ui_request") return false;
					const request = frame.request;
					if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
					const requestRecord = request as Record<string, unknown>;
					return requestRecord.title === "Synthetic approval" && requestRecord.method === "confirm";
				}),
			)
			.toBe(true);
		await expect(observer.page.locator("header").getByText(/^(Waiting for input|等待输入)$/)).toBeVisible();
		await expect(observer.page.getByRole("dialog", { name: "Synthetic approval" })).toHaveCount(0);
		expect(
			observerWire.events
				.slice(observerExtensionMark)
				.filter((event) => event.direction === "sent" && event.frame.type === "extension_ui_response"),
		).toEqual([]);
		await expect(observer.page.locator("textarea")).toBeDisabled();
		await expect(observer.page.getByRole("button", { name: /^(Take over|接管)$/ })).toHaveCount(0);

		await ownerDialog.getByRole("button", { name: /^(Confirm|确认)$/ }).click();
		await expect(
			owner.page.locator("main").getByText("E2E_EXTENSION_CONFIRMED", { exact: true }),
		).toBeVisible();
		await expect
			.poll(() =>
				fixtureEvent(
					harness,
					(event) => event.type === "extension_response" && event.text === EXTENSION_PROMPT,
				),
			)
			.toMatchObject({ confirmed: true });
		expect(ownerErrors.console).toEqual([]);
		expect(ownerErrors.page).toEqual([]);
		expect(observerErrors.console).toEqual([]);
		expect(observerErrors.page).toEqual([]);
	} finally {
		await closeContexts(owner.context, observer.context);
	}
});
