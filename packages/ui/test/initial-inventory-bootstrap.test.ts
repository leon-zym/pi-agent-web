import type { HotRuntimeInventoryDto } from "@pi-agent-web/protocol";
import { describe, expect, it, vi } from "vitest";
import { loadDirectoryAfterStableHotInventory } from "../src/lib/initial-inventory-bootstrap";

describe("initial hot inventory bootstrap", () => {
	it("accepts a newer same-epoch inventory revision after bounded REST loading", async () => {
		const waitForInitialHotInventory = vi
			.fn()
			.mockResolvedValueOnce({ serverEpoch: "epoch-1", revision: 1 })
			.mockRejectedValue(new Error("same-epoch revision must not restart bootstrap"));
		const loadWorkspaces = vi.fn(async () => undefined);
		await expect(
			loadDirectoryAfterStableHotInventory({
				waitForInitialHotInventory,
				loadWorkspaces,
				readTransportState: () => ({
					connectionState: "online",
					hotRuntimeInventory: {
						type: "hot_runtime_inventory",
						serverEpoch: "epoch-1",
						revision: 99,
						runtimes: [],
					},
				}),
				isCancelled: () => false,
			}),
		).resolves.toBe(true);
		expect(waitForInitialHotInventory).toHaveBeenCalledTimes(1);
		expect(loadWorkspaces).toHaveBeenCalledTimes(1);
	});

	it("reconciles again when the connection identity changes during REST directory loading", async () => {
		const tokens = [
			{ serverEpoch: "epoch-1", revision: 1 },
			{ serverEpoch: "epoch-2", revision: 3 },
		];
		const waitForInitialHotInventory = vi.fn(async () => {
			const token = tokens.shift();
			if (!token) throw new Error("unexpected inventory wait");
			return token;
		});
		const loadWorkspaces = vi.fn(async () => undefined);
		const matchingInventory = {
			type: "hot_runtime_inventory",
			serverEpoch: "epoch-2",
			revision: 3,
			runtimes: [],
		} satisfies HotRuntimeInventoryDto;

		await expect(
			loadDirectoryAfterStableHotInventory({
				waitForInitialHotInventory,
				loadWorkspaces,
				readTransportState: () => ({
					connectionState: "online",
					hotRuntimeInventory: matchingInventory,
				}),
				isCancelled: () => false,
			}),
		).resolves.toBe(true);
		expect(waitForInitialHotInventory).toHaveBeenCalledTimes(2);
		expect(loadWorkspaces).toHaveBeenCalledTimes(2);
	});

	it("stops before directory work when the component has unmounted", async () => {
		const loadWorkspaces = vi.fn(async () => undefined);
		await expect(
			loadDirectoryAfterStableHotInventory({
				waitForInitialHotInventory: async () => ({ serverEpoch: "epoch-1", revision: 1 }),
				loadWorkspaces,
				readTransportState: () => ({ connectionState: "offline", hotRuntimeInventory: null }),
				isCancelled: () => true,
			}),
		).resolves.toBe(false);
		expect(loadWorkspaces).not.toHaveBeenCalled();
	});
});
