import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/index.css";

const root = createRoot(document.getElementById("root")!);

if (import.meta.env.VITE_PI_WEB_BENCHMARK_BUILD === "1") {
	void import("./lib/benchmark-browser").then(({ renderBenchmarkRoot }) => {
		renderBenchmarkRoot(root, <App />);
	});
} else {
	root.render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
