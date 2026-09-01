import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./pack-smoke.mjs", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const seams = new Function(
	"AbortSignal",
	"fetch",
	`${extract("function fetchBounded", "function waitForOutput")}\n${extract(
		"async function closeChild",
		"function waitForSocket",
	)}\n${extract("function waitForSocket", "function readSocketFrame")}\n${extract(
		"function readSocketFrame",
		"async function startGateway",
	)}; return { fetchBounded, closeChild, waitForSocket, readSocketFrame };`,
)(AbortSignal, fetch);

function fakeChild(mode) {
	return {
		exitCode: null,
		signalCode: null,
		signals: [],
		kill(signal) {
			this.signals.push(signal);
			if (signal === "SIGTERM" && mode === "zero") this.exitCode = 0;
			if (signal === "SIGTERM" && mode === "nonzero") this.exitCode = 2;
			if (signal === "SIGTERM" && mode === "signal") this.signalCode = "SIGTERM";
			if (signal === "SIGKILL") this.exitCode = 0;
		},
	};
}

test("pack smoke seams fail closed for frames, shutdown, and HTTP", async () => {
	const socket = new EventEmitter();
	socket.terminate = () => {};
	await assert.rejects(
		seams.waitForSocket(
			socket,
			(finish) => {
				socket.once("message", (raw) => {
					const frame = seams.readSocketFrame(raw, finish, "test");
					if (!frame) return;
					finish();
				});
				socket.emit("message", Buffer.from("not-json"));
			},
			"timeout",
		),
		/invalid JSON frame/,
	);

	let frameError;
	assert.equal(
		seams.readSocketFrame(Buffer.from("null"), (error) => (frameError = error), "test"),
		null,
	);
	assert.ok(frameError instanceof Error);

	const zero = fakeChild("zero");
	await seams.closeChild(
		zero,
		async () => true,
		() => 0,
	);
	assert.deepEqual(zero.signals, ["SIGTERM"]);
	for (const mode of ["nonzero", "signal"]) {
		await assert.rejects(
			seams.closeChild(
				fakeChild(mode),
				async () => true,
				() => 0,
			),
		);
	}
	const forced = fakeChild("timeout");
	let waits = 0;
	await assert.rejects(
		seams.closeChild(
			forced,
			async () => ++waits > 1,
			() => 0,
		),
		/forced cleanup/,
	);
	assert.deepEqual(forced.signals, ["SIGTERM", "SIGKILL"]);

	let aborted = false;
	await assert.rejects(
		seams.fetchBounded(
			"http://stall",
			{},
			(_url, { signal }) =>
				new Promise((_, reject) => {
					const keepAlive = setTimeout(() => {}, 20);
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							clearTimeout(keepAlive);
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
			5,
		),
	);
	assert.equal(aborted, true);
});

test("pack smoke routes identity and asynchronous boundary checks through guards", () => {
	assert.match(source, /!packageNames\.includes\(manifest\.name\)/);
	assert.match(source, /manifest\.version !== packageVersion/);
	assert.match(source, /packedNames\.has\(manifest\.name\)/);
	assert.match(source, /manifest\.name !== packageName/);
	assert.equal((source.match(/\bfetchImpl\(/g) ?? []).length, 1);
	assert.equal((source.match(/readSocketFrame\(raw, finish/g) ?? []).length, 4);
	assert.equal((source.match(/await closeChild\(/g) ?? []).length, 3);
});
