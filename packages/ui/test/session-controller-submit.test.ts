import type { SessionCommandResponseDto } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useI18n } from "../src/lib/i18n";
import { en } from "../src/lib/i18n/en";
import { submitDraft } from "../src/lib/session-controller";
import { useComposerStore } from "../src/stores/composer";
import { useProjectionStore } from "../src/stores/projection";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { sessionTransport } from "../src/stores/session-transport";

const originalSendCommand = sessionTransport.store.getState().sendCommand;

function resetComposer(): void {
	useComposerStore.setState({
		bySession: {},
		activeSessionHandle: null,
		draft: "",
		images: [],
		trigger: null,
		mentionTrigger: null,
		command: null,
		submitState: "plain",
		activeSubmitId: null,
		attachmentWorkCount: 0,
		attachmentWorkIds: [],
		deliveryMode: "auto",
		queue: { steering: [], followUp: [] },
		recentQueued: [],
		isExpanded: false,
	});
}

beforeEach(() => {
	useI18n.getState().setLocale("en");
	resetComposer();
	useProjectionStore.setState({ projections: {}, order: [], currentSessionId: null });
	useSessionDirectoryStore.setState({
		currentWorkspaceHandle: "workspace-a",
		currentSession: { sessionHandle: "session-a" } as never,
		locallyCreatedTransientSessions: {},
	});
});

afterEach(() => {
	sessionTransport.store.setState({ sendCommand: originalSendCommand });
	vi.restoreAllMocks();
});

describe("submitDraft structured admission recovery", () => {
	it("keeps the captured draft and images after admission failure, then allows a successful retry", async () => {
		const failure = {
			type: "response",
			id: "failed-prompt",
			command: "prompt",
			success: false,
			error: "Gateway delivery failure",
			admissionError: {
				type: "payload_admission_error",
				code: "attachment_cache_exhausted",
				boundary: "attachment_cache",
				limitBytes: 1024,
				actualBytes: 2048,
			},
		} satisfies SessionCommandResponseDto;
		const success = {
			type: "response",
			id: "successful-prompt",
			command: "prompt",
			success: true,
		} satisfies SessionCommandResponseDto;
		const sendCommand = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
		sessionTransport.store.setState({ sendCommand });
		const toastError = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
		const composer = useComposerStore.getState();
		composer.beginSession("session-a");
		composer.setDraft("keep this prompt");
		composer.setImages([{ type: "image", mimeType: "image/png", data: "inline-image" }]);
		const submittedImages = useComposerStore.getState().images;

		await submitDraft("prompt");

		expect(useComposerStore.getState()).toMatchObject({
			draft: "keep this prompt",
			images: submittedImages,
			submitState: "plain",
		});
		const failureToast = toastError.mock.calls[0];

		await submitDraft("prompt");

		expect(sendCommand).toHaveBeenCalledTimes(2);
		expect(useComposerStore.getState()).toMatchObject({ draft: "", images: [], submitState: "plain" });
		expect(failureToast).toEqual([
			"Send failed",
			{
				description: (en as Record<string, string>)["payloadAdmission.attachment_cache_exhausted"],
			},
		]);
	});
});
