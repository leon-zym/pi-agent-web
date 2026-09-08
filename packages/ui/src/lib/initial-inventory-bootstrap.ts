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

interface DirectoryReconnectDependencies {
	readTransportState: InitialInventoryBootstrapDependencies["readTransportState"];
	subscribeTransportState: (listener: () => void) => () => void;
	invalidateDirectoryRequests: () => void;
	loadWorkspaces: (options: { isCurrent: () => boolean }) => Promise<void>;
	reloadCurrentSessions: (options: { isCurrent: () => boolean }) => Promise<unknown>;
}

/** Installed after initial bootstrap; each subsequent authenticated connection owns one refresh. */
export function watchDirectoryReconnect(dependencies: DirectoryReconnectDependencies): () => void {
	let connected = true;
	let generation = 0;
	let disposed = false;
	const observe = () => {
		const state = dependencies.readTransportState();
		if (state.connectionState !== "online" || !state.hotRuntimeInventory) {
			if (connected) generation += 1;
			connected = false;
			return;
		}
		if (connected) return;
		connected = true;
		const request = generation;
		const isCurrent = () => !disposed && generation === request;
		dependencies.invalidateDirectoryRequests();
		void (async () => {
			await dependencies.loadWorkspaces({ isCurrent });
			if (isCurrent()) await dependencies.reloadCurrentSessions({ isCurrent });
		})();
	};
	const unsubscribe = dependencies.subscribeTransportState(observe);
	observe();
	return () => {
		disposed = true;
		unsubscribe();
		dependencies.invalidateDirectoryRequests();
	};
}
