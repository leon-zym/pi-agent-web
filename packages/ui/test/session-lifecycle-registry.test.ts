import { describe, expect, it, vi } from "vitest";
import {
	createSessionLifecycleRegistry,
	SESSION_LIFECYCLE_OWNER_IDS,
	SessionLifecycleError,
	type SessionLifecycleIdentity,
	type SessionLifecycleOwner,
} from "../src/lib/session-lifecycle-registry";

const identity = (sessionHandle: string, generation = 1): SessionLifecycleIdentity => ({
	serverEpoch: "epoch-a",
	workspaceId: "workspace-a",
	sessionHandle,
	generation,
});

function owner(
	id: string,
	log: string[],
	options: { failPrepare?: boolean; failCommit?: boolean } = {},
): SessionLifecycleOwner {
	return {
		id,
		policy: {
			create: "reset",
			snapshot: "rebuild",
			rekey: "migrate",
			dispose: "reset",
		},
		prepare: ({ operation }) => {
			log.push(`${id}:prepare:${operation}`);
			if (options.failPrepare) throw new Error(`${id}:prepare-failed`);
			return {
				commit: () => {
					log.push(`${id}:commit:${operation}`);
					if (options.failCommit) throw new Error(`${id}:commit-failed`);
				},
				restore: () => log.push(`${id}:restore:${operation}`),
				intents: [],
			};
		},
	};
}

describe("SessionLifecycleRegistry", () => {
	it("fails fast on duplicate and incomplete owner registration", () => {
		const registry = createSessionLifecycleRegistry({ requiredOwnerIds: ["directory", "projection"] });
		registry.register(owner("directory", []));
		expect(() => registry.register(owner("directory", []))).toThrowError(SessionLifecycleError);
		expect(() => registry.assertReady()).toThrowError(/projection/);
	});

	it("requires the declared product owner set before a connection can start", () => {
		const registry = createSessionLifecycleRegistry({ requiredOwnerIds: SESSION_LIFECYCLE_OWNER_IDS });
		for (const id of SESSION_LIFECYCLE_OWNER_IDS.slice(0, -1)) registry.register(owner(id, []));
		expect(() => registry.assertReady()).toThrowError(/extension/);
	});

	it("prepares every owner before advancing the epoch or committing", () => {
		const log: string[] = [];
		const registry = createSessionLifecycleRegistry({ batch: (run) => run() });
		registry.register(owner("directory", log));
		registry.register(owner("projection", log));
		registry.assertReady();

		const result = registry.createSession({ identity: identity("session-a") });

		expect(result.status).toBe("committed");
		expect(registry.epoch).toBe(1);
		expect(log).toEqual([
			"directory:prepare:create",
			"projection:prepare:create",
			"directory:commit:create",
			"projection:commit:create",
		]);
	});

	it("does not commit or emit effects when prepare fails", () => {
		const log: string[] = [];
		const onCommitFailure = vi.fn();
		const registry = createSessionLifecycleRegistry({ onCommitFailure });
		registry.register(owner("directory", log));
		registry.register(owner("projection", log, { failPrepare: true }));
		registry.assertReady();

		const result = registry.createSession({
			identity: identity("session-a"),
			effects: [{ type: "toast", identity: identity("session-a"), dedupeKey: "never" }],
		});

		expect(result.status).toBe("rejected");
		expect(registry.epoch).toBe(0);
		expect(log).toEqual(["directory:prepare:create", "projection:prepare:create"]);
		expect(result.effects).toEqual([]);
		expect(onCommitFailure).not.toHaveBeenCalled();
	});

	it("restores committed owners in reverse order and enters the recovery callback", () => {
		const log: string[] = [];
		const onCommitFailure = vi.fn();
		const registry = createSessionLifecycleRegistry({ onCommitFailure });
		registry.register(owner("directory", log));
		registry.register(owner("projection", log));
		registry.register(owner("extension", log, { failCommit: true }));
		registry.assertReady();

		const result = registry.snapshotSession({ identity: identity("session-a") });

		expect(result.status).toBe("rejected");
		expect(registry.epoch).toBe(0);
		expect(log).toEqual([
			"directory:prepare:snapshot",
			"projection:prepare:snapshot",
			"extension:prepare:snapshot",
			"directory:commit:snapshot",
			"projection:commit:snapshot",
			"extension:commit:snapshot",
			"extension:restore:snapshot",
			"projection:restore:snapshot",
			"directory:restore:snapshot",
		]);
		expect(onCommitFailure).toHaveBeenCalledWith(
			expect.objectContaining({ operation: "snapshot", identity: identity("session-a") }),
		);
	});

	it("rejects a rekey that would collide with another registered identity", () => {
		const registry = createSessionLifecycleRegistry({
			requiredOwnerIds: ["directory"],
		});
		registry.register(owner("directory", []));
		registry.assertReady();
		registry.createSession({ identity: identity("parent") });
		registry.createSession({ identity: identity("child") });

		const result = registry.rekeySession({
			previousIdentity: identity("parent"),
			identity: identity("child"),
		});

		expect(result.status).toBe("rejected");
		expect("error" in result && result.error).toBeInstanceOf(SessionLifecycleError);
	});

	it("updates identity only after a successful rekey and disposes it atomically", () => {
		const registry = createSessionLifecycleRegistry({ requiredOwnerIds: ["directory"] });
		registry.register(owner("directory", []));
		registry.assertReady();
		registry.createSession({ identity: identity("parent") });

		expect(
			registry.rekeySession({
				previousIdentity: identity("parent"),
				identity: identity("child", 2),
			}).status,
		).toBe("committed");
		expect(registry.currentIdentity("parent")).toBeNull();
		expect(registry.currentIdentity("child")).toEqual(identity("child", 2));
		expect(registry.disposeSession({ identity: identity("child", 2) }).status).toBe("committed");
		expect(registry.currentIdentity("child")).toBeNull();
	});

	it("rejects cross-Workspace rekeys while allowing a disposed handle to reopen", () => {
		const registry = createSessionLifecycleRegistry({ requiredOwnerIds: ["directory"] });
		registry.register(owner("directory", []));
		registry.assertReady();
		registry.createSession({ identity: identity("parent") });

		const crossWorkspace = registry.rekeySession({
			previousIdentity: identity("parent"),
			identity: { ...identity("child", 2), workspaceId: "workspace-b" },
		});
		expect(crossWorkspace.status).toBe("rejected");

		const rekeyed = registry.rekeySession({
			previousIdentity: identity("parent"),
			identity: identity("child", 2),
		});
		expect(rekeyed.status).toBe("committed");

		registry.disposeSession({ identity: identity("child", 2) });
		expect(registry.createSession({ identity: identity("child", 3) }).status).toBe("committed");
	});
});
