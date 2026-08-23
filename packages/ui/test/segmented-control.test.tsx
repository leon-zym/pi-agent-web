import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl, type SegmentedControlOption } from "../src/components/ui/segmented-control";

describe("SegmentedControl component", () => {
	const options: SegmentedControlOption[] = [
		{ value: "off", label: "Off" },
		{ value: "low", label: "Low" },
		{ value: "high", label: "High" },
	];

	it("renders options with aria-pressed", () => {
		const onChange = vi.fn();
		const html = renderToStaticMarkup(
			createElement(SegmentedControl, {
				options,
				value: "low",
				onChange,
			}),
		);

		expect(html).toContain('aria-pressed="true"');
		expect(html).toContain('aria-pressed="false"');

		expect(html).toContain("Off");
		expect(html).toContain("Low");
		expect(html).toContain("High");
	});

	it("renders disabled state on the control or individual options", () => {
		const optionsWithDisabled: SegmentedControlOption[] = [
			{ value: "off", label: "Off" },
			{ value: "max", label: "Max", disabled: true },
		];

		const html = renderToStaticMarkup(
			createElement(SegmentedControl, {
				options: optionsWithDisabled,
				value: "off",
				onChange: () => undefined,
				disabled: true,
			}),
		);

		expect(html).toContain("cursor-not-allowed");
	});
});
