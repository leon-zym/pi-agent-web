import { expect, test } from "../fixtures/test";

test("audio chime preference synchronizes across open tabs", async ({ page, harness, context }) => {
	await page.addInitScript(() => localStorage.removeItem("piweb:audio-muted"));
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();
	const peer = await context.newPage();
	await peer.setViewportSize({ width: 1280, height: 900 });
	await peer.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(peer.locator("textarea")).toBeEnabled();

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await peer.getByRole("button", { name: "Settings", exact: true }).click();
	const localAudio = page.getByRole("dialog", { name: "Settings" }).getByRole("switch", {
		name: "Audio chime",
	});
	const peerAudio = peer.getByRole("dialog", { name: "Settings" }).getByRole("switch", {
		name: "Audio chime",
	});
	await expect(localAudio).toBeChecked();
	await expect(peerAudio).toBeChecked();
	await localAudio.click();
	await expect(localAudio).not.toBeChecked();
	await expect(peerAudio).not.toBeChecked();
	await peer.close();
});
