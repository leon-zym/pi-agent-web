import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDir, "../../..");
const artifactRoot = process.env.PI_WEB_BENCHMARK_ARTIFACT_DIR;
if (!artifactRoot || !path.isAbsolute(artifactRoot)) {
	throw new Error("PI_WEB_BENCHMARK_ARTIFACT_DIR must be an absolute path");
}

export default defineConfig({
	testDir: configDir,
	testMatch: "*.spec.ts",
	outputDir: path.join(artifactRoot, "playwright"),
	fullyParallel: false,
	forbidOnly: true,
	retries: 0,
	workers: 1,
	reporter: [["line"]],
	timeout: process.env.PI_WEB_BENCHMARK_TIER === "stress" ? 20 * 60_000 : 4 * 60_000,
	expect: { timeout: 30_000 },
	use: {
		...devices["Desktop Chrome"],
		launchOptions: {
			args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
		},
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	metadata: { repositoryRoot },
});
