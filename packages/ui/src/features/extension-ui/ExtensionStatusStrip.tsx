import { displayLabel, stripAnsi } from "../../lib/format";
import { useExtensionUiStore } from "../../stores/extension-ui";

/**
 * Aggregated extension status bar (setStatus): one
 * compact mono strip above the composer. Cleared by setStatus(..., undefined).
 */
export function ExtensionStatusStrip() {
	const status = useExtensionUiStore((s) => s.status);
	const entries = Object.entries(status);
	if (entries.length === 0) return null;

	const visible = entries.slice(0, 4);
	const rest = entries.length - visible.length;

	return (
		<div className="mb-1 flex h-7 items-center gap-2 overflow-x-auto rounded-sm bg-surface-2 px-3 font-mono text-[12px] text-ink-2">
			{visible.map(([key, text]) => (
				<span key={key} className="shrink-0 whitespace-nowrap">
					<span className="text-ink-3">{displayLabel(key)}</span>
					<span className="mx-1 text-ink-3/60">·</span>
					{displayLabel(text)}
				</span>
			))}
			{rest > 0 && <span className="shrink-0 text-ink-3">+{rest}</span>}
		</div>
	);
}

/**
 * Extension widgets (setWidget, string arrays only in RPC mode) mounted above
 * or below the composer.
 */
export function ExtensionWidgets({ placement }: { placement: "aboveEditor" | "belowEditor" }) {
	const widgets = useExtensionUiStore((s) => s.widgets);
	const matching = Object.values(widgets).filter((widget) => widget.placement === placement);
	if (matching.length === 0) return null;

	return (
		<div className="flex flex-col">
			{matching.map((widget) => (
				<div key={widget.key} className="border-t border-border bg-surface">
					<p className="px-4 pt-2 pb-0.5 font-mono text-[10px] tracking-wide text-ink-3 uppercase">
						{displayLabel(widget.key)}
					</p>
					<div className="scroll-slim max-h-24 overflow-y-auto px-4 pb-2 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-ink-2">
						{widget.lines.map(stripAnsi).join("\n")}
					</div>
				</div>
			))}
		</div>
	);
}
