import { beforeEach, describe, expect, it } from "vitest";
import { resolveRunningSubmitKind } from "../src/features/composer/composer-input";
import { useComposerStore } from "../src/stores/composer";
import type { ImageContent } from "../src/types/pi-types";

beforeEach(() => {
	useComposerStore.setState({
		bySession: {},
		activeSessionHandle: null,
		draft: "",
		images: [],
		trigger: null,
		submitState: "plain",
		deliveryMode: "auto",
		queue: { steering: [], followUp: [] },
		recentQueued: [],
	});
	useComposerStore.getState().beginSession("session-a");
});

describe("composer interactions", () => {
	it("always resolves Cmd/Ctrl+Enter to follow-up from the pre-update mode", () => {
		expect(resolveRunningSubmitKind("auto", true)).toBe("follow_up");
		expect(resolveRunningSubmitKind("steer", true)).toBe("follow_up");
		expect(resolveRunningSubmitKind("follow_up", true)).toBe("follow_up");
		expect(resolveRunningSubmitKind("auto", false)).toBe("steer");
		expect(resolveRunningSubmitKind("follow_up", false)).toBe("follow_up");
	});

	it("allows only one caller to claim the in-flight submit slot", () => {
		expect(useComposerStore.getState().beginSubmit()).toBe(true);
		expect(useComposerStore.getState().beginSubmit()).toBe(false);
		expect(useComposerStore.getState().submitState).toBe("submitting");
	});

	it("does not clear text edited while a submission is in flight", () => {
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "a" }];
		useComposerStore.getState().setDraft("original");
		useComposerStore.getState().setImages(images);
		const snapshot = useComposerStore.getState();

		useComposerStore.getState().setDraft("edited while sending");
		useComposerStore.getState().clearDraftIfUnchanged(snapshot.draft, snapshot.images);

		expect(useComposerStore.getState().draft).toBe("edited while sending");
		expect(useComposerStore.getState().images).toBe(images);
	});

	it("clears an unchanged submitted draft and its attachments", () => {
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "a" }];
		useComposerStore.getState().setDraft("send me");
		useComposerStore.getState().setImages(images);
		useComposerStore.getState().setTrigger({ index: 0, query: "send" });
		const snapshot = useComposerStore.getState();

		useComposerStore.getState().clearDraftIfUnchanged(snapshot.draft, snapshot.images);

		expect(useComposerStore.getState()).toMatchObject({ draft: "", images: [], trigger: null });
	});

	it("restores drafts and queues when the visible Session changes", () => {
		useComposerStore.getState().setDraft("draft a");
		useComposerStore.getState().setQueue({ steering: ["a"], followUp: [] });

		useComposerStore.getState().beginSession("session-b");
		useComposerStore.getState().setDraft("draft b");
		useComposerStore
			.getState()
			.setQueueForSession("session-a", { steering: ["a", "background"], followUp: [] });

		expect(useComposerStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			draft: "draft b",
			queue: { steering: [], followUp: [] },
		});

		useComposerStore.getState().beginSession("session-a");
		expect(useComposerStore.getState()).toMatchObject({
			draft: "draft a",
			queue: { steering: ["a", "background"], followUp: [] },
		});
	});
});
