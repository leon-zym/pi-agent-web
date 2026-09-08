/** Pure disconnect experiment only: receipt, bus delivery, and confirmed high watermarks differ. */
export function disconnectEvidenceIsValid(evidence, cursor, watermark, projection) {
	if (
		evidence?.invalid !== false ||
		evidence.ended !== true ||
		!Number.isSafeInteger(evidence.trial) ||
		evidence.trial < 0 ||
		!Array.isArray(evidence.rows) ||
		evidence.rows.length < 10 ||
		evidence.rows.length > 512
	)
		return false;
	if (
		Object.keys(evidence).sort().join() !== "beforeOverwrite,ended,invalid,rows,trial" ||
		!evidence.beforeOverwrite ||
		Object.keys(evidence.beforeOverwrite).sort().join() !== "prompt,promptCount,reply,replyCount"
	)
		return false;
	const rows = evidence.rows;
	const expectedKeys = ["baseline", "kind", "projected", "resync", "seq", "socket"];
	if (
		rows.some(
			(row) =>
				!row ||
				Object.keys(row).sort().join() !== expectedKeys.join() ||
				!Number.isSafeInteger(row.seq) ||
				row.seq < 0 ||
				!Number.isSafeInteger(row.socket) ||
				row.socket < 0 ||
				!Number.isSafeInteger(row.projected) ||
				row.projected < 0 ||
				typeof row.baseline !== "boolean" ||
				row.resync !== false,
		)
	)
		return false;
	if (
		rows[0].kind !== "start" ||
		rows.at(-1).kind !== "end" ||
		rows[0].seq !== cursor ||
		rows[0].projected !== cursor ||
		!rows[0].baseline ||
		rows.at(-1).seq !== watermark ||
		rows.at(-1).projected !== watermark ||
		!rows.at(-1).baseline ||
		watermark <= cursor
	)
		return false;
	const sockets = new Map();
	let last = cursor;
	let projected = cursor;
	let delivered = cursor;
	let attached = 0;
	let gate = null;
	let hold = null;
	let released = false;
	let subscriptions = 0;
	const forwardedBySocket = new Set();
	const forwarded = new Set(); // Membership only; bus and wire uniqueness are checked before insertion.
	for (let index = 1; index < rows.length; index++) {
		const row = rows[index];
		if (row.kind !== "state" && row.kind !== "end" && row.projected !== projected) return false;
		switch (row.kind) {
			case "attach":
				if (attached || index !== 1 || row.seq !== cursor || row.socket <= 0) return false;
				attached = row.socket;
				sockets.set(row.socket, { last: row.seq, closed: false, received: new Set() });
				break;
			case "subscribe":
				if (
					!gate ||
					!sockets.get(gate.socket)?.closed ||
					sockets.has(row.socket) ||
					row.seq !== last ||
					row.socket <= 0
				)
					return false;
				subscriptions++;
				sockets.set(row.socket, { last: row.seq, closed: false, received: new Set() });
				break;
			case "wire": {
				const socket = sockets.get(row.socket);
				if (!socket || socket.closed || row.seq !== socket.last + 1) return false;
				socket.last = row.seq;
				socket.received.add(row.seq);
				break;
			}
			case "forward":
				if (forwardedBySocket.has(`${row.socket}/${row.seq}`)) return false;
				forwardedBySocket.add(`${row.socket}/${row.seq}`);
				if (
					!sockets.get(row.socket)?.received.has(row.seq) ||
					(gate && row.socket === gate.socket) ||
					(hold && !released && row.seq >= hold.seq)
				)
					return false;
				forwarded.add(row.seq);
				break;
			case "bus":
				if (!forwarded.has(row.seq) || row.seq !== delivered + 1) return false;
				delivered = row.seq;
				break;
			case "state":
			case "end":
				if (
					row.seq < last ||
					row.seq > last + 1 ||
					row.seq > delivered ||
					row.projected < projected ||
					row.projected > row.seq ||
					(row.seq > last && !row.baseline) ||
					(row.kind === "end" && index !== rows.length - 1)
				)
					return false;
				last = row.seq;
				projected = row.projected;
				break;
			case "gate":
				if (
					gate ||
					row.socket !== attached ||
					!sockets.get(row.socket)?.received.has(row.seq) ||
					row.seq <= last ||
					forwarded.has(row.seq)
				)
					return false;
				gate = row;
				break;
			case "close": {
				const socket = sockets.get(row.socket);
				if (!socket || socket.closed) return false;
				socket.closed = true;
				break;
			}
			case "hold":
				if (
					hold ||
					!gate ||
					row.seq <= gate.seq ||
					row.socket === gate.socket ||
					!sockets.get(row.socket)?.received.has(row.seq)
				)
					return false;
				hold = row;
				break;
			case "release":
				if (
					!hold ||
					released ||
					row.socket !== hold.socket ||
					row.projected !== hold.seq - 1 ||
					last !== hold.seq - 1
				)
					return false;
				released = true;
				break;
			default:
				return false;
		}
	}
	const before = evidence.beforeOverwrite;
	return Boolean(
		gate &&
			hold &&
			released &&
			subscriptions === 1 &&
			delivered === watermark &&
			before &&
			before.promptCount === 1 &&
			before.replyCount === 1 &&
			before.prompt === projection.prompt &&
			before.reply === projection.reply,
	);
}
