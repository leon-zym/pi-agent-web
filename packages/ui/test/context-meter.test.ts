import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveContextDisplay } from "../src/features/composer/ContextMeter";

function stats(contextUsage: unknown): SessionStats {
	return { contextUsage } as unknown as SessionStats;
}

describe("context meter states", () => {
	it("keeps an absent stats response distinct from an unavailable value", () => {
		expect(resolveContextDisplay(null, true)).toEqual({ kind: "loading" });
		expect(resolveContextDisplay(null)).toEqual({ kind: "unavailable" });
		expect(resolveContextDisplay(stats({ tokens: null, contextWindow: null, percent: null }))).toEqual({
			kind: "unavailable",
		});
	});

	it("reports host-provided usage without inventing values", () => {
		expect(resolveContextDisplay(stats({ tokens: 24_000, contextWindow: 128_000, percent: 18.75 }))).toEqual({
			kind: "ready",
			tokens: 24_000,
			window: 128_000,
			percent: 18.75,
		});
	});
});
