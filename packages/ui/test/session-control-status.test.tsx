import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionControlStatusView } from "../src/features/session-control/SessionControlStatus";
import { tt, useI18n } from "../src/lib/i18n";
import type { SessionControlStatus } from "../src/stores/session-control";

const observerStatus: SessionControlStatus = {
	sessionHandle: "session-a",
	mode: "view_only",
	canControl: false,
	canTakeOver: true,
	takeoverPending: false,
	error: null,
	notice: null,
};

describe("SessionControlStatus presentation", () => {
	beforeEach(() => {
		useI18n.getState().setLocale("zh-CN");
	});

	it("renders an observer explanation and the Session-scoped action", () => {
		const html = renderToStaticMarkup(
			createElement(SessionControlStatusView, { status: observerStatus, surface: "composer" }),
		);

		expect(html).toContain('data-session-control-mode="view_only"');
		expect(html).toContain(tt("lease.observerBanner"));
		expect(html).toContain(tt("lease.takeOver"));
	});

	it("renders the revocation notice once in the composer surface", () => {
		const html = renderToStaticMarkup(
			createElement(SessionControlStatusView, {
				status: { ...observerStatus, notice: { key: "event-1", receivedAt: 10 } },
				surface: "composer",
			}),
		);

		expect(html.match(/此页面已失去当前 Session 的控制权/g)).toHaveLength(1);
	});

	it("keeps the bilingual confirmation contract in sync", () => {
		const zhDescription = tt("lease.takeOverDescription");
		useI18n.getState().setLocale("en");
		const enDescription = tt("lease.takeOverDescription");

		expect(zhDescription).toContain("当前 Session");
		expect(zhDescription).toContain("不会停止 Agent");
		expect(zhDescription).toContain("之前的页面会变为只读");
		expect(zhDescription).toContain("已经接纳的工作会继续执行");
		expect(enDescription).toContain("only the current Session");
		expect(enDescription).toContain("does not stop the Agent");
		expect(enDescription).toContain("previous page becomes read-only");
		expect(enDescription).toContain("work already admitted continues");
	});
});
