import fs from "node:fs";
import { chromium } from "playwright";

const OUT = "/tmp/piweb-shots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (msg) => {
	if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR: ${err.message}`));

await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/01-empty-light.png` });

// New session (aria-label is localized: en by default headless browser).
await page.getByRole("button", { name: "New session" }).first().click();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/02-empty-session.png` });

// Slash menu
await page.locator("textarea").click();
await page.keyboard.type("/");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/03-slash-menu.png` });
await page.keyboard.press("Escape");
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");

// Real conversation
await page.locator("textarea").type("用一句话介绍你自己");
await page.screenshot({ path: `${OUT}/04-before-send.png` });
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/05-streaming.png` });
try {
	await page.waitForSelector("text=Done", { timeout: 120000 });
} catch {
	console.log("no Done marker within 120s");
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/06-conversation-light.png` });

// Dark mode
await page.getByRole("button", { name: "Switch theme" }).first().click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/07-conversation-dark.png` });

// Branch tree panel
const treeButton = page.locator("button[aria-label='Branch tree']");
if ((await treeButton.count()) > 0) {
	await treeButton.first().click();
	await page.waitForTimeout(1500);
	await page.screenshot({ path: `${OUT}/08-tree-panel.png` });
}

// Settings
const settingsBtn = page.locator("button[aria-label='Settings']");
if ((await settingsBtn.count()) > 0) {
	await settingsBtn.first().click();
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${OUT}/09-settings.png` });
	await page.keyboard.press("Escape");
	await page.waitForTimeout(400);
}

// Narrow rail
await page.setViewportSize({ width: 1000, height: 800 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/10-narrow-rail.png` });

// Debug panel (Events tab)
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(500);
const debugTab = page.locator("button").filter({ hasText: "Events" }).first();
if ((await debugTab.count()) > 0) {
	await debugTab.click().catch(() => {});
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${OUT}/11-debug-panel.png` });
}

console.log("console errors:", consoleErrors.length ? consoleErrors.join("\n---\n") : "(none)");
await browser.close();
console.log("SHOTS DONE");
