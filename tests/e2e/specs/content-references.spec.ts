import type { Page } from "@playwright/test";
import {
	CANONICAL_CAPABILITIES,
	CANONICAL_CONTENT_REF_BUDGET,
	CANONICAL_PAYLOAD_BUDGET,
	CANONICAL_PROTOCOL_VERSION,
	CONTENT_REFERENCE_PROMPT,
	CONTENT_REFERENCE_READY_TEXT,
	collectContentRefs,
	contentReferenceHarnessOptions,
	contentRefFrames,
	contentRefUrl,
	observeWire,
	receivedWireFrames,
	sentWireFrames,
	serverHello,
} from "../fixtures/content-reference";
import { observePageErrors } from "../fixtures/page-observation";
import type { ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const LARGE_MARKERS = [
	"CONTENT_REFERENCE_TOOL_ARGS:BODY:START",
	"CONTENT_REFERENCE_PARTIAL_RESULT:BODY:START",
	"CONTENT_REFERENCE_TOOL_RESULT:BODY:START",
	"CONTENT_REFERENCE_TOOL_DETAILS:BODY:START",
	"CONTENT_REFERENCE_TOOL_TEXT:START",
	"CONTENT_REFERENCE_SET_EDITOR_TEXT:START",
	"CONTENT_REFERENCE_WIDGET_LINE_1:START",
	"CONTENT_REFERENCE_WIDGET_LINE_2:START",
	"CONTENT_REFERENCE_EDITOR_PREFILL:START",
];

test.describe("canonical content references", () => {
	test.use({ harnessOptions: contentReferenceHarnessOptions() });

	async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
		await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
		await expect(page.locator("#root > div")).toBeVisible();
		await expect(page.locator("textarea")).toBeEnabled();
	}

	async function sendContentReferencePrompt(page: Page): Promise<void> {
		await page.locator("textarea").fill(CONTENT_REFERENCE_PROMPT);
		await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	}

	async function dismissEditorDialog(page: Page): Promise<void> {
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.locator("textarea")).toHaveValue(/^CONTENT_REFERENCE_EDITOR_PREFILL:START/);
		await dialog.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
		await expect(page.getByText(CONTENT_REFERENCE_READY_TEXT, { exact: true })).toBeVisible();
		await expect(page.locator("textarea")).toHaveValue(/^CONTENT_REFERENCE_SET_EDITOR_TEXT:START/);
		await expect(page.getByText("CONTENT_REFERENCE_WIDGET_LINE_1:START", { exact: false })).toBeVisible();
	}

	function contentRequestUrls(requests: string[]): Set<string> {
		return new Set(requests);
	}

	test("negotiates raw 1.3 hello and keeps large roots off the WS until the UI asks", async ({
		page,
		harness,
	}) => {
		const errors = observePageErrors(page);
		const wire = observeWire(page);
		const contentRequests: Array<{ url: string; headers: Record<string, string> }> = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.startsWith("/api/v1/content/")) {
				contentRequests.push({ url: request.url(), headers: request.headers() });
			}
		});

		await openWorkbench(page, harness);
		await expect
			.poll(() => serverHello(wire))
			.toMatchObject({
				protocol: CANONICAL_PROTOCOL_VERSION,
				capabilities: expect.arrayContaining([...CANONICAL_CAPABILITIES]),
				payloadBudget: CANONICAL_PAYLOAD_BUDGET,
				contentRefBudget: CANONICAL_CONTENT_REF_BUDGET,
			});
		const hello = serverHello(wire);
		expect(new Set(hello?.capabilities as string[])).toEqual(new Set(CANONICAL_CAPABILITIES));
		expect(sentWireFrames(wire).find((frame) => frame.type === "client_hello")).toMatchObject({
			protocol: CANONICAL_PROTOCOL_VERSION,
			capabilities: CANONICAL_CAPABILITIES,
		});

		await sendContentReferencePrompt(page);
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
		const tool = page.getByRole("button", { name: /content-ref-edit/ }).first();
		await expect(tool).toBeVisible();
		await tool.click();
		await expect(page.locator("main")).toContainText("CONTENT_REFERENCE_TOOL_ARGS:BODY:START");
		await expect(page.locator("main")).toContainText("CONTENT_REFERENCE_TOOL_RESULT:BODY:START");
		await expect
			.poll(() => contentRequestUrls(contentRequests.map((request) => request.url)).size)
			.toBeGreaterThan(eagerUrls.size);

		await page.getByRole("button", { name: /^(Open in details panel|在详情面板中查看)$/ }).click();
		await expect(page.locator('[data-details-output-region="true"]').last()).toContainText(
			"CONTENT_REFERENCE_TOOL_TEXT:START",
		);
		expect(wire.sockets).toHaveLength(1);
		expect(wire.closed).toEqual([]);
		expect(errors.console).toEqual([]);
		expect(errors.page).toEqual([]);
	});

	test("replays refs and performs one exact cursorless recovery per failed lazy GET", async ({
		page,
		harness,
	}) => {
		const wire = observeWire(page);
		const contentRequests: string[] = [];
		await page.route("**/api/v1/content/**", async (route) => {
			contentRequests.push(route.request().url());
			await route.continue();
		});
		await openWorkbench(page, harness);
		await sendContentReferencePrompt(page);
		await expect.poll(() => contentRefFrames(wire).length).toBeGreaterThanOrEqual(1);
		await dismissEditorDialog(page);
		const readyRequestCount = contentRequests.length;

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("textarea")).toBeEnabled();
		const replaySession = page
			.locator("[data-session-row]")
			.filter({ hasText: CONTENT_REFERENCE_PROMPT })
			.first();
		await expect(replaySession).toBeVisible();
		await replaySession.getByRole("button").first().click();
		const replayTool = page.getByRole("button", { name: /content-ref-edit/ }).first();
		await expect(replayTool).toBeVisible();
		// A reload must not turn a collapsed historical tool into an eager content download.
		const beforeExpand = contentRequests.length;
		expect(beforeExpand).toBeGreaterThanOrEqual(readyRequestCount);

		let failureEnabled = false;
		let failureInjected = false;
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.route("**/api/v1/content/**", async (route) => {
			contentRequests.push(route.request().url());
			if (failureEnabled && !failureInjected) {
				failureInjected = true;
				await route.fulfill({ status: 410, contentType: "text/plain", body: "expired content" });
				return;
			}
			await route.continue();
		});
		failureEnabled = true;
		const eventStart = wire.events.length;
		await replayTool.click();
		await expect.poll(() => contentRequests.length).toBeGreaterThan(beforeExpand);
		await expect
			.poll(
				() =>
					wire.events
						.slice(eventStart)
						.filter(
							(event) =>
								event.direction === "sent" &&
								event.frame.type === "session_subscribe" &&
								!Object.hasOwn(event.frame, "cursor"),
						).length,
			)
			.toBe(1);
		await expect
			.poll(
				() =>
					wire.events
						.slice(eventStart)
						.some(
							(event) =>
								event.direction === "received" &&
								(event.frame.type === "session_snapshot" || event.frame.type === "session_snapshot_end"),
						),
				{ timeout: 30_000 },
			)
			.toBe(true);
		await page.waitForTimeout(250);
		expect(
			wire.events
				.slice(eventStart)
				.filter(
					(event) =>
						event.direction === "sent" &&
						event.frame.type === "session_subscribe" &&
						!Object.hasOwn(event.frame, "cursor"),
				),
		).toHaveLength(1);
	});

	for (const failure of ["gone", "metadata", "utf8", "json-field"] as const) {
		test(`rejects a ${failure} content response without an inline fallback`, async ({ page, harness }) => {
			const wire = observeWire(page);
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
			await sendContentReferencePrompt(page);
			await expect.poll(() => contentRefFrames(wire).length).toBeGreaterThanOrEqual(1);
			await dismissEditorDialog(page);
			failureEnabled = true;
			const tool = page.getByRole("button", { name: /content-ref-edit/ }).first();
			await tool.click();
			await expect.poll(() => lazyRequest).toBeDefined();
			const body = page.locator("main");
			expect(await body.innerText()).not.toContain("CONTENT_REFERENCE_TOOL_ARGS:BODY:START");
		});
	}

	test("aborts a hung lazy GET when the captured Session is no longer visible", async ({ page, harness }) => {
		const wire = observeWire(page);
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
		await sendContentReferencePrompt(page);
		await expect.poll(() => contentRefFrames(wire).length).toBeGreaterThanOrEqual(1);
		await dismissEditorDialog(page);
		hold = true;
		const eventStart = wire.events.length;
		const oldSessionHandle = sentWireFrames(wire).find(
			(event) => event.type === "session_subscribe",
		)?.sessionHandle;
		expect(oldSessionHandle).toEqual(expect.any(String));
		await page
			.getByRole("button", { name: /content-ref-edit/ })
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
