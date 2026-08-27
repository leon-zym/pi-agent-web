import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UserMessageBubble } from "../src/features/conversation/UserMessageBubble";
import { reportAuthoritativeAttachmentFailure, sessionImageKey } from "../src/lib/session-attachment";

describe("UserMessageBubble attachment refs", () => {
	it("keeps large inline bodies out of React list keys", () => {
		const data = "a".repeat(2 * 1024 * 1024);
		const key = sessionImageKey({ type: "image", mimeType: "image/png", data }, 3);
		expect(key).toBe("image/png:inline:3");
		expect(key).not.toContain(data);
	});

	it("reports only the exact generation whose authoritative baseline has committed", () => {
		const report = vi.fn(() => true);
		expect(
			reportAuthoritativeAttachmentFailure(
				"session-a",
				{ baselineAuthoritative: false, runtime: { generation: 8 } },
				report,
			),
		).toBe(false);
		expect(report).not.toHaveBeenCalled();

		expect(
			reportAuthoritativeAttachmentFailure(
				"session-a",
				{ baselineAuthoritative: true, runtime: { generation: 8 } },
				report,
			),
		).toBe(true);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith("session-a", 8, expect.any(Error));
	});

	it("renders a trusted ref through an authenticated same-origin attachment URL", () => {
		const html = renderToStaticMarkup(
			createElement(UserMessageBubble, {
				message: {
					entryKey: "user-ref",
					text: "restored image",
					source: "prompt",
					delivered: true,
					images: [
						{
							type: "image",
							mimeType: "image/png",
							data: {
								type: "attachment_ref",
								serverEpoch: "epoch-a",
								sha256: "d".repeat(64),
								mediaType: "image/png",
								byteLength: 48,
							},
						},
					] as never,
				},
			}),
		);

		expect(html).toContain(`/api/v1/attachments/epoch-a/${"d".repeat(64)}`);
		expect(html).not.toContain("data:image/png;base64");
		expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
	});
});
