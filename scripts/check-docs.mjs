#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set(["assets", "notes"]);
const hanCharacters = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const nonAsciiDashes = /[\u2013\u2014]/u;
const staleDocumentNames = /(?:README\.zh-CN\.md|(?:^|[/(])DESIGN\.md)/u;
const markdownLink = /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
const htmlLink = /(?:href|src)="([^"]+)"/gu;

async function collectMarkdown(target) {
	const stat = await fs.stat(target);
	if (stat.isFile()) return target.endsWith(".md") ? [target] : [];

	const files = [];
	for (const entry of await fs.readdir(target, { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const entryPath = path.join(target, entry.name);
		if (entry.isDirectory()) files.push(...(await collectMarkdown(entryPath)));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
	}
	return files;
}

function lineNumberAt(content, index) {
	return content.slice(0, index).split("\n").length;
}

function localTarget(rawTarget) {
	const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
	if (target.startsWith("#") || /^(?:https?:|mailto:|data:)/u.test(target)) {
		return null;
	}
	const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0];
	if (!withoutFragment) return null;
	try {
		return decodeURIComponent(withoutFragment);
	} catch {
		return withoutFragment;
	}
}

async function checkLocalLink(sourceFile, rawTarget, line, violations) {
	const target = localTarget(rawTarget);
	if (!target) return;
	const resolved = path.resolve(path.dirname(sourceFile), target);
	if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
		violations.push({ sourceFile, line, message: `link escapes repository: ${rawTarget}` });
		return;
	}
	try {
		await fs.access(resolved);
	} catch {
		violations.push({ sourceFile, line, message: `missing local target: ${rawTarget}` });
	}
}

async function main() {
	const rootMarkdown = (await fs.readdir(repositoryRoot, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => path.join(repositoryRoot, entry.name));
	const files = [...rootMarkdown, ...(await collectMarkdown(path.join(repositoryRoot, "docs")))].sort();
	const violations = [];

	for (const file of files) {
		const content = await fs.readFile(file, "utf8");
		for (const [index, line] of content.split("\n").entries()) {
			if (hanCharacters.test(line)) {
				violations.push({
					sourceFile: file,
					line: index + 1,
					message: "tracked documentation must be English",
				});
			}
			if (nonAsciiDashes.test(line)) {
				violations.push({ sourceFile: file, line: index + 1, message: "use plain English punctuation" });
			}
			if (staleDocumentNames.test(line)) {
				violations.push({ sourceFile: file, line: index + 1, message: "stale documentation path" });
			}
		}

		for (const expression of [markdownLink, htmlLink]) {
			expression.lastIndex = 0;
			let match = expression.exec(content);
			while (match) {
				await checkLocalLink(file, match[1], lineNumberAt(content, match.index), violations);
				match = expression.exec(content);
			}
		}
	}

	if (violations.length > 0) {
		for (const violation of violations) {
			console.error(
				`${path.relative(repositoryRoot, violation.sourceFile)}:${String(violation.line)} ${violation.message}`,
			);
		}
		throw new Error(`documentation check failed with ${String(violations.length)} violation(s)`);
	}

	console.log(`Documentation check passed for ${String(files.length)} tracked authority file(s).`);
}

await main();
