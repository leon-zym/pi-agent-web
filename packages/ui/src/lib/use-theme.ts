import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "pi-web-theme";

function readStored(): ThemePreference {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (value === "light" || value === "dark" || value === "system") return value;
	} catch {
		// localStorage unavailable
	}
	return "system";
}

function systemPrefersDark(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Theme preference with class-based dark mode. The resolved value drives the
 * .dark class on <html>; "system" tracks the OS preference live.
 */
export function useTheme() {
	const [preference, setPreference] = useState<ThemePreference>(() => readStored());
	const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

	const resolved: "light" | "dark" = preference === "system" ? (systemDark ? "dark" : "light") : preference;

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	useEffect(() => {
		const root = document.documentElement;
		root.classList.toggle("dark", resolved === "dark");
	}, [resolved]);

	const set = useCallback((next: ThemePreference) => {
		setPreference(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// ignore
		}
	}, []);

	return { preference, resolved, set };
}
