import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	WorkspaceFileReferenceError,
	WorkspaceFileReferenceService,
} from "../src/workspace-file-references.js";

const roots: string[] = [];

function workspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-reference-"));
	roots.push(root);
	return root;
}

function write(root: string, relativePath: string, content: string | Buffer): string {
	const target = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceFileReferenceService", () => {
	it("classifies text, hidden, generated, credential, binary, image, ignored, and large files", async () => {
		const root = workspace();
		execFileSync("git", ["init", "-q"], { cwd: root });
		write(root, ".gitignore", "ignored.txt\n");
		write(root, "src/index.ts", "export const answer = 42;\n");
		write(root, ".hidden.txt", "hidden\n");
		write(root, "dist/generated.js", "generated\n");
		write(root, ".env", "API_KEY=not-a-real-secret-value\n");
		write(root, "ignored.txt", "ignored\n");
		write(root, "binary.dat", Buffer.from([0, 1, 2, 3]));
		write(root, "image.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
		write(root, "large.txt", "x".repeat(70 * 1024));
		write(root, "line\nbreak.txt", "unsafe label");

		const result = await new WorkspaceFileReferenceService().search(root, "");
		const byPath = new Map(result.files.map((file) => [file.path, file]));

		expect(byPath.get("src/index.ts")).toMatchObject({ kind: "text", risks: [], availability: "ready" });
		expect(byPath.get(".hidden.txt")?.risks).toContain("hidden");
		expect(byPath.get("dist/generated.js")?.risks).toContain("generated");
		expect(byPath.get(".env")?.risks).toEqual(expect.arrayContaining(["hidden", "credential"]));
		expect(byPath.get(".env")?.preview).toBeUndefined();
		expect(byPath.get("ignored.txt")?.risks).toContain("ignored");
		expect(byPath.get("ignored.txt")?.preview).toBeUndefined();
		expect(byPath.get("binary.dat")).toMatchObject({ kind: "binary" });
		expect(byPath.get("image.png")).toMatchObject({ kind: "image", mimeType: "image/png" });
		expect(byPath.get("large.txt")?.risks).toContain("large");
		expect(byPath.get("line\nbreak.txt")).toMatchObject({ availability: "unavailable" });
		expect(result.policy).toBe("gitignore");
	});

	it("captures the exact previewed text and requires confirmation for risky content", async () => {
		const root = workspace();
		write(root, "safe.txt", "captured bytes\n");
		write(root, ".env", "PASSWORD=not-a-real-password\n");
		const service = new WorkspaceFileReferenceService();
		const search = await service.search(root, "");
		const safe = search.files.find((file) => file.path === "safe.txt")!;
		const sensitive = search.files.find((file) => file.path === ".env")!;

		await expect(
			service.capture(root, {
				path: sensitive.path,
				canonicalIdentity: sensitive.canonicalIdentity!,
				confirmed: false,
			}),
		).rejects.toMatchObject({ code: "workspace_file_confirmation_required" });
		expect(
			await service.capture(root, {
				path: safe.path,
				canonicalIdentity: safe.canonicalIdentity!,
				confirmed: false,
			}),
		).toMatchObject({ content: { type: "text", text: "captured bytes\n" } });
		expect(
			await service.capture(root, {
				path: sensitive.path,
				canonicalIdentity: sensitive.canonicalIdentity!,
				confirmed: true,
			}),
		).toMatchObject({ content: { type: "text", text: "PASSWORD=not-a-real-password\n" } });
	});

	it("rejects traversal, outside symlinks, symlink swaps, and inode replacement", async () => {
		const root = workspace();
		const outside = workspace();
		write(root, "a.txt", "a");
		write(root, "b.txt", "b");
		write(outside, "secret.txt", "outside");
		fs.symlinkSync(path.join(root, "a.txt"), path.join(root, "selected.txt"));
		fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "outside.txt"));
		const service = new WorkspaceFileReferenceService();
		const search = await service.search(root, "");
		const selected = search.files.find((file) => file.path === "selected.txt")!;
		const outsideResult = search.files.find((file) => file.path === "outside.txt")!;
		expect(outsideResult).toMatchObject({ availability: "unavailable" });

		await expect(
			service.capture(root, { path: "../secret.txt", canonicalIdentity: "1:2:3:4", confirmed: true }),
		).rejects.toBeInstanceOf(WorkspaceFileReferenceError);
		await expect(
			service.capture(root, { path: ".git/config", canonicalIdentity: "1:2:3:4", confirmed: true }),
		).rejects.toMatchObject({ code: "workspace_file_unavailable" });

		fs.unlinkSync(path.join(root, "selected.txt"));
		fs.symlinkSync(path.join(root, "b.txt"), path.join(root, "selected.txt"));
		await expect(
			service.capture(root, {
				path: selected.path,
				canonicalIdentity: selected.canonicalIdentity!,
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: "workspace_file_identity_changed" });

		const original = search.files.find((file) => file.path === "a.txt")!;
		fs.renameSync(path.join(root, "a.txt"), path.join(root, "old-a.txt"));
		write(root, "a.txt", "replacement");
		await expect(
			service.capture(root, {
				path: original.path,
				canonicalIdentity: original.canonicalIdentity!,
				confirmed: false,
			}),
		).rejects.toMatchObject({ code: "workspace_file_identity_changed" });
	});

	it("canonicalizes a Workspace root alias before discovery", async () => {
		const root = workspace();
		write(root, "safe.txt", "safe");
		const parent = workspace();
		const alias = path.join(parent, "workspace-alias");
		fs.symlinkSync(root, alias);

		const result = await new WorkspaceFileReferenceService().search(alias, "");
		expect(result.files.map((file) => file.path)).toContain("safe.txt");
	});

	it("keeps broken links visible and stops at directory and result budgets", async () => {
		const root = workspace();
		fs.symlinkSync(path.join(root, "missing.txt"), path.join(root, "broken.txt"));
		for (let index = 0; index < 360; index += 1) {
			write(root, `d-${String(index).padStart(3, "0")}/file.txt`, String(index));
		}
		const result = await new WorkspaceFileReferenceService().search(root, "");
		expect(result.files.find((file) => file.path === "broken.txt")).toMatchObject({
			availability: "unavailable",
		});
		expect(result.files.length).toBeLessThanOrEqual(50);
		expect(result.scannedDirectories).toBeLessThanOrEqual(300);
		expect(result.truncated).toBe(true);
	});

	it("honors cancellation before filesystem work", async () => {
		const root = workspace();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(new WorkspaceFileReferenceService().search(root, "", controller.signal)).rejects.toThrow(
			"cancelled",
		);
	});

	it("bounds concurrent operations and returns a stable unavailable-root error", async () => {
		const root = workspace();
		write(root, "safe.txt", "safe");
		const service = new WorkspaceFileReferenceService();
		const active = Array.from({ length: 4 }, () => service.search(root, ""));

		await expect(service.search(root, "")).rejects.toMatchObject({
			status: 429,
			code: "workspace_file_operations_busy",
		});
		await Promise.all(active);
		await expect(service.search(path.join(root, "missing"), "")).rejects.toMatchObject({
			status: 409,
			code: "workspace_file_root_unavailable",
			message: "Workspace root is unavailable",
		});
	});
});
