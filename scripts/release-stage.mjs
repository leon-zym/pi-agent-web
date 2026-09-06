#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PACKAGES = ["protocol", "server", "ui", "cli"].map((n) => `@pi-agent-web/${n}`);

export function parseArgs(argv) {
	let tag = null,
		outDir = "dist/staging",
		allowLocal = false,
		skipGitCheck = false;
	for (const a of argv) {
		if (a === "--allow-local") allowLocal = true;
		else if (a === "--allow-dirty") skipGitCheck = true;
		else if (a.startsWith("--tag=")) tag = a.slice(6);
		else if (a.startsWith("--out-dir=")) outDir = a.slice(10);
		else if (!a.startsWith("-") && !tag) tag = a;
	}
	return { tag, outDir, allowLocal, skipGitCheck };
}

export function runCommand(cmd, args, cwd) {
	const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
	return res.stdout;
}

export function validateTarball(tarballPath, expectedPkg) {
	const raw = runCommand("tar", ["-tzf", tarballPath]);
	const list = raw
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!list.some((f) => f.startsWith("package/dist/")))
		throw new Error(`Missing package/dist/ in ${tarballPath}`);
	if (!list.includes("package/LICENSE")) throw new Error(`Missing package/LICENSE in ${tarballPath}`);
	if (!list.includes("package/package.json"))
		throw new Error(`Missing package/package.json in ${tarballPath}`);
	if (list.some((f) => f.startsWith("package/src/"))) throw new Error(`Source leaked into ${tarballPath}`);
	if (list.some((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".d.ts"))) {
		throw new Error(`Uncompiled TypeScript leaked into ${tarballPath}`);
	}
	const manifest = runCommand("tar", ["-xOf", tarballPath, "package/package.json"]);
	if (manifest.includes("workspace:")) throw new Error(`Workspace protocol leaked into ${tarballPath}`);
	const parsed = JSON.parse(manifest);
	if (expectedPkg && parsed.name !== expectedPkg)
		throw new Error(`Expected ${expectedPkg}, found ${parsed.name}`);
	return parsed;
}

export function stageRelease({
	tag,
	outDir = "dist/staging",
	allowLocal = false,
	skipGitCheck = false,
	rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
}) {
	const isRunner = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
	if (!isRunner && !allowLocal) {
		throw new Error("release-stage is runner-only. Pass --allow-local for local testing.");
	}
	if (!tag) throw new Error("Release tag is required (e.g. --tag=v0.1.0)");

	const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
	if (`v${rootPkg.version}` !== tag)
		throw new Error(`Tag ${tag} does not match root version v${rootPkg.version}`);

	for (const pkgName of PACKAGES) {
		const pkgPath = path.join(rootDir, "packages", pkgName.replace("@pi-agent-web/", ""), "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		if (pkg.version !== rootPkg.version) {
			throw new Error(
				`Workspace package ${pkgName} version ${pkg.version} does not match ${rootPkg.version}`,
			);
		}
	}

	if (!skipGitCheck) {
		const diff = spawnSync("git", ["diff", "--quiet"], { cwd: rootDir });
		const cached = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: rootDir });
		if (diff.status !== 0 || cached.status !== 0) {
			throw new Error("Working tree is dirty. Staging requires a clean git tree.");
		}
	}

	const stageDir = path.resolve(rootDir, outDir, `pi-agent-web-${tag}`);
	const stagePackagesDir = path.join(stageDir, "packages");
	fs.rmSync(stageDir, { recursive: true, force: true });
	fs.mkdirSync(stagePackagesDir, { recursive: true });

	const tempPackDir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-stage-pack-"));
	const stagedTarballs = [];
	try {
		for (const pkgName of PACKAGES) {
			runCommand("pnpm", ["--filter", pkgName, "pack", "--pack-destination", tempPackDir], rootDir);
		}
		for (const file of fs
			.readdirSync(tempPackDir)
			.filter((f) => f.endsWith(".tgz"))
			.sort()) {
			const src = path.join(tempPackDir, file);
			const dest = path.join(stagePackagesDir, file);
			fs.copyFileSync(src, dest);
			const pkgManifest = validateTarball(dest);
			const bytes = fs.statSync(dest).size;
			const sha256 = createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
			stagedTarballs.push({ name: pkgManifest.name, version: pkgManifest.version, file, sha256, bytes });
		}
	} finally {
		fs.rmSync(tempPackDir, { recursive: true, force: true });
	}

	if (stagedTarballs.length !== PACKAGES.length) {
		throw new Error(`Expected ${PACKAGES.length} packages, staged ${stagedTarballs.length}`);
	}

	const distPkg = {
		name: "pi-agent-web",
		version: rootPkg.version,
		private: true,
		dependencies: Object.fromEntries(stagedTarballs.map((p) => [p.name, `file:./packages/${p.file}`])),
	};
	fs.writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(distPkg, null, "\t")}\n`);

	const rev = (args) => {
		const res = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
		return res.status === 0 ? res.stdout.trim() : "unknown";
	};
	const serverPkg = JSON.parse(
		fs.readFileSync(path.join(rootDir, "packages", "server", "package.json"), "utf8"),
	);
	const manifest = {
		schemaVersion: 1,
		tag,
		commit: rev(["rev-parse", "HEAD"]),
		tree: rev(["rev-parse", "HEAD^{tree}"]),
		version: rootPkg.version,
		node: process.versions.node.split(".")[0],
		pnpm: rootPkg.packageManager?.replace("pnpm@", "") ?? "11.21.0",
		protocol: "1.4",
		pi: serverPkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? "0.84.2",
		packages: stagedTarballs,
		install: "npm install --omit=dev --ignore-scripts",
		network: "public npm registry required",
		notes: "Third-party dependencies resolve from public npm registry at install time.",
	};
	fs.writeFileSync(path.join(stageDir, "bundle-manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

	const installMd = `# Installation and Quick Start\n\n## Requirements\n- Node.js >= 22\n- Network access to the public npm registry for third-party dependencies\n\n## Installation\n\nIn this directory, run:\n\n\`\`\`bash\nnpm install --omit=dev --ignore-scripts\n\`\`\`\n\n## Launching the Workbench\n\nStart the workbench via npx:\n\n\`\`\`bash\nnpx pi-web\n\`\`\`\n\nOr run the binary directly:\n\n\`\`\`bash\n./node_modules/.bin/pi-web\n\`\`\`\n`;
	fs.writeFileSync(path.join(stageDir, "INSTALL.md"), installMd);

	const licenseSrc = path.join(rootDir, "LICENSE");
	if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(stageDir, "LICENSE"));

	return { stageDir, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	try {
		const parsed = parseArgs(process.argv.slice(2));
		const { stageDir } = stageRelease(parsed);
		console.log(`RELEASE STAGE OK: ${stageDir}`);
	} catch (error) {
		console.error(`release-stage failed: ${error.message}`);
		process.exit(1);
	}
}
