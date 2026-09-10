import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Executable trust is reviewed explicitly; a descriptor or archive cannot extend this allowlist.
export const TRUSTED_REFERENCE_SOURCES = new Set([
	"7e0ca3e3738b31183b0661ed425f4d27b48d20bf",
	"00fe129125fcf273f8c27332ec4b115b59779ce8",
]);
export const TRUSTED_REFERENCE_SOURCE = "7e0ca3e3738b31183b0661ed425f4d27b48d20bf";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function readFrozenReferences(set, directory, repository = repositoryRoot) {
	if (!TRUSTED_REFERENCE_SOURCES.has(set.source)) throw new Error("unsupported trusted reference source");
	const ids = [set.reference1, set.reference2];
	if (
		new Set(ids).size !== 2 ||
		ids.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id))
	)
		throw new Error("invalid fixed reference IDs");
	// No HOME, tokens, Node preload options, Git overrides or workflow credentials reach old code.
	const env = { PATH: process.env.PATH };
	const options = { env, stdio: "pipe", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, cwd: repository };
	try {
		const resolved = execFileSync("git", ["rev-parse", "--verify", `${set.source}^{commit}`], options)
			.toString()
			.trim();
		if (resolved !== set.source) throw new Error("reference source identity mismatch");
	} catch {
		throw new Error(`missing trusted reference source; run git fetch --depth=1 origin ${set.source}`);
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-benchmark-source-"));
	try {
		const archive = execFileSync("git", ["archive", "--format=tar", set.source], options);
		execFileSync("tar", ["-xf", "-", "-C", root], { ...options, input: archive });
		const script = `
import path from 'node:path';
const {readCompleteBundle, compareBenchmarkBaseline, STRICT_SERIES} = await import(process.argv[1]);
const [directory, source, ids] = JSON.parse(await new Promise(resolve => {
 let input = ''; process.stdin.setEncoding('utf8');
 process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => resolve(input));
}));
const bundles = ids.map(id => {
 const bundle = readCompleteBundle(path.join(directory, id));
 const envelope = compareBenchmarkBaseline(bundle, bundle);
 if (envelope.status === 'INVALID' || envelope.errors.length) throw new Error('invalid reference envelope: ' + envelope.errors.join('; '));
 if (bundle.benchmark.runId !== id || bundle.manifest.source.commit !== source) throw new Error('fixed reference identity/source mismatch');
 for (const series of STRICT_SERIES) {
  const result = bundle.benchmark.results.find(r => r.domain + ':' + r.scenarioId + ':' + r.variant === series.scenario);
  const median = result?.summaries?.[series.name]?.median;
  if (!Number.isFinite(median) || median < 0) throw new Error('invalid reference selected median');
 }
 return bundle;
});
process.stdout.write(JSON.stringify(bundles));
`;
		const output = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				script,
				pathToFileURL(path.join(root, "scripts/compare-benchmark-baseline.mjs")).href,
			],
			{
				...options,
				cwd: root,
				timeout: 60_000,
				input: JSON.stringify([path.resolve(directory), set.source, ids]),
			},
		);
		const bundles = JSON.parse(output.toString());
		if (
			!Array.isArray(bundles) ||
			bundles.length !== 2 ||
			bundles.some(
				(bundle, index) =>
					bundle?.benchmark?.runId !== ids[index] || bundle?.manifest?.source?.commit !== set.source,
			)
		)
			throw new Error("invalid frozen reference validator output");
		return bundles;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}
