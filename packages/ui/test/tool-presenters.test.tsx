import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpandedToolCallBody, ToolCallRow } from "../src/features/conversation/ToolCallRow";
import { getToolPresenter } from "../src/features/conversation/tool-presenters";
import { tt } from "../src/lib/i18n";

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
		expect(html).toContain("old");
		expect(html).toContain("new");
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

	it("renders a failed tool result exactly once in the expanded body", () => {
		const failure = "Validation failed: missing required action";
		const html = renderToStaticMarkup(
			<ExpandedToolCallBody
				block={{
					type: "tool_call",
					key: "todo-invalid",
					toolCallId: "todo-invalid",
					toolName: "todo",
					argsText: '{"subject":"Audit"}',
					args: { subject: "Audit" },
					status: "error",
					result: failure,
				}}
				results={[
					{
						toolCallId: "todo-invalid",
						toolName: "todo",
						content: failure,
						isError: true,
					},
				]}
			/>,
		);

		expect(html.split(failure)).toHaveLength(2);
	});

	it("keeps one useful error message for Bash and diff presenters", () => {
		const emptyBashError = renderToStaticMarkup(
			<ExpandedToolCallBody
				block={{
					type: "tool_call",
					key: "bash-error",
					toolCallId: "bash-error",
					toolName: "bash",
					argsText: "",
					args: { command: "false" },
					status: "error",
				}}
				results={[{ toolCallId: "bash-error", toolName: "bash", content: "", isError: true }]}
			/>,
		);
		expect(emptyBashError).toContain(tt("tool.executionError"));
		expect(emptyBashError).not.toContain(tt("common.noOutput"));

		const editFailure = "Unable to apply the edit";
		const failedEdit = renderToStaticMarkup(
			<ExpandedToolCallBody
				block={{
					type: "tool_call",
					key: "edit-error",
					toolCallId: "edit-error",
					toolName: "edit",
					argsText: "",
					args: { path: "src/app.ts" },
					status: "error",
				}}
				results={[
					{
						toolCallId: "edit-error",
						toolName: "edit",
						content: editFailure,
						isError: true,
						details: { diff: "@@ -1 +1 @@\n-old\n+new" },
					},
				]}
			/>,
		);
		expect(failedEdit).toContain("old");
		expect(failedEdit.split(editFailure)).toHaveLength(2);
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

	it("renders line diff badge (+N -M) in ToolCallRow for file modification tools", () => {
		const html = renderToStaticMarkup(
			<ToolCallRow
				block={{
					type: "tool_call",
					key: "edit-stats",
					toolCallId: "call-stats",
					toolName: "edit",
					argsText: "",
					args: { path: "index.ts" },
					status: "done",
				}}
				results={[
					{
						toolCallId: "call-stats",
						toolName: "edit",
						content: "Applied edit",
						isError: false,
						details: { diff: "@@ -1,5 +1,6 @@\n-old\n-deprecated\n+new\n+improved\n+fast\n context" },
					},
				]}
			/>,
		);

		expect(html).toContain('data-testid="tool-diff-badge"');
		expect(html).toContain("+3");
		expect(html).toContain("-2");
	});

	it("summarizes write tool calls with file path and description", () => {
		const presenter = getToolPresenter("write");
		const summary = presenter.summarize({
			block: {
				type: "tool_call",
				key: "write-1",
				toolCallId: "call-w1",
				toolName: "write",
				argsText: "",
				args: { TargetFile: "src/button.tsx", Description: "Add button component" },
				status: "done",
			},
			results: [],
		});
		expect(summary).toBe("src/button.tsx · Add button component");
	});
});
