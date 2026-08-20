import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DebugEventRow } from "../src/features/details/DetailsPanel";
import type { SessionRawEventRecord } from "../src/stores/session-transport-contract";

const event = {
	receivedAt: Date.UTC(2026, 7, 21, 4, 3, 2),
	generation: 7,
	seq: 42,
	eventType: "agent_start",
	payload: { type: "agent_start", privateMarker: "only-in-payload" } as JsonAgentSessionEvent,
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
});
