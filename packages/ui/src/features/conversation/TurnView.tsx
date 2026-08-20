import { memo } from "react";
import { tt } from "../../lib/i18n";
import type { ProductTurn } from "../../types/view-models";
import { AssistantStepView } from "./AssistantStepView";
import { TurnTail } from "./TurnTail";
import { UserMessageBubble } from "./UserMessageBubble";

/**
 * One product turn: queued/injected user messages, assistant steps, and a
 * single turn-level tail (timing/tokens/copy) under the last step.
 */
export const TurnView = memo(function TurnView({ turn }: { turn: ProductTurn }) {
	return (
		<section data-turn-id={turn.id} aria-label={tt("turn.sectionAria")} className="flex flex-col gap-4">
			{turn.userMessages.map((message) => (
				<UserMessageBubble key={message.entryKey} message={message} />
			))}
			{turn.steps.map((step) => (
				<AssistantStepView key={step.key} turnId={turn.id} step={step} />
			))}
			<TurnTail turn={turn} />
		</section>
	);
});
