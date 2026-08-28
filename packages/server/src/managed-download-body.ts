import { Readable } from "node:stream";

export interface ManagedDownloadBodyOptions {
	stream: Readable;
	release: () => Promise<void>;
	failureMessage: string;
}

/**
 * Bridges an owned Node stream into a Web response body. The release promise is
 * memoized so EOF, failure, cancellation, and the store's own stream fence can
 * safely converge on the same idempotent pin release.
 */
export function managedDownloadBody(options: ManagedDownloadBodyOptions): ReadableStream<Uint8Array> {
	const reader = Readable.toWeb(options.stream).getReader();
	let settled = false;
	let releasePromise: Promise<void> | undefined;
	const releaseOnce = (): Promise<void> => {
		releasePromise ??= options.release();
		return releasePromise;
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (settled) return;
			try {
				const next = await reader.read();
				if (!next.done) {
					controller.enqueue(next.value);
					return;
				}
				settled = true;
				await releaseOnce();
				controller.close();
			} catch {
				settled = true;
				await releaseOnce().catch(() => undefined);
				controller.error(new Error(options.failureMessage));
			}
		},
		async cancel(reason) {
			if (!settled) {
				settled = true;
				await reader.cancel(reason).catch(() => undefined);
			}
			await releaseOnce();
		},
	});
}
