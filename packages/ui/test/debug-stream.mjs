import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 160)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
// Create a fresh session, wait for it to exist
await page.getByRole("button", { name: "New session" }).first().click();
await page.waitForTimeout(5000);
const ta = page.locator("textarea");
console.log("textarea count:", await ta.count());
await ta.fill("ping");
await page.keyboard.press("Enter");
await page.waitForTimeout(9000);
const state = await page.evaluate(() => {
	const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((t) =>
		t.textContent.slice(0, 120),
	);
	const bubbles = document.querySelectorAll(".bg-user-bubble").length;
	const sections = document.querySelectorAll("section").length;
	const text = document.body.innerText.slice(0, 600);
	return { toasts, bubbles, sections, text };
});
console.log("STATE:", JSON.stringify(state, null, 1));
await browser.close();
