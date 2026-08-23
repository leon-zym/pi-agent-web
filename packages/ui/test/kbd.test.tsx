import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Kbd } from "../src/components/ui/kbd";

describe("Kbd component", () => {
	it("renders a <kbd> element with standard token classes", () => {
		const html = renderToStaticMarkup(<Kbd>⌘K</Kbd>);
		expect(html).toContain("<kbd");
		expect(html).toContain("⌘K");
		expect(html).toContain("font-mono");
		expect(html).toContain("tabular-nums");
		expect(html).toContain("bg-surface-2");
		expect(html).toContain("border");
		expect(html).toContain("border-border");
		expect(html).toContain("text-ink-2");
		expect(html).toContain("rounded-xs");
		expect(html).toContain("px-1.5");
		expect(html).toContain("py-0.5");
		expect(html).toContain("text-[11px]");
	});

	it("merges custom className and forwards HTML attributes", () => {
		const html = renderToStaticMarkup(
			<Kbd className="custom-class" data-testid="kbd-shortcut" title="Command Enter">
				⌘↵
			</Kbd>,
		);
		expect(html).toContain("custom-class");
		expect(html).toContain('data-testid="kbd-shortcut"');
		expect(html).toContain('title="Command Enter"');
		expect(html).toContain("⌘↵");
	});
});
