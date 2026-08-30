import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantStepView } from "../src/features/conversation/AssistantStepView";
import { formatToolGroupSummary, ToolGroupView } from "../src/features/conversation/ToolGroupView";
import { extractDiffLineStats } from "../src/features/conversation/tool-presenters";
import type { AssistantStep, ContentBlock, UiToolResult } from "../src/types/view-models";

describe("ToolGroup & Stacked Layout", () => {
	it("extracts diff line statistics (+N -M) from unified diff text", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 context line
-old line 1
-old line 2
+new line 1
+new line 2
+new line 3
 context line`;
		const stats = extractDiffLineStats(diff);
		expect(stats).toEqual({ additions: 3, deletions: 2 });
	});

	it("formats tool group summary with counts breakdown and duration", () => {
		const tools: Array<Extract<ContentBlock, { type: "tool_call" }>> = [
			{
				type: "tool_call",
				key: "1",
				toolCallId: "1",
				toolName: "read_file",
				args: {},
				argsText: "",
				status: "done",
			},
			{
				type: "tool_call",
				key: "2",
				toolCallId: "2",
				toolName: "read_file",
				args: {},
				argsText: "",
				status: "done",
			},
			{
				type: "tool_call",
				key: "3",
				toolCallId: "3",
				toolName: "grep",
				args: {},
				argsText: "",
				status: "done",
			},
		];
		const summary = formatToolGroupSummary(tools, 3400, false);
		expect(summary).toContain("3");
		expect(summary).toContain("read_file × 2");
		expect(summary).toContain("grep × 1");
		expect(summary).toContain("3.4s");
	});

	it("renders ToolGroupView with summary header and stacked layout when expanded", () => {
		const tools: Array<Extract<ContentBlock, { type: "tool_call" }>> = [
			{
				type: "tool_call",
				key: "t1",
				toolCallId: "t1",
				toolName: "read",
				args: { path: "a.ts" },
				argsText: "",
				status: "done",
			},
			{
				type: "tool_call",
				key: "t2",
				toolCallId: "t2",
				toolName: "grep",
				args: { pattern: "fn" },
				argsText: "",
				status: "done",
			},
			{
				type: "tool_call",
				key: "t3",
				toolCallId: "t3",
				toolName: "bash",
				args: { command: "ls" },
				argsText: "",
				status: "done",
			},
		];
		const resultsIndex = new Map<string, UiToolResult[]>();

		const collapsedHtml = renderToStaticMarkup(
			<ToolGroupView
				tools={tools}
				resultsByToolCallId={resultsIndex}
				defaultOpen={false}
				durationMs={1200}
			/>,
		);
		expect(collapsedHtml).toContain('aria-expanded="false"');
		expect(collapsedHtml).toContain("read × 1");
		expect(collapsedHtml).toContain("grep × 1");
		expect(collapsedHtml).toContain("bash × 1");
		expect(collapsedHtml).toContain("max-lg:min-h-10");

		const expandedHtml = renderToStaticMarkup(
			<ToolGroupView tools={tools} resultsByToolCallId={resultsIndex} defaultOpen={true} durationMs={1200} />,
		);
		expect(expandedHtml).toContain('aria-expanded="true"');
		expect(expandedHtml).toContain("rounded-t-md");
		expect(expandedHtml).toContain("rounded-b-md");
		expect(expandedHtml).toContain("divide-y");
	});

	it("aggregates >2 consecutive tool calls in AssistantStepView only when settled", () => {
		const settledStep: AssistantStep = {
			key: "step-1",
			isSettled: true,
			timing: { startTime: 1000, endTime: 2500 },
			toolResults: [],
			blocks: [
				{ type: "thinking", key: "th1", text: "Planning...", isStreaming: false },
				{
					type: "tool_call",
					key: "t1",
					toolCallId: "1",
					toolName: "read",
					args: { path: "1.ts" },
					argsText: "",
					status: "done",
				},
				{
					type: "tool_call",
					key: "t2",
					toolCallId: "2",
					toolName: "grep",
					args: { pattern: "x" },
					argsText: "",
					status: "done",
				},
				{
					type: "tool_call",
					key: "t3",
					toolCallId: "3",
					toolName: "bash",
					args: { command: "pwd" },
					argsText: "",
					status: "done",
				},
				{ type: "text", key: "txt1", markdown: "Step complete.", isStreaming: false },
			],
		};

		const settledHtml = renderToStaticMarkup(<AssistantStepView turnId="turn-1" step={settledStep} />);
		// In settled step with 3 tool calls, tool calls are aggregated in ToolGroupView
		expect(settledHtml).toContain("3");
		expect(settledHtml).toContain("read × 1");

		const streamingStep: AssistantStep = {
			...settledStep,
			isSettled: false,
			blocks: [
				{ type: "thinking", key: "th1", text: "Planning...", isStreaming: true },
				{
					type: "tool_call",
					key: "t1",
					toolCallId: "1",
					toolName: "read",
					args: { path: "1.ts" },
					argsText: "",
					status: "running",
				},
				{
					type: "tool_call",
					key: "t2",
					toolCallId: "2",
					toolName: "grep",
					args: { pattern: "x" },
					argsText: "",
					status: "running",
				},
				{
					type: "tool_call",
					key: "t3",
					toolCallId: "3",
					toolName: "bash",
					args: { command: "pwd" },
					argsText: "",
					status: "running",
				},
			],
		};

		const streamingHtml = renderToStaticMarkup(<AssistantStepView turnId="turn-1" step={streamingStep} />);
		// In streaming step, tool calls remain individual rows and are NOT aggregated
		expect(streamingHtml).not.toContain("read × 1");
	});
});
