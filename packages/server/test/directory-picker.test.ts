import { describe, expect, it } from "vitest";
import { nativeDirectoryPickerCommand, pickWorkspaceDirectory } from "../src/directory-picker.js";

describe("native workspace directory picker", () => {
	it("uses platform commands without a shell", () => {
		const macos = nativeDirectoryPickerCommand("darwin");
		expect(macos.file).toBe("osascript");
		expect(macos.args).toEqual([
			"-e",
			'try\nPOSIX path of (choose folder with prompt "选择工作区目录")\non error number -128\n""\nend try',
		]);
		expect(nativeDirectoryPickerCommand("win32").file).toBe("powershell.exe");
		expect(nativeDirectoryPickerCommand("linux")).toEqual({
			file: "zenity",
			args: ["--file-selection", "--directory", "--title=选择工作区目录"],
		});
	});

	it("returns an absolute selected path and treats an empty selection as cancellation", async () => {
		await expect(
			pickWorkspaceDirectory("darwin", async () => " /Users/example/Code/project/\n"),
		).resolves.toBe("/Users/example/Code/project/");
		await expect(pickWorkspaceDirectory("darwin", async () => "\n")).resolves.toBeNull();
		await expect(pickWorkspaceDirectory("darwin", async () => "relative/path")).rejects.toThrow(
			"relative path",
		);
	});

	it("treats a cancelled Zenity picker as no selection", async () => {
		const cancelled = Object.assign(new Error("cancelled"), { code: 1 });
		await expect(pickWorkspaceDirectory("linux", async () => Promise.reject(cancelled))).resolves.toBeNull();
	});
});
