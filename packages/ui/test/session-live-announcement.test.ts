import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	formatSessionLiveAnnouncement,
	SessionLiveAnnouncements,
	shouldAnnounceSessionLiveAnnouncement,
} from "../src/features/session-status/SessionLiveAnnouncements";
import {
	createSessionLiveAnnouncementController,
	type SessionLiveSessionObservation,
} from "../src/features/session-status/session-live-announcement";
import { useI18n } from "../src/lib/i18n";
import { en } from "../src/lib/i18n/en";
import { zhCN } from "../src/lib/i18n/zh-CN";

const identity = {
	serverEpoch: "epoch-a",
	workspaceId: "workspace-a",
	sessionHandle: "session-a",
	generation: 1,
} as const;

function session(overrides: Partial<SessionLiveSessionObservation> = {}): SessionLiveSessionObservation {
	return {
		identity,
		phase: "busy",
		lastSeq: 2,
		pendingRequestId: null,
		recoveryPhase: null,
		recoveryTerminalKey: null,
		revocationKey: null,
		...overrides,
	};
}

function observations(
	value: SessionLiveSessionObservation,
): ReadonlyMap<string, SessionLiveSessionObservation> {
	return new Map([[value.identity.sessionHandle, value]]);
}

describe("Session live announcement edges", () => {
	it("keeps the Session label localized in the announcement copy", () => {
		useI18n.setState({ locale: "en", t: en });
		expect(formatSessionLiveAnnouncement({ kind: "settled" }, "Background A")).toBe(
			"Session Background A finished.",
		);
		useI18n.setState({ locale: "zh-CN", t: zhCN });
		expect(formatSessionLiveAnnouncement({ kind: "waiting_ui" }, "后台 A")).toBe(
			"Session「后台 A」正在等待输入。",
		);
	});

	it("renders one polite atomic live region without streaming content", () => {
		const html = renderToStaticMarkup(createElement(SessionLiveAnnouncements));
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('aria-atomic="true"');
		expect(html).toContain('data-testid="session-live-announcements"');
	});

	it("suppresses duplicate current-session recovery and takeover announcements", () => {
		expect(
			shouldAnnounceSessionLiveAnnouncement(
				{ kind: "degraded", sessionHandle: "current-session" },
				"current-session",
			),
		).toBe(false);
		expect(
			shouldAnnounceSessionLiveAnnouncement(
				{ kind: "takeover_revoked", sessionHandle: "current-session" },
				"current-session",
			),
		).toBe(false);
		expect(
			shouldAnnounceSessionLiveAnnouncement(
				{ kind: "degraded", sessionHandle: "background-session" },
				"current-session",
			),
		).toBe(true);
		expect(
			shouldAnnounceSessionLiveAnnouncement(
				{ kind: "settled", sessionHandle: "current-session" },
				"current-session",
			),
		).toBe(true);
	});

	it("announces running to settled once per identity and terminal sequence", () => {
		const controller = createSessionLiveAnnouncementController();
		expect(controller.observe(observations(session()))).toEqual([]);
		expect(controller.observe(observations(session({ lastSeq: 3 })))).toEqual([]);

		const settled = controller.observe(
			observations(
				session({
					phase: "ready",
					lastSeq: 7,
				}),
			),
		);
		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({ kind: "settled", terminalKey: "seq:7" });
		expect(controller.observe(observations(session({ phase: "ready", lastSeq: 7 })))).toEqual([]);

		expect(controller.observe(observations(session({ phase: "busy", lastSeq: 8 })))).toEqual([]);
		expect(controller.observe(observations(session({ phase: "ready", lastSeq: 8 })))).toHaveLength(1);
	});

	it("announces waiting_ui with the blocking request identity and ignores deltas", () => {
		const controller = createSessionLiveAnnouncementController();
		controller.observe(observations(session({ phase: "ready" })));
		controller.observe(observations(session({ phase: "busy", lastSeq: 4 })));

		const waiting = controller.observe(
			observations(
				session({
					phase: "waiting_ui",
					lastSeq: 5,
					pendingRequestId: "request-1",
				}),
			),
		);
		expect(waiting).toHaveLength(1);
		expect(waiting[0]).toMatchObject({ kind: "waiting_ui", terminalKey: "request:request-1" });
		expect(controller.observe(observations(session({ phase: "waiting_ui", lastSeq: 6 })))).toEqual([]);
	});

	it("announces recovery degradation once for its stable recovery terminal", () => {
		const controller = createSessionLiveAnnouncementController();
		controller.observe(observations(session({ recoveryPhase: "syncing" })));

		const degraded = controller.observe(
			observations(
				session({
					recoveryPhase: "degraded",
					recoveryTerminalKey: "seq:12:attempt:4",
				}),
			),
		);
		expect(degraded).toHaveLength(1);
		expect(degraded[0]).toMatchObject({ kind: "degraded", terminalKey: "seq:12:attempt:4" });
		expect(
			controller.observe(
				observations(session({ recoveryPhase: "degraded", recoveryTerminalKey: "seq:12:attempt:4" })),
			),
		).toEqual([]);
		controller.observe(observations(session({ recoveryPhase: "syncing" })));
		expect(
			controller.observe(
				observations(
					session({
						recoveryPhase: "degraded",
						recoveryTerminalKey: "seq:12:attempt:4",
					}),
				),
			),
		).toEqual([]);
	});

	it("announces takeover revocation once and fences identity changes", () => {
		const controller = createSessionLiveAnnouncementController();
		controller.observe(observations(session({ phase: "ready" })));
		const revoked = controller.observe(observations(session({ phase: "ready", revocationKey: "lease:4" })));
		expect(revoked).toHaveLength(1);
		expect(revoked[0]).toMatchObject({ kind: "takeover_revoked", terminalKey: "lease:4" });
		expect(controller.observe(observations(session({ phase: "ready", revocationKey: "lease:4" })))).toEqual(
			[],
		);

		const nextGeneration = {
			...identity,
			generation: 2,
		};
		expect(
			controller.observe(
				observations(
					session({
						identity: nextGeneration,
						phase: "ready",
						lastSeq: 9,
					}),
				),
			),
		).toEqual([]);
	});

	it("keeps the identity in every emitted key", () => {
		const controller = createSessionLiveAnnouncementController();
		controller.observe(observations(session({ phase: "ready" })));
		const announcement = controller.observe(observations(session({ phase: "busy", lastSeq: 10 })));
		expect(announcement).toEqual([]);
		const settled = controller.observe(observations(session({ phase: "ready", lastSeq: 11 })))[0];
		expect(settled?.key).toContain("epoch-a");
		expect(settled?.key).toContain("workspace-a");
		expect(settled?.key).toContain("session-a");
		expect(settled?.key).toContain(":1");
	});
});
