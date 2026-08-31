import {
	WORKSPACE_FILE_REFERENCE_MAX_COUNT,
	WORKSPACE_FILE_REFERENCE_TEXT_TOTAL_MAX_BYTES,
	type WorkspaceFileReferenceDto,
} from "@pi-agent-web/protocol";
import { create } from "zustand";
import type { ImageContent } from "../types/pi-types";

export type DeliveryMode = "auto" | "steer" | "follow_up";

export interface SlashTrigger {
	/** Index in the draft where the "/" token starts. */
	index: number;
	/** Current query after the "/" (no spaces). */
	query: string;
}

export interface MentionTrigger {
	/** Index in the draft where the "@" token starts. */
	index: number;
	/** Current query after the "@" (no whitespace). */
	query: string;
}

export interface RecentQueued {
	text: string;
	source: "steer" | "follow_up";
	at: number;
}

/** A selected Pi command is atomic UI state; only its argument body remains editable. */
export interface SlashCommandToken {
	readonly name: string;
	readonly displayName: string;
	readonly source: "extension" | "prompt" | "skill";
}

/** Serialize Host-captured files using Pi's established CLI file envelope. */
export function serializeComposerMessage(
	command: SlashCommandToken | null,
	draft: string,
	fileReferences: WorkspaceFileReferenceDto[] = [],
): string {
	if (fileReferences.length > WORKSPACE_FILE_REFERENCE_MAX_COUNT) {
		throw new Error("workspace_file_reference_count_exceeded");
	}
	let expandedBytes = 0;
	const files = fileReferences.map((reference) => {
		const name = escapeFileName(reference.metadata.path);
		if (reference.content.type === "image") return `<file name="${name}"></file>`;
		if (reference.content.type === "binary_base64") {
			expandedBytes += reference.content.data.length;
			return `<file name="${name}" encoding="base64">\n${reference.content.data}\n</file>`;
		}
		expandedBytes += new TextEncoder().encode(reference.content.text).byteLength;
		return `<file name="${name}">\n${reference.content.text}\n</file>`;
	});
	if (expandedBytes > WORKSPACE_FILE_REFERENCE_TEXT_TOTAL_MAX_BYTES) {
		throw new Error("workspace_file_reference_text_budget_exceeded");
	}
	const body = [draft.trim(), ...files].filter(Boolean).join("\n");
	if (!command) return body;
	return body ? `/${command.name} ${body}` : `/${command.name}`;
}

export function workspaceFileImages(fileReferences: WorkspaceFileReferenceDto[]): ImageContent[] {
	return fileReferences.flatMap((reference) =>
		reference.content.type === "image"
			? [
					{
						type: "image" as const,
						mimeType: reference.content.mimeType,
						data: reference.content.data,
					},
				]
			: [],
	);
}

function escapeFileName(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("\r", "&#13;")
		.replaceAll("\n", "&#10;")
		.replaceAll("\t", "&#9;");
}

export interface ComposerSnapshot {
	draft: string;
	images: ImageContent[];
	fileReferences: WorkspaceFileReferenceDto[];
	trigger: SlashTrigger | null;
	mentionTrigger: MentionTrigger | null;
	command: SlashCommandToken | null;
	submitState: "plain" | "submitting";
	activeSubmitId: number | null;
	attachmentWorkCount: number;
	attachmentWorkIds: readonly number[];
	deliveryMode: DeliveryMode;
	queue: { steering: string[]; followUp: string[] };
	recentQueued: RecentQueued[];
	isExpanded: boolean;
}

interface ComposerState extends ComposerSnapshot {
	bySession: Record<string, ComposerSnapshot>;
	activeSessionHandle: string | null;
	beginSession: (sessionHandle: string | null) => void;
	forgetSession: (sessionHandle: string) => void;
	setIsExpanded: (expanded: boolean) => void;
	setIsExpandedForSession: (sessionHandle: string, expanded: boolean) => void;
	setDraft: (draft: string) => void;
	setDraftForSession: (sessionHandle: string, draft: string) => void;
	setImages: (images: ImageContent[]) => void;
	setImagesForSession: (sessionHandle: string, images: ImageContent[]) => void;
	addFileReference: (reference: WorkspaceFileReferenceDto) => void;
	addFileReferenceForSession: (sessionHandle: string, reference: WorkspaceFileReferenceDto) => void;
	removeFileReference: (canonicalIdentity: string) => void;
	removeFileReferenceForSession: (sessionHandle: string, canonicalIdentity: string) => void;
	beginAttachmentWorkForSession: (sessionHandle: string) => number;
	finishAttachmentWorkForSession: (
		sessionHandle: string,
		attachmentWorkId: number,
		preparedImages?: ImageContent[],
	) => void;
	setTrigger: (trigger: SlashTrigger | null) => void;
	setTriggerForSession: (sessionHandle: string, trigger: SlashTrigger | null) => void;
	setMentionTrigger: (mentionTrigger: MentionTrigger | null) => void;
	setMentionTriggerForSession: (sessionHandle: string, mentionTrigger: MentionTrigger | null) => void;
	setCommand: (command: SlashCommandToken | null) => void;

