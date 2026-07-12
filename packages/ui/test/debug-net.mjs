import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 240)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 400)));
page.on("requestfailed", (r) => console.log("REQFAIL", r.url().slice(0, 100), r.failure()?.errorText));
page.on("response", (r) => {
	if (r.url().includes("/api/")) console.log("RESP", r.status(), r.url().slice(0, 120));
});
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.locator("li[role=treeitem]").first().click();
await page.waitForTimeout(6000);
// Check the transport store state via window (zustand store not exposed; use DOM)
console.log("done");
await browser.close();
