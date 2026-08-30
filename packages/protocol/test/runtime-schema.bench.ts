import { bench, describe } from "vitest";
import { PRODUCT_RUNTIME_SCHEMAS } from "../src/boundary-schemas.js";
import {
	isProductSessionEventDto,
	isSessionCommandResponseDto,
	isSessionWsClientMessage,
} from "../src/index.js";

const command = { type: "get_state", id: "benchmark-command" } as const;
const event = { type: "agent_start" } as const;
const response = {
	type: "response",
	id: "benchmark-response",
	command: "get_state",
	success: true,
	data: {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "benchmark-session",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	},
} as const;
const clientFrame = {
	type: "command",
	sessionHandle: "benchmark-session-handle",
	expectedGeneration: 1,
	command,
} as const;

function assertValid(value: boolean): void {
	if (!value) throw new Error("benchmark fixture was rejected");
}

describe("schema-backed boundary performance", () => {
	bench("product command schema gate", () => {
		assertValid(PRODUCT_RUNTIME_SCHEMAS.command.check(command));
	});

	bench("product event decoder", () => {
		assertValid(isProductSessionEventDto(event));
	});

	bench("product response decoder", () => {
		assertValid(isSessionCommandResponseDto(response));
	});

	bench("multiplexed client frame decoder", () => {
		assertValid(isSessionWsClientMessage(clientFrame));
	});
});
