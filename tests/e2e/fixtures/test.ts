import { test as base, expect } from "@playwright/test";
import {
	type ProductionHarness,
	type StartHarnessOptions,
	startProductionHarness,
} from "./production-harness";

interface BrowserFixtures {
	harness: ProductionHarness;
	harnessOptions: StartHarnessOptions;
}

export const test = base.extend<BrowserFixtures>({
	harnessOptions: [{}, { option: true }],
	harness: async ({ browserName: _browserName, harnessOptions }, use, testInfo) => {
		const harness = await startProductionHarness(harnessOptions);
		try {
			await use(harness);
		} finally {
			if (testInfo.status !== testInfo.expectedStatus) {
				await testInfo.attach("pi-web-server.log", {
					body: Buffer.from(harness.logs(), "utf8"),
					contentType: "text/plain",
				});
			}
			await harness.stop();
		}
	},
});

export { expect };
