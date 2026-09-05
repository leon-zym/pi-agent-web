import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8");

describe("AppShell status placement", () => {
	it("keeps SessionLiveAnnouncements inside the AppShell root", () => {
		expect(appSource).not.toContain("SessionLiveAnnouncements");
		expect(appShellSource).toContain(
			'import { SessionLiveAnnouncements } from "../features/session-status/SessionLiveAnnouncements";',
		);
		expect(appShellSource).toMatch(/\n\t\t\t<SessionLiveAnnouncements \/>\n\t\t<\/div>\n\t\);\n\}\s*$/u);
	});
});
