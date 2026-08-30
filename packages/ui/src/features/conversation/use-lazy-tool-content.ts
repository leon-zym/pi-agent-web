import type {
	SessionJsonValueDto,
	SessionRuntimeDto,
	SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import { useEffect, useState } from "react";
import { tt } from "../../lib/i18n";
import type {
	SessionJsonRootProjection,
	SessionTextPayloadProjection,
} from "../../lib/session-content-adapter";
import { sessionTransport } from "../../stores/session-transport";
import type { SessionTransportController } from "../../stores/session-transport-contract";
import type { ContentBlock, UiToolResult } from "../../types/view-models";

export type ToolCallBlock = Extract<ContentBlock, { type: "tool_call" }>;

/** Transport-owned lazy content methods, kept narrow for injected test facades. */
export type ContentTransportFacade = Pick<SessionTransportController, "resolveText" | "resolveJson">;

export interface LazyToolContentMaterializationInput {
	identity: SessionRuntimeIdentityDto | null;
	block: ToolCallBlock;
	results: readonly UiToolResult[];
	transport?: ContentTransportFacade;
	signal: AbortSignal;
	/** Abort all sibling roots when one root fails. */
	abortSiblings?: () => void;
}

export interface MaterializedToolContent {
	block: ToolCallBlock;
	results: UiToolResult[];
}

export type LazyToolContentState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; block: ToolCallBlock; results: UiToolResult[] }
	| { status: "error"; error: unknown };

/** Construct the only identity shape that a content consumer may retain. */
export function createSessionRuntimeIdentity(
	runtime:
		| Pick<SessionRuntimeDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">
		| null
		| undefined,
	sessionHandle: string | null | undefined,
): SessionRuntimeIdentityDto | null {
	if (!runtime || !sessionHandle || runtime.sessionHandle !== sessionHandle) return null;
	return Object.freeze({
		serverEpoch: runtime.serverEpoch,
		workspaceId: runtime.workspaceId,
		sessionHandle: runtime.sessionHandle,
		generation: runtime.generation,
	});
}

function isJsonValue(value: unknown): value is SessionJsonValueDto {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return true;
	}
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	return Object.values(value).every(isJsonValue);
}

function cloneJsonValue(value: SessionJsonValueDto): SessionJsonValueDto {
	if (Array.isArray(value)) return value.map(cloneJsonValue);
	if (value !== null && typeof value === "object") {
		const clone: { [key: string]: SessionJsonValueDto } = {};
		for (const [key, child] of Object.entries(value)) clone[key] = cloneJsonValue(child);
		return clone;
	}
	return value;
}

function isJsonRecord(value: SessionJsonValueDto): value is { [key: string]: SessionJsonValueDto } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValueToToolOutput(value: SessionJsonValueDto | undefined): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (isJsonRecord(value)) {
		for (const key of ["output", "partial", "text"]) {
			const candidate = value[key];
			if (typeof candidate === "string") return candidate;
		}
		const content = value.content;
		if (Array.isArray(content)) {
			const textParts: string[] = [];
			for (const item of content) {
				if (!isJsonRecord(item)) continue;
				if (item.type === "text" && typeof item.text === "string") textParts.push(item.text);
			}
			if (textParts.length > 0) return textParts.join("\n");
		}
	}
	return JSON.stringify(value) ?? "";
}

