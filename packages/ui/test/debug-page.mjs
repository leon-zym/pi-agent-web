import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 160)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const buttons = await page.evaluate(() => {
	return [...document.querySelectorAll("button")]
		.map((b) => ({
			text: b.textContent.slice(0, 30),
			aria: b.getAttribute("aria-label"),
			disabled: b.disabled,
		}))
		.filter((b) => b.text.includes("新建") || b.text.includes("会话") || b.aria);
});
console.log("BUTTONS:", JSON.stringify(buttons.slice(0, 12), null, 1));
await browser.close();
