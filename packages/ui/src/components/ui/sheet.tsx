import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
	return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
	return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
	return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
	className,
	children,
	side = "right",
	...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: "top" | "right" | "bottom" | "left" }) {
	return (
		<SheetPrimitive.Portal>
			<SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
			<SheetPrimitive.Content
				data-slot="sheet-content"
				className={cn(
					"fixed z-50 flex flex-col gap-4 border-border bg-base shadow-lv3 outline-none transition-transform",
					side === "right" &&
						"inset-y-0 right-0 h-full w-80 border-l data-[state=closed]:translate-x-full data-[state=open]:translate-x-0",
					side === "left" &&
						"inset-y-0 left-0 h-full w-80 border-r data-[state=closed]:-translate-x-full data-[state=open]:translate-x-0",
					side === "bottom" &&
						"inset-x-0 bottom-0 border-t data-[state=closed]:translate-y-full data-[state=open]:translate-y-0",
					className,
				)}
				{...props}
			>
				{children}
				<SheetPrimitive.Close className="absolute right-3.5 top-3.5 rounded-sm text-ink-3 opacity-70 transition-opacity hover:bg-hover hover:text-ink focus:ring-2 focus:ring-primary/40 focus:outline-none disabled:pointer-events-none">
					<X className="size-4" />
					<span className="sr-only">关闭</span>
				</SheetPrimitive.Close>
			</SheetPrimitive.Content>
		</SheetPrimitive.Portal>
	);
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
	return (
		<SheetPrimitive.Title
			data-slot="sheet-title"
			className={cn("px-5 pt-5 text-base font-semibold", className)}
			{...props}
		/>
	);
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
	return (
		<SheetPrimitive.Description
			data-slot="sheet-description"
			className={cn("px-5 text-sm text-ink-2", className)}
			{...props}
		/>
	);
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger };
