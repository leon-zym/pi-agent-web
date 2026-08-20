import type { Page } from "@playwright/test";

export interface PageErrors {
	console: string[];
	page: string[];
}

export function observePageErrors(page: Page): PageErrors {
	const errors: PageErrors = { console: [], page: [] };
	page.on("console", (message) => {
		if (message.type() === "error") errors.console.push(message.text());
	});
	page.on("pageerror", (error) => errors.page.push(error.stack ?? error.message));
	return errors;
}

export async function bootstrapBrowserSession(page: Page, origin: string): Promise<number> {
	const response = await page.context().request.get(`${origin}/api/v1/bootstrap`, {
		headers: { Origin: origin },
	});
	return response.status();
}

export async function pageOverflow(page: Page): Promise<{
	viewportWidth: number;
	htmlScrollWidth: number;
	bodyScrollWidth: number;
	offenders: Array<{ tag: string; testId: string | null; left: number; right: number; width: number }>;
}> {
	return page.evaluate(() => {
		const viewportWidth = window.innerWidth;
		const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					tag: element.tagName.toLowerCase(),
					testId: element.getAttribute("data-testid"),
					left: Math.round(rect.left),
					right: Math.round(rect.right),
					width: Math.round(rect.width),
				};
			})
			.filter(({ left, right, width }) => width > 0 && (left < -1 || right > viewportWidth + 1))
			.slice(0, 12);
		return {
			viewportWidth,
			htmlScrollWidth: document.documentElement.scrollWidth,
			bodyScrollWidth: document.body.scrollWidth,
			offenders,
		};
	});
}
