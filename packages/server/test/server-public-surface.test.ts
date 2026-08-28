import { expect, expectTypeOf, it } from "vitest";
import * as server from "../src/index.js";
import {
	type CreateSessionRequest,
	type HotRuntimeSubscriptionResult,
	type HotRuntimeSubscriptionToken,
	type SessionCommandContext,
	type SessionHotRuntimeObservation,
	type SessionIdentityTransitionCommit,
	type SessionManagementContext,
	SessionRuntime,
	type SessionRuntimeOptions,
	type SessionRuntimePiPayloadServices,
	SessionSupervisor,
	type SessionSupervisorOptions,
} from "../src/index.js";

it("keeps Runtime and Supervisor internals off the public server barrel", () => {
	expect(server.SessionRuntime).toBe(SessionRuntime);
	expect(server.SessionSupervisor).toBe(SessionSupervisor);
	for (const internal of [
		"SessionRuntimeCore",
		"createFutureSessionRuntime",
		"createFutureSessionSupervisor",
		"createCurrentSessionRuntimePiPayloadServices",
		"createFutureSessionRuntimePiPayloadServices",
	]) {
		expect(server).not.toHaveProperty(internal);
	}

	expectTypeOf<SessionIdentityTransitionCommit>().toBeObject();
	expectTypeOf<SessionHotRuntimeObservation>().toBeObject();
	expectTypeOf<SessionRuntimeOptions>().toBeObject();
	expectTypeOf<SessionRuntimePiPayloadServices>().toBeObject();
	expectTypeOf<SessionCommandContext>().toBeObject();
	expectTypeOf<SessionManagementContext>().toBeObject();
	expectTypeOf<CreateSessionRequest>().toBeObject();
	expectTypeOf<HotRuntimeSubscriptionToken>().toBeObject();
	expectTypeOf<HotRuntimeSubscriptionResult>().toBeObject();
	expectTypeOf<SessionSupervisorOptions>().toBeObject();
});
