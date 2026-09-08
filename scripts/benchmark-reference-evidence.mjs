import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BUDGET_POLICY = "completion-median-v1";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const runId = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
const keys = (value, names) => value && Object.keys(value).sort().join() === names.sort().join();

export function referenceSet(description, environment) {
	if (!keys(description, ["policy", "actions", "local"]) || description.policy !== BUDGET_POLICY)
		throw new Error("invalid reference description/policy");
	if (!["actions", "local"].includes(environment)) throw new Error("select actions or local references");
	const set = description[environment];
	if (keys(set, ["status"]) && set.status === "pending") return set;
	if (
		!keys(set, ["status", "source", "artifactId", "sha256", "reference1", "reference2"]) ||
		set.status !== "active" ||
		!/^[a-f0-9]{40}$/.test(set.source) ||
		!sha(set.sha256) ||
		!runId(set.reference1) ||
		!runId(set.reference2) ||
		set.reference1 === set.reference2 ||
		(environment === "actions"
			? !Number.isSafeInteger(set.artifactId) || set.artifactId <= 0
			: set.artifactId !== null)
	)
		throw new Error("invalid active reference evidence configuration");
	return set;
}

// One bounded cohort archive, not a reference generator. Never trust archive paths or sizes.
export function unpackReferenceArchive(bytes, digest) {
	if (bytes.length > 8 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== digest)
		throw new Error("reference archive size/digest mismatch");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-benchmark-reference-"));
	try {
		const archive = path.join(directory, "cohort.zip");
		fs.writeFileSync(archive, bytes);
		execFileSync(
			"python3",
			[
				"-c",
				`
import pathlib, stat, sys, zipfile
root = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 2048 or sum(e.file_size for e in entries) > 128 * 1024 * 1024:
        raise ValueError('reference archive exceeds extraction budget')
    seen = set()
    for entry in entries:
        name = entry.filename
        p = pathlib.PurePosixPath(name)
        mode = entry.external_attr >> 16
        if not name or '\\\\' in name or p.is_absolute() or '..' in p.parts or name in seen or stat.S_ISLNK(mode):
            raise ValueError('unsafe reference archive entry')
        seen.add(name)
    archive.extractall(root)
`,
				archive,
				path.join(directory, "runs"),
			],
			{ timeout: 30_000, stdio: "pipe" },
		);
		return {
			directory: path.join(directory, "runs"),
			dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		fs.rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

export function loadReferenceArchive(set, environment, localArchive) {
	let bytes;
	if (environment === "local") {
		if (!localArchive || fs.statSync(localArchive).size > 8 * 1024 * 1024)
			throw new Error("active local reference archive missing or oversized");
		bytes = fs.readFileSync(localArchive);
	} else {
		if (localArchive) throw new Error("Actions references cannot use a local archive override");
		const repository = process.env.GITHUB_REPOSITORY;
		if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("missing Actions repository");
		const endpoint = `repos/${repository}/actions/artifacts/${set.artifactId}`;
		const options = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 };
		const metadata = JSON.parse(execFileSync("gh", ["api", endpoint], options));
		if (
			metadata.id !== set.artifactId ||
			metadata.expired !== false ||
			!Number.isFinite(Date.parse(metadata.expires_at)) ||
			Date.parse(metadata.expires_at) <= Date.now() ||
			!Number.isSafeInteger(metadata.size_in_bytes) ||
			metadata.size_in_bytes > 8 * 1024 * 1024
		)
			throw new Error("active Actions reference artifact unavailable/expired/oversized");
		bytes = execFileSync("gh", ["api", `${endpoint}/zip`], options);
	}
	return unpackReferenceArchive(bytes, set.sha256);
}
