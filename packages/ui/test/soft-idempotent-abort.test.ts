import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { abortCurrentRun, isSoftIdempotentError, sendControlCommand } from "../src/lib/session-controller";
import { useSessionDirectoryStore } from "../src/stores/session-directory";

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("../src/lib/session-command", () => ({
	sendControlCommand: vi.fn(),
	sendReadCommand: vi.fn(),
	sendControlExtensionUiResponse: vi.fn(),
}));

describe("Soft Idempotency for Abort and Extension Responses", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSessionDirectoryStore.setState({
			currentSession: {
				sessionHandle: "session-test",
				workspaceHandle: "ws-test",
				nativeSessionId: "id-1",
				sessionFile: "/path/file.jsonl",
				persisted: true,
				createdAt: null,
				modifiedAt: null,
				messageCount: 0,
				firstMessage: "",
				runtime: null,
			},
		});
	});

	it("identifies known soft-idempotent error tokens", () => {
		expect(isSoftIdempotentError("no_active_run")).toBe(true);
		expect(isSoftIdempotentError("Error: no_active_run")).toBe(true);
		expect(isSoftIdempotentError("dialog_already_closed")).toBe(true);
		expect(isSoftIdempotentError("invalid_dialog_id")).toBe(true);
		expect(isSoftIdempotentError("session_idle")).toBe(true);
		expect(isSoftIdempotentError(new Error("dialog_already_closed"))).toBe(true);

		// Non-idempotent errors
		expect(isSoftIdempotentError("session_read_only")).toBe(false);
		expect(isSoftIdempotentError("permission_denied")).toBe(false);
		expect(isSoftIdempotentError(null)).toBe(false);
		expect(isSoftIdempotentError(undefined)).toBe(false);
	});

	it("silently swallows soft-idempotent errors on abort without toast error", async () => {
		vi.mocked(sendControlCommand).mockResolvedValue({
			success: false,
			error: "no_active_run",
		} as any);

		await abortCurrentRun();
		expect(toast.error).not.toHaveBeenCalled();

		// Thrown error with soft token
		vi.mocked(sendControlCommand).mockRejectedValue(new Error("session_idle"));
		await abortCurrentRun();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("displays toast error for genuine abort failures", async () => {
		vi.mocked(sendControlCommand).mockRejectedValue(new Error("connection_lost"));

		await abortCurrentRun();
		expect(toast.error).toHaveBeenCalled();
	});
});
