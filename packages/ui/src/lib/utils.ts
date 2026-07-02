import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind class merge helper (shadcn convention). */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
