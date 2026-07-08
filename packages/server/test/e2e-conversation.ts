import { startServer } from "../src/main.js";

/**
 * Full-stack conversation smoke: gateway -> supervisor -> real pi process ->
 * real model (deepseek), driven over the WebSocket wire like the UI does.
 */
const handle = await startServer({ config: { port: 3001 } });
const base = "http://127.0.0.1:3001";

try {
  const wsResp = (await (
    await fetch(base + "/api/v1/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/Users/leonzhang/Code/pi-agent-web" }),
    })
  ).json()) as { id: string };
  const workspaceId = wsResp.id;
  console.log("workspace:", workspaceId);

  const WebSocketCtor = (await import("ws")).default;
  const ws = new WebSocketCtor("ws://127.0.0.1:3001/api/v1/ws");
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  const pending = new Map<string, { resolve: (r: unknown) => void }>();
  const events: Array<{ type: string; extra?: string }> = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as {
      type: string;
      response?: { id?: string; success?: boolean; error?: string; data?: unknown };
      event?: { type: string };
      process_status?: { state: string };
    };
    if (frame.type === "response" && frame.response?.id) {
      pending.get(frame.response.id)?.resolve(frame.response);
      pending.delete(frame.response.id);
    } else if (frame.type === "event" && frame.event) {
      const event = frame.event as { type: string; assistantMessageEvent?: { type: string } };
      events.push({
        type: event.type,
        extra: event.type === "message_update" ? event.assistantMessageEvent?.type : undefined,
      });
      console.log("EVENT:", event.type, event.assistantMessageEvent?.type ?? "");
    } else if (frame.type === "process_status") {
      console.log("process_status:", frame.process_status?.state);
    }
  });

  let seq = 0;
  const command = (payload: Record<string, unknown>) => {
    seq += 1;
    const id = "e2e-" + String(seq);
    const response = new Promise<{ success?: boolean; error?: string; data?: unknown }>((resolve) => {
      pending.set(id, { resolve });
    });
    ws.send(JSON.stringify({ type: "command", workspaceId, command: { id, ...payload } }));
    return response;
  };

  const expectOk = async (label: string, response: Promise<{ success?: boolean; error?: string }>) => {
    const r = await response;
    if (r.success === false) throw new Error(label + " failed: " + r.error);
    console.log(label + " ok");
    return r;
  };

  // 1. New session
  await expectOk("new_session", command({ type: "new_session" }));
  const state1 = await expectOk("get_state", command({ type: "get_state" }));
  const sessionId = (state1.data as { sessionId: string }).sessionId;
  console.log("sessionId:", sessionId);
  // Declare the listen scope so the gateway delivers this session's events.
  ws.send(JSON.stringify({ type: "session_listen", workspaceId, sessionId }));

  // 2. Pick a fast cheap model, thinking off
  await expectOk("set_model", command({ type: "set_model", provider: "deepseek", modelId: "deepseek-v4-flash" }));
  await expectOk("set_thinking_level", command({ type: "set_thinking_level", level: "off" }));

  // 3. Real prompt round trip
  const settled = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (events.some((e) => e.type === "agent_settled")) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
  await expectOk("prompt", command({ type: "prompt", message: "用一句话回复：你好，世界" }));
  await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error("prompt timeout")), 120_000))]);

  const kinds = new Set(events.map((e) => e.type));
  console.log("event types seen:", [...kinds].join(", "));
  const updates = events.filter((e) => e.type === "message_update").length;
  console.log("message_update count:", updates);
  const assistantEnd = events.filter((e) => e.type === "message_end").length;
  console.log("message_end count:", assistantEnd);

  const messages = await expectOk("get_messages", command({ type: "get_messages" }));
  const list = (messages.data as { messages: Array<{ role: string }> }).messages;
  console.log("messages roles:", list.map((m) => m.role).join(" -> "));
  const assistant = list.findLast((m) => m.role === "assistant");
  const text = (assistant as { content: Array<{ type: string; text?: string }> }).content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  console.log("assistant text:", JSON.stringify(text.slice(0, 120)));

  // 4. Abort semantics: start a second prompt and abort it quickly.
  const aborted = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (events.some((e) => e.type === "agent_settled")) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
  await expectOk("prompt2", command({ type: "prompt", message: "请写一篇 2000 字的文章，主题是 Rust 异步编程，先写大纲" }));
  await new Promise((r) => setTimeout(r, 1500));
  await expectOk("abort", command({ type: "abort" }));
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("abort timeout")), 60_000))]);
  console.log("abort settled ok");

  // 5. Commands + tree + stats
  const commands = await expectOk("get_commands", command({ type: "get_commands" }));
  const commandCount = (commands.data as { commands: unknown[] }).commands.length;
  console.log("slash commands:", commandCount);
  const tree = await expectOk("get_tree", command({ type: "get_tree" }));
  console.log("tree nodes:", (tree.data as { tree: unknown[] }).tree.length);
  const stats = await expectOk("get_session_stats", command({ type: "get_session_stats" }));
  console.log("stats tokens:", (stats.data as { tokens: { total: number } }).tokens.total);

  console.log("E2E CONVERSATION OK");
  ws.close();
} catch (error) {
  console.error("E2E ERROR:", error);
  process.exitCode = 1;
} finally {
  await handle.close();
  process.exit(0);
}
