// A scripted ACP agent for the bridge tests: one model option, and a prompt that
// starts with "tool" asks permission before "running" a tool ("ask <command>": before running that command); one that starts with
// "crash" asks and then exits without waiting for the answer. One that starts with
// "limit" is refused for a usage limit that resets in a minute (FAKE_AGENT_LIMIT_SECONDS):
// Claude Code's `_claude/rateLimit` with status "rejected", then the turn ends; "limit-error"
// ends it with an error instead. The next prompt is answered, the limit over. One that starts with
// "hang" says a word and then never ends its turn, whatever `session/cancel` asks (for Force stop). With
// FAKE_AGENT_STORE set it keeps its updates in that file and can load the session.
import * as fs from "node:fs";
import { AcpConnection, lineSplitter } from "../mods/acp-chat/acp.js";

const store = process.env.FAKE_AGENT_STORE;
const history = store && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];

const sid = "fake-session";
let model = "small";
let cancelled = false;
let limited = false;

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
  if (text.startsWith("hang")) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hanging." } });
    return new Promise(() => {});
  }
  if (text.startsWith("limit")) {
    limited = true;
    const resetsAt = Math.floor(Date.now() / 1000) + (Number(process.env.FAKE_AGENT_LIMIT_SECONDS) || 60);
    update({ sessionUpdate: "usage_update", used: 1000, size: 200000, _meta: { "_claude/rateLimit": { status: "rejected", resetsAt, rateLimitType: "five_hour" } } });
    if (text.startsWith("limit-error")) throw new Error("Usage limit reached");
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You've hit your limit." } });
    return { stopReason: "end_turn" };
  }
  if (limited) {
    limited = false;
    update({ sessionUpdate: "usage_update", used: 1000, size: 200000, _meta: { "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour" } } });
  }
  // "ask <command>": asks to run that command, as an agent's shell tool does (kind "execute", the command in rawInput),
  // with an "always" option beside "allow once". FAKE_AGENT_ASK_BARE=1 leaves the raw input out: only the title has it.
  if (text.startsWith("ask ")) {
    const command = text.slice(4).trim(), bare = process.env.FAKE_AGENT_ASK_BARE === "1";
    update({ sessionUpdate: "tool_call", toolCallId: "t2", title: `\`${command}\``, kind: "execute", status: "pending", ...(bare ? {} : { rawInput: { command, description: "Run a command" } }) });
    const answer = await conn.request("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t2", title: `\`${command}\``, ...(bare ? {} : { rawInput: { command } }) },
      options: [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const picked = answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
    update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: picked === "yes" || picked === "always" ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: `answered: ${picked}` } }] });
    if (cancelled) return { stopReason: "cancelled" };
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
