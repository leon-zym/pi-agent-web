import type { ProductSessionEventDto, SessionTreeNodeDto } from "@pi-agent-web/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	DebugEventRow,
	DebugEventsRegion,
	DetailsPanel,
	InspectorCodeSections,
	TreeNodeRow,
} from "../src/features/details/DetailsPanel";
import { flattenConversationTree } from "../src/features/details/tree-model";
import type { SessionRawEventRecord } from "../src/stores/session-transport-contract";

const event = {
	receivedAt: Date.UTC(2026, 7, 21, 4, 3, 2),
	serverEpoch: "test-server-epoch",
	workspaceId: "workspace-a",
	generation: 7,
	seq: 42,
	eventType: "agent_start",
	payload: { type: "agent_start", privateMarker: "only-in-payload" } as ProductSessionEventDto,
} satisfies SessionRawEventRecord;

describe("details panel presenters", () => {
	it("mounts and highlights only the individually expanded event payload", () => {
		const collapsed = renderToStaticMarkup(
			<DebugEventRow event={event} expanded={false} onToggle={() => undefined} />,
		);
		expect(collapsed).not.toContain("data-event-payload");
		expect(collapsed).not.toContain("only-in-payload");

		const expanded = renderToStaticMarkup(
			<DebugEventRow event={event} expanded={true} onToggle={() => undefined} />,
		);
		expect(expanded).toContain('data-event-payload="7:42"');
		expect(expanded).toContain('data-code-language="json"');
		expect(expanded).toContain("only-in-payload");
	});

	it("keeps the mode tabs on one line while reserving the collapse control", () => {
		const markup = renderToStaticMarkup(<DetailsPanel open onToggle={() => undefined} />);

		expect(markup).toContain('data-details-tabs="true"');
		expect(markup).toMatch(/data-details-tabs="true"[^>]*class="[^"]*min-w-0/);
		expect(markup).toMatch(/data-details-tab-label="true"[^>]*class="[^"]*whitespace-nowrap/);
		expect(markup).toMatch(/data-details-collapse="true"[^>]*class="[^"]*shrink-0/);
	});

	it("gives Inspector output and Raw events their own fill-and-scroll regions", () => {
		const inspector = renderToStaticMarkup(
			<InspectorCodeSections
				argsCode={{ code: '{\n  "command": "pwd"\n}', language: "json" }}
				resultCode={{ code: "/workspace", language: undefined }}
			/>,
		);
		expect(inspector).toMatch(/data-details-output-region="true"[^>]*class="[^"]*min-h-0[^"]*flex-1/);

		const events = renderToStaticMarkup(
			<DebugEventsRegion
				events={[event]}
				expandedEventKey={null}
				onExpandedEventKeyChange={() => undefined}
			/>,
		);
		expect(events).toMatch(
			/data-details-raw-events-region="true"[^>]*class="[^"]*min-h-0[^"]*flex-1[^"]*overflow-y-auto/,
		);
	});

	it("keeps branch folding and Fork as keyboard-focusable native controls", () => {
		const child: SessionTreeNodeDto = {
			entry: {
				type: "message",
				id: "child",
				parentId: "root",
				timestamp: "2026-08-21T00:00:00.000Z",
				message: { role: "user", content: "reply", timestamp: 0 },
			},
			children: [],
		};
		const root: SessionTreeNodeDto = {
			entry: {
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "2026-08-21T00:00:00.000Z",
				message: { role: "user", content: "request", timestamp: 0 },
			},
			children: [child],
		};
		const [row] = flattenConversationTree([root], "child", new Set(["root"]));
		expect(row).toBeDefined();
		const markup = renderToStaticMarkup(
			<TreeNodeRow row={row!} onToggle={() => undefined} onFork={() => undefined} canFork />,
		);

		expect(markup).toContain('aria-expanded="false"');
		expect(markup).toContain("lucide-git-fork");
		expect(markup).toContain("focus-visible:ring-2");
		const forkButton = markup.match(/<button[^>]*aria-label="[^"]+"[^>]*>/)?.[0];
		expect(forkButton).toBeDefined();
		expect(forkButton).not.toContain(" disabled=");
		expect(forkButton).toContain("size-10");
		expect(forkButton).not.toContain("opacity-0");
	});

	it("uses a hidden layout spacer instead of an unnamed disabled control for a leaf", () => {
		const leaf: SessionTreeNodeDto = {
			entry: {
				type: "message",
				id: "leaf",
				parentId: null,
				timestamp: "2026-08-21T00:00:00.000Z",
				message: { role: "user", content: "done", timestamp: 0 },
			},
			children: [],
		};
		const [row] = flattenConversationTree([leaf], "leaf");
		const markup = renderToStaticMarkup(
			<TreeNodeRow row={row!} onToggle={() => undefined} onFork={() => undefined} canFork />,
		);

		expect(markup).not.toContain(" disabled=");
		expect(markup).toContain('aria-hidden="true"');
	});
});
