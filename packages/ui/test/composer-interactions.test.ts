import { beforeEach, describe, expect, it } from "vitest";
import {
	detectSlashTrigger,
	isSlashCommitKey,
	resolveComposerKeyAction,
	resolveRunningSubmitKind,
	shouldRemoveCommandOnBackspace,
} from "../src/features/composer/composer-input";
import { type SlashCommandToken, serializeComposerMessage, useComposerStore } from "../src/stores/composer";
import type { ImageContent } from "../src/types/pi-types";

beforeEach(() => {
	useComposerStore.setState({
		bySession: {},
		activeSessionHandle: null,
		draft: "",
		images: [],
		fileReferences: [],
		trigger: null,
		command: null,
		submitState: "plain",
		activeSubmitId: null,
		attachmentWorkCount: 0,
		attachmentWorkIds: [],
		deliveryMode: "auto",
		queue: { steering: [], followUp: [] },
		recentQueued: [],
	});
	useComposerStore.getState().beginSession("session-a");
});

describe("composer interactions", () => {
	const skillToken: SlashCommandToken = {
		name: "skill:review",
		displayName: "review",
		source: "skill",
	};

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

	it("commits the highlighted menu item with Tab or Enter, but never Space", () => {
		expect(isSlashCommitKey({ key: "Tab" })).toBe(true);
		expect(isSlashCommitKey({ key: "Enter" })).toBe(true);
		expect(isSlashCommitKey({ key: " " })).toBe(false);
		expect(isSlashCommitKey({ key: "Enter", shiftKey: true })).toBe(false);
		expect(isSlashCommitKey({ key: "Tab", ctrlKey: true })).toBe(false);
	});

	it("opens command completion only for the first non-whitespace token", () => {
		expect(detectSlashTrigger("/rev", 4)).toEqual({ index: 0, query: "rev" });
		expect(detectSlashTrigger("  /rev", 6)).toEqual({ index: 2, query: "rev" });
		expect(detectSlashTrigger("\t/rev", 5)).toEqual({ index: 1, query: "rev" });
		expect(detectSlashTrigger("Before /rev", 11)).toBeNull();
		expect(detectSlashTrigger("Before\n/rev", 11)).toBeNull();
		expect(detectSlashTrigger("https://example.com", 8)).toBeNull();
		expect(detectSlashTrigger("/rev args", 9)).toBeNull();
		expect(detectSlashTrigger("//rev", 5)).toBeNull();
	});

	it("serializes an immutable command token separately from its editable body", () => {
		expect(serializeComposerMessage(skillToken, "  src/lib\nfocus on races  ")).toBe(
			"/skill:review src/lib\nfocus on races",
		);
		expect(serializeComposerMessage(skillToken, "")).toBe("/skill:review");
		expect(serializeComposerMessage(null, "  ordinary prompt  ")).toBe("ordinary prompt");
	});

	it("serializes Host-captured file bytes instead of asking Pi to reopen a path", () => {
		const text = serializeComposerMessage(null, "Review @src/example.ts", [
			{
				metadata: {
					path: 'src/a"&b.ts',
					canonicalIdentity: "1:2:3:4",
					byteSize: 18,
					kind: "text",
					estimatedTokens: 5,
					risks: [],
					availability: "ready",
					previewTruncated: false,
				},
				content: { type: "text", text: "export const x = 1;" },
			},
		]);

		expect(text).toContain('Review @src/example.ts\n<file name="src/a&quot;&amp;b.ts">');
		expect(text).toContain("export const x = 1;");
	});

	it("removes the whole token on an empty-body Backspace and via the remove action", () => {
		expect(
			shouldRemoveCommandOnBackspace({
				hasCommand: true,
				draft: "",
				key: "Backspace",
				composing: false,
				selectionStart: 0,
				selectionEnd: 0,
			}),
		).toBe(true);
		expect(
			shouldRemoveCommandOnBackspace({
				hasCommand: true,
				draft: "arg",
				key: "Backspace",
				composing: false,
				selectionStart: 0,
				selectionEnd: 0,
			}),
		).toBe(false);

		useComposerStore.getState().setCommand(skillToken);
		useComposerStore.getState().setDraft("kept body");
		useComposerStore.getState().setCommand(null);
		expect(useComposerStore.getState()).toMatchObject({ command: null, draft: "kept body" });
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

	it("clears the captured command submission after Session switch and canonical rekey only", () => {
		const composer = useComposerStore.getState();
		composer.setCommand(skillToken);
		composer.setDraft("review this");
		expect(composer.beginSubmit()).toBe(true);
		const submitted = useComposerStore.getState().bySession["session-a"]!;

		composer.beginSession("session-b");
		composer.setCommand({ name: "compact", displayName: "compact", source: "extension" });
		composer.setDraft("session b body");
		composer.rekeySession("session-a", "session-a-canonical");
		composer.clearDraftIfUnchangedForSession(
			"session-a",
			submitted.draft,
			submitted.images,
			submitted.command,
			submitted.activeSubmitId,
		);
		composer.finishSubmitForSession("session-a", submitted.activeSubmitId);

		expect(useComposerStore.getState().bySession["session-a"]).toBeUndefined();
		expect(useComposerStore.getState().bySession["session-a-canonical"]).toMatchObject({
			draft: "",
			command: null,
			submitState: "plain",
		});
		expect(useComposerStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			draft: "session b body",
			command: { name: "compact" },
		});
	});

	it("does not clear a command token replaced while its submission is in flight", () => {
		const composer = useComposerStore.getState();
		composer.setCommand(skillToken);
		composer.setDraft("same body");
		expect(composer.beginSubmit()).toBe(true);
		const submitted = useComposerStore.getState().bySession["session-a"]!;
		composer.setCommand({ ...skillToken });

		composer.clearDraftIfUnchangedForSession(
			"session-a",
			submitted.draft,
			submitted.images,
			submitted.command,
			submitted.activeSubmitId,
		);
		expect(useComposerStore.getState()).toMatchObject({ draft: "same body", command: skillToken });
	});

	it("tracks attachment preparation across Session switches and canonical rekey", () => {
		const composer = useComposerStore.getState();
		const attachmentWorkId = composer.beginAttachmentWorkForSession("session-a");
		composer.beginSession("session-b");
		composer.rekeySession("session-a", "session-a-canonical");

		expect(useComposerStore.getState().bySession["session-a-canonical"]?.attachmentWorkCount).toBe(1);
		expect(useComposerStore.getState().attachmentWorkCount).toBe(0);

		composer.finishAttachmentWorkForSession("session-a", attachmentWorkId, [
			{ type: "image", mimeType: "image/png", data: "prepared" },
		]);
		expect(useComposerStore.getState().bySession["session-a-canonical"]).toMatchObject({
			attachmentWorkCount: 0,
			images: [{ data: "prepared" }],
		});
		expect(useComposerStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			images: [],
			attachmentWorkCount: 0,
		});
	});

	it("keeps captured file bytes on their Session across navigation and canonical rekey", () => {
		const composer = useComposerStore.getState();
		const reference = {
			metadata: {
				path: "src/reference.ts",
				canonicalIdentity: "1:2:3:4",
				byteSize: 8,
				kind: "text" as const,
				estimatedTokens: 2,
				risks: [],
				availability: "ready" as const,
				previewTruncated: false,
			},
			content: { type: "text" as const, text: "captured" },
		};

		composer.addFileReferenceForSession("session-a", reference);
		composer.beginSession("session-b");
		composer.rekeySession("session-a", "session-a-canonical");

		expect(useComposerStore.getState().fileReferences).toEqual([]);
		expect(useComposerStore.getState().bySession["session-a"]).toBeUndefined();
		expect(useComposerStore.getState().bySession["session-a-canonical"]?.fileReferences).toEqual([reference]);
	});

	it("restores drafts and queues when the visible Session changes", () => {
		useComposerStore.getState().setDraft("draft a");
		useComposerStore.getState().setCommand(skillToken);
		useComposerStore.getState().setQueue({ steering: ["a"], followUp: [] });

		useComposerStore.getState().beginSession("session-b");
		useComposerStore.getState().setDraft("draft b");
		useComposerStore
			.getState()
			.setQueueForSession("session-a", { steering: ["a", "background"], followUp: [] });

		expect(useComposerStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			draft: "draft b",
			command: null,
			queue: { steering: [], followUp: [] },
		});

		useComposerStore.getState().beginSession("session-a");
		expect(useComposerStore.getState()).toMatchObject({
			draft: "draft a",
			command: skillToken,
			queue: { steering: ["a", "background"], followUp: [] },
		});
	});

	it("tracks 70vh isExpanded state per session and migrates on canonical rekey", () => {
		const composer = useComposerStore.getState();
		expect(composer.isExpanded).toBe(false);

		composer.setIsExpanded(true);
		expect(useComposerStore.getState().isExpanded).toBe(true);

		composer.beginSession("session-b");
		expect(useComposerStore.getState().isExpanded).toBe(false);

		composer.rekeySession("session-a", "session-a-canonical");
		composer.beginSession("session-a-canonical");
		expect(useComposerStore.getState().isExpanded).toBe(true);
	});

	describe("keybinding arbitration state machine", () => {
		it("Idle + Normal: Enter sends prompt, Shift+Enter wraps", () => {
			expect(
				resolveComposerKeyAction({
					key: "Enter",
					running: false,
					isExpanded: false,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "submit", mode: "prompt" });

			expect(
				resolveComposerKeyAction({
					key: "Enter",
					shiftKey: true,
					running: false,
					isExpanded: false,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "newline" });
		});

		it("Idle + 70vh: Enter wraps, Cmd/Ctrl+Enter sends prompt", () => {
			expect(
				resolveComposerKeyAction({
					key: "Enter",
					running: false,
					isExpanded: true,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "newline" });

			expect(
				resolveComposerKeyAction({
					key: "Enter",
					metaKey: true,
					running: false,
					isExpanded: true,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "submit", mode: "prompt" });

			expect(
				resolveComposerKeyAction({
					key: "Enter",
					ctrlKey: true,
					running: false,
					isExpanded: true,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "submit", mode: "prompt" });
		});

		it("Running + Normal: Enter steers, Cmd/Ctrl+Enter follow_up", () => {
			expect(
				resolveComposerKeyAction({
					key: "Enter",
					running: true,
					isExpanded: false,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "submit", mode: "steer" });

			expect(
				resolveComposerKeyAction({
					key: "Enter",
					metaKey: true,
					running: true,
					isExpanded: false,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "submit", mode: "follow_up" });

			expect(
				resolveComposerKeyAction({
					key: "Enter",
					ctrlKey: true,
					running: true,
					isExpanded: false,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "submit", mode: "follow_up" });
		});

		it("Running + 70vh: Enter wraps, Cmd/Ctrl+Enter sends with selected delivery mode", () => {
			expect(
				resolveComposerKeyAction({
					key: "Enter",
					running: true,
					isExpanded: true,
					deliveryMode: "steer",
				}),
			).toEqual({ type: "newline" });

			expect(
				resolveComposerKeyAction({
					key: "Enter",
					metaKey: true,
					running: true,
					isExpanded: true,
					deliveryMode: "steer",
				}),
			).toEqual({ type: "submit", mode: "steer" });

			expect(
				resolveComposerKeyAction({
					key: "Enter",
					metaKey: true,
					running: true,
					isExpanded: true,
					deliveryMode: "follow_up",
				}),
			).toEqual({ type: "submit", mode: "follow_up" });
		});

		it("ignores Enter while IME composition is active", () => {
			expect(
				resolveComposerKeyAction({
					key: "Enter",
					composing: true,
					running: false,
					isExpanded: false,
					deliveryMode: "auto",
				}),
			).toEqual({ type: "none" });
		});
	});
});
