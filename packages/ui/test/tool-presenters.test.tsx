import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCallRow } from "../src/features/conversation/ToolCallRow";
import { getToolPresenter } from "../src/features/conversation/tool-presenters";

describe("tool presenters", () => {
	it("renders the complete Bash command separately from its output", () => {
		const presenter = getToolPresenter("bash");
		const body = presenter.renderBody?.({
			block: {
				type: "tool_call",
				key: "bash-1",
				toolCallId: "call-bash",
				toolName: "bash",
				argsText: '{"command":"printf \\"first\\\\nsecond\\""}',
				args: { command: 'printf "first\\nsecond"' },
				status: "done",
				partialOutput: "still running",
				result: { output: "first\\nsecond\\n" },
			},
			results: [],
		});

		const html = renderToStaticMarkup(body);
		expect(html).toContain('data-tool-section="command"');
		expect(html).toContain("printf &quot;first\\nsecond&quot;");
		expect(html).toContain('data-tool-section="output"');
		expect(html).toContain("first\\nsecond");
		expect(html).not.toContain("still running");
	});

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

	it("does not serialize large arguments or results while a ToolCall is collapsed", () => {
		let serializationCount = 0;
		const expensive = {
			toJSON: () => {
				serializationCount += 1;
				return { payload: "x".repeat(1024 * 1024) };
			},
		};
		const html = renderToStaticMarkup(
			<ToolCallRow
				block={{
					type: "tool_call",
					key: "read-large",
					toolCallId: "read-large",
					toolName: "read",
					argsText: "",
					args: { path: "large.json", expensive },
					status: "done",
					result: expensive,
				}}
				results={[]}
			/>,
		);

		expect(serializationCount).toBe(0);
		expect(html).toContain("large.json");
	});

	it("keeps a multi-MiB Bash command out of the collapsed summary DOM", () => {
		const command = `printf start;${"x".repeat(2 * 1024 * 1024)};E2E_BASH_TAIL`;
		const html = renderToStaticMarkup(
			<ToolCallRow
				block={{
					type: "tool_call",
					key: "bash-large",
					toolCallId: "bash-large",
					toolName: "bash",
					argsText: "",
					args: { command },
					status: "done",
				}}
				results={[]}
			/>,
		);

		expect(Buffer.byteLength(command, "utf8")).toBeGreaterThan(2 * 1024 * 1024);
		expect(html.includes("E2E_BASH_TAIL")).toBe(false);
		expect(html.length).toBeLessThan(10_000);
	});
});
