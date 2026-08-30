#!/usr/bin/env node

/**
 * scripts/check-style.mjs
 *
 * Style Anti-Pattern Linter for packages/ui/src
 *
 * Enforces design system invariants from docs/design.md:
 * 1. no-hardcoded-hex: Disallow raw hex colors in TSX/TS/CSS (except root theme tokens in index.css)
 * 2. no-gradient: Disallow decorative gradients (except .thinking-sweep in index.css and functional scroll masks)
 * 3. no-glassmorphism: Disallow arbitrary backdrop-blur (except whitelisted modal overlays/dock)
 * 4. no-transition-all: Disallow transition-all
 * 5. no-arbitrary-z: Disallow non-standard arbitrary z-index classes (e.g. z-[9999])
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const UI_SRC_DIR = path.resolve(ROOT_DIR, "packages/ui/src");

const RULES = [
	{
		id: "no-hardcoded-hex",
		description: "Disallow raw #rrggbb hex colors (use semantic CSS tokens instead)",
		regex: /#[0-9a-fA-F]{3,8}\b/g,
		isAllowed: (filePath, lineContent) => {
			const relPath = path.relative(ROOT_DIR, filePath);
			// Whitelist token definitions in styles/index.css
			if (relPath === "packages/ui/src/styles/index.css") {
				// Allowed in variable assignment lines (--piw-*: #hex)
				if (/--piw-[a-z0-9-]+:\s*#[0-9a-fA-F]{3,8}/.test(lineContent)) {
					return true;
				}
			}
			// Whitelist comments
			if (/^\s*(\/\/|\/\*|\*)/.test(lineContent)) {
				return true;
			}
			return false;
		},
	},
	{
		id: "no-gradient",
		description: "Disallow decorative bg-gradient / linear-gradient",
		regex: /(?:bg-gradient-[a-z0-9-]+|linear-gradient\([^)]+\)|radial-gradient\([^)]+\))/g,
		isAllowed: (filePath, lineContent) => {
			const relPath = path.relative(ROOT_DIR, filePath);
			// Whitelist .thinking-sweep signature motion in index.css
			if (relPath === "packages/ui/src/styles/index.css" && lineContent.includes("linear-gradient")) {
				return true;
			}
			// Whitelist functional bottom fade scroll mask in ChatViewport.tsx
			if (
				relPath === "packages/ui/src/features/conversation/ChatViewport.tsx" &&
				lineContent.includes("bg-gradient-to-t")
			) {
				return true;
			}
			return false;
		},
	},
	{
		id: "no-glassmorphism",
		description: "Disallow arbitrary backdrop-blur glassmorphism effects",
		regex: /backdrop-blur(?:-\[[^\]]+\]|-[a-z0-9]+)?/g,
		isAllowed: (filePath, _lineContent) => {
			const relPath = path.relative(ROOT_DIR, filePath);
			// Whitelist controlled modal dialog overlays
			if (
				relPath === "packages/ui/src/components/ui/alert-dialog.tsx" ||
				relPath === "packages/ui/src/components/ui/dialog.tsx"
			) {
				return true;
			}
			return false;
		},
	},
	{
		id: "no-transition-all",
		description: "Disallow transition-all (animate only transform, opacity, color)",
		regex: /\btransition-all\b/g,
		isAllowed: () => false,
	},
	{
		id: "no-arbitrary-z",
		description: "Disallow arbitrary z-index classes like z-[...]",
		regex: /\bz-\[[^\]]+\]/g,
		isAllowed: () => false,
	},
];

async function collectFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vite") {
				continue;
			}
			files.push(...(await collectFiles(fullPath)));
		} else if (entry.isFile()) {
			if (/\.(tsx|ts|css)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
				files.push(fullPath);
			}
		}
	}
	return files;
}

async function checkFile(filePath) {
	const content = await fs.readFile(filePath, "utf-8");
	const lines = content.split("\n");
	const violations = [];

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const lineContent = lines[lineIdx];
		const lineNum = lineIdx + 1;

		if (lineContent.includes("check-style-ignore")) {
			continue;
		}

		for (const rule of RULES) {
			rule.regex.lastIndex = 0;
			let match = rule.regex.exec(lineContent);
			while (match !== null) {
				if (!rule.isAllowed(filePath, lineContent, match[0])) {
					violations.push({
						filePath,
						lineNum,
						col: match.index + 1,
						ruleId: rule.id,
						description: rule.description,
						matched: match[0],
						lineContent: lineContent.trim(),
					});
				}
				match = rule.regex.exec(lineContent);
			}
		}
	}

	return violations;
}

async function main() {
	console.log(`🔍 Checking style invariants in ${path.relative(ROOT_DIR, UI_SRC_DIR)}...`);

	try {
		const files = await collectFiles(UI_SRC_DIR);
		let totalViolations = 0;

		for (const file of files) {
			const fileViolations = await checkFile(file);
			if (fileViolations.length > 0) {
				totalViolations += fileViolations.length;
				const relPath = path.relative(ROOT_DIR, file);
				console.error(`\n❌ ${relPath}:`);
				for (const v of fileViolations) {
					console.error(`   line ${v.lineNum}:${v.col} [${v.ruleId}] ${v.description}`);
					console.error(`   > ${v.lineContent}`);
				}
			}
		}

		if (totalViolations > 0) {
			console.error(`\n💥 Failed: Found ${totalViolations} style anti-pattern violation(s).`);
			process.exit(1);
		} else {
			console.log(
				`✅ Passed: All ${files.length} UI source files conform to docs/design.md style invariants.`,
			);
			process.exit(0);
		}
	} catch (err) {
		console.error("Error executing style check:", err);
		process.exit(1);
	}
}

main();