	setCommandForSession: (sessionHandle: string, command: SlashCommandToken | null) => void;
	setSubmitState: (state: "plain" | "submitting") => void;
	setSubmitStateForSession: (sessionHandle: string, state: "plain" | "submitting") => void;
	/** Atomically claim the active Session's single in-flight submit slot. */
	beginSubmit: () => boolean;
	beginSubmitForSession: (sessionHandle: string) => boolean;
	setDeliveryMode: (mode: DeliveryMode) => void;
	setDeliveryModeForSession: (sessionHandle: string, mode: DeliveryMode) => void;
	setQueue: (queue: { steering: string[]; followUp: string[] }) => void;
	setQueueForSession: (sessionHandle: string, queue: { steering: string[]; followUp: string[] }) => void;
	/** Record a just-submitted queued message for injection source labeling. */
	recordQueued: (text: string, source: "steer" | "follow_up") => void;
	recordQueuedForSession: (sessionHandle: string, text: string, source: "steer" | "follow_up") => void;
	/** Resolve a queued text to its source; consumes the entry. */
	consumeInjectionSource: (text: string) => "steer" | "follow_up" | undefined;
	consumeInjectionSourceForSession: (
		sessionHandle: string,
		text: string,
	) => "steer" | "follow_up" | undefined;
	clearDraft: () => void;
	clearDraftForSession: (sessionHandle: string) => void;
	/** Clear only when the user has not edited the draft during submission. */
	clearDraftIfUnchanged: (
		draft: string,
		images: ImageContent[],
		command?: SlashCommandToken | null,
		fileReferences?: WorkspaceFileReferenceDto[],
	) => void;
	clearDraftIfUnchangedForSession: (
		sessionHandle: string,
		draft: string,
		images: ImageContent[],
		command?: SlashCommandToken | null,
		activeSubmitId?: number | null,
		fileReferences?: WorkspaceFileReferenceDto[],
	) => void;
	finishSubmitForSession: (sessionHandle: string, activeSubmitId: number | null) => void;
	/** Move in-flight composer state when a pending Session gets its canonical handle. */
	rekeySession: (previousSessionHandle: string, sessionHandle: string) => void;
}

const RECENT_QUEUE_TTL_MS = 5 * 60_000;
const RECENT_QUEUE_LIMIT = 20;
let submitIdCounter = 0;
let attachmentWorkIdCounter = 0;

function emptySnapshot(): ComposerSnapshot {
	return {
		draft: "",
		images: [],
		fileReferences: [],
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
	};
}

function visible(snapshot: ComposerSnapshot): ComposerSnapshot {
	return {
		draft: snapshot.draft,
		images: snapshot.images,
		fileReferences: snapshot.fileReferences,
		trigger: snapshot.trigger,
		mentionTrigger: snapshot.mentionTrigger,
		command: snapshot.command,
		submitState: snapshot.submitState,
		activeSubmitId: snapshot.activeSubmitId,
		attachmentWorkCount: snapshot.attachmentWorkCount,
		attachmentWorkIds: snapshot.attachmentWorkIds,
		deliveryMode: snapshot.deliveryMode,
		queue: snapshot.queue,
		recentQueued: snapshot.recentQueued,
		isExpanded: snapshot.isExpanded,
	};
}

