import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getToolPresenter } from "../src/features/conversation/tool-presenters";

describe("tool presenters", () => {
	it("renders an edit result as a semantic inline diff", () => {
		const presenter = getToolPresenter("edit");
		const body = presenter.renderBody?.({
			block: {
				type: "tool_call",
				key: "edit-1",
				toolCallId: "call-1",
				toolName: "edit",
				argsText: "",
				args: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
				status: "done",
			},
			results: [
				{
					toolCallId: "call-1",
					toolName: "edit",
					content: "Edited src/app.ts",
					isError: false,
					details: { diff: "@@ -1 +1 @@\n-old\n+new" },
				},
			],
		});

		const html = renderToStaticMarkup(body);
		expect(html).toContain('data-diff-kind="hunk"');
		expect(html).toContain('data-diff-kind="delete"');
		expect(html).toContain('data-diff-kind="add"');
		expect(html).toContain("-old");
		expect(html).toContain("+new");
	});

	it("falls back to the generic body when Pi supplies no diff details", () => {
		const presenter = getToolPresenter("edit");
		const body = presenter.renderBody?.({
			block: {
				type: "tool_call",
				key: "edit-2",
				toolCallId: "call-2",
				toolName: "edit",
				argsText: "",
				args: { path: "src/app.ts" },
				status: "done",
			},
			results: [],
		});
		expect(body).toBeNull();
	});
});
