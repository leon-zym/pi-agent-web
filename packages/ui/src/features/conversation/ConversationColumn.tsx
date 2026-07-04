import { useViewStore } from "../../stores/view";
import { ComposerSeat } from "../composer/ComposerSeat";
import { ExtensionStatusStrip, ExtensionWidgets } from "../extension-ui/ExtensionStatusStrip";
import { ChatViewport } from "./ChatViewport";
import { SessionHeader } from "./SessionHeader";

/**
 * Center column: session header over the scroll viewport with the
 * persistent composer seat docked at the bottom.
 */
export function ConversationColumn() {
	const rightPanelOpen = useViewStore((s) => s.rightPanelOpen);

	return (
		<div className="flex h-full min-w-0 flex-col">
			<SessionHeader />
			<div className="relative min-h-0 flex-1">
				<ChatViewport />
				{/* Extension status aggregation strip sits directly above the composer. */}
				<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 mx-auto flex w-full max-w-[780px] flex-col items-stretch px-4 pb-1">
					<ExtensionStatusStrip />
				</div>
			</div>
			<ExtensionWidgets placement="belowEditor" />
			<ComposerSeat />
			{rightPanelOpen && <div className="hidden" />}
		</div>
	);
}
