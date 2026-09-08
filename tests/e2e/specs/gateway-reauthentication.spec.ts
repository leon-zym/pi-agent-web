import type {
	InlineSessionWsServerMessage,
	SessionWsClientMessage,
} from "../../../packages/protocol/src/index";
import { installWebSocketDropControl, sendControlledWebSocketFrame } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

test("the same document reauthenticates after Gateway restart and preserves its draft", async ({
	page,
	harness,
}) => {
	const sent: SessionWsClientMessage[] = [];
	const received: InlineSessionWsServerMessage[] = [];
	const epochs: string[] = [];
	let bootstrapRequests = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/v1/bootstrap") bootstrapRequests += 1;
	});
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload))));
		socket.on("framereceived", ({ payload }) => {
			const frame = JSON.parse(String(payload));
			if (frame.type === "server_hello") epochs.push(frame.serverEpoch);
			else received.push(frame);
		});
	});
	await installWebSocketDropControl(page);
	await page.goto(harness.origin);
	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled();
	await textarea.fill("E2E_BEFORE_GATEWAY_RESTART");
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect(page.locator("main")).toContainText("E2E_REPLY:E2E_BEFORE_GATEWAY_RESTART");
	const oldCommand = sent.find((frame) => frame.type === "command" && frame.command.type === "prompt");
	if (oldCommand?.type !== "command") throw new Error("Missing pre-restart prompt authority");
	const oldEpoch = epochs.at(-1);
	const bootstrapsBefore = bootstrapRequests;
	await textarea.fill("E2E_DRAFT_AFTER_GATEWAY_RESTART");
	await page.evaluate(() => {
		document.documentElement.dataset.sameDocument = "preserved";
	});

	// No Browser cookie helper or page reload is permitted here.
	await harness.restart();
	await expect(textarea).toBeEnabled({ timeout: 25_000 });
	await expect(textarea).toHaveValue("E2E_DRAFT_AFTER_GATEWAY_RESTART");
	await expect(page.locator("html")).toHaveAttribute("data-same-document", "preserved");
	expect(bootstrapRequests).toBeGreaterThan(bootstrapsBefore);
	expect(epochs.at(-1)).not.toBe(oldEpoch);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect(page.locator("main")).toContainText("E2E_REPLY:E2E_DRAFT_AFTER_GATEWAY_RESTART");
	const newCommand = sent.findLast((frame) => frame.type === "command" && frame.command.type === "prompt");
	if (newCommand?.type !== "command") throw new Error("Missing recovered prompt authority");
	expect(newCommand.sessionHandle).toBe(oldCommand.sessionHandle);
	expect(newCommand.fencingToken).not.toBe(oldCommand.fencingToken);
	await sendControlledWebSocketFrame(page, {
		...newCommand,
		fencingToken: oldCommand.fencingToken,
		command: { id: "stale-restart-fence", type: "prompt", message: "E2E_STALE_RESTART_FENCE" },
	});
	await expect
		.poll(() =>
			received.find((frame) => frame.type === "response" && frame.response.id === "stale-restart-fence"),
		)
		.toMatchObject({ response: { success: false } });
	expect(
		harness.piEvents().filter((event) => event.type === "prompt" && event.text === "E2E_STALE_RESTART_FENCE"),
	).toHaveLength(0);
	expect(
		harness
			.piEvents()
			.filter((event) => event.type === "prompt" && event.text === "E2E_DRAFT_AFTER_GATEWAY_RESTART"),
	).toHaveLength(1);
});
