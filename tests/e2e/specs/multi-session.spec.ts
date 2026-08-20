import type { Page, WebSocket } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import type { HarnessSession, PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const A_PROMPT = "E2E_A_SLOW";
const B_PROMPT = "E2E_B_FAST";
const AFTER_IMAGE_PROMPT = "E2E_AFTER_IMAGE";

async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("nav")).toBeVisible();
	await expect(page.locator("main")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
}

async function sendPrompt(page: Page, message: string): Promise<void> {
	const textarea = page.locator("textarea");
	await textarea.fill(message);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

async function listSessions(harness: ProductionHarness): Promise<HarnessSession[]> {
	const result = await harness.requestJson<{ sessions: HarnessSession[] }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions`,
	);
	return result.sessions;
}

async function runtimeState(harness: ProductionHarness, sessionHandle: string): Promise<string> {
	const result = await harness.requestJson<{ state: string }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions/${encodeURIComponent(sessionHandle)}/process`,
	);
	return result.state;
}

function eventFor(
	harness: ProductionHarness,
	predicate: (event: PiFixtureEvent) => boolean,
): PiFixtureEvent | undefined {
	return harness.piEvents().find(predicate);
}

test("two Sessions in one Workspace stream independently while the user switches views", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	await openWorkbench(page, harness);

	const selectedARow = page.locator('[data-session-row][data-current="true"]');
	await expect(selectedARow).toHaveAttribute("data-runtime-state", "idle");
	await sendPrompt(page, A_PROMPT);
	await expect
		.poll(() => eventFor(harness, (event) => event.type === "prompt" && event.text === A_PROMPT))
		.toBeTruthy();
	const aPrompt = eventFor(harness, (event) => event.type === "prompt" && event.text === A_PROMPT);
	const aSession = (await listSessions(harness)).find(
		(session) => session.nativeSessionId === aPrompt?.sessionId,
	);
	expect(aSession, "the active fresh Session must materialize into the native directory").toBeDefined();
	if (!aSession) throw new Error("Active fresh Session was missing");
	await expect.poll(() => runtimeState(harness, aSession.sessionHandle)).toBe("running");
	await expect(selectedARow).toHaveAttribute("data-runtime-state", "running");

	const sidebar = page.locator("nav");
	await sidebar
		.getByRole("button", { name: /^(New session|新建会话)$/ })
		.first()
		.click();
	await expect.poll(async () => (await listSessions(harness)).length).toBe(3);
	await expect(page.locator("[data-session-row]")).toHaveCount(3);
	await expect(page.locator('[data-session-row][data-current="true"]')).toHaveCount(1);
	await expect(page.locator("textarea")).toBeEnabled();

	const selectedBRow = page.locator('[data-session-row][data-current="true"]');
	await expect(selectedBRow).toHaveAttribute("data-runtime-state", "idle");
	await sendPrompt(page, B_PROMPT);
	await expect(page.locator("main")).toContainText(`E2E_REPLY:${B_PROMPT}`);
	const bPrompt = eventFor(harness, (event) => event.type === "prompt" && event.text === B_PROMPT);
	const bSession = (await listSessions(harness)).find(
		(session) => session.nativeSessionId === bPrompt?.sessionId,
	);
	expect(bSession, "the second fresh Session must materialize into the native directory").toBeDefined();
	if (!bSession) throw new Error("Second fresh Session was missing");
	await expect.poll(() => runtimeState(harness, bSession.sessionHandle)).toBe("idle");
	await expect.poll(() => runtimeState(harness, aSession.sessionHandle)).toBe("running");
	await expect(page.locator("main").getByText(/^(Working…|处理中…)$/)).toHaveCount(0);
	await expect(page.locator("main").getByText(/^(Steer|插队)$/)).toHaveCount(0);
	await expect(page.locator("header").getByText(/^(Ready|就绪)$/)).toBeVisible();
	await expect(page.locator('[data-session-row][data-runtime-state="running"]')).toHaveCount(1);

	// A has emitted a real streaming delta while B remains the visible Session.
	await expect
		.poll(() => Boolean(eventFor(harness, (event) => event.type === "delta" && event.text === A_PROMPT)))
		.toBe(true);
	await expect(page.locator("main")).not.toContainText(`E2E_REPLY:${A_PROMPT}`);

	// Let A finish entirely in the background, then reopen it and recover the completed projection.
	harness.releasePrompt(A_PROMPT);
	await expect
		.poll(() => Boolean(eventFor(harness, (event) => event.type === "settled" && event.text === A_PROMPT)))
		.toBe(true);
	await expect.poll(() => runtimeState(harness, aSession.sessionHandle)).toBe("idle");
	await expect(page.locator("main")).not.toContainText(`E2E_REPLY:${A_PROMPT}`);
	const aRow = page.locator("[data-session-row]").filter({ hasText: A_PROMPT });
	await expect(aRow).toBeVisible();
	await expect(aRow).toHaveAttribute("data-unread", "true");
	const bRow = page.locator("[data-session-row]").filter({ hasText: B_PROMPT });
	await expect(bRow).toHaveCount(1);
	await aRow.getByRole("button").first().click();
	await expect(aRow).toHaveAttribute("data-unread", "false");
	await expect(page.locator("main")).toContainText(`E2E_REPLY:${A_PROMPT}`);
	await expect(page.locator("main")).not.toContainText(`E2E_REPLY:${B_PROMPT}`);
	await expect(page.locator("main").getByText(/^(Working…|处理中…)$/)).toHaveCount(0);
	await expect(page.locator("main").getByText(/^(Steer|插队)$/)).toHaveCount(0);

	// B remains independently addressable after A's background completion.
	await bRow.getByRole("button").first().click();
	await expect(page.locator("main")).toContainText(`E2E_REPLY:${B_PROMPT}`);
	await expect(page.locator("main")).not.toContainText(`E2E_REPLY:${A_PROMPT}`);

	expect(aPrompt?.sessionId).toBe(aSession.nativeSessionId);
	expect(bPrompt?.sessionId).toBe(bSession.nativeSessionId);
	expect(aPrompt?.pid).not.toBe(bPrompt?.pid);
	expect(
		new Set(
			harness
				.piEvents()
				.filter((event) => event.type === "started")
				.map((event) => event.pid),
		).size,
	).toBeGreaterThanOrEqual(2);

	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("an image-only prompt is delivered and the same WebSocket remains usable", async ({ page, harness }) => {
	const errors = observePageErrors(page);
	const sockets: WebSocket[] = [];
	const closedSockets: string[] = [];
	page.on("websocket", (socket) => {
		sockets.push(socket);
		socket.on("close", () => closedSockets.push(socket.url()));
	});
	await openWorkbench(page, harness);

	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZqxQAAAAASUVORK5CYII=",
		"base64",
	);
	await page.locator("#piweb-image-input").setInputFiles({
		name: "one-pixel.png",
		mimeType: "image/png",
		buffer: png,
	});
	await expect(page.getByAltText(/^(Attachment 1|附件 1)$/)).toBeVisible();
	await expect(page.locator("textarea")).toHaveValue("");
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();

	await expect(page.getByAltText(/^(Attachment image 1|附件图片 1)$/)).toBeVisible();
	await expect(page.locator("main")).toContainText("E2E_IMAGE_OK:1:image/png");
	await expect
		.poll(() =>
			eventFor(harness, (event) => event.type === "prompt" && event.text === "" && event.imageCount === 1),
		)
		.toMatchObject({
			imageCount: 1,
			imageMimeTypes: ["image/png"],
			imageChars: png.toString("base64").length,
		});
	const imagePrompt = eventFor(
		harness,
		(event) => event.type === "prompt" && event.text === "" && event.imageCount === 1,
	);
	const imageSession = (await listSessions(harness)).find(
		(session) => session.nativeSessionId === imagePrompt?.sessionId,
	);
	expect(imageSession, "the image Session must materialize into the native directory").toBeDefined();
	if (!imageSession) throw new Error("Image Session was missing");
	await expect.poll(() => runtimeState(harness, imageSession.sessionHandle)).toBe("idle");

	// A second command proves that the image frame neither closed nor poisoned the multiplexed socket.
	await sendPrompt(page, AFTER_IMAGE_PROMPT);
	await expect(page.locator("main")).toContainText(`E2E_REPLY:${AFTER_IMAGE_PROMPT}`);
	await expect.poll(() => runtimeState(harness, imageSession.sessionHandle)).toBe("idle");
	expect(sockets).toHaveLength(1);
	expect(closedSockets).toEqual([]);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
