import type { NativeSessionDto, NativeSessionListDto, NativeWorkspaceDto } from "@pi-agent-web/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { useSessionDirectoryStore as directory } from "../src/stores/session-directory";

const initial = directory.getState();
const workspace = (workspaceHandle: string): NativeWorkspaceDto => ({
	workspaceHandle,
	path: "/tmp",
	available: true,
	pinned: false,
	displayName: workspaceHandle,
	lastOpenedAt: null,
	sessionCount: 1,
	hasNativeHistory: true,
});
const session = (workspaceHandle: string): NativeSessionDto => ({
	workspaceHandle,
	sessionHandle: `session-${workspaceHandle}`,
	nativeSessionId: "native",
	sessionFile: "/tmp/test.jsonl",
	persisted: true,
	createdAt: null,
	modifiedAt: null,
	messageCount: 1,
	firstMessage: "Test",
	runtime: null,
});
const list = (workspaceHandle: string): NativeSessionListDto => ({
	sessions: [session(workspaceHandle)],
	layout: { sessionDir: "/tmp", source: "default" },
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function seed() {
	directory.setState({
		workspaces: [workspace("a"), workspace("b")],
		currentWorkspaceHandle: "a",
		currentSession: session("a"),
		sessionsByWorkspace: { a: [session("a")], b: [session("b")] },
	});
}
afterEach(() => {
	directory.getState().invalidateDirectoryRequests();
	directory.setState(initial, true);
	vi.restoreAllMocks();
});

it.each(["success", "failure"])(
	"ignores pre-recovery directory %s arriving after a newer result",
	async (outcome) => {
		seed();
		const oldWorkspaces = deferred<NativeWorkspaceDto[]>(),
			oldSessions = deferred<NativeSessionListDto>();
		vi.spyOn(api, "listWorkspaces")
			.mockReturnValueOnce(oldWorkspaces.promise)
			.mockResolvedValue([workspace("a"), workspace("b")]);
		vi.spyOn(api, "listSessions").mockReturnValueOnce(oldSessions.promise).mockResolvedValue(list("a"));
		const old = Promise.all([
			directory.getState().loadWorkspaces(),
			directory.getState().reloadSessions("a"),
		]);
		directory.getState().invalidateDirectoryRequests();
		await directory.getState().loadWorkspaces();
		await directory.getState().reloadSessions("a");
		const recovered = directory.getState();
		if (outcome === "success") {
			oldWorkspaces.resolve([]);
			oldSessions.resolve({ sessions: [], layout: { sessionDir: "/tmp", source: "default" } });
		} else {
			oldWorkspaces.reject(new Error("old workspace failure"));
			oldSessions.reject(new Error("old session failure"));
		}
		await old;
		expect(directory.getState()).toBe(recovered);
		expect(directory.getState()).toMatchObject({
			error: undefined,
			loadingWorkspaces: false,
			loadingSessions: false,
			currentSession: { sessionHandle: "session-a" },
		});
	},
);

it.each(["success", "failure"])("does not apply a canceled recovery %s", async (outcome) => {
	seed();
	const workspaces = deferred<NativeWorkspaceDto[]>(),
		sessions = deferred<NativeSessionListDto>();
	vi.spyOn(api, "listWorkspaces").mockReturnValue(workspaces.promise);
	vi.spyOn(api, "listSessions").mockReturnValue(sessions.promise);
	let current = true;
	const pending = Promise.all([
		directory.getState().loadWorkspaces({ isCurrent: () => current }),
		directory.getState().reloadSessions("a", { isCurrent: () => current }),
	]);
	current = false;
	directory.getState().invalidateDirectoryRequests();
	const canceled = directory.getState();
	if (outcome === "success") {
		workspaces.resolve([]);
		sessions.resolve(list("b"));
	} else {
		workspaces.reject(new Error("canceled"));
		sessions.reject(new Error("canceled"));
	}
	await pending;
	expect(directory.getState()).toBe(canceled);
});

it.each(["success", "failure"])("preserves a newer workspace selection on late %s", async (outcome) => {
	seed();
	const workspaces = deferred<NativeWorkspaceDto[]>(),
		sessions = deferred<NativeSessionListDto>();
	vi.spyOn(api, "listWorkspaces").mockReturnValue(workspaces.promise);
	vi.spyOn(api, "listSessions").mockReturnValueOnce(sessions.promise).mockResolvedValue(list("b"));
	vi.spyOn(api, "activateWorkspace").mockResolvedValue(workspace("b"));
	const pending = Promise.all([
		directory.getState().loadWorkspaces(),
		directory.getState().reloadSessions("a"),
	]);
	await directory.getState().selectWorkspace("b");
	if (outcome === "success") {
		workspaces.resolve([workspace("a")]);
		sessions.resolve(list("a"));
	} else {
		workspaces.reject(new Error("old a"));
		sessions.reject(new Error("old a"));
	}
	await pending;
	expect(directory.getState()).toMatchObject({
		currentWorkspaceHandle: "b",
		currentSession: null,
		error: undefined,
		loadingWorkspaces: false,
		loadingSessions: false,
	});
	expect(directory.getState().sessionsByWorkspace.b).toEqual([session("b")]);
	expect(directory.getState().workspaces.map((item) => item.workspaceHandle)).toContain("b");
});

it("preserves cached data on recovery failure and clears the error on the next recovery", async () => {
	seed();
	vi.spyOn(api, "listWorkspaces")
		.mockRejectedValueOnce(new Error("workspaces unavailable"))
		.mockResolvedValue([workspace("a"), workspace("b")]);
	vi.spyOn(api, "listSessions")
		.mockRejectedValueOnce(new Error("sessions unavailable"))
		.mockResolvedValue(list("a"));
	await directory.getState().loadWorkspaces();
	await directory.getState().reloadSessions("a");
	expect(directory.getState()).toMatchObject({
		error: "sessions unavailable",
		loadingWorkspaces: false,
		loadingSessions: false,
		currentSession: { sessionHandle: "session-a" },
	});
	expect(directory.getState().sessionsByWorkspace.a).toEqual([session("a")]);
	await directory.getState().loadWorkspaces();
	await directory.getState().reloadSessions("a");
	expect(directory.getState()).toMatchObject({
		error: undefined,
		loadingWorkspaces: false,
		loadingSessions: false,
	});
});

it("ends loading when reconnect ownership expires before its requests settle", async () => {
	seed();
	const workspaces = deferred<NativeWorkspaceDto[]>(),
		sessions = deferred<NativeSessionListDto>();
	vi.spyOn(api, "listWorkspaces").mockReturnValue(workspaces.promise);
	vi.spyOn(api, "listSessions").mockReturnValue(sessions.promise);
	let current = true;
	const pending = Promise.all([
		directory.getState().loadWorkspaces({ isCurrent: () => current }),
		directory.getState().reloadSessions("a", { isCurrent: () => current }),
	]);
	expect(directory.getState()).toMatchObject({ loadingWorkspaces: true, loadingSessions: true });
	current = false;
	workspaces.reject(new Error("disconnected"));
	sessions.reject(new Error("disconnected"));
	await pending;
	expect(directory.getState()).toMatchObject({
		loadingWorkspaces: false,
		loadingSessions: false,
		error: undefined,
		currentSession: { sessionHandle: "session-a" },
	});
});

it("does not let an expired request clear a newer request's loading state", async () => {
	seed();
	const oldWorkspaces = deferred<NativeWorkspaceDto[]>(),
		oldSessions = deferred<NativeSessionListDto>();
	const newWorkspaces = deferred<NativeWorkspaceDto[]>(),
		newSessions = deferred<NativeSessionListDto>();
	vi.spyOn(api, "listWorkspaces")
		.mockReturnValueOnce(oldWorkspaces.promise)
		.mockReturnValueOnce(newWorkspaces.promise);
	vi.spyOn(api, "listSessions")
		.mockReturnValueOnce(oldSessions.promise)
		.mockReturnValueOnce(newSessions.promise);
	let current = true;
	const old = Promise.all([
		directory.getState().loadWorkspaces({ isCurrent: () => current }),
		directory.getState().reloadSessions("a", { isCurrent: () => current }),
	]);
	current = false;
	const next = Promise.all([directory.getState().loadWorkspaces(), directory.getState().reloadSessions("a")]);
	oldWorkspaces.reject(new Error("expired"));
	oldSessions.reject(new Error("expired"));
	await old;
	expect(directory.getState()).toMatchObject({
		loadingWorkspaces: true,
		loadingSessions: true,
		error: undefined,
	});
	newWorkspaces.resolve([workspace("a"), workspace("b")]);
	newSessions.resolve(list("a"));
	await next;
	expect(directory.getState()).toMatchObject({
		loadingWorkspaces: false,
		loadingSessions: false,
		error: undefined,
	});
});
