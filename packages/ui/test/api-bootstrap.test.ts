import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";

afterEach(() => vi.unstubAllGlobals());

it("bootstraps only the same origin without redirects or cache and forwards cancellation", async () => {
	const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
	vi.stubGlobal("fetch", fetch);
	const controller = new AbortController();
	await api.bootstrap(controller.signal);
	expect(fetch).toHaveBeenCalledWith(
		"/api/v1/bootstrap",
		expect.objectContaining({
			signal: controller.signal,
			mode: "same-origin",
			redirect: "error",
			cache: "no-store",
			credentials: "include",
		}),
	);
});

it("does not treat a forbidden bootstrap as successful authentication", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response('{"error":"forbidden origin"}', { status: 403 })),
	);
	await expect(api.bootstrap()).rejects.toMatchObject({ status: 403 });
});
