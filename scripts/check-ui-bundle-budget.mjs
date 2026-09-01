import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDirectory = path.join(repositoryRoot, "packages/ui/dist/assets");

const budgets = {
	entry: 256 * 1024,
	settledMarkdown: 110 * 1024,
	css: 12 * 1024,
};

function findSingleAsset(assets, pattern, label) {
	const matches = assets.filter((asset) => pattern.test(asset));
	if (matches.length !== 1) {
		throw new Error(`${label} asset match is ambiguous: ${matches.join(", ") || "none"}`);
	}
	return matches[0];
}

function gzipBytes(filePath) {
	return gzipSync(fs.readFileSync(filePath)).byteLength;
}

function checkBudget(label, actualBytes, maxBytes) {
	if (actualBytes > maxBytes) {
		throw new Error(`${label} gzip budget exceeded: ${String(actualBytes)} > ${String(maxBytes)} bytes`);
	}
	console.log(`BUNDLE OK ${label}: ${String(actualBytes)} / ${String(maxBytes)} bytes gzip`);
}

if (!fs.existsSync(assetsDirectory)) {
	throw new Error(`UI build assets are missing: ${assetsDirectory}`);
}

const assets = fs.readdirSync(assetsDirectory);
const entry = findSingleAsset(assets, /^index-[^/]+\.js$/u, "entry JavaScript");
const settledMarkdown = findSingleAsset(assets, /^SettledMarkdown-[^/]+\.js$/u, "settled Markdown");
const cssAssets = assets.filter((asset) => asset.endsWith(".css"));
if (cssAssets.length === 0) throw new Error("UI CSS assets are missing");

checkBudget("entry JavaScript", gzipBytes(path.join(assetsDirectory, entry)), budgets.entry);
checkBudget(
	"settled Markdown JavaScript",
	gzipBytes(path.join(assetsDirectory, settledMarkdown)),
	budgets.settledMarkdown,
);
checkBudget(
	"all UI CSS",
	cssAssets.reduce((total, asset) => total + gzipBytes(path.join(assetsDirectory, asset)), 0),
	budgets.css,
);
