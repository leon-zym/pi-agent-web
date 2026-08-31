import { type ReactNode, StrictMode } from "react";
import type { Root } from "react-dom/client";

/**
 * This root exists only in a Vite benchmark build. The normal production entry never imports the
 * module, so benchmark-only build composition does not enter the standard bundle.
 */
export function renderBenchmarkRoot(root: Root, children: ReactNode): void {
	root.render(<StrictMode>{children}</StrictMode>);
}
