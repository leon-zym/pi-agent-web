import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffBlock, extractCleanCode, parseUnifiedDiff } from "../src/features/conversation/DiffBlock";

describe("DiffBlock & Unified Diff Parsing", () => {
	const sampleDiff = `--- a/src/index.ts
+++ b/src/index.ts
@@ -10,5 +10,6 @@
 import { a } from "./a";
-import { b } from "./b";
+import { bNew } from "./b";
+import { c } from "./c";
 export const ready = true;`;

	it("parses unified diff lines with dual line numbers and line kinds", () => {
		const lines = parseUnifiedDiff(sampleDiff);
		expect(lines.length).toBe(8);

		// Header lines
		expect(lines[0]?.kind).toBe("header");
		expect(lines[1]?.kind).toBe("header");

		// Hunk line
		expect(lines[2]?.kind).toBe("hunk");

		// Context line
		expect(lines[3]?.kind).toBe("context");
		expect(lines[3]?.oldLineNumber).toBe(10);
		expect(lines[3]?.newLineNumber).toBe(10);
		expect(lines[3]?.content).toBe('import { a } from "./a";');

		// Delete line
		expect(lines[4]?.kind).toBe("delete");
		expect(lines[4]?.oldLineNumber).toBe(11);
		expect(lines[4]?.newLineNumber).toBeNull();
		expect(lines[4]?.content).toBe('import { b } from "./b";');

		// Add lines
		expect(lines[5]?.kind).toBe("add");
		expect(lines[5]?.oldLineNumber).toBeNull();
		expect(lines[5]?.newLineNumber).toBe(11);
		expect(lines[5]?.content).toBe('import { bNew } from "./b";');

		expect(lines[6]?.kind).toBe("add");
		expect(lines[6]?.oldLineNumber).toBeNull();
		expect(lines[6]?.newLineNumber).toBe(12);
		expect(lines[6]?.content).toBe('import { c } from "./c";');

		// Trailing context line
		expect(lines[7]?.kind).toBe("context");
		expect(lines[7]?.oldLineNumber).toBe(12);
		expect(lines[7]?.newLineNumber).toBe(13);
		expect(lines[7]?.content).toBe("export const ready = true;");
	});

	it("extracts clean copy code by stripping +/-, removing deleted lines and headers", () => {
		const cleanCode = extractCleanCode(sampleDiff);
		expect(cleanCode).toBe(
			'import { a } from "./a";\nimport { bNew } from "./b";\nimport { c } from "./c";\nexport const ready = true;',
		);
		expect(cleanCode).not.toContain("---");
		expect(cleanCode).not.toContain("+++");
		expect(cleanCode).not.toContain("@@");
		expect(cleanCode).not.toContain('import { b } from "./b";');
	});

	it("renders DiffBlock with dual-column gutter, semantic highlights, and copy actions", () => {
		const html = renderToStaticMarkup(<DiffBlock diff={sampleDiff} fileName="src/index.ts" />);

		// File header / name
		expect(html).toContain("src/index.ts");
		expect(html).toContain('data-diff-file-name="true"');
		expect(html).toContain('title="src/index.ts"');
		expect(html).toContain("min-h-10");
		expect(html).toContain("grid-cols-2");

		// Copy buttons
		expect(html).toContain("复制纯净代码");
		expect(html).toContain("复制 Diff");

		// Semantic highlights
		expect(html).toContain("bg-success-soft/30");
		expect(html).toContain("text-success");
		expect(html).toContain("bg-danger-soft/30");
		expect(html).toContain("text-danger");

		// Dual-column gutter line numbers
		expect(html).toContain("data-diff-line");
		expect(html).toContain("data-old-line");
		expect(html).toContain("data-new-line");
	});

	it("ignores backslash markers like \\ No newline at end of file in clean code and numbering", () => {
		const diffWithWarning = `@@ -1,2 +1,2 @@
-old line
+new line
\\ No newline at end of file`;
		const lines = parseUnifiedDiff(diffWithWarning);
		expect(lines.find((l) => l.raw.startsWith("\\"))?.kind).toBe("header");
		expect(extractCleanCode(diffWithWarning)).toBe("new line");
	});
});
