import {
	Literal,
	Optional,
	type TSchema,
	Boolean as TypeBoolean,
	Object as TypeObject,
	String as TypeString,
	Unknown,
} from "typebox/type";
import { createRuntimeSchema, createRuntimeSchemaRegistry, type RuntimeSchema } from "./runtime-schema.js";

/** Product-boundary objects are structurally checked before their semantic guards run. */
export type ProductBoundaryRecord = Record<string, unknown>;

function isProductBoundaryRecord(value: unknown): value is ProductBoundaryRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordSchema(id: string, shape: TSchema): RuntimeSchema<ProductBoundaryRecord> {
	return createRuntimeSchema({ id, shape, guard: isProductBoundaryRecord });
}

const FRAME_TYPE = TypeString({ minLength: 1, maxLength: 64 });
const IDENTIFIER = TypeString({ minLength: 1, maxLength: 256 });

export const PRODUCT_BOUNDARY_SHAPES = Object.freeze({
	command: TypeObject(
		{
			type: FRAME_TYPE,
			id: Optional(IDENTIFIER),
		},
		{ additionalProperties: true },
	),
	message: TypeObject(
		{
			role: TypeString({ minLength: 1, maxLength: 64 }),
		},
		{ additionalProperties: true },
	),
	response: TypeObject(
		{
			type: Literal("response"),
			id: Optional(IDENTIFIER),
			command: TypeString({ minLength: 1, maxLength: 64 }),
			success: TypeBoolean(),
			data: Optional(Unknown()),
			error: Optional(TypeString({ maxLength: 1_048_576 })),
			admissionError: Optional(Unknown()),
		},
		{ additionalProperties: false },
	),
	event: TypeObject(
		{
			type: FRAME_TYPE,
		},
		{ additionalProperties: true },
	),
	extensionUiRequest: TypeObject(
		{
			type: Literal("extension_ui_request"),
			id: IDENTIFIER,
			method: FRAME_TYPE,
		},
		{ additionalProperties: true },
	),
	extensionUiResponse: TypeObject(
		{
			type: Literal("extension_ui_response"),
			id: IDENTIFIER,
			value: Optional(Unknown()),
			confirmed: Optional(TypeBoolean()),
			cancelled: Optional(Literal(true)),
		},
		{ additionalProperties: false },
	),
	wsClient: TypeObject(
		{
			type: FRAME_TYPE,
			sessionHandle: IDENTIFIER,
		},
		{ additionalProperties: true },
	),
	wsServer: TypeObject(
		{
			type: FRAME_TYPE,
		},
		{ additionalProperties: true },
	),
	snapshot: TypeObject(
		{
			type: Literal("session_snapshot"),
		},
		{ additionalProperties: true },
	),
	serverHello: TypeObject(
		{
			type: Literal("server_hello"),
		},
		{ additionalProperties: true },
	),
	clientHello: TypeObject(
		{
			type: Literal("client_hello"),
		},
		{ additionalProperties: true },
	),
});

/** Pi-owned envelopes intentionally exclude Gateway-only admission metadata. */
const PI_WIRE_BOUNDARY_SHAPES = Object.freeze({
	response: TypeObject(
		{
			type: Literal("response"),
			id: Optional(IDENTIFIER),
			command: TypeString({ minLength: 1, maxLength: 64 }),
			success: TypeBoolean(),
			data: Optional(Unknown()),
			error: Optional(TypeString({ maxLength: 1_048_576 })),
		},
		{ additionalProperties: false },
	),
	event: TypeObject(
		{
			type: FRAME_TYPE,
		},
		{ additionalProperties: true },
	),
	extensionUiRequest: TypeObject(
		{
			type: Literal("extension_ui_request"),
			id: IDENTIFIER,
			method: FRAME_TYPE,
		},
		{ additionalProperties: true },
	),
});

export const PRODUCT_RUNTIME_SCHEMAS = Object.freeze({
	command: recordSchema("pi-web.command", PRODUCT_BOUNDARY_SHAPES.command),
	message: recordSchema("pi-web.message", PRODUCT_BOUNDARY_SHAPES.message),
	response: recordSchema("pi-web.response", PRODUCT_BOUNDARY_SHAPES.response),
	event: recordSchema("pi-web.event", PRODUCT_BOUNDARY_SHAPES.event),
	extensionUiRequest: recordSchema("pi-web.extension-ui-request", PRODUCT_BOUNDARY_SHAPES.extensionUiRequest),
	extensionUiResponse: recordSchema(
		"pi-web.extension-ui-response",
		PRODUCT_BOUNDARY_SHAPES.extensionUiResponse,
	),
	wsClient: recordSchema("pi-web.ws-client", PRODUCT_BOUNDARY_SHAPES.wsClient),
	wsServer: recordSchema("pi-web.ws-server", PRODUCT_BOUNDARY_SHAPES.wsServer),
	snapshot: recordSchema("pi-web.session-snapshot", PRODUCT_BOUNDARY_SHAPES.snapshot),
	serverHello: recordSchema("pi-web.server-hello", PRODUCT_BOUNDARY_SHAPES.serverHello),
	clientHello: recordSchema("pi-web.client-hello", PRODUCT_BOUNDARY_SHAPES.clientHello),
});

export const PRODUCT_RUNTIME_SCHEMA_REGISTRY = createRuntimeSchemaRegistry(PRODUCT_RUNTIME_SCHEMAS);

/** Generic upstream-frame envelopes. Their nested data remains owned by each adapter. */
export const PI_WIRE_RUNTIME_SCHEMAS = Object.freeze({
	response: recordSchema("pi-wire.response-envelope", PI_WIRE_BOUNDARY_SHAPES.response),
	event: recordSchema("pi-wire.event-envelope", PI_WIRE_BOUNDARY_SHAPES.event),
	extensionUiRequest: recordSchema(
		"pi-wire.extension-ui-request-envelope",
		PI_WIRE_BOUNDARY_SHAPES.extensionUiRequest,
	),
});

export const PI_WIRE_RUNTIME_SCHEMA_REGISTRY = createRuntimeSchemaRegistry(PI_WIRE_RUNTIME_SCHEMAS);
