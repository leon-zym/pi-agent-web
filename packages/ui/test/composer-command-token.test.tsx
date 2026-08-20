import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerCommandToken } from "../src/features/composer/ComposerSeat";

describe("composer command token", () => {
	it("uses the compact status-capsule geometry for a selected skill", () => {
		const html = renderToStaticMarkup(
			<ComposerCommandToken
				command={{ name: "skill:review", displayName: "review", source: "skill" }}
				onRemove={() => undefined}
			/>,
		);

		expect(html).toContain('data-slot="badge"');
		expect(html).toContain("rounded-full");
		expect(html).toContain("h-6");
		expect(html).toContain("/review");
		expect(html).not.toContain("h-8");
		expect(html).not.toContain("max-lg:h-10");
	});
});
