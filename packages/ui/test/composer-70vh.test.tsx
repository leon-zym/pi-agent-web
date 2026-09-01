import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeHarness = vi.hoisted(() => ({
	transport: {
		sessions: {
			"session-a": {
				subscribed: true,
				baselineAuthoritative: true,
				generation: 1,
				lease: { isController: true, fencingToken: "tok-1" },
				runtime: {
					serverEpoch: "epoch-a",
					workspaceId: "workspace-a",
					sessionHandle: "session-a",
					generation: 1,
					state: "running",
				},
				freshLeaseBaseline: {
					serverEpoch: "epoch-a",
					workspaceId: "workspace-a",
					sessionHandle: "session-a",
					generation: 1,
				},
			},
		},
	},
	directory: {
		currentWorkspaceHandle: "workspace-a",
		currentSession: { sessionHandle: "session-a" },
		sessionCreation: null,
	},
	projection: {
		currentSessionId: "session-a",
		projections: {},
	},
	composer: {
		draft: "my long text",
		images: [],
		trigger: null,
		command: null,
		submitState: "plain" as const,
		activeSubmitId: null,
		attachmentWorkCount: 0,
		fileReferences: [],
		attachmentWorkIds: [],
		deliveryMode: "steer" as const,
		queue: { steering: [], followUp: [] },
		recentQueued: [],
		isExpanded: false,
		bySession: {} as Record<string, unknown>,
		activeSessionHandle: "session-a",
		setDraft: vi.fn(),
		setImages: vi.fn(),
		setTrigger: vi.fn(),
		setCommand: vi.fn(),
		setDeliveryMode: vi.fn(),
		setIsExpanded: vi.fn(),
	},
	commands: {
		commands: [],
	},
}));

vi.mock("../src/stores/session-transport", () => ({
	useSessionTransportStore: (selector: (state: typeof storeHarness.transport) => unknown) =>
		selector(storeHarness.transport),
}));

vi.mock("../src/stores/session-directory", () => ({
	useSessionDirectoryStore: Object.assign(
		(selector: (state: typeof storeHarness.directory) => unknown) => selector(storeHarness.directory),
		{ getState: () => storeHarness.directory },
	),
	reconcileHiddenSessionLifecycle: vi.fn(),
	installSessionDirectoryLifecycleCoordinator: vi.fn(),
}));

vi.mock("../src/stores/projection", () => ({
	useProjectionStore: (selector: (state: typeof storeHarness.projection) => unknown) =>
		selector(storeHarness.projection),
	selectActiveTurnId: () => "turn-1",
}));

vi.mock("../src/stores/composer", () => ({
	useComposerStore: Object.assign(
		(selector?: (state: typeof storeHarness.composer) => unknown) =>
			selector ? selector(storeHarness.composer) : storeHarness.composer,
		{
			getState: () => storeHarness.composer,
			setState: (update: Partial<typeof storeHarness.composer>) => {
				Object.assign(storeHarness.composer, update);
			},
		},
	),
	serializeComposerMessage: (_command: unknown, draft: string) => draft,
}));

vi.mock("../src/stores/slash-commands", () => ({
	useSlashCommandsStore: (selector: (state: typeof storeHarness.commands) => unknown) =>
		selector(storeHarness.commands),
}));

import { ComposerSeat } from "../src/features/composer/ComposerSeat";

describe("ComposerSeat 70vh immersive mode", () => {
	beforeEach(() => {
		storeHarness.composer.isExpanded = false;
		storeHarness.composer.deliveryMode = "steer";
		storeHarness.composer.draft = "my long text";
	});

	it("renders expand toggle button with Maximize2 icon when collapsed", () => {
		storeHarness.composer.isExpanded = false;
		const html = renderToStaticMarkup(createElement(ComposerSeat));

		expect(html).toContain('data-testid="composer-expand-toggle"');
		expect(html).not.toContain("h-[70vh]");
	});

	it("renders 70vh container styling and Minimize2 icon when expanded", () => {
		storeHarness.composer.isExpanded = true;
		const html = renderToStaticMarkup(createElement(ComposerSeat));

		expect(html).toContain('data-testid="composer-expand-toggle"');
		expect(html).toContain("h-[70vh]");
	});

	it("renders segmented delivery mode selector in 70vh running mode", () => {
		storeHarness.composer.isExpanded = true;
		const html = renderToStaticMarkup(createElement(ComposerSeat));

		expect(html).toContain('data-testid="composer-segmented-delivery-mode"');
		expect(html).toMatch(/插队|Steer/);
		expect(html).toMatch(/排队|Follow-up/);
	});
});
