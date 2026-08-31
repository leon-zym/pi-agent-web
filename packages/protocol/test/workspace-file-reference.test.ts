import { describe, expect, it } from "vitest";
import {
	SESSION_IMAGE_MAX_BASE64_CHARS,
	SESSION_TEXT_MAX_BYTES,
	WORKSPACE_FILE_IMAGE_MAX_BYTES,
	WORKSPACE_FILE_REFERENCE_TEXT_TOTAL_MAX_BYTES,
	WORKSPACE_FILE_TEXT_MAX_BYTES,
} from "../src/index.js";

describe("Workspace file reference budgets", () => {
	it("fit every captured representation inside the downstream prompt ceilings", () => {
		expect(Math.ceil((WORKSPACE_FILE_IMAGE_MAX_BYTES * 4) / 3)).toBeLessThanOrEqual(
			SESSION_IMAGE_MAX_BASE64_CHARS,
		);
		expect(WORKSPACE_FILE_TEXT_MAX_BYTES).toBeLessThanOrEqual(WORKSPACE_FILE_REFERENCE_TEXT_TOTAL_MAX_BYTES);
		expect(WORKSPACE_FILE_REFERENCE_TEXT_TOTAL_MAX_BYTES).toBeLessThan(SESSION_TEXT_MAX_BYTES);
	});
});
