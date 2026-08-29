import { useLayoutEffect, useRef, useState } from "react";
import { hasAnsiControlCharacters, stripAnsi } from "../../lib/format";

export const STREAMING_TEXT_SEGMENT_SIZE = 16 * 1024;

/** Copy a bounded slice so V8 cannot retain the complete accumulated stream as its backing store. */
function copyStreamingText(text: string): string {
	return text.length < 2 ? text : Array.from(text).join("");
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function takeStreamingText(text: string, start: number, maxLength: number): { value: string; end: number } {
	const requestedEnd = Math.min(text.length, start + Math.max(1, maxLength));
	let end = requestedEnd;
	if (
		end < text.length &&
		end > start &&
		isHighSurrogate(text.charCodeAt(end - 1)) &&
		isLowSurrogate(text.charCodeAt(end))
	) {
		end -= 1;
	}
	if (end === start) end = Math.min(text.length, start + 2);
	return { value: copyStreamingText(text.slice(start, end)), end };
}

export function splitStreamingText(text: string, segmentSize = STREAMING_TEXT_SEGMENT_SIZE): string[] {
	const safeSegmentSize = Math.max(1, Math.floor(segmentSize));
	if (text.length === 0) return [];
	const segments: string[] = [];
	for (let offset = 0; offset < text.length; ) {
		const segment = takeStreamingText(text, offset, safeSegmentSize);
		segments.push(segment.value);
		offset = segment.end;
	}
	return segments;
}

export function appendStreamingTextSegments(
	segments: readonly string[],
	appendedText: string,
	segmentSize = STREAMING_TEXT_SEGMENT_SIZE,
): string[] {
	if (appendedText.length === 0) return [...segments];
	const safeSegmentSize = Math.max(1, Math.floor(segmentSize));
	const next = [...segments];
	let offset = 0;
	const lastIndex = next.length - 1;
	const last = next[lastIndex];
	if (last !== undefined && last.length < safeSegmentSize) {
		const available = safeSegmentSize - last.length;
		const addition = takeStreamingText(appendedText, 0, available);
		next[lastIndex] = copyStreamingText(last + addition.value);
		offset = addition.end;
	}
	const joinedLast = next[next.length - 1];
	if (
		offset === 0 &&
		joinedLast !== undefined &&
		isHighSurrogate(joinedLast.charCodeAt(joinedLast.length - 1)) &&
		isLowSurrogate(appendedText.charCodeAt(0))
	) {
		next[next.length - 1] = copyStreamingText(joinedLast + appendedText[0]);
		offset = 1;
	}
	for (; offset < appendedText.length; ) {
		const segment = takeStreamingText(appendedText, offset, safeSegmentSize);
		next.push(segment.value);
		offset = segment.end;
	}
	return next;
}

interface StreamingTextProps {
	text: string;
}

interface TextFingerprint {
	length: number;
	prefix: string;
	suffix: string;
}

const FINGERPRINT_LENGTH = 128;

interface StreamingDisplayState {
	rawLength: number;
	displayText: string;
	hasControls: boolean;
}

/** Avoid rescanning the accumulated raw stream when the append-only suffix has no controls. */
export function useStreamingDisplayText(text: string, streaming: boolean): string {
	const stateRef = useRef<StreamingDisplayState>({ rawLength: 0, displayText: "", hasControls: false });
	const state = stateRef.current;
	if (!streaming) {
		const displayText = stripAnsi(text);
		state.rawLength = text.length;
		state.displayText = displayText;
		state.hasControls = displayText !== text;
		return displayText;
	}

	if (text.length === state.rawLength && !state.hasControls && state.displayText === text) {
		return state.displayText;
	}
	if (text.length > state.rawLength && !state.hasControls) {
		const suffix = text.slice(state.rawLength);
		if (!hasAnsiControlCharacters(suffix)) {
			state.rawLength = text.length;
			state.displayText = text;
			return text;
		}
	}
	const displayText = stripAnsi(text);
	state.rawLength = text.length;
	state.displayText = displayText;
	state.hasControls = hasAnsiControlCharacters(text);
	return displayText;
}

function fingerprint(text: string): TextFingerprint {
	return {
		length: text.length,
		prefix: copyStreamingText(text.slice(0, FINGERPRINT_LENGTH)),
		suffix: copyStreamingText(text.slice(-FINGERPRINT_LENGTH)),
	};
}

function keepsAppendOnlyContract(previous: TextFingerprint, nextText: string): boolean {
	if (nextText.length < previous.length) return false;
	if (!nextText.startsWith(previous.prefix)) return false;
	const previousSuffixStart = Math.max(0, previous.length - previous.suffix.length);
	return nextText.slice(previousSuffixStart, previous.length) === previous.suffix;
}

/**
 * Renders the live assistant tail as stable text segments. The projection
 * contract is append-only while a block is streaming, so each update changes
 * at most one bounded text node and appends new nodes instead of replacing the
 * complete accumulated Markdown string.
 */
export function StreamingText({ text }: StreamingTextProps) {
	const [segments, setSegments] = useState(() => splitStreamingText(text));
	const fingerprintRef = useRef<TextFingerprint>(fingerprint(text));

	useLayoutEffect(() => {
		const previous = fingerprintRef.current;
		const next = fingerprint(text);
		if (next.length === previous.length) {
			setSegments(splitStreamingText(text));
		} else if (keepsAppendOnlyContract(previous, text)) {
			setSegments((current) => appendStreamingTextSegments(current, text.slice(previous.length)));
		} else {
			setSegments(splitStreamingText(text));
		}
		fingerprintRef.current = next;
	}, [text]);

	return (
		<div className="whitespace-pre-wrap">
			{segments.map((segment, index) => (
				<span key={index}>{segment}</span>
			))}
		</div>
	);
}
