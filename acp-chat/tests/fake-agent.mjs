// A scripted ACP agent for the bridge tests: one model option, and a prompt that
// starts with "tool" asks permission before "running" a tool; one that starts with
// "crash" asks and then exits without waiting for the answer. With
// FAKE_AGENT_STORE set it keeps its updates in that file and can load the session.
import * as fs from "node:fs";
import { AcpConnection, lineSplitter } from "../mods/acp-chat/acp.js";

const store = process.env.FAKE_AGENT_STORE;
const history = store && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];

const sid = "fake-session";
let model = "small";
let cancelled = false;

const conn = new AcpConnection((line) => process.stdout.write(line), {
  onNotification(method) {
    if (method === "session/cancel") cancelled = true;
  },
  async onRequest(method, params) {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake Agent", version: "0" }, agentCapabilities: { loadSession: !!store } };
      case "session/load":
        for (const u of history) conn.notify("session/update", { sessionId: sid, update: u });
        return { configOptions: [config()] };
      case "session/new":
        return { sessionId: sid, configOptions: [config()] };
      case "session/set_config_option":
        model = params.value;
        return { configOptions: [config()] };
      case "session/prompt":
        return prompt(params.prompt[0].text);
    }
  },
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", lineSplitter((line) => conn.feed(line)));

function config() {
  return { id: "model", name: "Model", type: "select", currentValue: model, options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] };
}

function update(u) {
  conn.notify("session/update", { sessionId: sid, update: u });
  if (store) {
    history.push(u);
    fs.writeFileSync(store, JSON.stringify(history));
  }
}

async function prompt(text) {
  cancelled = false;
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  if (text.startsWith("crash")) {
    conn.request("session/request_permission", { sessionId: sid, toolCall: { toolCallId: "t0", title: "Crash" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] }).catch(() => {});
    setTimeout(() => process.exit(3), 300);
    return new Promise(() => {});
  }
  if (text.startsWith("tool")) {
    update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit notes.md", kind: "edit", status: "pending" });
    const answer = await conn.request("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t1", title: "Edit notes.md" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "yes";
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "edited" : "rejected" } }] });
    if (cancelled) return { stopReason: "cancelled" };
  }
  for (const word of [`(${model}) `, "you ", "said: ", text]) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word } });
  return { stopReason: "end_turn" };
}
