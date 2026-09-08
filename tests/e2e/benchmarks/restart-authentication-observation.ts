import type { Page, Request } from "@playwright/test";

/** Ordinals describe only one restart trial, not a general network trace. */
export interface RestartAuthenticationObservation {
	arm: number | null;
	seal: number | null;
	invalid: boolean;
	requests: Array<{
		url: string;
		method: string;
		resourceType: string;
		samePage: boolean;
		mainFrame: boolean;
		redirected: boolean;
		start: number;
		failure: number | null;
		error: string | null;
	}>;
	console: Array<{ index: number; at: number; type: string; text: string; url: string; samePage: boolean }>;
}

export function observeRestartAuthentication(page: Page) {
	let ordinal = 0;
	let observation: RestartAuthenticationObservation | null = null;
	const requests = new Map<Request, RestartAuthenticationObservation["requests"][number]>();
	const onRequest = (request: Request) => {
		if (!observation || new URL(request.url()).pathname !== "/api/v1/bootstrap") return;
		if (observation.requests.length >= 32) {
			observation.invalid = true;
			return;
		}
		let samePage = false;
		let mainFrame = false;
		try {
			samePage = request.frame().page() === page;
			mainFrame = request.frame() === page.mainFrame();
		} catch {
			/* Worker requests cannot establish main-frame ownership. */
		}
		const row = {
			url: request.url(),
			method: request.method(),
			resourceType: request.resourceType(),
			samePage,
			mainFrame,
			redirected: request.redirectedFrom() !== null,
			start: ++ordinal,
			failure: null,
			error: null,
		} as RestartAuthenticationObservation["requests"][number];
		requests.set(request, row);
		observation.requests.push(row);
	};
	const onFailed = (request: Request) => {
		const row = requests.get(request);
		if (!row || !observation) return;
		row.failure = ++ordinal;
		row.error = request.failure()?.errorText ?? null;
	};
	const onConsole = (message: import("@playwright/test").ConsoleMessage) => {
		if (!observation || message.type() !== "error") return;
		if (observation.console.length >= 32) {
			observation.invalid = true;
			return;
		}
		observation.console.push({
			index: observation.console.length,
			at: ++ordinal,
			type: message.type(),
			text: message.text(),
			url: message.location().url,
			samePage: message.page() === page,
		});
	};
	page.on("request", onRequest);
	page.on("requestfailed", onFailed);
	page.on("console", onConsole);
	return {
		begin() {
			ordinal = 0;
			requests.clear();
			observation = { arm: null, seal: null, invalid: false, requests: [], console: [] };
		},
		arm() {
			if (observation) observation.arm = ++ordinal;
		},
		seal() {
			if (observation) observation.seal = ++ordinal;
		},
		read() {
			return observation ? structuredClone(observation) : null;
		},
		dispose() {
			page.off("request", onRequest);
			page.off("requestfailed", onFailed);
			page.off("console", onConsole);
			requests.clear();
			observation = null;
		},
	};
}

/** Exclude one console index only when the restart window explains it uniquely. */
export function expectedRestartAuthenticationError(
	observation: RestartAuthenticationObservation | null,
	origin: string,
	messages: string[],
): number | null {
	if (!observation || observation.invalid) return null;
	const { arm, seal, requests, console: logs } = observation;
	if (arm === null || seal === null || arm >= seal) return null;
	const parsed = new URL(origin);
	if (
		parsed.origin !== origin ||
		!["http:", "https:"].includes(parsed.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
	)
		return null;
	if (
		logs.length !== messages.length ||
		logs.some((log, index) => log.index !== index || log.text !== messages[index])
	)
		return null;
	const inWindow = (value: number) => value > arm && value < seal;
	const candidates = requests.filter(
		(request) => inWindow(request.start) || (request.failure !== null && inWindow(request.failure)),
	);
	const windowLogs = logs.filter((log) => inWindow(log.at));
	if (candidates.length !== 1 || windowLogs.length !== 1) return null;
	const request = candidates[0];
	const log = windowLogs[0];
	const url = `${origin}/api/v1/bootstrap`;
	if (
		!request ||
		!log ||
		request.url !== url ||
		request.method !== "GET" ||
		request.resourceType !== "fetch" ||
		!request.samePage ||
		!request.mainFrame ||
		request.redirected ||
		!inWindow(request.start) ||
		request.failure === null ||
		!inWindow(request.failure) ||
		request.failure <= request.start ||
		request.error !== "net::ERR_CONNECTION_REFUSED" ||
		log.url !== url ||
		!log.samePage ||
		log.type !== "error" ||
		log.text !== "Failed to load resource: net::ERR_CONNECTION_REFUSED"
	)
		return null;
	return log.index;
}
