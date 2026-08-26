import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const forbiddenPackagePrefix = "@earendil-works/pi-";
const forbiddenImport = /(?:from\s+|import\s*\(\s*)["']@earendil-works\/pi-/;

function sourceFiles(root: string): string[] {
	const result: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) result.push(...sourceFiles(absolute));
		else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(absolute);
	}
	return result;
}

describe("browser product protocol dependency boundary", () => {
	it("keeps upstream Pi packages out of protocol and UI sources and tests", () => {
		const roots = [
			path.join(workspaceRoot, "packages/protocol/src"),
			path.join(workspaceRoot, "packages/protocol/test"),
			path.join(workspaceRoot, "packages/ui/src"),
			path.join(workspaceRoot, "packages/ui/test"),
		];
		const violations = roots
			.flatMap(sourceFiles)
			.filter((file) => forbiddenImport.test(fs.readFileSync(file, "utf8")))
			.map((file) => path.relative(workspaceRoot, file));

		expect(violations).toEqual([]);
	});

	it("keeps the upstream Pi package out of browser package manifests", () => {
		const manifests = ["packages/protocol/package.json", "packages/ui/package.json"];
		const dependencySections = [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies",
		];
		const violations = manifests.filter((manifest) => {
			const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, manifest), "utf8")) as Record<
				string,
				Record<string, string> | undefined
			>;
			return dependencySections.some((section) =>
				Object.keys(parsed[section] ?? {}).some((name) => name.startsWith(forbiddenPackagePrefix)),
			);
		});

		expect(violations).toEqual([]);
	});
});
