import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 160)));
page.on("websocket", (ws) => {
	ws.on("framesent", (f) => {
		const p = String(f.payload);
		if (p.includes("prompt") || p.includes("agent_")) console.log("WS>", p.slice(0, 120));
	});
});
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
// open first session
await page.locator("li[role=treeitem]").first().click();
await page.waitForTimeout(5000);
const ta = page.locator("textarea");
await ta.click();
await ta.fill("hi");
await page.keyboard.press("Enter");
await page.waitForTimeout(15000);
const state = await page.evaluate(() => {
	const bubbles = document.querySelectorAll(".bg-user-bubble").length;
	const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((t) =>
		t.textContent.slice(0, 120),
	);
	const text = document.body.innerText.slice(-900);
	return { bubbles, toasts, text };
});
console.log("STATE:", JSON.stringify(state, null, 1));
await browser.close();
