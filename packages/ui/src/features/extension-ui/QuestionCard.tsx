import { Check, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Kbd } from "../../components/ui/kbd";
import { displayLabel } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";

export interface ParsedOption {
	raw: string;
	label: string;
	isRecommended: boolean;
}

const RECOMMENDED_REGEX = /\s*[(（\[]\s*(recommended|推荐)\s*[)）\]]\s*/i;

export function parseOptionText(option: string): ParsedOption {
	const isRecommended = RECOMMENDED_REGEX.test(option);
	const label = option.replace(RECOMMENDED_REGEX, "").trim();
	return {
		raw: option,
		label: label || option,
		isRecommended,
	};
}

export interface QuestionCardProps {
	options: string[];
	selectedValue: string | null;
	onSelect: (value: string) => void;
	disabled?: boolean;
	allowCustom?: boolean;
	onDirectSubmit?: (value: string) => void;
}

/**
 * Structured QuestionCard conforming to Pi protocol { value: string }.
 * Features:
 * - Direct keyboard 1-9 shortcuts with <Kbd> indicators.
 * - Automatic detection and badging of "(Recommended)" / "[Recommended]" options.
 * - Optional custom write-in input field.
 */
export function QuestionCard({
	options,
	selectedValue,
	onSelect,
	disabled = false,
	allowCustom = true,
	onDirectSubmit,
}: QuestionCardProps) {
	const [customInput, setCustomInput] = useState("");
	const [isCustomSelected, setIsCustomSelected] = useState(false);

	const parsedOptions = useMemo(() => options.map(parseOptionText), [options]);

	// Auto-detect and pre-select recommended option
	useEffect(() => {
		if (selectedValue === null) {
			const recommended = parsedOptions.find((opt) => opt.isRecommended);
			if (recommended) {
				onSelect(recommended.raw);
			}
		}
	}, [parsedOptions, selectedValue, onSelect]);

	// Keyboard 1-9 shortcuts
	useEffect(() => {
		if (disabled) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
			) {
				return;
			}

			const keyNum = Number.parseInt(event.key, 10);
			if (keyNum >= 1 && keyNum <= Math.min(parsedOptions.length, 9)) {
				event.preventDefault();
				const chosen = parsedOptions[keyNum - 1]?.raw;
				if (chosen) {
					setIsCustomSelected(false);
					onSelect(chosen);
					onDirectSubmit?.(chosen);
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [disabled, parsedOptions, onSelect, onDirectSubmit]);

	const handleOptionClick = (optionRaw: string) => {
		if (disabled) return;
		setIsCustomSelected(false);
		onSelect(optionRaw);
	};

	const handleCustomChange = (val: string) => {
		setCustomInput(val);
		setIsCustomSelected(true);
		onSelect(val);
	};

	return (
		<div data-testid="question-card" className="flex flex-col gap-1.5">
			<div className="flex flex-col gap-1">
				{parsedOptions.map((opt, index) => {
					const isSelected = !isCustomSelected && selectedValue === opt.raw;
					const shortcutNumber = index < 9 ? index + 1 : null;

					return (
						<button
							key={opt.raw}
							type="button"
							data-testid={`question-option-${index}`}
							onClick={() => handleOptionClick(opt.raw)}
							disabled={disabled}
							className={cn(
								"flex min-h-9 items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover",
								isSelected ? "border-primary/50 bg-primary-soft text-ink" : "bg-surface text-ink-2",
								disabled && "cursor-not-allowed opacity-60",
							)}
						>
							<div className="flex min-w-0 flex-1 items-center gap-2">
								<span
									className={cn(
										"flex size-4 shrink-0 items-center justify-center rounded-full border",
										isSelected ? "border-primary bg-primary text-white" : "border-border-strong",
									)}
								>
									{isSelected && <Check className="size-3" />}
								</span>
								<span className="min-w-0 truncate font-medium">{displayLabel(opt.label)}</span>
								{opt.isRecommended && (
									<Badge
										variant="primary"
										data-testid="recommended-badge"
										className="h-5 gap-0.5 px-1.5 text-[11px]"
									>
										<Sparkles className="size-3" />
										{tt("ext.recommended")}
									</Badge>
								)}
							</div>
							{shortcutNumber !== null && <Kbd className="size-5 shrink-0 text-[10px]">{shortcutNumber}</Kbd>}
						</button>
					);
				})}
			</div>

			{allowCustom && (
				<div className="mt-1 flex flex-col gap-1">
					<Input
						data-testid="question-custom-input"
						placeholder={tt("ext.customInput")}
						value={customInput}
						onChange={(e) => handleCustomChange(e.target.value)}
						onFocus={() => {
							if (customInput) {
								setIsCustomSelected(true);
								onSelect(customInput);
							}
						}}
						disabled={disabled}
						className={cn(
							"h-8 text-[13px]",
							isCustomSelected && customInput ? "border-primary ring-1 ring-primary/30" : "",
						)}
					/>
				</div>
			)}
		</div>
	);
}
