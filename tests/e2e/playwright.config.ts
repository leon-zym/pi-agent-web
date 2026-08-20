import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDir, "../..");

export default defineConfig({
	testDir: path.join(configDir, "specs"),
	outputDir: path.join(repositoryRoot, "test-results", "browser-e2e"),
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
	timeout: 45_000,
	expect: {
		timeout: 10_000,
	},
	use: {
		...devices["Desktop Chrome"],
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
