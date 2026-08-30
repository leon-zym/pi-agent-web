import { Check } from "typebox/schema";
import type { TSchema } from "typebox/type";

export interface RuntimeSchema<T> {
	/** Stable identifier used in diagnostics and compatibility reports. */
	readonly id: string;
	/** JSON Schema-shaped declaration used for structural validation and tooling. */
	readonly shape: TSchema;
	/** Semantic/contextual guard owned by the boundary. */
	readonly guard: (value: unknown) => value is T;
	readonly check: (value: unknown) => value is T;
}

export interface RuntimeSchemaRegistry {
	readonly names: readonly string[];
	get(name: string): RuntimeSchema<unknown> | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function structurallyMatches(shape: TSchema, value: unknown): boolean {
	try {
		if (!isPlainRecord(value)) return false;
		return Check(shape, value);
	} catch {
		return false;
	}
}

/**
 * Combine a declarative structural shape with a boundary-owned semantic guard.
 *
 * TypeBox is deliberately only the shallow structural gate here. The semantic
 * guard remains responsible for contextual identity, UTF-8 accounting, item
 * and depth limits, and any normalization-specific rules. This avoids asking a
 * generic JSON-schema walker to make security decisions it cannot represent.
 */
export function createRuntimeSchema<T>(definition: {
	id: string;
	shape: TSchema;
	guard: (value: unknown) => value is T;
}): RuntimeSchema<T> {
	const check = (value: unknown): value is T => {
		if (!structurallyMatches(definition.shape, value)) return false;
		try {
			return definition.guard(value);
		} catch {
			return false;
		}
	};
	return Object.freeze({
		id: definition.id,
		shape: definition.shape,
		guard: definition.guard,
		check,
	});
}

/** Create an immutable lookup surface without guessing unknown schema names. */
export function createRuntimeSchemaRegistry(
	schemas: Readonly<Record<string, RuntimeSchema<unknown>>>,
): RuntimeSchemaRegistry {
	const entries = Object.freeze({ ...schemas });
	const names = Object.freeze(Object.keys(entries));
	return Object.freeze({
		names,
		get(name: string) {
			return Object.hasOwn(entries, name) ? entries[name] : undefined;
		},
	});
}
