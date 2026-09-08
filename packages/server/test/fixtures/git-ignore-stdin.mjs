import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Use a real pipe, but order the first write after the child has closed its input.
// Isolating this process makes an unhandled stream error fail the regression itself.
const spawn = cp.spawn;
const completions = [];
const closesInput = process.argv[3] === "closed";
cp.spawn = (command, _args, options) => {
	if (command !== "git") throw new Error("Unexpected subprocess in ignore-policy fixture");
	const script = closesInput
		? "require('node:fs').closeSync(0);process.send('ready');setTimeout(()=>process.exit(0),100)"
		: "process.stdin.resume();process.stdin.on('end',()=>process.exit(1));process.send('ready')";
	const child = spawn(process.execPath, ["-e", script], {
		...options,
		stdio: ["pipe", "pipe", "ignore", "ipc"],
	});
	completions.push(new Promise((resolve) => child.once("close", resolve)));
	const end = child.stdin.end.bind(child.stdin);
	child.stdin.end = (data) => {
		child.once("message", () => end(data));
		return child.stdin;
	};
	return child;
};
syncBuiltinESMExports();

const { WorkspaceFileReferenceService } = await import("../../src/workspace-file-references.ts");
const service = new WorkspaceFileReferenceService();
const root = process.argv[2];
const search = await service.search(root, "safe.txt");
const file = search.files[0];
const request = { path: file.path, canonicalIdentity: file.canonicalIdentity, confirmed: false };
let captureError = null;
try {
	await service.capture(root, request);
} catch (error) {
	captureError = error.code;
}
const captured = await service.capture(root, { ...request, confirmed: true });
await Promise.all(completions);
console.log(JSON.stringify({ policy: search.policy, file, captureError, content: captured.content }));
