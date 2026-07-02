import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-base disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
	{
		variants: {
			variant: {
				default: "bg-primary text-white hover:bg-primary-hover",
				secondary: "bg-surface-2 text-ink hover:bg-hover",
				ghost: "text-ink-2 hover:bg-hover hover:text-ink",
				outline: "border border-border-strong bg-transparent text-ink hover:bg-hover",
				destructive: "bg-danger text-white hover:bg-danger/90",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-8 px-3",
				sm: "h-7 rounded-sm px-2.5 text-xs",
				lg: "h-9 rounded-sm px-4",
				icon: "size-7 rounded-sm",
				"icon-lg": "size-9 rounded-full",
				pill: "h-8 rounded-full px-4",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant,
	size,
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot : "button";
	return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export type ButtonProps = React.ComponentProps<typeof Button>;

export { Button, buttonVariants };
