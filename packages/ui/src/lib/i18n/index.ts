import { create } from "zustand";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type Locale = "zh-CN" | "en";
export type Dictionary = typeof zhCN;

interface I18nState {
	locale: Locale;
	t: Dictionary;
	setLocale: (locale: Locale) => void;
}

const STORAGE_KEY = "pi-web-locale";

function readStored(): Locale {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (value === "zh-CN" || value === "en") return value;
		// First visit: follow the browser language; zh-CN is the fallback.
		const lang = navigator.language.toLowerCase();
		if (lang.startsWith("zh")) return "zh-CN";
		if (lang.startsWith("en")) return "en";
	} catch {
		// SSR / storage unavailable
	}
	return "zh-CN";
}

export const useI18n = create<I18nState>()((set) => {
	const locale = readStored();
	return {
		locale,
		t: locale === "en" ? en : zhCN,
		setLocale: (next) => {
			try {
				localStorage.setItem(STORAGE_KEY, next);
			} catch {
				// ignore
			}
			set({ locale: next, t: next === "en" ? en : zhCN });
		},
	};
});

/** Convenience hook: the dictionary plus the current locale. */
export function useT() {
	const t = useI18n((s) => s.t);
	const locale = useI18n((s) => s.locale);
	return { t, locale };
}

export type I18nArgs = Record<string, string | number>;

/** Interpolate {key} placeholders in a dictionary message. */
export function interpolate(message: string, args?: I18nArgs): string {
	if (!args) return message;
	return message.replace(/\{(\w+)\}/g, (match, key: string) => {
		const value = args[key];
		return value === undefined ? match : String(value);
	});
}

/**
 * Translate outside of React (stores, controllers, plain modules).
 * Uses the current locale at call time.
 */
export function tt(id: keyof Dictionary, args?: I18nArgs): string {
	const { t } = useI18n.getState();
	return interpolate(t[id], args);
}

/** Localized relative time (zh-CN vs en). */
export function formatRelativeTimeLocal(timestampMs: number, now = Date.now(), locale?: Locale): string {
	const current = locale ?? useI18n.getState().locale;
	const delta = now - timestampMs;
	const minutes = Math.floor(delta / 60_000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	const date = new Date(timestampMs);
	const nowDate = new Date(now);

	if (current === "en") {
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		if (date.getFullYear() === nowDate.getFullYear()) {
			return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
		}
		return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
	}

	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	if (hours < 24) return `${hours} 小时前`;
	if (days < 7) return `${days} 天前`;
	if (date.getFullYear() === nowDate.getFullYear()) {
		return `${date.getMonth() + 1}月${date.getDate()}日`;
	}
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
