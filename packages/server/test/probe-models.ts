import { PiProcess } from "../src/pi-process.ts";
import { resolvePiRuntime } from "../src/resolver.ts";

const resolved = await resolvePiRuntime({ baseDir: process.cwd() });
const proc = new PiProcess({ cwd: "/Users/leonzhang/Code/pi-mono", resolved, readyTimeoutMs: 30000 });
await proc.start();

const t0 = Date.now();
const models = await proc.send({ type: "get_available_models" });
console.log(
	`t+${Date.now() - t0}ms models:`,
	JSON.stringify(
		(models.success ? (models as any).data.models : []).map((m: any) => `${m.provider}/${m.id}`),
	),
);
const state = await proc.send({ type: "get_state" });
const s = (state as any).data;
console.log(
	"state.model:",
	s?.model ? `${s.model.provider}/${s.model.id}` : null,
	"thinkingLevel:",
	s?.thinkingLevel,
);
console.log("state.sessionId:", s?.sessionId, "sessionFile:", s?.sessionFile);

// wait 16s to see the background refresh
await new Promise((r) => setTimeout(r, 16000));
const models2 = await proc.send({ type: "get_available_models" });
console.log(
	"t+16s models:",
	JSON.stringify(
		(models2.success ? (models2 as any).data.models : []).map((m: any) => `${m.provider}/${m.id}`),
	),
);
const levels = await proc.send({ type: "get_available_thinking_levels" });
console.log("thinking levels:", JSON.stringify((levels as any).data));
await proc.stop();
process.exit(0);
