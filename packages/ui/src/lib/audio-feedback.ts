/**
 * Native Web Audio API chime synthesis (DESIGN.md 8.2).
 * Synthesizes pure sine tones directly without external audio assets.
 */

const STORAGE_KEY = "piweb:audio-muted";
const audioMutedListeners = new Set<() => void>();

function notifyAudioMutedListeners(): void {
	for (const listener of audioMutedListeners) listener();
}

function onAudioMutedStorage(event: StorageEvent): void {
	if (event.key === STORAGE_KEY || event.key === null) notifyAudioMutedListeners();
}

export function subscribeAudioMuted(listener: () => void): () => void {
	audioMutedListeners.add(listener);
	if (
		audioMutedListeners.size === 1 &&
		typeof window !== "undefined" &&
		typeof window.addEventListener === "function"
	) {
		window.addEventListener("storage", onAudioMutedStorage);
	}
	return () => {
		audioMutedListeners.delete(listener);
		if (
			audioMutedListeners.size === 0 &&
			typeof window !== "undefined" &&
			typeof window.removeEventListener === "function"
		) {
			window.removeEventListener("storage", onAudioMutedStorage);
		}
	};
}

export function isAudioMuted(): boolean {
	try {
		if (typeof localStorage !== "undefined") {
			return localStorage.getItem(STORAGE_KEY) === "true";
		}
	} catch {
		// Ignore storage access restrictions
	}
	return false;
}

export function setAudioMuted(muted: boolean): boolean {
	try {
		if (typeof localStorage !== "undefined") {
			const previous = isAudioMuted();
			const value = muted ? "true" : "false";
			localStorage.setItem(STORAGE_KEY, value);
			if (localStorage.getItem(STORAGE_KEY) !== value) return false;
			if (previous !== muted) notifyAudioMutedListeners();
			return true;
		}
	} catch {
		// Ignore storage access restrictions
	}
	return false;
}

function getAudioContext(): AudioContext | null {
	if (typeof window === "undefined") return null;
	const AudioContextClass =
		window.AudioContext ||
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!AudioContextClass) return null;
	try {
		return new AudioContextClass();
	} catch {
		return null;
	}
}

/**
 * Play a gentle 120ms ascending sine wave chime (440Hz -> 880Hz) on task completion.
 */
export async function playCompletionChime(): Promise<void> {
	if (isAudioMuted()) return;
	const ctx = getAudioContext();
	if (!ctx) return;

	try {
		if (ctx.state === "suspended") {
			await ctx.resume().catch(() => {});
		}

		const now = ctx.currentTime;
		const duration = 0.12; // 120ms

		const osc = ctx.createOscillator();
		const gain = ctx.createGain();

		osc.type = "sine";
		osc.frequency.setValueAtTime(440, now);
		osc.frequency.exponentialRampToValueAtTime(880, now + duration);

		gain.gain.setValueAtTime(0.001, now);
		gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

		osc.connect(gain);
		gain.connect(ctx.destination);

		osc.start(now);
		osc.stop(now + duration);

		// Clean up audio context after tone finishes
		setTimeout(
			() => {
				void ctx.close().catch(() => {});
			},
			(duration + 0.05) * 1000,
		);
	} catch {
		// Error-safe: silently suppress audio errors (e.g. autoplay policy)
	}
}

/**
 * Play a double-pulse attention chime when user interaction is required (waiting_ui / Extension dialog).
 */
export async function playAttentionChime(): Promise<void> {
	if (isAudioMuted()) return;
	const ctx = getAudioContext();
	if (!ctx) return;

	try {
		if (ctx.state === "suspended") {
			await ctx.resume().catch(() => {});
		}

		const now = ctx.currentTime;
		const toneDuration = 0.07;
		const gap = 0.04;

		// Pulse 1: 587.33Hz (D5)
		const osc1 = ctx.createOscillator();
		const gain1 = ctx.createGain();
		osc1.type = "sine";
		osc1.frequency.setValueAtTime(587.33, now);
		gain1.gain.setValueAtTime(0.001, now);
		gain1.gain.linearRampToValueAtTime(0.12, now + 0.015);
		gain1.gain.exponentialRampToValueAtTime(0.001, now + toneDuration);
		osc1.connect(gain1);
		gain1.connect(ctx.destination);
		osc1.start(now);
		osc1.stop(now + toneDuration);

		// Pulse 2: 880Hz (A5)
		const start2 = now + toneDuration + gap;
		const osc2 = ctx.createOscillator();
		const gain2 = ctx.createGain();
		osc2.type = "sine";
		osc2.frequency.setValueAtTime(880, start2);
		gain2.gain.setValueAtTime(0.001, start2);
		gain2.gain.linearRampToValueAtTime(0.12, start2 + 0.015);
		gain2.gain.exponentialRampToValueAtTime(0.001, start2 + toneDuration);
		osc2.connect(gain2);
		gain2.connect(ctx.destination);
		osc2.start(start2);
		osc2.stop(start2 + toneDuration);

		setTimeout(
			() => {
				void ctx.close().catch(() => {});
			},
			(start2 + toneDuration + 0.05) * 1000,
		);
	} catch {
		// Error-safe
	}
}
