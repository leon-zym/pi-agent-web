import type { HotRuntimeInventoryDto } from "@pi-agent-web/protocol";
import type { HotRuntimeInventoryToken, SessionTransportConnectionState } from "../stores/session-transport";

interface InitialInventoryBootstrapDependencies {
	waitForInitialHotInventory: () => Promise<HotRuntimeInventoryToken>;
	loadWorkspaces: () => Promise<void>;
	readTransportState: () => {
		connectionState: SessionTransportConnectionState;
		hotRuntimeInventory: HotRuntimeInventoryDto | null;
	};
	isCancelled: () => boolean;
}

/** Keep REST directory state fenced to the same online Gateway epoch observed before loading. */
export async function loadDirectoryAfterStableHotInventory({
	waitForInitialHotInventory,
	loadWorkspaces,
	readTransportState,
	isCancelled,
}: InitialInventoryBootstrapDependencies): Promise<boolean> {
	for (;;) {
		const inventoryToken = await waitForInitialHotInventory();
		if (isCancelled()) return false;
		await loadWorkspaces();
		if (isCancelled()) return false;
		const transport = readTransportState();
		const inventory = transport.hotRuntimeInventory;
		if (transport.connectionState === "online" && inventory?.serverEpoch === inventoryToken.serverEpoch) {
			return true;
		}
	}
}
