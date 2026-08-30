import { Literal, Object as TypeObject, String as TypeString } from "typebox/type";
import { describe, expect, it, vi } from "vitest";
import {
	PI_WIRE_RUNTIME_SCHEMA_REGISTRY,
	PRODUCT_BOUNDARY_SHAPES,
	PRODUCT_RUNTIME_SCHEMA_REGISTRY,
	PRODUCT_RUNTIME_SCHEMAS,
} from "../src/boundary-schemas.js";
import { createRuntimeSchema, createRuntimeSchemaRegistry } from "../src/runtime-schema.js";

interface TestFrame {
	type: "test";
	value: string;
}

const testFrameSchema = createRuntimeSchema<TestFrame>({
	id: "test.frame",
	shape: TypeObject(
		{
			type: Literal("test"),
			value: TypeString({ minLength: 1, maxLength: 8 }),
		},
		{ additionalProperties: false },
	),
	guard: (value): value is TestFrame => {
		return (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			(value as { type?: unknown }).type === "test" &&
			typeof (value as { value?: unknown }).value === "string"
		);
	},
});

describe("runtime schema boundary", () => {
	it("runs the semantic guard only after structural admission", () => {
		const guard = vi.fn((value: unknown): value is TestFrame => {
			return testFrameSchema.guard(value);
		});
		const schema = createRuntimeSchema<TestFrame>({
			id: "test.guarded",
			shape: TypeObject({ type: Literal("test"), value: TypeString() }, { additionalProperties: true }),
			guard: (value): value is TestFrame => guard(value),
		});

		expect(schema.check({ type: "other", value: "ok" })).toBe(false);
		expect(guard).not.toHaveBeenCalled();
		expect(schema.check({ type: "test", value: "ok" })).toBe(true);
		expect(guard).toHaveBeenCalledTimes(1);
	});

	it("fails closed for non-plain objects and validator exceptions", () => {
		expect(testFrameSchema.check(new Date())).toBe(false);
		const throwingProxy = new Proxy(
			{ type: "test", value: "ok" },
			{
				getPrototypeOf: () => {
					throw new Error("untrusted proxy");
				},
			},
		);
		expect(testFrameSchema.check(throwingProxy)).toBe(false);
		const schema = createRuntimeSchema<TestFrame>({
			id: "test.throwing",
			shape: TypeObject({ type: Literal("test") }, { additionalProperties: true }),
			guard: (_value): _value is TestFrame => {
				throw new Error("must stay private");
			},
		});
		expect(schema.check({ type: "test" })).toBe(false);
	});

	it("freezes a named registry and returns unknown names without guessing", () => {
		const registry = createRuntimeSchemaRegistry({ frame: testFrameSchema });
		expect(Object.isFrozen(registry)).toBe(true);
		expect(registry.get("frame")).toBe(testFrameSchema);
		expect(registry.get("missing")).toBeUndefined();
		expect(registry.get("__proto__")).toBeUndefined();
		expect(registry.get("constructor")).toBeUndefined();
		expect(registry.names).toEqual(["frame"]);
	});

	it("keeps product and Pi-wire envelope registries separate", () => {
		expect(PRODUCT_RUNTIME_SCHEMA_REGISTRY.names).toEqual([
			"command",
			"message",
			"response",
			"event",
			"extensionUiRequest",
			"extensionUiResponse",
			"wsClient",
			"wsServer",
			"snapshot",
			"serverHello",
			"clientHello",
		]);
		expect(PI_WIRE_RUNTIME_SCHEMA_REGISTRY.names).toEqual(["response", "event", "extensionUiRequest"]);
		expect(
			PRODUCT_RUNTIME_SCHEMAS.response.check({
				type: "response",
				command: "get_state",
				success: true,
				unexpected: true,
			}),
		).toBe(false);
		expect(
			PI_WIRE_RUNTIME_SCHEMA_REGISTRY.get("response")?.check({
				type: "response",
				command: "get_state",
				success: true,
				unexpected: true,
			}),
		).toBe(false);
		expect(
			PI_WIRE_RUNTIME_SCHEMA_REGISTRY.get("response")?.check({
				type: "response",
				command: "get_state",
				success: false,
				error: "failed",
				admissionError: { code: "gateway_only" },
			}),
		).toBe(false);
		expect(PI_WIRE_RUNTIME_SCHEMA_REGISTRY.get("response")?.shape).not.toBe(
			PRODUCT_RUNTIME_SCHEMAS.response.shape,
		);
		expect(PRODUCT_BOUNDARY_SHAPES.event).toMatchObject({ type: "object" });
	});
});
