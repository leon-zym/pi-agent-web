import type { Page } from "@playwright/test";
import type {
	RecoveryEvidence,
	RecoverySample,
} from "../../../packages/ui/src/lib/benchmark-recovery-recorder";

interface RecoveryApi {
	start(trial: number, handle: string): void;
	record(trial: number, kind: RecoverySample["kind"], socket: number, seq: number): void;
	end(trial: number): void;
	read(): RecoveryEvidence;
	fail(): void;
}
type EvidenceWindow = Window &
	typeof globalThis & {
		__piwebBenchmarkRecovery: RecoveryApi;
		__piwebRecoveryGate: {
			arm(trial: number, handle: string, epoch: string, generation: number, workspaceId: string): void;
			release(): void;
			finish(): RecoveryEvidence;
		};
	};

/** Control only callback delivery. Native receipt remains visible before the gate closes the socket. */
export async function installRecoveryGate(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const win = window as EvidenceWindow;
		const NativeSocket = window.WebSocket;
		let nextSocket = 0;
		let active: {
			trial: number;
			handle: string;
			epoch: string;
			generation: number;
			workspaceId: string;
		} | null = null;
		let gateSocket = 0;
		let heldSocket = 0;
		let released = false;
		const sockets: Array<{ id: number; socket: WebSocket }> = [];
		let pending: Array<() => void> = [];
		const api = () => win.__piwebBenchmarkRecovery;
		const record = (kind: RecoverySample["kind"], socket: number, seq: number) => {
			if (active) api().record(active.trial, kind, socket, seq);
		};
		Object.defineProperty(window, "WebSocket", {
			configurable: true,
			writable: true,
			value: new Proxy(NativeSocket, {
				construct(target, args) {
					const socket = Reflect.construct(target, args) as WebSocket;
					const id = ++nextSocket;
					sockets.push({ id, socket });
					let blockedTrial: number | null = null;
					let callback: ((event: MessageEvent) => void) | null = null;
					Object.defineProperty(socket, "onmessage", {
						configurable: true,
						get: () => callback,
						set: (value) => {
							callback = value;
						},
					});
					const send = socket.send.bind(socket);
					socket.send = (data) => {
						if (active && typeof data === "string") {
							const message = JSON.parse(data);
							if (message.type === "session_subscribe" && message.sessionHandle === active.handle) {
								if (
									message.cursor?.serverEpoch !== active.epoch ||
									message.cursor?.generation !== active.generation
								)
									api().fail();
								record("subscribe", id, message.cursor?.seq ?? -1);
							}
						}
						send(data);
					};
					socket.addEventListener("close", () => {
						if (active) record("close", id, 0);
					});
					socket.addEventListener("message", (event) => {
						const message = JSON.parse(String(event.data));
						if (blockedTrial !== null && blockedTrial !== active?.trial) {
							api().fail();
							return;
						}
						const targeted = active && message.sessionHandle === active.handle;
						const sequenced = targeted && Number.isSafeInteger(message.seq);
						if (sequenced) {
							if (
								message.serverEpoch !== active?.epoch ||
								message.generation !== active?.generation ||
								message.workspaceId !== active?.workspaceId
							)
								api().fail();
							record("wire", id, message.seq);
						}
						if (active && id === gateSocket) return;
						if (targeted && gateSocket === 0 && message.event?.assistantMessageEvent?.type === "text_delta") {
							gateSocket = id;
							blockedTrial = active!.trial;
							record("gate", id, message.seq);
							socket.close(4100, "benchmark callback gate");
							return;
						}
						const capturedTrial = active?.trial;
						const deliver = () => {
							if (capturedTrial !== undefined && capturedTrial !== active?.trial) {
								api().fail();
								return;
							}
							if (sequenced) record("forward", id, message.seq);
							callback?.call(socket, event);
						};
						if (
							targeted &&
							!released &&
							message.event?.type === "message_end" &&
							message.event.message?.role === "assistant"
						) {
							heldSocket = id;
							record("hold", id, message.seq);
						}
						if (active && heldSocket === id && !released) {
							if (pending.length >= 64) {
								api().fail();
								return;
							}
							pending.push(deliver);
						} else deliver();
					});
					return socket;
				},
			}),
		});
		win.__piwebRecoveryGate = {
			arm(trial, handle, epoch, generation, workspaceId) {
				if (active || pending.length) {
					api().fail();
					return;
				}
				active = { trial, handle, epoch, generation, workspaceId };
				gateSocket = 0;
				heldSocket = 0;
				released = false;
				api().start(trial, handle);
				const socket = sockets.findLast((entry) => entry.socket.readyState === NativeSocket.OPEN);
				record("attach", socket?.id ?? -1, api().read().rows[0]?.seq ?? -1);
			},
			release() {
				if (!active || !heldSocket || released) {
					api().fail();
					return;
				}
				record("release", heldSocket, 0);
				released = true;
				const callbacks = pending;
				pending = [];
				for (const deliver of callbacks) deliver();
			},
			finish() {
				if (!active || !released || pending.length) api().fail();
				if (active) api().end(active.trial);
				active = null;
				return api().read();
			},
		};
	});
}
export async function armRecoveryGate(
	page: Page,
	trial: number,
	handle: string,
	epoch: string,
	generation: number,
	workspaceId: string,
) {
	await page.evaluate((args) => (window as EvidenceWindow).__piwebRecoveryGate.arm(...args), [
		trial,
		handle,
		epoch,
		generation,
		workspaceId,
	] as const);
}
export async function waitForRecoveryHold(page: Page): Promise<void> {
	await page.waitForFunction(() =>
		(window as EvidenceWindow).__piwebBenchmarkRecovery.read().rows.some((row) => row.kind === "hold"),
	);
}
export async function releaseRecoveryGate(page: Page): Promise<void> {
	await page.evaluate(() => (window as EvidenceWindow).__piwebRecoveryGate.release());
}
export async function finishRecoveryEvidence(page: Page): Promise<RecoveryEvidence> {
	return page.evaluate(() => (window as EvidenceWindow).__piwebRecoveryGate.finish());
}
