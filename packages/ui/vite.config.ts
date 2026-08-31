import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// Dev: vite serves the SPA on 5173 and proxies REST + WS to the gateway on 3000.
export const DEV_GATEWAY_ORIGIN = "http://127.0.0.1:3000";
const benchmarkBuild = process.env.VITE_PI_WEB_BENCHMARK_BUILD === "1";

function buildOutputDirectory(): string {
	if (!benchmarkBuild) return "dist";
	const outputDirectory = process.env.PI_WEB_BENCHMARK_UI_OUT_DIR;
	if (!outputDirectory || !path.isAbsolute(outputDirectory)) {
		throw new Error("A benchmark UI build requires an absolute PI_WEB_BENCHMARK_UI_OUT_DIR");
	}
	return outputDirectory;
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function normalizedLoopbackOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname) || parsed.origin !== value) {
			return undefined;
		}
		return parsed.origin;
	} catch {
		return undefined;
	}
}

function requestLoopbackOrigin(host: string | undefined): string | undefined {
	if (!host) return undefined;
	try {
		const parsed = new URL(`http://${host}`);
		if (
			parsed.username ||
			parsed.password ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash ||
			!isLoopbackHost(parsed.hostname)
		) {
			return undefined;
		}
		return parsed.origin;
	} catch {
		return undefined;
	}
}

const rejectCrossOriginProxyRequest: NonNullable<ProxyOptions["bypass"]> = (request, _response) => {
	const targetOrigin = requestLoopbackOrigin(request.headers.host);
	const rawOrigin = request.headers.origin;
	const allowed = rawOrigin
		? targetOrigin !== undefined && normalizedLoopbackOrigin(rawOrigin) === targetOrigin
		: request.headers["sec-fetch-site"] === "same-origin" && targetOrigin !== undefined;
	return allowed ? undefined : false;
};

export function createGatewayProxy(gatewayOrigin: string): Record<string, ProxyOptions> {
	return {
		"/api/v1/ws": {
			bypass: rejectCrossOriginProxyRequest,
			target: gatewayOrigin.replace("http:", "ws:"),
			changeOrigin: true,
			headers: { Origin: gatewayOrigin },
			ws: true,
		},
		"/api": {
			bypass: rejectCrossOriginProxyRequest,
			target: gatewayOrigin,
			changeOrigin: true,
			headers: { Origin: gatewayOrigin },
		},
	};
}

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: benchmarkBuild ? { "react-dom/client": "react-dom/profiling" } : {},
	},
	server: {
		port: 5173,
		proxy: createGatewayProxy(DEV_GATEWAY_ORIGIN),
	},
	build: {
		outDir: buildOutputDirectory(),
		sourcemap: true,
		chunkSizeWarningLimit: 900,
	},
});
