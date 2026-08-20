import { expectData } from "@pi-agent-web/protocol";
import { Check, CircleAlert, Copy, GitFork, OctagonX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { displayError, formatCost, formatDuration, formatTokens, stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { forkFromEntry, sendReadCommand } from "../../lib/session-controller";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSessionTransportStore } from "../../stores/session-transport";
import type { ProductTurn } from "../../types/view-models";

/**
 * The single turn-level footer: timing, tokens, cost, and error /
 * aborted markers live here, not on every assistant fragment. Fork acts on
 * the newest forkable user message of the session (get_fork_messages).
 */
export function TurnTail({ turn }: { turn: ProductTurn }) {
	const [copied, setCopied] = useState(false);
	const sessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const canControl = useSessionTransportStore((state) => {
		const channel = sessionHandle ? state.sessions[sessionHandle] : undefined;
		return Boolean(channel?.lease.isController && channel.lease.fencingToken);
	});

	const copyTurn = async () => {
		const text = turn.steps
			.map((step) =>
				step.blocks
					.filter((block) => block.type === "text")
					.map((block) => (block.type === "text" ? block.markdown : ""))
					.join("\n\n"),
			)
			.join("\n\n");
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	const forkLast = async () => {
		if (!sessionHandle) return;
		try {
			const response = await sendReadCommand(sessionHandle, { type: "get_fork_messages" });
			const { messages } = expectData(response) as { messages: Array<{ entryId: string; text: string }> };
			const last = messages[messages.length - 1];
			if (!last) {
				toast.info(tt("tail.noForkMessages"));
				return;
			}
			await forkFromEntry(last.entryId);
		} catch (error) {
			toast.error(tt("tail.forkFailed"), {
				description: displayError(error),
			});
		}
	};

	const totalTokens = turn.usage?.totalTokens ?? sumStepTokens(turn);
	const cost = turn.usage?.cost ?? 0;

	return (
		<div className="flex min-h-6 items-center gap-2 text-[11px] text-ink-3">
			{turn.status === "error" && (
				<span className="inline-flex items-center gap-1 text-danger">
					<CircleAlert className="size-3.5" />
					{turn.errorMessage ? stripAnsi(turn.errorMessage) : tt("tail.modelError")}
				</span>
			)}
			{turn.status === "aborted" && (
				<span className="inline-flex items-center gap-1 text-ink-3">
					<OctagonX className="size-3.5" />
					{tt("common.stopped")}
				</span>
			)}
			{turn.status === "settled" && (
				<span className="inline-flex items-center gap-1 text-success">
					<Check className="size-3.5" />
					{tt("common.done")}
				</span>
			)}
			<span className="font-mono tabular-nums">
				{turn.timing?.durationMs !== undefined ? formatDuration(turn.timing.durationMs) : ""}
			</span>
			{totalTokens > 0 && <span className="font-mono tabular-nums">{formatTokens(totalTokens)} tokens</span>}
			{cost > 0 && <span className="font-mono tabular-nums">{formatCost(cost)}</span>}
			<span className="flex-1" />
			<button
				type="button"
				className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
				onClick={() => void copyTurn()}
			>
				{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
				{copied ? tt("common.copied") : tt("common.copy")}
			</button>
			<button
				type="button"
				className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
				onClick={() => void forkLast()}
				disabled={!canControl}
			>
				<GitFork className="size-3" />
				{tt("common.fork")}
			</button>
		</div>
	);
}

function sumStepTokens(turn: ProductTurn): number {
	let sum = 0;
	for (const step of turn.steps) {
		sum += step.usage?.totalTokens ?? 0;
	}
	return sum;
}
