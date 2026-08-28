import type { Page } from "@playwright/test";
import {
	collectContentRefs,
	contentRefFrames,
	contentRefUrl,
	FUTURE_CAPABILITIES,
	FUTURE_CONTENT_PROMPT,
	FUTURE_CONTENT_REF_BUDGET,
	FUTURE_PAYLOAD_BUDGET,
	FUTURE_PROTOCOL_MINOR,
	FUTURE_READY_TEXT,
	futureFixtureHarnessOptions,
	futureHello,
	observeFutureWire,
	privateL3Enabled,
	receivedWireFrames,
	sentWireFrames,
} from "../fixtures/future-content-ref";
import { observePageErrors } from "../fixtures/page-observation";
import type { ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const LARGE_MARKERS = [
	"FUTURE_TOOL_ARGS:BODY:START",
	"FUTURE_PARTIAL_RESULT:BODY:START",
	"FUTURE_TOOL_RESULT:BODY:START",
	"FUTURE_TOOL_DETAILS:BODY:START",
	"FUTURE_TOOL_TEXT:START",
	"FUTURE_SET_EDITOR_TEXT:START",
	"FUTURE_WIDGET_LINE_1:START",
	"FUTURE_WIDGET_LINE_2:START",
	"FUTURE_EDITOR_PREFILL:START",
];

test.describe("private protocol 1.3/L3 content references", () => {
	test.skip(
		!privateL3Enabled(),
		"Private L3 is disabled. Run only against a 7E-activated Gateway with PI_WEB_E2E_PRIVATE_L3=1.",
	);
	test.use({ harnessOptions: futureFixtureHarnessOptions() });

	async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
		await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
		await expect(page.locator("#root > div")).toBeVisible();
		await expect(page.locator("textarea")).toBeEnabled();
	}

	async function sendFuturePrompt(page: Page): Promise<void> {
		await page.locator("textarea").fill(FUTURE_CONTENT_PROMPT);
		await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	}

	async function dismissEditorDialog(page: Page): Promise<void> {
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.locator("textarea")).toHaveValue(/^FUTURE_EDITOR_PREFILL:START/);
		await dialog.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
		await expect(page.getByText(FUTURE_READY_TEXT, { exact: true })).toBeVisible();
		await expect(page.locator("textarea")).toHaveValue(/^FUTURE_SET_EDITOR_TEXT:START/);
		await expect(page.getByText("FUTURE_WIDGET_LINE_1:START", { exact: false })).toBeVisible();
	}

	function contentRequestUrls(requests: string[]): Set<string> {
		return new Set(requests);
	}

	test("negotiates raw 1.3 hello and keeps large roots off the WS until the UI asks", async ({
		page,
		harness,
	}) => {
		const errors = observePageErrors(page);
		const wire = observeFutureWire(page);
		const contentRequests: Array<{ url: string; headers: Record<string, string> }> = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.startsWith("/api/v1/content/")) {
				contentRequests.push({ url: request.url(), headers: request.headers() });
			}
		});

		await openWorkbench(page, harness);
		await expect
			.poll(() => futureHello(wire))
			.toMatchObject({
				protocol: { major: 1, minor: FUTURE_PROTOCOL_MINOR },
				capabilities: FUTURE_CAPABILITIES,
				payloadBudget: FUTURE_PAYLOAD_BUDGET,
				contentRefBudget: FUTURE_CONTENT_REF_BUDGET,
			});
		const hello = futureHello(wire);
		expect(hello?.capabilities).toEqual(FUTURE_CAPABILITIES);
		expect(sentWireFrames(wire).find((frame) => frame.type === "client_hello")).toMatchObject({
			protocol: { major: 1, minor: FUTURE_PROTOCOL_MINOR },
			capabilities: FUTURE_CAPABILITIES,
		});

		await sendFuturePrompt(page);
		await expect.poll(() => contentRefFrames(wire).length).toBeGreaterThanOrEqual(1);
		await dismissEditorDialog(page);

		const refs = collectContentRefs(wire);
		const uniqueRefs = [...new Map(refs.map((ref) => [contentRefUrl(harness.origin, ref), ref])).values()];
		expect(uniqueRefs.length).toBeGreaterThanOrEqual(7);
		const receivedRaw = wire.events
			.filter((event) => event.direction === "received")
			.map((event) => event.raw)
			.join("\n");
		for (const marker of LARGE_MARKERS) expect(receivedRaw).not.toContain(marker);
		expect(receivedWireFrames(wire).some((frame) => frame.type === "event")).toBe(true);

		// Extension roots are eager; tool/message roots remain lazy while collapsed.
		const eagerUrls = contentRequestUrls(contentRequests.map((request) => request.url));
		expect(eagerUrls.size).toBeGreaterThanOrEqual(3);
		expect(eagerUrls.size).toBeLessThan(uniqueRefs.length);
		for (const request of contentRequests) {
			const url = request.url;
			expect(uniqueRefs.some((ref) => contentRefUrl(harness.origin, ref) === url)).toBe(true);
			expect(request.headers.accept).toBe("application/octet-stream");
		}
		const tool = page.getByRole("button", { name: /future-edit/ }).first();
		await expect(tool).toBeVisible();
		await tool.click();
		await expect(page.locator("main")).toContainText("FUTURE_TOOL_ARGS:BODY:START");
		await expect(page.locator("main")).toContainText("FUTURE_TOOL_RESULT:BODY:START");
		await expect
			.poll(() => contentRequestUrls(contentRequests.map((request) => request.url)).size)
			.toBeGreaterThan(eagerUrls.size);

		await page.getByRole("button", { name: /^(Open in details panel|在详情面板中查看)$/ }).click();
		await expect(page.locator('[data-details-output-region="true"]').last()).toContainText(
			"FUTURE_TOOL_TEXT:START",
		);
		expect(wire.sockets).toHaveLength(1);
		expect(wire.closed).toEqual([]);
		expect(errors.console).toEqual([]);
		expect(errors.page).toEqual([]);
	});

	test("replays future refs and performs one exact cursorless recovery per failed lazy GET", async ({
		page,
		harness,
	}) => {
		const wire = observeFutureWire(page);
		const contentRequests: string[] = [];
		await page.route("**/api/v1/content/**", async (route) => {
			contentRequests.push(route.request().url());
			await route.continue();
		});
		await openWorkbench(page, harness);
		await sendFuturePrompt(page);
		await expect.poll(() => contentRefFrames(wire).length).toBeGreaterThanOrEqual(1);
		await dismissEditorDialog(page);
		const readyRequestCount = contentRequests.length;

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("textarea")).toBeEnabled();
		const replaySession = page
			.locator("[data-session-row]")
			.filter({ hasText: FUTURE_CONTENT_PROMPT })
			.first();
		await expect(replaySession).toBeVisible();
		await replaySession.getByRole("button").first().click();
		const replayTool = page.getByRole("button", { name: /future-edit/ }).first();
		await expect(replayTool).toBeVisible();
		// A reload must not turn a collapsed historical tool into an eager content download.
		const beforeExpand = contentRequests.length;
		expect(beforeExpand).toBeGreaterThanOrEqual(readyRequestCount);

		let failed = false;
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.route("**/api/v1/content/**", async (route) => {
			contentRequests.push(route.request().url());
			if (failed) {
				await route.fulfill({ status: 410, contentType: "text/plain", body: "expired future content" });
				return;
			}
			await route.continue();
		});
		failed = true;
		const eventStart = wire.events.length;
		await replayTool.click();
		await expect.poll(() => contentRequests.length).toBeGreaterThan(beforeExpand);
		await expect
			.poll(
				() =>
					wire.events
						.slice(eventStart)
						.filter((event) => event.direction === "sent" && event.frame.type === "session_subscribe").length,
			)
			.toBe(1);
		const recoverySubscriptions = wire.events
			.slice(eventStart)
			.filter((event) => event.direction === "sent" && event.frame.type === "session_subscribe");
		expect(recoverySubscriptions[0]?.frame).not.toHaveProperty("cursor");
		await expect
			.poll(() =>
				wire.events
					.slice(eventStart)
					.some((event) => event.direction === "received" && event.frame.type === "session_snapshot"),
			)
			.toBe(true);
		await page.waitForTimeout(250);
		expect(
			wire.events
				.slice(eventStart)
				.filter((event) => event.direction === "sent" && event.frame.type === "session_subscribe"),
		).toHaveLength(1);
	});

	for (const failure of ["gone", "metadata", "utf8", "json-field"] as const) {
		test(`rejects a ${failure} content response without an inline fallback`, async ({ page, harness }) => {
			const wire = observeFutureWire(page);
			let lazyRequest: string | undefined;
			let failureEnabled = false;
			await page.route("**/api/v1/content/**", async (route) => {
				if (!failureEnabled) {
					await route.continue();
					return;
				}
				lazyRequest = route.request().url();
				const ref = collectContentRefs(wire).find(
					(candidate) => contentRefUrl(harness.origin, candidate) === lazyRequest,
				);
				if (!ref) throw new Error(`failed to map exact content URL: ${lazyRequest}`);
				if (failure === "gone") {
					await route.fulfill({ status: 410, contentType: "text/plain", body: "gone" });
					return;
				}
				if (failure === "metadata") {
					await route.fulfill({
						status: 200,
						headers: { "Content-Type": "text/plain", "Content-Length": String(ref.byteLength) },
						body: Buffer.alloc(ref.byteLength, 0x61),
					});
					return;
				}
				if (failure === "utf8") {
					const body = Buffer.alloc(ref.byteLength, 0x61);
					body[0] = 0xc3;
					body[1] = 0x28;
					await route.fulfill({ status: 200, headers: validContentHeaders(ref.byteLength), body });
					return;
				}
				const json = Buffer.from(JSON.stringify({ unexpected: "field" }).padEnd(ref.byteLength, " "), "utf8");
				await route.fulfill({ status: 200, headers: validContentHeaders(ref.byteLength), body: json });
			});
			await openWorkbench(page, harness);
			await sendFuturePrompt(page);
			await expect.poll(() => contentRefFrames(wire).length).toBeGreaterThanOrEqual(1);
			await dismissEditorDialog(page);
			failureEnabled = true;
			const tool = page.getByRole("button", { name: /future-edit/ }).first();
			await tool.click();
			await expect.poll(() => lazyRequest).toBeDefined();
			const body = page.locator("main");
			expect(await body.innerText()).not.toContain("FUTURE_TOOL_ARGS:BODY:START");
		});
	}

	test("aborts a hung lazy GET when the captured Session is no longer visible", async ({ page, harness }) => {
		const wire = observeFutureWire(page);
		let hold = false;
		let heldRequest: string | undefined;
		const failedRequests: string[] = [];
		page.on("requestfailed", (request) => {
			if (request.url().includes("/api/v1/content/")) failedRequests.push(request.url());
		});
		await page.route("**/api/v1/content/**", async (route) => {
			if (!hold) {
				await route.continue();
				return;
			}
			heldRequest = route.request().url();
			await new Promise<void>(() => {});
		});
		await openWorkbench(page, harness);
		await sendFuturePrompt(page);
		await expect.poll(() => contentRefFrames(wire).length).toBeGreaterThanOrEqual(1);
		await dismissEditorDialog(page);
		hold = true;
		const eventStart = wire.events.length;
		const oldSessionHandle = sentWireFrames(wire).find(
			(event) => event.type === "session_subscribe",
		)?.sessionHandle;
		expect(oldSessionHandle).toEqual(expect.any(String));
		await page
			.getByRole("button", { name: /future-edit/ })
			.first()
			.click();
		await expect.poll(() => heldRequest).toBeDefined();
		await page
			.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
			.getByRole("button", { name: /^(New session|新建会话)$/ })
			.first()
			.click();
		await expect(page.locator("textarea")).toBeEnabled();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await expect.poll(() => failedRequests.length).toBeGreaterThanOrEqual(1);
		await page.waitForTimeout(250);
		expect(
			wire.events
				.slice(eventStart)
				.filter(
					(event) =>
						event.frame.type === "session_subscribe" && event.frame.sessionHandle === oldSessionHandle,
				),
		).toHaveLength(0);
	});
});

function validContentHeaders(byteLength: number): Record<string, string> {
	return {
		"Cache-Control": "no-store",
		"Content-Length": String(byteLength),
		"Content-Type": "application/octet-stream",
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
	};
}
