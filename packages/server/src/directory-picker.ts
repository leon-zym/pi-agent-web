import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PICKER_TIMEOUT_MS = 120_000;

export interface NativePickerCommand {
	file: string;
	args: string[];
}

export type DirectoryPickerExecutor = (file: string, args: string[]) => Promise<string>;

/** Return the platform-native folder picker command without involving a shell. */
export function nativeDirectoryPickerCommand(
	platform: NodeJS.Platform = process.platform,
): NativePickerCommand {
	switch (platform) {
		case "darwin":
			return {
				file: "osascript",
				args: [
					"-e",
					'try\nPOSIX path of (choose folder with prompt "选择工作区目录")\non error number -128\n""\nend try',
				],
			};
		case "win32":
			return {
				file: "powershell.exe",
				args: [
					"-NoProfile",
					"-NonInteractive",
					"-STA",
					"-Command",
					[
						"Add-Type -AssemblyName System.Windows.Forms",
						"$picker = New-Object System.Windows.Forms.FolderBrowserDialog",
						'$picker.Description = "选择工作区目录"',
						"if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
						"  [Console]::Write($picker.SelectedPath)",
						"}",
					].join("\n"),
				],
			};
		case "linux":
			return { file: "zenity", args: ["--file-selection", "--directory", "--title=选择工作区目录"] };
		default:
			throw new Error(`Native directory picker is not supported on ${platform}`);
	}
}

async function executeNativePicker(file: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(file, args, {
		encoding: "utf8",
		timeout: PICKER_TIMEOUT_MS,
		windowsHide: true,
	});
	return stdout;
}

function hasExitCode(error: unknown, code: number): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Open the local OS folder picker and return its selected absolute path, or null on cancellation. */
export async function pickWorkspaceDirectory(
	platform: NodeJS.Platform = process.platform,
	execute: DirectoryPickerExecutor = executeNativePicker,
): Promise<string | null> {
	const command = nativeDirectoryPickerCommand(platform);
	let output: string;
	try {
		output = await execute(command.file, command.args);
	} catch (error) {
		// Zenity reports a normal cancellation with status 1.
		if (platform === "linux" && hasExitCode(error, 1)) return null;
		throw error;
	}

	const selectedPath = output.trim();
	if (!selectedPath) return null;
	if (!path.isAbsolute(selectedPath)) throw new Error("Native directory picker returned a relative path");
	return selectedPath;
}