export const useComposerStore = create<ComposerState>()((set, get) => {
	const updateSession = (
		sessionHandle: string,
		update: (snapshot: ComposerSnapshot) => ComposerSnapshot,
	): ComposerSnapshot => {
		let result = emptySnapshot();
		set((state) => {
			const current = state.bySession[sessionHandle] ?? emptySnapshot();
			result = update(current);
			return {
				bySession: { ...state.bySession, [sessionHandle]: result },
				...(state.activeSessionHandle === sessionHandle ? visible(result) : {}),
			};
		});
		return result;
	};

	return {
		...emptySnapshot(),
		bySession: {},
		activeSessionHandle: null,

		beginSession: (activeSessionHandle) =>
			set((state) => ({
				activeSessionHandle,
				...visible(
					activeSessionHandle ? (state.bySession[activeSessionHandle] ?? emptySnapshot()) : emptySnapshot(),
				),
			})),

		forgetSession: (sessionHandle) =>
			set((state) => {
				const bySession = { ...state.bySession };
				delete bySession[sessionHandle];
				return {
					bySession,
					...(state.activeSessionHandle === sessionHandle
						? { activeSessionHandle: null, ...visible(emptySnapshot()) }
						: {}),
				};
			}),

		setIsExpanded: (isExpanded) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setIsExpandedForSession(handle, isExpanded);
			else set({ isExpanded });
		},
		setIsExpandedForSession: (sessionHandle, isExpanded) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, isExpanded })),

		setDraft: (draft) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setDraftForSession(handle, draft);
		},
		setDraftForSession: (sessionHandle, draft) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, draft })),

		setImages: (images) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setImagesForSession(handle, images);
		},
		setImagesForSession: (sessionHandle, images) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, images })),
		addFileReference: (reference) => {
			const handle = get().activeSessionHandle;
			if (handle) get().addFileReferenceForSession(handle, reference);
		},
		addFileReferenceForSession: (sessionHandle, reference) =>
			updateSession(sessionHandle, (snapshot) => {
				const withoutSamePath = snapshot.fileReferences.filter(
					(candidate) => candidate.metadata.path !== reference.metadata.path,
				);
				if (withoutSamePath.length >= WORKSPACE_FILE_REFERENCE_MAX_COUNT) return snapshot;
				return {
					...snapshot,
					fileReferences: [...withoutSamePath, reference],
				};
			}),
		removeFileReference: (canonicalIdentity) => {
			const handle = get().activeSessionHandle;
			if (handle) get().removeFileReferenceForSession(handle, canonicalIdentity);
		},
		removeFileReferenceForSession: (sessionHandle, canonicalIdentity) =>
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				fileReferences: snapshot.fileReferences.filter(
					(reference) => reference.metadata.canonicalIdentity !== canonicalIdentity,
				),
			})),
		beginAttachmentWorkForSession: (sessionHandle) => {
			attachmentWorkIdCounter += 1;
			const attachmentWorkId = attachmentWorkIdCounter;
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				attachmentWorkCount: snapshot.attachmentWorkCount + 1,
				attachmentWorkIds: [...snapshot.attachmentWorkIds, attachmentWorkId],
			}));
			return attachmentWorkId;
		},
		finishAttachmentWorkForSession: (sessionHandle, attachmentWorkId, preparedImages) => {
			const state = get();
			const direct = state.bySession[sessionHandle];
			const targetHandle = direct?.attachmentWorkIds.includes(attachmentWorkId)
				? sessionHandle
				: Object.entries(state.bySession).find(([, snapshot]) =>
						snapshot.attachmentWorkIds.includes(attachmentWorkId),
					)?.[0];
			if (!targetHandle) return;
			updateSession(targetHandle, (snapshot) => ({
				...snapshot,
				...(preparedImages ? { images: preparedImages } : {}),
				attachmentWorkCount: Math.max(0, snapshot.attachmentWorkCount - 1),
				attachmentWorkIds: snapshot.attachmentWorkIds.filter((id) => id !== attachmentWorkId),
			}));
		},

		setTrigger: (trigger) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setTriggerForSession(handle, trigger);
		},
		setTriggerForSession: (sessionHandle, trigger) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, trigger })),

		setMentionTrigger: (mentionTrigger) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setMentionTriggerForSession(handle, mentionTrigger);
		},
		setMentionTriggerForSession: (sessionHandle, mentionTrigger) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, mentionTrigger })),

		setCommand: (command) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setCommandForSession(handle, command);
		},
		setCommandForSession: (sessionHandle, command) =>
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				command,
				trigger: command ? null : snapshot.trigger,
			})),

		setSubmitState: (submitState) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setSubmitStateForSession(handle, submitState);
		},
		setSubmitStateForSession: (sessionHandle, submitState) =>
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				submitState,
				activeSubmitId: submitState === "plain" ? null : snapshot.activeSubmitId,
			})),

		beginSubmit: () => {
			const handle = get().activeSessionHandle;
			return handle ? get().beginSubmitForSession(handle) : false;
		},
		beginSubmitForSession: (sessionHandle) => {
			if ((get().bySession[sessionHandle] ?? emptySnapshot()).submitState === "submitting") return false;
			submitIdCounter += 1;
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				submitState: "submitting",
				activeSubmitId: submitIdCounter,
			}));
			return true;
		},

		setDeliveryMode: (deliveryMode) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setDeliveryModeForSession(handle, deliveryMode);
		},
		setDeliveryModeForSession: (sessionHandle, deliveryMode) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, deliveryMode })),

		setQueue: (queue) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setQueueForSession(handle, queue);
		},
		setQueueForSession: (sessionHandle, queue) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, queue })),

		recordQueued: (text, source) => {
			const handle = get().activeSessionHandle;
			if (handle) get().recordQueuedForSession(handle, text, source);
		},
		recordQueuedForSession: (sessionHandle, text, source) => {
			const now = Date.now();
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				recentQueued: [...snapshot.recentQueued, { text, source, at: now }]
					.filter((entry) => now - entry.at < RECENT_QUEUE_TTL_MS)
					.slice(-RECENT_QUEUE_LIMIT),
			}));
		},

		consumeInjectionSource: (text) => {
			const handle = get().activeSessionHandle;
			return handle ? get().consumeInjectionSourceForSession(handle, text) : undefined;
		},
		consumeInjectionSourceForSession: (sessionHandle, text) => {
			const current = get().bySession[sessionHandle] ?? emptySnapshot();
			const index = current.recentQueued.findIndex((entry) => entry.text === text);
			const entry = current.recentQueued[index];
			if (!entry) return undefined;
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				recentQueued: snapshot.recentQueued.filter((_, candidate) => candidate !== index),
			}));
			return entry.source;
		},

		clearDraft: () => {
			const handle = get().activeSessionHandle;
			if (handle) get().clearDraftForSession(handle);
		},
		clearDraftForSession: (sessionHandle) =>
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				draft: "",
				images: [],
				fileReferences: [],
				trigger: null,
				mentionTrigger: null,
				command: null,
			})),

		clearDraftIfUnchanged: (draft, images, command = null, fileReferences) => {
			const handle = get().activeSessionHandle;
			if (handle) get().clearDraftIfUnchangedForSession(handle, draft, images, command, null, fileReferences);
		},
		clearDraftIfUnchangedForSession: (
			sessionHandle,
			draft,
			images,
			command = null,
			activeSubmitId = null,
			fileReferences,
		) => {
			const state = get();
			const targetHandle =
				activeSubmitId === null
					? sessionHandle
					: Object.entries(state.bySession).find(
							([, snapshot]) => snapshot.activeSubmitId === activeSubmitId,
						)?.[0];
			if (!targetHandle) return;
			const current = state.bySession[targetHandle];
			if (
				current?.draft === draft &&
				current.images === images &&
				current.command === command &&
				(fileReferences === undefined || current.fileReferences === fileReferences) &&
				(activeSubmitId === null || current.activeSubmitId === activeSubmitId)
			) {
				get().clearDraftForSession(targetHandle);
			}
		},

		finishSubmitForSession: (sessionHandle, activeSubmitId) => {
			const state = get();
			const targetHandle =
				activeSubmitId === null
					? sessionHandle
					: Object.entries(state.bySession).find(
							([, snapshot]) => snapshot.activeSubmitId === activeSubmitId,
						)?.[0];
			if (!targetHandle) return;
			updateSession(targetHandle, (snapshot) => ({
				...snapshot,
				submitState: "plain",
				activeSubmitId: null,
			}));
		},

		rekeySession: (previousSessionHandle, sessionHandle) => {
			if (previousSessionHandle === sessionHandle) return;
			set((state) => {
				const previous = state.bySession[previousSessionHandle];
				if (!previous) return {};
				const bySession = { ...state.bySession, [sessionHandle]: previous };
				delete bySession[previousSessionHandle];
				const activeSessionHandle =
					state.activeSessionHandle === previousSessionHandle ? sessionHandle : state.activeSessionHandle;
				return {
					bySession,
					activeSessionHandle,
					...(activeSessionHandle === sessionHandle ? visible(previous) : {}),
				};
			});
		},
	};
});
