import type * as React from "react";
import { useCallback } from "react";
import { cn } from "../../lib/utils";

export interface SegmentedControlOption<T extends string = string> {
	value: T;
	label: React.ReactNode;
	disabled?: boolean;
	ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string = string> {
	options: SegmentedControlOption<T>[];
	value: T | null;
	onChange: (value: T) => void;
	disabled?: boolean;
	size?: "sm" | "default";
	className?: string;
}

export function SegmentedControl<T extends string = string>({
	options,
	value,
	onChange,
	disabled = false,
	size = "default",
	className,
}: SegmentedControlProps<T>) {
	const handleButtonKeyDown = useCallback(
		(optValue: T, event: React.KeyboardEvent<HTMLButtonElement>) => {
			if (disabled) return;
			const enabledOptions = options.filter((opt) => !opt.disabled);
			if (enabledOptions.length === 0) return;

			const currentIndex = enabledOptions.findIndex((opt) => opt.value === optValue);

			if (event.key === "ArrowRight" || event.key === "ArrowDown") {
				event.preventDefault();
				const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabledOptions.length;
				const nextOpt = enabledOptions[nextIndex];
				if (nextOpt) onChange(nextOpt.value);
			} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
				event.preventDefault();
				const prevIndex = currentIndex <= 0 ? enabledOptions.length - 1 : currentIndex - 1;
				const prevOpt = enabledOptions[prevIndex];
				if (prevOpt) onChange(prevOpt.value);
			}
		},
		[disabled, options, onChange],
	);

	return (
		<div
			className={cn(
				"inline-flex items-center rounded-md border border-border bg-surface-2 p-0.5 text-xs text-ink-2",
				disabled && "cursor-not-allowed opacity-60",
				className,
			)}
		>
			{options.map((opt) => {
				const isSelected = value === opt.value;
				const isOptDisabled = disabled || opt.disabled;

				return (
					<button
						key={opt.value}
						type="button"
						aria-pressed={isSelected}
						aria-label={opt.ariaLabel}
						disabled={isOptDisabled}
						onKeyDown={(e) => handleButtonKeyDown(opt.value, e)}
						onClick={() => onChange(opt.value)}
						className={cn(
							"inline-flex items-center justify-center rounded-sm font-medium transition-[background-color,color,box-shadow] duration-150 select-none",
							size === "sm" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs",
							isSelected ? "bg-surface text-ink shadow-lv1" : "text-ink-3 hover:text-ink",
							isOptDisabled && "cursor-not-allowed opacity-50",
						)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
