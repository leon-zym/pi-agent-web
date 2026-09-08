import { expect, test } from "../fixtures/test";

test.use({ harnessOptions: { extraEnv: { PI_WEB_E2E_MODEL_CAPABILITIES: "1" } } });

test("model selection refreshes the visible upstream thinking choices without reconnecting", async ({
	page,
	harness,
}) => {
	let sockets = 0;
	page.on("websocket", () => {
		sockets += 1;
	});
	await page.goto(harness.origin);
	const trigger = page.getByRole("button", { name: /^(Model and thinking level|模型与思考级别)$/ });
	await expect(trigger).toContainText("Plain Model");
	await trigger.click();
	await expect(page.getByRole("button", { name: /^(Thinking level|思考级别)/ })).toHaveCount(0);
	await page.getByRole("button", { name: /^(Model|模型) Plain Model$/ }).click();
	await page.getByRole("button", { name: "Reason Model", exact: true }).click();
	const effort = page.getByRole("button", { name: /^(Thinking level|思考级别)/ });
	await effort.click();
	await expect(page.getByRole("button", { name: /^(Low|低)$/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /^(High|高)$/ })).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("button", { name: /^(Off|关闭)$/ })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await trigger.click();
	await page.getByRole("button", { name: /^(Model|模型) Reason Model$/ }).click();
	await page.getByRole("button", { name: "Extended Model", exact: true }).click();
	await effort.click();
	await expect(page.getByRole("button", { name: /^(Max|最大)$/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /^(Low|低)$/ })).toHaveCount(0);
	expect(sockets).toBe(1);
});