function abortError(): DOMException {
	return new DOMException("Lazy tool content materialization was aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function defaultContentTransport(): ContentTransportFacade {
	return sessionTransport;
}

function resolveTransport(transport: ContentTransportFacade | undefined): ContentTransportFacade {
	return transport ?? defaultContentTransport();
}

async function materializeTextProjection(
	projection: SessionTextPayloadProjection,
	identity: SessionRuntimeIdentityDto | null,
	transport: ContentTransportFacade | undefined,
	signal: AbortSignal,
): Promise<string> {
	assertNotAborted(signal);
	if (projection.kind === "inline") return projection.value;
	if (!identity) throw new Error(tt("tool.executionError"));
	const materialized = await resolveTransport(transport).resolveText(identity, projection, signal);
	assertNotAborted(signal);
	if (typeof materialized !== "string") throw new Error(tt("tool.executionError"));
	return materialized;
}

async function materializeJsonProjection(
	projection: SessionJsonRootProjection,
	identity: SessionRuntimeIdentityDto | null,
	transport: ContentTransportFacade | undefined,
	signal: AbortSignal,
): Promise<SessionJsonValueDto> {
	assertNotAborted(signal);
	if (projection.kind === "inline") return cloneJsonValue(projection.value);
	if (!identity) throw new Error(tt("tool.executionError"));
	const materialized = await resolveTransport(transport).resolveJson(
		identity,
		projection,
		isJsonValue,
		signal,
	);
	assertNotAborted(signal);
	if (!isJsonValue(materialized)) throw new Error(tt("tool.executionError"));
	return cloneJsonValue(materialized);
}

async function materializeTextSequence(
	payloads: readonly SessionTextPayloadProjection[],
	identity: SessionRuntimeIdentityDto | null,
	transport: ContentTransportFacade | undefined,
	signal: AbortSignal,
): Promise<string> {
	const text: string[] = [];
	for (const payload of payloads) {
		text.push(await materializeTextProjection(payload, identity, transport, signal));
	}
	return text.join("\n");
}

function abortOnFailure<T>(promise: Promise<T>, abortSiblings: () => void): Promise<T> {
	return promise.catch((error: unknown) => {
		abortSiblings();
		throw error;
	});
}

async function materializeToolResult(
	result: UiToolResult,
	identity: SessionRuntimeIdentityDto | null,
	transport: ContentTransportFacade | undefined,
	signal: AbortSignal,
	abortSiblings: () => void,
): Promise<UiToolResult> {
	const contentPromise = result.textPayloads
		? materializeTextSequence(result.textPayloads, identity, transport, signal)
		: Promise.resolve(undefined);
	const detailsPromise = result.detailsPayload
		? materializeJsonProjection(result.detailsPayload, identity, transport, signal)
		: Promise.resolve(undefined);
	const [content, details] = await Promise.all([
		abortOnFailure(contentPromise, abortSiblings),
		abortOnFailure(detailsPromise, abortSiblings),
	]);
	return {
		...result,
		...(result.textPayloads ? { content: content ?? "" } : {}),
		...(result.detailsPayload ? { details } : {}),
	};
}

/** Materialize one expanded tool consumer without mutating projection state. */
export async function materializeLazyToolContent(
	input: LazyToolContentMaterializationInput,
): Promise<MaterializedToolContent> {
	const { identity, block, results, transport, signal } = input;
	const abortSiblings = input.abortSiblings ?? (() => undefined);
	const argsPromise = block.argsPayload
		? materializeJsonProjection(block.argsPayload, identity, transport, signal)
		: Promise.resolve(undefined);
	const partialPromise = block.partialResultPayload
		? materializeJsonProjection(block.partialResultPayload, identity, transport, signal)
		: Promise.resolve(undefined);
	const resultPromise = block.resultPayload
		? materializeJsonProjection(block.resultPayload, identity, transport, signal)
		: Promise.resolve(undefined);

	const [args, partial, result, materializedResults] = await Promise.all([
		abortOnFailure(argsPromise, abortSiblings),
		abortOnFailure(partialPromise, abortSiblings),
		abortOnFailure(resultPromise, abortSiblings),
		abortOnFailure(
			Promise.all(
				results.map((entry) => materializeToolResult(entry, identity, transport, signal, abortSiblings)),
			),
			abortSiblings,
		),
	]);

	assertNotAborted(signal);
	const materializedBlock: ToolCallBlock = {
		...block,
		...(block.argsPayload ? { args } : {}),
		...(block.partialResultPayload ? { partialOutput: jsonValueToToolOutput(partial) } : {}),
		...(block.resultPayload
			? {
					result,
					partialOutput: jsonValueToToolOutput(result),
				}
			: {}),
	};
	return { block: materializedBlock, results: materializedResults };
}

export function useLazyToolContent({
	enabled,
	identity,
	block,
	results,
	transport,
}: {
	enabled: boolean;
	identity: SessionRuntimeIdentityDto | null;
	block: ToolCallBlock;
	results: readonly UiToolResult[];
	transport?: ContentTransportFacade;
}): LazyToolContentState {
	const [state, setState] = useState<LazyToolContentState>({ status: "idle" });

	useEffect(() => {
		if (!enabled) {
			setState({ status: "idle" });
			return;
		}

		const controller = new AbortController();
		const capturedIdentity = identity;
		let active = true;
		setState({ status: "loading" });
		void materializeLazyToolContent({
			identity: capturedIdentity,
			block,
			results,
			transport,
			signal: controller.signal,
			abortSiblings: () => controller.abort(),
		}).then(
			(materialized) => {
				if (!active || controller.signal.aborted || capturedIdentity !== identity) return;
				setState({ status: "ready", ...materialized });
			},
			(error: unknown) => {
				if (!active || controller.signal.aborted || capturedIdentity !== identity) return;
				setState({ status: "error", error });
			},
		);

		return () => {
			active = false;
			controller.abort();
		};
	}, [enabled, identity, block, results, transport]);

	return state;
}
