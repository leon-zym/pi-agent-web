import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// Find the most recent real session row and click it
const rows = await page.evaluate(() => {
	return [...document.querySelectorAll("li[role=treeitem]")].map((li) => li.textContent.slice(0, 80));
});
console.log("SESSION ROWS:", JSON.stringify(rows));

// Click the first session row (most recent)
const first = page.locator("li[role=treeitem]").first();
if ((await first.count()) > 0) {
	await first.click();
	console.log("clicked first session row");
}
await page.waitForTimeout(4000);
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 700));
console.log("BODY AFTER OPEN:", bodyText);
await browser.close();
