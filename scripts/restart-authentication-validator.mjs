const keys = (value, expected) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const ordinal = (value) => Number.isSafeInteger(value) && value > 0;

/** Independently check raw public-API facts; no producer-supplied match is trusted. */
export function validateRestartAuthentication(value) {
	if (
		!keys(value, ["arm", "seal", "invalid", "requests", "console"]) ||
		typeof value.invalid !== "boolean" ||
		!ordinal(value.arm) ||
		!ordinal(value.seal) ||
		value.arm >= value.seal ||
		!Array.isArray(value.requests) ||
		!Array.isArray(value.console) ||
		value.requests.length > 32 ||
		value.console.length > 32
	)
		return false;
	const seen = new Set([value.arm, value.seal]);
	const add = (at) => {
		if (!ordinal(at) || seen.has(at)) return false;
		seen.add(at);
		return true;
	};
	for (const row of value.requests) {
		if (
			!keys(row, [
				"url",
				"method",
				"resourceType",
				"samePage",
				"mainFrame",
				"redirected",
				"start",
				"failure",
				"error",
			]) ||
			![row.url, row.method, row.resourceType].every((item) => typeof item === "string") ||
			![row.samePage, row.mainFrame, row.redirected].every((item) => typeof item === "boolean") ||
			!add(row.start)
		)
			return false;
		if (
			row.failure === null
				? row.error !== null
				: !add(row.failure) || row.failure <= row.start || typeof row.error !== "string"
		)
			return false;
	}
	for (let index = 0; index < value.console.length; index++) {
		const row = value.console[index];
		if (
			!keys(row, ["index", "at", "type", "text", "url", "samePage"]) ||
			row.index !== index ||
			!add(row.at) ||
			![row.type, row.text, row.url].every((item) => typeof item === "string") ||
			typeof row.samePage !== "boolean"
		)
			return false;
	}
	return true;
}

export function restartAuthenticationErrorIndex(observation) {
	const evidence = observation?.facts?.restartAuthentication;
	if (!validateRestartAuthentication(evidence) || evidence.invalid) return null;
	const lifecycle = observation.facts.lifecycle;
	const origin = lifecycle?.originBefore;
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return null;
	}
	if (
		origin !== lifecycle.originAfter ||
		parsed.origin !== origin ||
		!["http:", "https:"].includes(parsed.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
	)
		return null;
	const messages = observation.browserErrors?.console;
	if (
		!Array.isArray(messages) ||
		messages.length !== evidence.console.length ||
		evidence.console.some((row, index) => row.text !== messages[index])
	)
		return null;
	const between = (at) => at !== null && at > evidence.arm && at < evidence.seal;
	const requests = evidence.requests.filter((row) => between(row.start) || between(row.failure));
	const logs = evidence.console.filter((row) => between(row.at));
	if (requests.length !== 1 || logs.length !== 1) return null;
	const request = requests[0];
	const log = logs[0];
	const endpoint = `${origin}/api/v1/bootstrap`;
	if (
		request.url !== endpoint ||
		request.method !== "GET" ||
		request.resourceType !== "fetch" ||
		request.samePage !== true ||
		request.mainFrame !== true ||
		request.redirected !== false ||
		!between(request.start) ||
		!between(request.failure) ||
		request.error !== "net::ERR_CONNECTION_REFUSED" ||
		log.type !== "error" ||
		log.samePage !== true ||
		log.url !== endpoint ||
		log.text !== "Failed to load resource: net::ERR_CONNECTION_REFUSED"
	)
		return null;
	return log.index;
}
