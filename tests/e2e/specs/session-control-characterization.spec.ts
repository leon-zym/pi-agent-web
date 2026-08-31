import type { Browser, BrowserContext, Page } from "@playwright/test";
import { observeWire, receivedWireFrames } from "../fixtures/content-reference";
import {
	dropControlledWebSockets,
	installWebSocketDropControl,
	observePageErrors,
} from "../fixtures/page-observation";
import type { PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const RUNNING_PROMPT = "E2E_A_SLOW_OBSERVER";
const EXTENSION_PROMPT = "E2E_EXTENSION_CONFIRM";
const SECOND_PROMPT = "E2E_B_FAST";
const OBSERVER_EVIDENCE_KEY = "__piwebSessionControlAcceptanceEvidence";

interface ObserverPageEvidence {
	dialogSeen: boolean;
	extensionResponses: Record<string, unknown>[];
}

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

async function installObserverEvidenceRecorder(page: Page): Promise<void> {
	await page.addInitScript((evidenceKey: string) => {
		const evidence = { dialogSeen: false, extensionResponses: [] as Record<string, unknown>[] };
		Object.defineProperty(window, evidenceKey, { value: evidence });

		const matchesSyntheticApprovalDialog = (element: Element): boolean => {
			if (element.getAttribute("role") !== "dialog") return false;
			const labelledBy = element.getAttribute("aria-labelledby");
			const labelledText = labelledBy
				?.split(/\s+/)
				.map((id) => document.getElementById(id)?.textContent ?? "")
				.join(" ");
			return [element.getAttribute("aria-label"), labelledText, element.textContent].some((text) =>
				text?.includes("Synthetic approval"),
			);
		};
		const inspectElement = (element: Element): void => {
			if (matchesSyntheticApprovalDialog(element)) evidence.dialogSeen = true;
			for (const dialog of element.querySelectorAll('[role="dialog"]')) {
				if (matchesSyntheticApprovalDialog(dialog)) evidence.dialogSeen = true;
			}
		};
		const inspectCurrentDialogs = (): void => {
			for (const dialog of document.querySelectorAll('[role="dialog"]')) inspectElement(dialog);
		};
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.target instanceof Element) inspectElement(record.target);
				for (const node of record.addedNodes) {
					if (node instanceof Element) inspectElement(node);
				}
			}
			inspectCurrentDialogs();
		});
		observer.observe(document, { attributes: true, characterData: true, childList: true, subtree: true });
		inspectCurrentDialogs();

		const nativeSend = WebSocket.prototype.send;
		WebSocket.prototype.send = function (payload): void {
			if (typeof payload === "string") {
				try {
					const parsed = JSON.parse(payload) as unknown;
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						const frame = parsed as Record<string, unknown>;
						if (frame.type === "extension_ui_response") evidence.extensionResponses.push(frame);
					}
				} catch {}
			}
			nativeSend.call(this, payload);
		};
	}, OBSERVER_EVIDENCE_KEY);
}

async function observerEvidence(page: Page): Promise<ObserverPageEvidence> {
	return page.evaluate((evidenceKey: string) => {
		const evidence = (window as unknown as Record<string, unknown>)[evidenceKey];
		if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
			throw new Error("observer evidence recorder was not installed");
		}
		const record = evidence as Record<string, unknown>;
		if (typeof record.dialogSeen !== "boolean" || !Array.isArray(record.extensionResponses)) {
			throw new Error("observer evidence recorder has an invalid shape");
		}
		return {
			dialogSeen: record.dialogSeen,
			extensionResponses: record.extensionResponses as Record<string, unknown>[],
		};
	}, OBSERVER_EVIDENCE_KEY);
}

