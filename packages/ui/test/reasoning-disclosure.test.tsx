import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ReasoningDisclosure } from "../src/features/conversation/ReasoningDisclosure";
import { useViewStore } from "../src/stores/view";

describe("ReasoningDisclosure component", () => {
	beforeEach(() => {
		useViewStore.getState().clearSession();
	});

	it("renders streaming state with 5-line scrollable window, sweep pulse, and live indicator", () => {
		const text =
			"Analyzing dependencies...\nResolving package versions...\nChecking lockfile...\nDone step 1.\nReady.";
		const html = renderToStaticMarkup(<ReasoningDisclosure text={text} status="streaming" isTail={true} />);

		// Shows thinking sweep when streaming and isTail
		expect(html).toContain("thinking-sweep");

		// Has 5-line scrollable window with max-h-[110px] and scroll-slim
		expect(html).toContain("max-h-[110px]");
		expect(html).toContain("overflow-y-auto");
		expect(html).toContain("scroll-slim");
		expect(html).toContain("Analyzing dependencies");
		expect(html).toContain("Ready.");
	});

	it("renders settled state showing tail teaser summary by default and uses CSS grid for fold", () => {
		const text = "First thought.\nSecond thought.\nThis is the tail conclusion paragraph.";
		const html = renderToStaticMarkup(<ReasoningDisclosure text={text} status="settled" isTail={false} />);

		// Collapsed by default
		expect(html).toContain('aria-expanded="false"');

		// Header displays the tail teaser summary
		expect(html).toContain("This is the tail conclusion paragraph.");

		// Grid collapse structure
		expect(html).toContain("grid-rows-[0fr]");
		expect(html).toContain("transition-[grid-template-rows]");
	});

	it("renders expanded state with full text when defaultOpen is true", () => {
		const text = "First thought.\nSecond thought.\nThis is the tail conclusion paragraph.";
		const html = renderToStaticMarkup(
			<ReasoningDisclosure text={text} status="settled" isTail={false} defaultOpen={true} />,
		);

		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("grid-rows-[1fr]");
		expect(html).toContain("First thought.");
	});

	it("renders micro ExternalLink button for secondary inspection action", () => {
		const html = renderToStaticMarkup(
			<ReasoningDisclosure text="Detailed thinking steps." status="settled" isTail={false} />,
		);

		expect(html).toContain("lucide-external-link");
		expect(html).toContain("<button");
	});
});
