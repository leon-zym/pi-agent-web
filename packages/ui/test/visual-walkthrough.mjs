import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/tmp/piweb-shots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + "/01-empty-light.png" });

// Wait for auto-selected workspace; otherwise click the workspace row.
try {
  await page.waitForSelector('button:not([disabled]):has-text("新建会话")', { timeout: 10000 });
} catch {
  await page.locator('button').filter({ hasText: 'pi-agent-web' }).first().click();
  await page.waitForTimeout(2500);
}
// New session via sidebar button
await page.getByRole("button", { name: "新建会话" }).first().click();
await page.waitForTimeout(4000);
await page.screenshot({ path: OUT + "/02-empty-session.png" });

// Slash menu
await page.locator("textarea").click();
await page.keyboard.type("/");
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT + "/03-slash-menu.png" });
await page.keyboard.press("Escape");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");

// Real conversation
await page.locator("textarea").type("用一句话介绍你自己");
await page.screenshot({ path: OUT + "/04-before-send.png" });
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);
await page.screenshot({ path: OUT + "/05-streaming.png" });
// wait for the turn tail (完成) with a generous timeout
try {
  await page.waitForSelector("text=完成", { timeout: 120_000 });
} catch {
  console.log("no 完成 marker within 120s");
}
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT + "/06-conversation-light.png" });

// Dark mode
await page.getByRole("button", { name: "切换主题" }).first().click();
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + "/07-conversation-dark.png" });

// Branch tree panel
await page.getByRole("button", { name: "分支树" }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT + "/08-tree-panel.png" });

// Settings
await page.getByRole("button", { name: "设置" }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: OUT + "/09-settings.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// Narrow viewport: rail mode
await page.setViewportSize({ width: 1000, height: 800 });
await page.waitForTimeout(800);
await page.screenshot({ path: OUT + "/10-narrow-rail.png" });

// Debug panel
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(500);
await page.getByRole("button", { name: "事件" }).click().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: OUT + "/11-debug-panel.png" });

console.log("console errors:", consoleErrors.length ? consoleErrors.join("\n---\n") : "(none)");
await browser.close();
console.log("SHOTS DONE");
