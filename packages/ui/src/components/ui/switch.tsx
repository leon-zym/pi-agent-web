import * as SwitchPrimitive from "@radix-ui/react-switch";
import type * as React from "react";
import { cn } from "../../lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"group peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-border-strong transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40 data-[state=checked]:bg-primary data-[state=unchecked]:bg-border-strong disabled:pointer-events-none disabled:opacity-50 [@media(hover:none)]:size-10 [@media(hover:none)]:!bg-transparent",
				className,
			)}
			{...props}
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 left-1/2 hidden h-5 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-strong [@media(hover:none)]:block group-data-[state=checked]:bg-primary"
			/>
			<SwitchPrimitive.Thumb className="pointer-events-none relative block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5 [@media(hover:none)]:absolute [@media(hover:none)]:top-3 [@media(hover:none)]:left-1" />
		</SwitchPrimitive.Root>
	);
}

export { Switch };
