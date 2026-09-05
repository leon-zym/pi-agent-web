import { Check, Sparkles } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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

const RECOMMENDED_REGEX = /\s*[(（[]\s*(recommended|推荐)\s*[)）\]]\s*/i;

export function parseOptionText(option: string): ParsedOption {
	const isRecommended = RECOMMENDED_REGEX.test(option);
	const label = option.replace(RECOMMENDED_REGEX, "").trim();
	return {
		raw: option,
		label: label || option,
		isRecommended,
	};
}

export function getQuestionCardNavigationIndex(
	key: string,
	activeIndex: number,
	optionCount: number,
): number | null {
	if (optionCount <= 0) return null;
	const current = Math.min(Math.max(activeIndex, 0), optionCount - 1);
	switch (key) {
		case "ArrowDown":
		case "ArrowRight":
			return (current + 1) % optionCount;
		case "ArrowUp":
		case "ArrowLeft":
			return (current - 1 + optionCount) % optionCount;
		case "Home":
			return 0;
		case "End":
			return optionCount - 1;
		default:
			return null;
	}
}

export function getQuestionCardShortcutIndex(key: string, optionCount: number): number | null {
	if (optionCount <= 0 || !/^[1-9]$/u.test(key)) return null;
	const index = Number.parseInt(key, 10) - 1;
	return index < optionCount ? index : null;
}

export function getQuestionCardOptionGroupName(instanceId: string): string {
	return `question-card-options-${instanceId}`;
}

export interface QuestionCardFocusRoot {
	contains: (node: Node | null) => boolean;
}

export function isQuestionCardFocused(
	root: QuestionCardFocusRoot | null,
	activeElement: Node | null,
): boolean {
	if (!root || activeElement === null || activeElement === undefined) return false;
	return root.contains(activeElement);
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
	const optionGroupName = getQuestionCardOptionGroupName(useId());
	const [customInput, setCustomInput] = useState("");
	const [isCustomSelected, setIsCustomSelected] = useState(false);

	const parsedOptions = useMemo(() => options.map(parseOptionText), [options]);
	const initialActiveIndex = Math.max(
		0,
		selectedValue === null
			? parsedOptions.findIndex((option) => option.isRecommended)
			: parsedOptions.findIndex((option) => option.raw === selectedValue),
	);
	const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
	const optionRefs = useRef<Array<HTMLInputElement | null>>([]);
	const cardRef = useRef<HTMLDivElement | null>(null);

	// Auto-detect and pre-select recommended option
	useEffect(() => {
		if (selectedValue === null) {
			const recommended = parsedOptions.find((opt) => opt.isRecommended);
			if (recommended) {
				onSelect(recommended.raw);
			}
		}
	}, [parsedOptions, selectedValue, onSelect]);

	useEffect(() => {
		const selectedIndex = parsedOptions.findIndex((option) => option.raw === selectedValue);
		if (selectedIndex >= 0) {
			setActiveIndex(selectedIndex);
			return;
		}
		setActiveIndex((current) => Math.min(current, Math.max(parsedOptions.length - 1, 0)));
	}, [parsedOptions, selectedValue]);

	const selectOption = useCallback(
		(index: number, directSubmit = false) => {
			if (disabled) return;
			const chosen = parsedOptions[index]?.raw;
			if (!chosen) return;
			setActiveIndex(index);
			setIsCustomSelected(false);
			onSelect(chosen);
			if (directSubmit) onDirectSubmit?.(chosen);
		},
		[disabled, onDirectSubmit, onSelect, parsedOptions],
	);

	const focusOption = useCallback(
		(index: number) => {
			selectOption(index);
			optionRefs.current[index]?.focus();
		},
		[selectOption],
	);

	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (disabled || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (
			target &&
			((target.tagName === "INPUT" && (target as HTMLInputElement).type !== "radio") ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable)
		) {
			return;
		}
		const shortcut = getQuestionCardShortcutIndex(event.key, parsedOptions.length);
		if (shortcut !== null) {
			event.preventDefault();
			selectOption(shortcut, true);
			return;
		}
		const nextIndex = getQuestionCardNavigationIndex(event.key, activeIndex, parsedOptions.length);
		if (nextIndex === null) return;
		event.preventDefault();
		focusOption(nextIndex);
	};

	// Keyboard 1-9 shortcuts
	useEffect(() => {
		if (disabled) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			const activeElement = typeof document === "undefined" ? null : document.activeElement;
			if (!isQuestionCardFocused(cardRef.current, activeElement)) return;
			const target = event.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
			) {
				return;
			}

			const shortcut = getQuestionCardShortcutIndex(event.key, parsedOptions.length);
			if (shortcut !== null) {
				event.preventDefault();
				const chosen = parsedOptions[shortcut]?.raw;
				if (chosen) {
					selectOption(shortcut, true);
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [disabled, parsedOptions, selectOption]);

	const handleCustomChange = (val: string) => {
		setCustomInput(val);
		setIsCustomSelected(true);
		onSelect(val);
	};

	return (
		<div ref={cardRef} data-testid="question-card" className="flex flex-col gap-1.5">
			<div
				role="radiogroup"
				aria-label={tt("ext.choices")}
				onKeyDown={handleKeyDown}
				className="flex flex-col gap-1"
			>
				{parsedOptions.map((opt, index) => {
					const isSelected = !isCustomSelected && selectedValue === opt.raw;
					const shortcutNumber = index < 9 ? index + 1 : null;

					return (
						<label
							key={opt.raw}
							data-testid={`question-option-${index}`}
							className={cn(
								"flex min-h-9 cursor-pointer items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover focus-within:ring-2 focus-within:ring-primary/40",
								isSelected ? "border-primary/50 bg-primary-soft text-ink" : "bg-surface text-ink-2",
								disabled && "cursor-not-allowed opacity-60",
							)}
						>
							<input
								type="radio"
								name={optionGroupName}
								checked={isSelected}
								aria-checked={isSelected}
								aria-keyshortcuts={shortcutNumber === null ? undefined : String(shortcutNumber)}
								tabIndex={activeIndex === index ? 0 : -1}
								ref={(element) => {
									optionRefs.current[index] = element;
								}}
								onChange={() => selectOption(index)}
								disabled={disabled}
								className="sr-only"
							/>
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
						</label>
					);
				})}
			</div>

			{allowCustom && (
				<div className="mt-1 flex flex-col gap-1">
					<Input
						data-testid="question-custom-input"
						aria-label={tt("ext.customInput")}
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
