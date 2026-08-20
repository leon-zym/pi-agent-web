import type { DeliveryMode } from "../../stores/composer";

export function resolveRunningSubmitKind(
	deliveryMode: DeliveryMode,
	queueShortcut: boolean,
): "steer" | "follow_up" {
	if (queueShortcut) return "follow_up";
	return deliveryMode === "follow_up" ? "follow_up" : "steer";
}
