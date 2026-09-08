import type { Route } from "@playwright/test";
import { expect, test } from "../fixtures/test";

test("silently reloads the directory after two failed reads and a real Gateway restart", async ({
	page,
	harness,
}) => {
	let armed = false;
	let releaseBootstrap: (() => void) | undefined;
	const bootstrapGate = new Promise<void>((resolve) => {
		releaseBootstrap = resolve;
	});
	const held: Route[] = [];
	const failed: string[] = [];
	const recovered: string[] = [];
	const epochs: string[] = [];
	let bootstrapRecovered = false;
	let restarted = false;
	let promptCount = 0;
	page.on("websocket", (socket) => {
		socket.on("framereceived", ({ payload }) => {
			const frame = JSON.parse(String(payload));
			if (frame.type === "server_hello") epochs.push(frame.serverEpoch);
		});
		socket.on("framesent", ({ payload }) => {
			const frame = JSON.parse(String(payload));
			if (frame.type === "command" && frame.command.type === "prompt") promptCount += 1;
		});
	});
	const isDirectory = (url: string) => {
		const path = new URL(url).pathname;
		return path === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/sessions$/.test(path);
	};
	page.on("requestfailed", (request) => {
		if (isDirectory(request.url())) failed.push(request.url());
	});
	page.on("response", (response) => {
		if (!restarted || response.status() !== 200) return;
		if (new URL(response.url()).pathname === "/api/v1/bootstrap") bootstrapRecovered = true;
		if (isDirectory(response.url())) recovered.push(new URL(response.url()).pathname);
	});
	await page.route("**/api/v1/**", async (route) => {
		if (armed && isDirectory(route.request().url()) && held.length < 2) {
			held.push(route);
			return;
		}
		if (restarted && new URL(route.request().url()).pathname === "/api/v1/bootstrap") await bootstrapGate;
		await route.continue();
	});
	// Observe the real Zustand store when its bound hook receives the vanilla API.
	// The original assignment and all store actions are left untouched.
	await page.addInitScript(() => {
		const assign = Object.assign;
		Object.assign = new Proxy(assign, {
			apply(target, receiver, args) {
				const result = Reflect.apply(target, receiver, args);
				if (typeof result?.getState === "function") {
					const state = result.getState();
					if (typeof state?.reloadSessions === "function" && "currentWorkspaceHandle" in state) {
						Object.defineProperty(window, "readDirectoryForTest", {
							value: () => {
								const current = result.getState();
								return {
									error: current.error ?? null,
									loadingWorkspaces: current.loadingWorkspaces,
									loadingSessions: current.loadingSessions,
									workspace: current.currentWorkspaceHandle,
									session: current.currentSession?.sessionHandle ?? null,
									catalog: current.sessionsByWorkspace[current.currentWorkspaceHandle] ?? [],
								};
							},
						});
						Object.assign = assign;
					}
				}
				return result;
			},
		});
	});
	const readDirectory = () =>
		page.evaluate(() =>
			(
				window as typeof window & {
					readDirectoryForTest: () => {
						error: string | null;
						loadingWorkspaces: boolean;
						loadingSessions: boolean;
						workspace: string | null;
						session: string | null;
						catalog: { sessionHandle: string }[];
					};
				}
			).readDirectoryForTest(),
		);
	await page.goto(harness.origin);
	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled();
	armed = true;
	await textarea.fill("E2E_DIRECTORY_RESTART");
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
	await expect(page.locator("main")).toContainText("E2E_REPLY:E2E_DIRECTORY_RESTART");
	await expect.poll(() => held.length).toBe(2);
	await textarea.fill("Keep this draft across restart");
	const selectedBefore = (await readDirectory()).session;
	expect(selectedBefore).toBeTruthy();
	const oldEpoch = epochs.at(-1);
	expect(oldEpoch).toBeTruthy();
	restarted = true;
	const restart = harness.restart();
	await Promise.all(held.map((route) => route.abort("connectionfailed")));
	await expect.poll(() => failed.length).toBe(2);
	await expect.poll(async () => (await readDirectory()).error).toBe("Failed to fetch");
	releaseBootstrap?.();
	await restart;
	// From here there is no prompt, click, refresh or other user activity.
	await expect.poll(() => bootstrapRecovered).toBe(true);
	await expect.poll(() => epochs.at(-1)).not.toBe(oldEpoch);
	await expect.poll(() => recovered).toContain("/api/v1/workspaces");
	await expect
		.poll(() => recovered)
		.toContain(`/api/v1/workspaces/${harness.workspace.workspaceHandle}/sessions`);
	await expect(textarea).toBeEnabled({ timeout: 25_000 });
	await expect(textarea).toHaveValue("Keep this draft across restart");
	await expect(page.locator("main")).toContainText("E2E_REPLY:E2E_DIRECTORY_RESTART");
	await expect.poll(readDirectory).toMatchObject({
		error: null,
		loadingWorkspaces: false,
		loadingSessions: false,
		workspace: harness.workspace.workspaceHandle,
		session: selectedBefore,
	});
	expect((await readDirectory()).catalog.map((session) => session.sessionHandle)).toContain(selectedBefore);
	expect(promptCount).toBe(1);
	expect(harness.piEvents().filter((event) => event.type === "prompt")).toHaveLength(1);
});
