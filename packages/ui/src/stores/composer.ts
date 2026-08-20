import { create } from "zustand";
import type { ImageContent } from "../types/pi-types";

export type DeliveryMode = "auto" | "steer" | "follow_up";

export interface SlashTrigger {
	/** Index in the draft where the "/" token starts. */
	index: number;
	/** Current query after the "/" (no spaces). */
	query: string;
}

export interface RecentQueued {
	text: string;
	source: "steer" | "follow_up";
	at: number;
}

export interface ComposerSnapshot {
	draft: string;
	images: ImageContent[];
	trigger: SlashTrigger | null;
	submitState: "plain" | "submitting";
	deliveryMode: DeliveryMode;
	queue: { steering: string[]; followUp: string[] };
	recentQueued: RecentQueued[];
}

interface ComposerState extends ComposerSnapshot {
	bySession: Record<string, ComposerSnapshot>;
	activeSessionHandle: string | null;
	beginSession: (sessionHandle: string | null) => void;
	forgetSession: (sessionHandle: string) => void;
	setDraft: (draft: string) => void;
	setDraftForSession: (sessionHandle: string, draft: string) => void;
	setImages: (images: ImageContent[]) => void;
	setImagesForSession: (sessionHandle: string, images: ImageContent[]) => void;
	setTrigger: (trigger: SlashTrigger | null) => void;
	setTriggerForSession: (sessionHandle: string, trigger: SlashTrigger | null) => void;
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
	clearDraftIfUnchanged: (draft: string, images: ImageContent[]) => void;
	clearDraftIfUnchangedForSession: (sessionHandle: string, draft: string, images: ImageContent[]) => void;
}

const RECENT_QUEUE_TTL_MS = 5 * 60_000;
const RECENT_QUEUE_LIMIT = 20;

function emptySnapshot(): ComposerSnapshot {
	return {
		draft: "",
		images: [],
		trigger: null,
		submitState: "plain",
		deliveryMode: "auto",
		queue: { steering: [], followUp: [] },
		recentQueued: [],
	};
}

function visible(snapshot: ComposerSnapshot): ComposerSnapshot {
	return {
		draft: snapshot.draft,
		images: snapshot.images,
		trigger: snapshot.trigger,
		submitState: snapshot.submitState,
		deliveryMode: snapshot.deliveryMode,
		queue: snapshot.queue,
		recentQueued: snapshot.recentQueued,
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

		setTrigger: (trigger) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setTriggerForSession(handle, trigger);
		},
		setTriggerForSession: (sessionHandle, trigger) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, trigger })),

		setSubmitState: (submitState) => {
			const handle = get().activeSessionHandle;
			if (handle) get().setSubmitStateForSession(handle, submitState);
		},
		setSubmitStateForSession: (sessionHandle, submitState) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, submitState })),

		beginSubmit: () => {
			const handle = get().activeSessionHandle;
			return handle ? get().beginSubmitForSession(handle) : false;
		},
		beginSubmitForSession: (sessionHandle) => {
			if ((get().bySession[sessionHandle] ?? emptySnapshot()).submitState === "submitting") return false;
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, submitState: "submitting" }));
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
				trigger: null,
			})),

		clearDraftIfUnchanged: (draft, images) => {
			const handle = get().activeSessionHandle;
			if (handle) get().clearDraftIfUnchangedForSession(handle, draft, images);
		},
		clearDraftIfUnchangedForSession: (sessionHandle, draft, images) => {
			const current = get().bySession[sessionHandle];
			if (current?.draft === draft && current.images === images) {
				get().clearDraftForSession(sessionHandle);
			}
		},
	};
});
