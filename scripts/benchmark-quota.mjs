import fs from "node:fs";
import path from "node:path";

// Resolve only a fully visible cgroup v2 hierarchy. Unsupported or hidden
// ancestors stay unknown; a leaf's `max` cannot establish the host's quota.
export function benchmarkQuota({
	platform,
	totalMemory,
	readFile = (name) => fs.readFileSync(name, "utf8"),
}) {
	const evidence = [];
	const unknown = () => ({ cpu: "unavailable", memoryBytes: "unavailable", evidence });
	if (platform !== "linux") return { cpu: "unavailable", memoryBytes: totalMemory, evidence };
	function read(name, role) {
		try {
			const value = readFile(name).trim();
			if (value.length > 1024 * 1024) throw Object.assign(new Error(), { code: "CAP" });
			return { value };
		} catch (error) {
			const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
			evidence.push({ role, error: code });
			return { error: code };
		}
	}
	const membership = read("/proc/self/cgroup", "membership");
	const mountinfo = read("/proc/self/mountinfo", "mountinfo");
	if (membership.error || mountinfo.error) return unknown();
	const rows = membership.value.split("\n");
	// Hybrid/v1 CPU hierarchies need their own visibility proof; do not guess.
	if (rows.length !== 1 || !rows[0].startsWith("0::/")) {
		evidence.push({ reason: "unsupported-membership" });
		return unknown();
	}
	const group = rows[0].slice(3);
	if (path.posix.normalize(group) !== group || group.split("/").length > 17) {
		evidence.push({ reason: "invalid-membership-path" });
		return unknown();
	}
	const mounts = mountinfo.value.split("\n").filter((row) => row.includes(" - cgroup2 "));
	if (mounts.length !== 1) {
		evidence.push({ reason: "ambiguous-or-missing-v2-mount" });
		return unknown();
	}
	const fields = mounts[0].split(" - ")[0].split(" ");
	// Escaped/noncanonical mount paths and subtree mounts are not interpreted.
	const mount = fields[4];
	if (
		fields[3] !== "/" ||
		!mount?.startsWith("/") ||
		mount.includes("\\") ||
		path.posix.normalize(mount) !== mount
	) {
		evidence.push({ reason: "unsupported-mount-root" });
		return unknown();
	}
	const controllers = read(path.posix.join(mount, "cgroup.controllers"), "root-controllers");
	if (controllers.error) return unknown();
	const available = controllers.value.split(/\s+/);
	const values = {};
	for (const [controller, file] of [
		["cpu", "cpu.max"],
		["memory", "memory.max"],
	]) {
		const root = read(path.posix.join(mount, file), `${controller}-root`);
		// Kernel v2 exposes these files on non-root cgroups when the controller
		// is available. Available controller + ENOENT identifies the real root,
		// unlike a namespace/subtree root with a hidden parent (file present).
		if (!available.includes(controller) || root.error !== "ENOENT") {
			evidence.push({ controller, reason: "root-visibility-unproven" });
			values[controller] = "unavailable";
			continue;
		}
		let current = group;
		let bound = null;
		let valid = true;
		let depth = 0;
		while (current !== "/") {
			const observed = read(path.posix.join(mount, current, file), `${controller}-ancestor-${depth}`);
			evidence.push({ controller, ancestor: depth, ...(observed.error ? {} : { value: observed.value }) });
			const match =
				controller === "cpu"
					? /^(max|[1-9]\d*) ([1-9]\d*)$/.exec(observed.value ?? "")
					: /^(max|[1-9]\d*)$/.exec(observed.value ?? "");
			if (!match || match.slice(1).some((v) => v !== "max" && !Number.isSafeInteger(Number(v)))) {
				valid = false;
				break;
			}
			if (match[1] !== "max") {
				const candidate = [Number(match[1]), controller === "cpu" ? Number(match[2]) : 1];
				if (!bound || BigInt(candidate[0]) * BigInt(bound[1]) < BigInt(bound[0]) * BigInt(candidate[1]))
					bound = candidate;
			}
			current = path.posix.dirname(current);
			depth += 1;
		}
		values[controller] = !valid
			? "unavailable"
			: controller === "cpu"
				? bound
					? `${bound[0]}/${bound[1]}`
					: "unlimited"
				: bound
					? Math.min(totalMemory, bound[0])
					: totalMemory;
	}
	return { cpu: values.cpu, memoryBytes: values.memory, evidence };
}
