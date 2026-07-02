import { create } from "zustand";
import type { ImageContent } from "../types/pi-types";

export type DeliveryMode = "auto" | "steer" | "follow_up";

export interface SlashTrigger {
	/** Index in the draft where the "/" token starts. */
	index: number;
	/** Current query after the "/" (no spaces). */
	query: string;
}

interface RecentQueued {
	text: string;
	source: "steer" | "follow_up";
	at: number;
}

interface ComposerState {
	draft: string;
	images: ImageContent[];
	trigger: SlashTrigger | null;
	submitState: "plain" | "submitting";
	/** Delivery intent while the agent is running (steer / follow_up). */
	deliveryMode: DeliveryMode;
	/** Mirrored from queue_update events; drives the Queue Dock. */
	queue: { steering: string[]; followUp: string[] };
	recentQueued: RecentQueued[];
	setDraft: (draft: string) => void;
	setImages: (images: ImageContent[]) => void;
	setTrigger: (trigger: SlashTrigger | null) => void;
	setSubmitState: (state: "plain" | "submitting") => void;
	setDeliveryMode: (mode: DeliveryMode) => void;
	setQueue: (queue: { steering: string[]; followUp: string[] }) => void;
	/** Record a just-submitted queued message for injection source labeling. */
	recordQueued: (text: string, source: "steer" | "follow_up") => void;
	/** Resolve a queued text to its source; consumes the entry. */
	consumeInjectionSource: (text: string) => "steer" | "follow_up" | undefined;
	clearDraft: () => void;
}

export const useComposerStore = create<ComposerState>()((set, get) => ({
	draft: "",
	images: [],
	trigger: null,
	submitState: "plain",
	deliveryMode: "auto",
	queue: { steering: [], followUp: [] },
	recentQueued: [],

	setDraft: (draft) => set({ draft }),
	setImages: (images) => set({ images }),
	setTrigger: (trigger) => set({ trigger }),
	setSubmitState: (submitState) => set({ submitState }),
	setDeliveryMode: (deliveryMode) => set({ deliveryMode }),
	setQueue: (queue) => set({ queue }),

	recordQueued: (text, source) => {
		const recentQueued = [...get().recentQueued, { text, source, at: Date.now() }]
			.filter((entry) => Date.now() - entry.at < 5 * 60_000)
			.slice(-20);
		set({ recentQueued });
	},

	consumeInjectionSource: (text) => {
		const index = get().recentQueued.findIndex((entry) => entry.text === text);
		if (index === -1) return undefined;
		const entry = get().recentQueued[index];
		if (!entry) return undefined;
		set({ recentQueued: get().recentQueued.filter((_, i) => i !== index) });
		return entry.source;
	},

	clearDraft: () => set({ draft: "", images: [], trigger: null }),
}));
