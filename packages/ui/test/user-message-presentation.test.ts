import { describe, expect, it } from "vitest";
import { presentUserMessage, serializePresentedUserMessage } from "../src/lib/user-message-presentation";

describe("user message presentation", () => {
	it("keeps user arguments only for an unambiguous expanded skill envelope", () => {
		const presented = presentUserMessage(
			'<skill name="review" location="/private/review/SKILL.md">\nPRIVATE BODY\n</skill>\n\nfocus on auth',
		);

		expect(presented).toEqual({ command: "/skill:review", text: "focus on auth" });
		expect(serializePresentedUserMessage(presented)).toBe("/skill:review focus on auth");
	});

	it("copies only the command when the skill body contains another closing delimiter", () => {
		const presented = presentUserMessage(
			'<skill name="review" location="/private/review/SKILL.md">\nExample:\n</skill>\n\nPRIVATE BODY AFTER EXAMPLE\n</skill>\n\nreal user args',
		);
		const copied = serializePresentedUserMessage(presented);

		expect(presented).toEqual({ command: "/skill:review", text: "" });
		expect(copied).toBe("/skill:review");
		expect(copied).not.toContain("PRIVATE");
		expect(copied).not.toContain("/private");
		expect(copied).not.toContain("real user args");
	});

	it("does not treat an inline closing-token example as the envelope boundary", () => {
		const presented = presentUserMessage(
			'<skill name="review" location="/private/review/SKILL.md">\nUse inline example: </skill>\n\nPRIVATE TRAILING BODY',
		);

		expect(presented).toEqual({ command: "/skill:review", text: "" });
		expect(serializePresentedUserMessage(presented)).toBe("/skill:review");
	});
});
