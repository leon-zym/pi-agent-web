import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { en } from "../src/lib/i18n/en";
import { zhCN } from "../src/lib/i18n/zh-CN";

const sourceFiles = [
	new URL("../src/features/extension-ui/OnboardingWizard.tsx", import.meta.url),
	new URL("../src/features/extension-ui/QuestionCard.tsx", import.meta.url),
	new URL("../src/features/session-status/SessionLiveAnnouncements.tsx", import.meta.url),
];

function findBareCopy(source: string): string[] {
	const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*$/gmu, "");
	const jsxText = [...withoutComments.matchAll(/>([^<>{}\n]+)</gu)]
		.map((match) => match[1]?.trim() ?? "")
		.filter((value) => /[\p{L}\p{N}]/u.test(value));
	const naturalLanguageAttributes = [
		...withoutComments.matchAll(/\b(aria-label|title|placeholder|alt)\s*=\s*(["'])(.*?)\2/gu),
	].map((match) => `${match[1]}=${match[2]}${match[3]}${match[2]}`);
	return [...jsxText, ...naturalLanguageAttributes];
}

describe("narrow UI copy guard", () => {
	it("keeps onboarding and touched Extension/a11y surfaces on the dictionary", () => {
		const violations = sourceFiles.flatMap((url) =>
			findBareCopy(readFileSync(url, "utf8")).map((value) => `${url.pathname}: ${value}`),
		);
		expect(violations).toEqual([]);
	});

	it("rejects JSX text and natural-language accessible attributes", () => {
		expect(findBareCopy("<div>Needs translation</div>")).toEqual(["Needs translation"]);
		expect(findBareCopy('<input aria-label="Needs translation" />')).toEqual([
			'aria-label="Needs translation"',
		]);
		expect(findBareCopy('<input placeholder={tt("copy.key")} />')).toEqual([]);
	});

	it("keeps the English and zh-CN dictionary shapes identical", () => {
		expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
	});
});
