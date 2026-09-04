import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
	getQuestionCardNavigationIndex,
	getQuestionCardOptionGroupName,
	getQuestionCardShortcutIndex,
	isQuestionCardFocused,
	parseOptionText,
	QuestionCard,
} from "../src/features/extension-ui/QuestionCard";

describe("QuestionCard component and option parsing", () => {
	it("parses recommendation tags from option strings", () => {
		expect(parseOptionText("Use Vitest (Recommended)")).toEqual({
			raw: "Use Vitest (Recommended)",
			label: "Use Vitest",
			isRecommended: true,
		});

		expect(parseOptionText("Fast mode [Recommended]")).toEqual({
			raw: "Fast mode [Recommended]",
			label: "Fast mode",
			isRecommended: true,
		});

		expect(parseOptionText("启用增量编译 (推荐)")).toEqual({
			raw: "启用增量编译 (推荐)",
			label: "启用增量编译",
			isRecommended: true,
		});

		expect(parseOptionText("全量架构优化（推荐）")).toEqual({
			raw: "全量架构优化（推荐）",
			label: "全量架构优化",
			isRecommended: true,
		});

		expect(parseOptionText("Standard mode")).toEqual({
			raw: "Standard mode",
			label: "Standard mode",
			isRecommended: false,
		});
	});

	it("renders options, recommended badges, and Kbd shortcut numbers", () => {
		const onSelect = vi.fn();
		const options = ["Option Alpha (Recommended)", "Option Beta", "Option Gamma"];

		const html = renderToStaticMarkup(
			createElement(QuestionCard, {
				options,
				selectedValue: "Option Beta",
				onSelect,
			}),
		);

		expect(html).toContain('data-testid="question-card"');
		expect(html).toContain("Option Alpha");
		expect(html).toContain("Option Beta");
		expect(html).toContain("Option Gamma");
		expect(html).toContain('data-testid="recommended-badge"');
		expect(html).toContain('role="radiogroup"');
		expect(html).toContain('aria-label="选项"');
		expect((html.match(/type="radio"/g) ?? []).length).toBe(3);
		expect(html).toContain('aria-checked="true"');
		const selectedRow = html.match(
			/<label\b[^>]*data-testid="question-option-1"[^>]*>[\s\S]*?<\/label>/,
		)?.[0];
		expect(selectedRow).toContain("bg-primary-soft");
		expect(html).not.toMatch(/<input\b[^>]*data-testid="question-option-/);
		const radioInputs = html.match(/<input\b[^>]*type="radio"[^>]*>/g) ?? [];
		expect(radioInputs[0]).toContain('tabindex="-1"');
		expect(radioInputs[1]).toContain('tabindex="0"');
		expect(radioInputs[2]).toContain('tabindex="-1"');
		expect(html).toContain("<kbd");
		expect(html).toContain(">1<");
		expect(html).toContain(">2<");
		expect(html).toContain(">3<");
	});

	it("maps radio navigation keys with wrapping and Home/End", () => {
		expect(getQuestionCardNavigationIndex("ArrowRight", 0, 3)).toBe(1);
		expect(getQuestionCardNavigationIndex("ArrowDown", 2, 3)).toBe(0);
		expect(getQuestionCardNavigationIndex("ArrowLeft", 0, 3)).toBe(2);
		expect(getQuestionCardNavigationIndex("ArrowUp", 0, 3)).toBe(2);
		expect(getQuestionCardNavigationIndex("Home", 2, 3)).toBe(0);
		expect(getQuestionCardNavigationIndex("End", 0, 3)).toBe(2);
		expect(getQuestionCardNavigationIndex("PageDown", 0, 3)).toBeNull();
	});

	it("maps only the first nine number keys to available choices", () => {
		expect(getQuestionCardShortcutIndex("1", 3)).toBe(0);
		expect(getQuestionCardShortcutIndex("9", 9)).toBe(8);
		expect(getQuestionCardShortcutIndex("9", 8)).toBeNull();
		expect(getQuestionCardShortcutIndex("0", 3)).toBeNull();
		expect(getQuestionCardShortcutIndex("a", 3)).toBeNull();
	});

	it("isolates coexisting cards and scopes numeric shortcuts to the focused card", () => {
		const html = renderToStaticMarkup(
			createElement(
				"div",
				null,
				createElement(QuestionCard, {
					options: ["First card"],
					selectedValue: null,
					onSelect: () => undefined,
				}),
				createElement(QuestionCard, {
					options: ["Second card"],
					selectedValue: null,
					onSelect: () => undefined,
				}),
			),
		);
		const groupNames = [...html.matchAll(/<input\b[^>]*type="radio"[^>]*name="([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(groupNames).toHaveLength(2);
		expect(new Set(groupNames).size).toBe(2);
		expect(getQuestionCardOptionGroupName("card-a")).toBe("question-card-options-card-a");

		const activeElement = {} as Node;
		const focusedCard = { contains: (candidate: Node | null) => candidate === activeElement };
		const backgroundCard = { contains: () => false };
		expect(isQuestionCardFocused(focusedCard, activeElement)).toBe(true);
		expect(isQuestionCardFocused(backgroundCard, activeElement)).toBe(false);
		expect(isQuestionCardFocused(focusedCard, null)).toBe(false);
	});

	it("renders custom write-in input", () => {
		const html = renderToStaticMarkup(
			createElement(QuestionCard, {
				options: ["Option 1", "Option 2"],
				selectedValue: null,
				onSelect: () => undefined,
				allowCustom: true,
			}),
		);

		expect(html).toContain('data-testid="question-custom-input"');
	});
});
