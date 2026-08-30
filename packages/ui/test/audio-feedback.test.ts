import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isAudioMuted,
	playAttentionChime,
	playCompletionChime,
	setAudioMuted,
	subscribeAudioMuted,
} from "../src/lib/audio-feedback";

describe("audio-feedback", () => {
	let createdContexts: any[] = [];
	const storage = new Map<string, string>();

	beforeEach(() => {
		createdContexts = [];
		storage.clear();

		const mockLocalStorage = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			clear: () => storage.clear(),
		};

		// Mock AudioContext
		class MockGainNode {
			gain = {
				setValueAtTime: vi.fn(),
				exponentialRampToValueAtTime: vi.fn(),
				linearRampToValueAtTime: vi.fn(),
				value: 1,
			};
			connect = vi.fn();
		}

		class MockOscillatorNode {
			type = "sine";
			frequency = {
				setValueAtTime: vi.fn(),
				exponentialRampToValueAtTime: vi.fn(),
				linearRampToValueAtTime: vi.fn(),
				value: 440,
			};
			connect = vi.fn();
			start = vi.fn();
			stop = vi.fn();
		}

		class MockAudioContext {
			state = "running";
			currentTime = 0;
			destination = {};
			createGain = vi.fn(() => new MockGainNode());
			createOscillator = vi.fn(() => new MockOscillatorNode());
			resume = vi.fn().mockResolvedValue(undefined);
			close = vi.fn().mockResolvedValue(undefined);
			constructor() {
				createdContexts.push(this);
			}
		}

		vi.stubGlobal("localStorage", mockLocalStorage);
		vi.stubGlobal("AudioContext", MockAudioContext);
		vi.stubGlobal("window", {
			AudioContext: MockAudioContext,
			localStorage: mockLocalStorage,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("manages mute state through localStorage", () => {
		expect(isAudioMuted()).toBe(false);
		expect(setAudioMuted(true)).toBe(true);
		expect(isAudioMuted()).toBe(true);
		expect(setAudioMuted(false)).toBe(true);
		expect(isAudioMuted()).toBe(false);
	});

	it("notifies same-tab subscribers only after a successful persisted write", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeAudioMuted(listener);

		expect(setAudioMuted(true)).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();

		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: () => {
				throw new Error("quota denied");
			},
		});
		expect(setAudioMuted(false)).toBe(false);
		expect(isAudioMuted()).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("plays completion chime (440Hz -> 880Hz ascending 120ms sine wave)", async () => {
		setAudioMuted(false);
		await playCompletionChime();

		expect(createdContexts.length).toBeGreaterThan(0);
		const ctx = createdContexts[0];
		expect(ctx.createOscillator).toHaveBeenCalled();
		expect(ctx.createGain).toHaveBeenCalled();
	});

	it("does not play when muted", async () => {
		setAudioMuted(true);
		await playCompletionChime();
		await playAttentionChime();

		expect(createdContexts.length).toBe(0);
	});

	it("plays attention chime when unmuted", async () => {
		setAudioMuted(false);
		await playAttentionChime();

		expect(createdContexts.length).toBeGreaterThan(0);
	});

	it("handles suspended AudioContext gracefully by attempting resume", async () => {
		setAudioMuted(false);
		class SuspendedAudioContext {
			state = "suspended";
			currentTime = 0;
			destination = {};
			createGain = vi.fn(() => ({
				gain: {
					setValueAtTime: vi.fn(),
					linearRampToValueAtTime: vi.fn(),
					exponentialRampToValueAtTime: vi.fn(),
				},
				connect: vi.fn(),
			}));
			createOscillator = vi.fn(() => ({
				frequency: {
					setValueAtTime: vi.fn(),
					linearRampToValueAtTime: vi.fn(),
					exponentialRampToValueAtTime: vi.fn(),
				},
				connect: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
			}));
			resume = vi.fn().mockResolvedValue(undefined);
			close = vi.fn().mockResolvedValue(undefined);
			constructor() {
				createdContexts.push(this);
			}
		}

		vi.stubGlobal("AudioContext", SuspendedAudioContext);
		vi.stubGlobal("window", {
			AudioContext: SuspendedAudioContext,
			localStorage: {
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
				clear: () => storage.clear(),
			},
		});

		await expect(playCompletionChime()).resolves.not.toThrow();
	});

	it("does not throw when AudioContext is undefined (e.g. unsupported browser / SSR)", async () => {
		vi.stubGlobal("window", {});
		setAudioMuted(false);

		await expect(playCompletionChime()).resolves.not.toThrow();
		await expect(playAttentionChime()).resolves.not.toThrow();
	});
});
