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

/** Install before navigation so a test can explicitly drop only browser WebSockets. */
export async function installWebSocketDropControl(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const sockets: WebSocket[] = [];
		const ControlledWebSocket = new Proxy(window.WebSocket, {
			construct(target, args) {
				const socket = Reflect.construct(target, args) as WebSocket;
				sockets.push(socket);
				return socket;
			},
		});
		Object.defineProperty(window, "WebSocket", {
			configurable: true,
			value: ControlledWebSocket,
			writable: true,
		});
		Object.defineProperty(window, "__piwebDropSocketsForE2e", {
			configurable: true,
			value: () => {
				for (const socket of sockets) {
					if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
						socket.close(4100, "synthetic e2e disconnect");
					}
				}
			},
		});
		Object.defineProperty(window, "__piwebSendSocketFrameForE2e", {
			configurable: true,
			value: (frame: unknown) => {
				const socket = sockets.findLast((candidate) => candidate.readyState === WebSocket.OPEN);
				if (!socket) throw new Error("No open controlled WebSocket is available");
				socket.send(JSON.stringify(frame));
			},
		});
	});
}

export async function dropControlledWebSockets(page: Page): Promise<void> {
	await page.evaluate(() => {
		(
			window as typeof window & {
				__piwebDropSocketsForE2e: () => void;
			}
		).__piwebDropSocketsForE2e();
	});
}

export async function sendControlledWebSocketFrame(page: Page, frame: unknown): Promise<void> {
	await page.evaluate((value) => {
		(
			window as typeof window & {
				__piwebSendSocketFrameForE2e: (frame: unknown) => void;
			}
		).__piwebSendSocketFrameForE2e(value);
	}, frame);
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
