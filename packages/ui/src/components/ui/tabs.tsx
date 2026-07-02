import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "../../lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
	return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			className={cn("flex items-center gap-4 border-b border-border", className)}
			{...props}
		/>
	);
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
	return (
		<TabsPrimitive.Trigger
			data-slot="tabs-trigger"
			className={cn(
				"relative -mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-0.5 pb-2 text-[13px] font-medium text-ink-3 outline-none transition-colors hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-primary/40 data-[state=active]:border-primary data-[state=active]:text-ink",
				className,
			)}
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
	return (
		<TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />
	);
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
