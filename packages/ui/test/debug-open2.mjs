import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 240)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.locator("li[role=treeitem]").first().click();
await page.waitForTimeout(6000);
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 900));
console.log("BODY:", bodyText);
const toasts = await page.evaluate(() =>
	[...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent.slice(0, 160)),
);
console.log("TOASTS:", JSON.stringify(toasts));
await browser.close();
