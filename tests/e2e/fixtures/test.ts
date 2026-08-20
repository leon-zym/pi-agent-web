import { test as base, expect } from "@playwright/test";
import { type ProductionHarness, startProductionHarness } from "./production-harness";

interface BrowserFixtures {
	harness: ProductionHarness;
}

export const test = base.extend<BrowserFixtures>({
	harness: async ({ browserName: _browserName }, use, testInfo) => {
		const harness = await startProductionHarness();
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
