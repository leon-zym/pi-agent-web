import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
	return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
	return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
	className,
	children,
	side = "right",
	showCloseButton = true,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
	side?: "right" | "left";
	showCloseButton?: boolean;
}) {
	return (
		<SheetPrimitive.Portal>
			<SheetPrimitive.Overlay
				data-slot="sheet-overlay"
				className="fixed inset-0 z-50 bg-black/35 motion-reduce:transition-none"
			/>
			<SheetPrimitive.Content
				data-slot="sheet-content"
				className={cn(
					"fixed inset-y-0 z-50 flex h-full w-80 flex-col overflow-hidden border-border bg-base shadow-lv3 outline-none overscroll-contain",
					side === "right" ? "right-0 border-l" : "left-0 border-r",
					className,
				)}
				{...props}
			>
				{children}
				{showCloseButton && (
					<SheetPrimitive.Close className="absolute top-1.5 right-1.5 flex size-10 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none">
						<X className="size-4" />
						<span className="sr-only">{tt("common.close")}</span>
					</SheetPrimitive.Close>
				)}
			</SheetPrimitive.Content>
		</SheetPrimitive.Portal>
	);
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
	return (
		<SheetPrimitive.Title
			data-slot="sheet-title"
			className={cn("text-base font-semibold text-ink", className)}
			{...props}
		/>
	);
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
	return (
		<SheetPrimitive.Description
			data-slot="sheet-description"
			className={cn("text-sm text-ink-2", className)}
			{...props}
		/>
	);
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle };
