import type * as React from "react";
import { cn } from "../../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"flex h-8 w-full rounded-sm border border-border bg-surface px-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
