import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRecoveryNotice } from "../src/features/conversation/SessionRecoveryNotice";
import { useI18n } from "../src/lib/i18n";
import { en } from "../src/lib/i18n/en";
import { zhCN } from "../src/lib/i18n/zh-CN";

const syncingState = {
	identity: {
		serverEpoch: "epoch-a",
		workspaceId: "workspace-a",
		sessionHandle: "session-a",
		generation: 1,
	},
	phase: "syncing" as const,
	attempt: 1,
	cursorless: false,
	retryAt: null,
	lastError: null,
};

afterEach(() => {
	useI18n.setState({ locale: "zh-CN", t: zhCN });
});

describe("SessionRecoveryNotice", () => {
	it("announces syncing and stale state politely without a retry action", () => {
		useI18n.setState({ locale: "en", t: en });
		const html = renderToStaticMarkup(
			createElement(SessionRecoveryNotice, { state: syncingState, onRetry: () => undefined }),
		);

		expect(html).toContain('role="status"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('aria-atomic="true"');
		expect(html).toContain('data-resync-state="syncing"');
		expect(html).toContain("Syncing this Session");
		expect(html).toContain("may be out of date");
		expect(html).not.toContain("Retry sync");
	});

	it("renders a semantic warning and focus-visible manual retry in degraded state", () => {
		useI18n.setState({ locale: "en", t: en });
		const html = renderToStaticMarkup(
			createElement(SessionRecoveryNotice, {
				state: { ...syncingState, phase: "degraded", attempt: 4 },
				onRetry: () => undefined,
			}),
		);

		expect(html).toContain('data-resync-state="degraded"');
		expect(html).toContain("Session sync needs attention");
		expect(html).toContain("Automatic recovery stopped after four attempts.");
		expect(html).toContain("Retry sync");
		expect(html).toContain("bg-warning-soft");
		expect(html).toContain("text-warning");
		expect(html).toContain("focus-visible:");
	});

	it("renders the same recovery surface in zh-CN", () => {
		const html = renderToStaticMarkup(
			createElement(SessionRecoveryNotice, {
				state: { ...syncingState, phase: "degraded", attempt: 4 },
				onRetry: () => undefined,
			}),
		);

		expect(html).toContain("Session 同步需要处理");
		expect(html).toContain("自动恢复已在四次尝试后停止。");
		expect(html).toContain("同步完成前，此处显示的对话内容可能已过时。");
		expect(html).toContain("重试同步");
	});
});
