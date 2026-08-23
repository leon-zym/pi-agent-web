import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseOptionText, QuestionCard } from "../src/features/extension-ui/QuestionCard";

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
		expect(html).toContain("<kbd");
		expect(html).toContain(">1<");
		expect(html).toContain(">2<");
		expect(html).toContain(">3<");
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
