import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
	"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums",
	{
		variants: {
			variant: {
				default: "border-transparent bg-surface-2 text-ink-2",
				primary: "border-transparent bg-primary-soft text-primary",
				success: "border-transparent bg-success-soft text-success",
				warning: "border-transparent bg-warning-soft text-warning",
				danger: "border-transparent bg-danger-soft text-danger",
				outline: "border-border-strong text-ink-2",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

function Badge({
	className,
	variant,
	...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
