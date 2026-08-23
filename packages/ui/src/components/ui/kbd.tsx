import type * as React from "react";
import { cn } from "../../lib/utils";

export interface KbdProps extends React.ComponentProps<"kbd"> {}

export function Kbd({ className, ...props }: KbdProps) {
	return (
		<kbd
			className={cn(
				"inline-flex items-center justify-center rounded-xs border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-2 tabular-nums select-none",
				className,
			)}
			{...props}
		/>
	);
}
