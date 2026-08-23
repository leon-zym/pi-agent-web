import { MobileTopBar } from "../../components/mobile/MobileTopBar";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSessionTransportStore } from "../../stores/session-transport";
import { ComposerSeat } from "../composer/ComposerSeat";
import { ExtensionStatusStrip, ExtensionWidgets } from "../extension-ui/ExtensionStatusStrip";
import { ChatViewport } from "./ChatViewport";
import { SessionHeader } from "./SessionHeader";

/**
 * Center column: session header over the scroll viewport with the
 * persistent composer seat docked at the bottom.
 */
export function ConversationColumn({
	hideHeader = false,
	isMobile = false,
	onOpenSwitcher,
}: {
	hideHeader?: boolean;
	isMobile?: boolean;
	onOpenSwitcher?: () => void;
} = {}) {
	const currentWorkspace = useSessionDirectoryStore((s) => s.currentWorkspace);
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const runtime = useSessionTransportStore((s) =>
		currentSession?.sessionHandle ? s.sessions[currentSession.sessionHandle]?.runtime : undefined,
	);

	return (
		<div className="flex h-full min-w-0 flex-col">
			{!hideHeader &&
				(isMobile && onOpenSwitcher ? (
					<MobileTopBar
						workspace={currentWorkspace}
						session={currentSession}
						status={runtime?.state}
						onOpenSwitcher={onOpenSwitcher}
					/>
				) : (
					<SessionHeader />
				))}
			<div className="relative min-h-0 flex-1">
				<ChatViewport />
				{/* Extension status aggregation strip sits directly above the composer. */}
				<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 mx-auto flex w-full max-w-[780px] flex-col items-stretch px-4 pb-1">
					<ExtensionStatusStrip />
				</div>
			</div>
			<ExtensionWidgets placement="belowEditor" />
			<ComposerSeat />
		</div>
	);
}
