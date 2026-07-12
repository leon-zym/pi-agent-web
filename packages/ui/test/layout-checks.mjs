import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

// Programmatic layout checks instead of image inspection.
const checks = await page.evaluate(() => {
	const q = (sel) => document.querySelector(sel);
	const grid = q("#root > div");
	const cols = grid ? getComputedStyle(grid).gridTemplateColumns : "?";
	const sidebar = q('nav[aria-label="Sidebar"]');
	const composer = q("textarea");
	const content = q("main");
	const bodyBg = getComputedStyle(document.body).backgroundColor;
	const ink = getComputedStyle(document.body).color;
	return {
		gridColumns: cols,
		sidebarPresent: !!sidebar,
		sidebarWidth: sidebar ? sidebar.getBoundingClientRect().width : 0,
		composerPresent: !!composer,
		composerWidth: composer ? composer.closest(".rounded-xl")?.getBoundingClientRect().width : 0,
		mainWidth: content ? content.getBoundingClientRect().width : 0,
		bodyBg,
		ink,
		textareaRows: composer ? composer.getAttribute("rows") : null,
	};
});
console.log("CHECKS:", JSON.stringify(checks, null, 1));

// Start a new session and inspect streaming layout classes.
await page.getByRole("button", { name: "New session" }).first().click();
await page.waitForTimeout(3000);
await page.locator("textarea").type("ping");
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
const streamChecks = await page.evaluate(() => {
	const userBubble = document.querySelector(".bg-user-bubble");
	const sweep = document.querySelector(".thinking-sweep");
	const stop = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Stop");
	const hint = [...document.querySelectorAll("p")].find((p) => p.textContent.includes("Running"));
	return {
		userBubblePresent: !!userBubble,
		thinkingSweepPresent: !!sweep,
		stopButtonPresent: !!stop,
		runningHint: hint ? hint.textContent.slice(0, 80) : null,
	};
});
console.log("STREAM:", JSON.stringify(streamChecks, null, 1));
await browser.close();
console.log("LAYOUT CHECKS DONE");
