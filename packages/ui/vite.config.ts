import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: vite serves the SPA on 5173 and proxies REST + WS to the gateway on 3000.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			"/api/v1/ws": {
				target: "ws://127.0.0.1:3000",
				ws: true,
			},
			"/api": {
				target: "http://127.0.0.1:3000",
				changeOrigin: true,
			},
		},
	},
	build: {
		outDir: "dist",
		sourcemap: true,
		chunkSizeWarningLimit: 900,
	},
});