test("two Browser contexts expose fenced Session control and preserve pending work", async ({
	browser,
	harness,
}) => {
	const owner = await isolatedPage(browser);
	const observer = await isolatedPage(browser);
	const ownerErrors = observePageErrors(owner.page);
	const observerErrors = observePageErrors(observer.page);
	await installWebSocketDropControl(observer.page);
	await installObserverEvidenceRecorder(owner.page);
	await installObserverEvidenceRecorder(observer.page);
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
		await expect(observer.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"view_only",
		);
		await expect(observer.page.locator("textarea")).toBeDisabled();
		await expect(observer.page.locator("textarea")).toHaveAttribute(
			"placeholder",
			/^(Read-only in this tab|当前标签页为只读模式)$/,
		);
		const observerComposerControl = observer.page.getByTestId("composer-session-control");
		await expect(observerComposerControl).toContainText(/(Another page controls|另一个页面正在控制)/);
		await expect(
			observerComposerControl.getByRole("button", { name: /^(Take over Session|接管 Session)$/ }),
		).toBeVisible();

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
		const observerDialog = observer.page.getByRole("dialog", { name: "Synthetic approval" });
		await expect(observerDialog).toBeVisible();
		await expect(observerDialog.getByRole("button", { name: /^(Confirm|确认)$/ })).toBeDisabled();
		await expect(observerDialog).toContainText(/(remaining|剩余|Expires|超时)/);
		const observerExtensionControl = observerDialog.getByTestId("extension-session-control");
		await expect(observerExtensionControl).toContainText(/(Another page controls|另一个页面正在控制)/);
		await expect(
			observerExtensionControl.getByRole("button", { name: /^(Take over Session|接管 Session)$/ }),
		).toBeVisible();
		await observerExtensionControl
			.getByRole("button", { name: /^(Take over Session|接管 Session)$/ })
			.click();

		await expect(observer.page.getByRole("alertdialog")).toBeVisible();
		const takeoverConfirmation = observer.page.getByRole("alertdialog");
		await expect(takeoverConfirmation).toContainText(/(only the current Session|当前 Session)/);
		await expect(takeoverConfirmation).toContainText(/(does not stop the Agent|不会停止 Agent)/);
		await expect(takeoverConfirmation).toContainText(
			/(previous page becomes read-only|之前的页面会变为只读)/,
		);
		await expect(takeoverConfirmation).toContainText(
			/(work already admitted continues|已经接纳的工作会继续执行)/,
		);
		await takeoverConfirmation.getByRole("button", { name: /^(Take over Session|接管 Session)$/ }).click();

		await expect(observer.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"controller",
		);
		await expect(owner.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"view_only",
		);
		await expect(owner.page.locator("textarea")).toBeDisabled();
		await expect(ownerDialog.getByRole("button", { name: /^(Confirm|确认)$/ })).toBeDisabled();
		await expect(owner.page.getByTestId("composer-session-control")).toContainText(
			/(lost control|失去当前 Session 的控制权)/,
		);
		await expect(observerDialog.getByRole("button", { name: /^(Confirm|确认)$/ })).toBeEnabled();
		await observerDialog.getByRole("button", { name: /^(Confirm|确认)$/ }).click();

		await expect(
			owner.page.locator("main").getByText("E2E_EXTENSION_CONFIRMED", { exact: true }),
		).toBeVisible();
		await expect(
			observer.page.locator("main").getByText("E2E_EXTENSION_CONFIRMED", { exact: true }),
		).toBeVisible();
		expect(await observerEvidence(owner.page)).toMatchObject({ dialogSeen: true, extensionResponses: [] });
		expect(await observerEvidence(observer.page)).toMatchObject({ dialogSeen: true });
		expect((await observerEvidence(observer.page)).extensionResponses).toHaveLength(1);
		await expect(observer.page.locator("textarea")).toBeDisabled();
		await expect
			.poll(() =>
				fixtureEvent(
					harness,
					(event) => event.type === "extension_response" && event.text === EXTENSION_PROMPT,
				),
			)
			.toMatchObject({ confirmed: true });

		// A separate Session may still be controlled by the former owner while the takeover
		// recipient remains in control of the original Session.
		await owner.page
			.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
			.getByRole("button", { name: /^(New session|新建会话)$/ })
			.first()
			.click();
		await expect(owner.page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
		await sendPrompt(owner.page, SECOND_PROMPT);
		await expect(owner.page.locator("main")).toContainText(`E2E_REPLY:${SECOND_PROMPT}`);
		await expect(owner.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"controller",
		);
		await expect(observer.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"controller",
		);

		// Reload and an explicit socket drop must recover the same controller affordance.
		await observer.page.reload({ waitUntil: "domcontentloaded" });
		await expect(observer.page.locator("main")).toBeVisible();
		const reopenedOriginalRow = observer.page
			.locator("[data-session-row]")
			.filter({ hasText: RUNNING_PROMPT });
		await expect(reopenedOriginalRow).toBeVisible();
		await reopenedOriginalRow.getByRole("button").first().click();
		await expect(observer.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"controller",
		);
		await expect(observer.page.locator("textarea")).toBeEnabled();
		const socketsBeforeDrop = observerWire.sockets.length;
		await dropControlledWebSockets(observer.page);
		await expect(observer.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"reconnecting",
		);
		await expect(observer.page.locator("textarea")).toBeDisabled();
		await expect.poll(() => observerWire.sockets.length).toBeGreaterThan(socketsBeforeDrop);
		await expect(observer.page.getByTestId("session-control-status")).toHaveAttribute(
			"data-session-control-mode",
			"controller",
		);
		await expect(observer.page.locator("textarea")).toBeEnabled();
		expect(await observer.page.locator("main").textContent()).not.toContain(SECOND_PROMPT);
		expect(ownerErrors.console).toEqual([]);
		expect(ownerErrors.page).toEqual([]);
		expect(observerErrors.console).toEqual([]);
		expect(observerErrors.page).toEqual([]);
	} finally {
		await closeContexts(owner.context, observer.context);
	}
});
