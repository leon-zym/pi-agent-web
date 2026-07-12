import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("websocket", (ws) => {
	console.log("WS OPEN", ws.url());
	ws.on("framereceived", (f) => console.log("WS<", String(f.payload).slice(0, 400)));
});
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await page.locator("li[role=treeitem]").first().click();
await page.waitForTimeout(10000);
await browser.close();
