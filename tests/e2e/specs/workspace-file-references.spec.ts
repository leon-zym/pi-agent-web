import fs from "node:fs";
import path from "node:path";
import { pageOverflow } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

test("file mentions capture exact bytes, confirm sensitive files, and preserve failed drafts on mobile", async ({
	page,
	harness,
}) => {
	const sourcePath = path.join(harness.workspacePath, "src", "reference.ts");
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, "export const captured = 42;\n", "utf8");
	fs.writeFileSync(path.join(harness.workspacePath, ".env"), "API_KEY=deterministic-fixture-value\n", "utf8");
	const changingPath = path.join(harness.workspacePath, "changing.txt");
	fs.writeFileSync(changingPath, "previewed\n", "utf8");

	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	const composer = page.locator("textarea");
	await expect(composer).toBeEnabled();

	await composer.fill("Review @reference");
	const safeItem = page.getByTestId("file-mention-item-0");
	await expect(safeItem).toContainText("reference.ts");
	await expect(page.getByTestId("file-mention-detail")).toContainText("export const captured = 42;");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("composer-file-references")).toContainText("src/reference.ts");
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect
		.poll(() => harness.piEvents().find((event) => event.type === "prompt")?.text ?? "")
		.toContain('<file name="src/reference.ts">\nexport const captured = 42;\n\n</file>');

	await expect(page.getByTestId("composer-card")).toHaveAttribute("aria-busy", "false");
	await expect(page.getByTestId("composer-file-references")).toHaveCount(0);
	await composer.fill("Check @.env");
	await expect(page.getByTestId("file-mention-item-0")).toContainText(/Sensitive pattern|疑似敏感内容/);
	await page.keyboard.press("Enter");
	const includeButton = page.getByRole("button", { name: /^(Include file|加入文件)$/ });
	await expect(includeButton).toBeVisible();
	await expect(page.getByTestId("composer-file-references")).toHaveCount(0);
	await includeButton.click();
	await expect(page.getByTestId("composer-file-references")).toContainText(".env");
	await page.getByRole("button", { name: /^(Remove file reference|移除文件引用)/ }).click();

	await composer.fill("Keep this draft @changing");
	await expect(page.getByTestId("file-mention-item-0")).toContainText("changing.txt");
	fs.renameSync(changingPath, `${changingPath}.old`);
	fs.writeFileSync(changingPath, "replacement\n", "utf8");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("file-mention-detail")).toContainText(/The file changed|文件已变化/);
	await expect(composer).toHaveValue("Keep this draft @changing");
	await expect(page.getByTestId("composer-file-references")).toHaveCount(0);

	const overflow = await pageOverflow(page);
	expect(overflow.htmlScrollWidth).toBeLessThanOrEqual(overflow.viewportWidth);

	await page.evaluate(() => {
		localStorage.setItem("pi-web-locale", "zh-CN");
		localStorage.setItem("pi-web-theme", "dark");
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page.locator("textarea").fill("检查 @.env");
	await expect(page.getByTestId("file-mention-item-0")).toContainText("疑似敏感内容");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: "加入文件" })).toBeVisible();
	const darkOverflow = await pageOverflow(page);
	expect(darkOverflow.htmlScrollWidth).toBeLessThanOrEqual(darkOverflow.viewportWidth);
});
