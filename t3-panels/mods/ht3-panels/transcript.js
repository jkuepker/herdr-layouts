// Folds ACP `session/update` notifications into a list of chat items the mod
// draws. Shared by the bridge and the mod, like acp.js.
//
// Item kinds: user, agent, thought, tool, plan, notice.

export function emptyTranscript() {
  return { items: [], dropped: 0, usage: null, commands: [], nextId: 1 };
}

// `attachments`: what was sent along, for the message to show: [{ name, path, image }].
// `steered`: it went into a turn that was running (session.js steer), so it starts no turn of its own.
export function addUser(t, text, attachments = null, steered = false) {
  push(t, { kind: "user", text, ...(attachments?.length ? { attachments } : {}), ...(steered ? { steered: true } : {}) });
}

// What an agent says of a limit. Claude Code's adapter sends the account's rate limit with a usage update
// (`_meta["_claude/rateLimit"]`: status allowed | allowed_warning | rejected, resetsAt in seconds, utilization 0..1,
// rateLimitType); any agent's refusal for a limit comes as an error's text (limitText). -> t.limit, or nothing.
const LIMIT_WORDS = /rate.?limit|usage limit|limit (?:reached|exceeded)|quota|too many requests|\b429\b|out of credits|credit balance|insufficient (?:credit|quota|funds)|billing/i;
export const limitText = (text) => (LIMIT_WORDS.test(String(text ?? "")) ? String(text).trim().split("\n")[0].slice(0, 200) : null);
export function noteLimit(t, info) {
  if (!info || typeof info !== "object" || !info.status) return;
  t.limit = { status: String(info.status), ...(Number.isFinite(Number(info.resetsAt)) ? { resetsAt: Number(info.resetsAt) } : {}),
    ...(Number.isFinite(Number(info.utilization)) ? { utilization: Number(info.utilization) } : {}), ...(info.rateLimitType ? { type: String(info.rateLimitType) } : {}),
    ...(info.text ? { text: String(info.text) } : {}), at: Date.now() };
}

// What was said so far, as text a new session can be told (a forked chat's first prompt): the
// messages and replies in order, the oldest dropped first when it runs past `max` characters.
export function handoffText(t, max = 60000) {
  const parts = t.items.filter((m) => (m.kind === "user" || m.kind === "agent") && m.text).map((m) => `${m.kind === "user" ? "User" : "Assistant"}: ${m.text.trim()}`);
  let text = parts.join("\n\n");
  if (text.length > max) text = "…" + text.slice(-max);
  return text;
}

// `more`: what a notice carries besides its words, e.g. { undo: <commit> } on a revert's (chat.js draws its Undo).
export function addNotice(t, text, level = "info", more = null) {
  push(t, { kind: "notice", text, level, ...(more ?? {}) });
}

export function applyUpdate(t, u, now = Date.now()) {
  switch (u.sessionUpdate) {
    case "user_message_chunk":
      return appendText(t, "user", u);
    case "agent_message_chunk":
      return appendText(t, "agent", u);
    case "agent_thought_chunk":
      return appendText(t, "thought", u);
    case "tool_call":
      return upsertTool(t, u, true, now);
    case "tool_call_update":
      return upsertTool(t, u, false, now);
    case "plan": {
      const plan = find(t, (i) => i.kind === "plan" && i.open);
      const entries = (u.entries ?? []).map((e) => ({ content: e.content, status: e.status }));
      if (plan) plan.entries = entries;
      else push(t, { kind: "plan", entries, open: true });
      return;
    }
    case "usage_update":
      noteLimit(t, u._meta?.["_claude/rateLimit"]);
      // The context now (and the cost, when the agent sends one), and a sample of it for the Usage dialog: each change, the last 240.
      t.usage = { used: u.used, size: u.size, ...(u.cost && typeof u.cost === "object" ? { cost: { amount: u.cost.amount, currency: u.cost.currency } } : {}) };
      t.usageLog ??= [];
      if (t.usageLog.at(-1)?.used !== u.used || t.usageLog.at(-1)?.size !== u.size) { t.usageLog.push({ at: Date.now(), used: u.used, size: u.size }); if (t.usageLog.length > 240) t.usageLog.splice(0, t.usageLog.length - 240); }
      return;
    case "available_commands_update":
      t.commands = (u.availableCommands ?? []).map((c) => ({ name: c.name, description: c.description }));
      return;
  }
}

// A thread as Markdown, to paste into an issue, a note or another agent: its name, where it ran, then what was
// said in order. Tools are one line each, plans a checklist; thoughts and notices are left out.
export function toMarkdown({ title, agent, cwd, branch, machine, items }) {
  const where = [agent, machine ? `${machine}:${cwd ?? "~"}` : cwd, branch ? `branch ${branch}` : null].filter(Boolean).join(" · ");
  const out = [`# ${String(title || "Chat").split("\n")[0]}`, ...(where ? ["", `_${where}_`] : [])];
  let last = null;
  const head = (who) => { if (last !== who) { out.push("", `## ${who}`); last = who; } out.push(""); };
  for (const m of items ?? []) {
    if (m.kind === "user") { head("You"); out.push(String(m.text ?? "").trim(), ...(m.attachments ?? []).map((a) => `- attached: ${a.name}`)); }
    else if (m.kind === "agent" && String(m.text ?? "").trim()) { head(agent || "Agent"); out.push(String(m.text).trim()); }
    else if (m.kind === "tool") { head(agent || "Agent"); out.push(`- \`${String(m.title || "tool").replace(/`/g, "'")}\`${m.status && m.status !== "completed" ? ` (${m.status})` : ""}`); }
    else if (m.kind === "plan") { head(agent || "Agent"); out.push(...(m.entries ?? []).map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`)); }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// A finished turn closes the open plan and stops agent text from merging into
// the next turn's reply.
export function endTurn(t) {
  for (const i of t.items) i.open = false;
}

// Drops the oldest items until the JSON fits in `maxBytes`.
export function trim(t, maxBytes) {
  while (t.items.length > 1 && JSON.stringify(t).length > maxBytes) {
    t.items.shift();
    t.dropped++;
  }
}

function push(t, item) {
  t.items.push({ id: String(t.nextId++), open: true, ...item });
}

function find(t, pred) {
  for (let i = t.items.length - 1; i >= 0; i--) if (pred(t.items[i])) return t.items[i];
  return null;
}

function contentText(c) {
  if (!c) return "";
  if (c.type === "text") return c.text ?? "";
  if (c.type === "resource_link") return `[${c.name ?? c.uri}](${c.uri})`;
  if (c.type === "resource") return c.resource?.text ?? c.resource?.uri ?? "";
  if (c.type === "image") return "*(image)*";
  return "";
}

function appendText(t, kind, u) {
  const text = contentText(u.content);
  if (!text) return;
  const last = t.items[t.items.length - 1];
  const sameMessage = u.messageId == null || last?.messageId === u.messageId;
  if (last && last.kind === kind && last.open && sameMessage) last.text += text;
  else push(t, { kind, text, messageId: u.messageId });
}

function toolDetail(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const c of content) {
    if (c.type === "content") parts.push(contentText(c.content));
    else if (c.type === "diff") parts.push(`${c.path}\n${diffText(c.oldText, c.newText)}`);
    else if (c.type === "terminal") parts.push(`(terminal ${c.terminalId})`);
  }
  return parts.filter(Boolean).join("\n\n") || null;
}

function diffText(oldText, newText) {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  if (!oldText) return b.map((l) => "+ " + l).join("\n");
  return [...a.map((l) => "- " + l), ...b.map((l) => "+ " + l)].join("\n");
}

// A subagent is a tool call too. Claude Code's adapter names the tool that starts one (`_meta.claudeCode.toolName`:
// "Task", "Agent" in newer versions) and stamps what the subagent itself runs with its parent's id
// (`_meta.claudeCode.parentToolUseId`). -> item.sub on the call that is a subagent, item.parent on its children's;
// startedAt and endedAt (ms) are when the call came and when it ended, for the bar over the message box (subagents).
const SUB_TOOLS = ["Task", "Agent"];
const ENDED = ["completed", "failed", "cancelled"];
function upsertTool(t, u, isNew, now = Date.now()) {
  let item = find(t, (i) => i.kind === "tool" && i.toolCallId === u.toolCallId);
  if (!item) {
    if (!isNew && u.title == null) return;
    push(t, { kind: "tool", toolCallId: u.toolCallId, title: "", status: "pending", toolKind: "other", detail: null, startedAt: now });
    item = t.items[t.items.length - 1];
  }
  const cc = u._meta?.claudeCode;
  if (SUB_TOOLS.includes(cc?.toolName)) item.sub = true;
  if (typeof cc?.parentToolUseId === "string" && cc.parentToolUseId && cc.parentToolUseId !== item.toolCallId) {
    item.parent = cc.parentToolUseId;
    const parent = find(t, (i) => i.kind === "tool" && i.toolCallId === item.parent);
    if (parent) parent.sub = true;
  }
  if (u.title != null) item.title = u.title;
  if (u.status != null) item.status = u.status;
  if (ENDED.includes(item.status)) item.endedAt ??= now; else delete item.endedAt;
  if (u.kind != null) item.toolKind = u.kind;
  const detail = toolDetail(u.content);
  if (detail != null) item.detail = detail;
  if (u.locations?.length && !item.detail) item.detail = u.locations.map((l) => l.path).join("\n");
}

// The subagents of the turn that is running, for the bar over the message box (chat.js subBar): the ones at work,
// and for `linger` ms the ones that just ended. -> [{ id (the item's, to scroll to), toolCallId, title, running,
// failed, ms (how long it ran, or has run), doing (what it runs now: its newest unfinished tool call's title) }].
export const SUB_LINGER_MS = 4000;
export function subagents(items, now = Date.now(), linger = SUB_LINGER_MS) {
  const all = items ?? [];
  // A message steered into the turn starts no turn of its own.
  let from = all.length;
  while (from > 0 && (all[from - 1].kind !== "user" || all[from - 1].steered)) from--;
  const out = [];
  for (let i = from; i < all.length; i++) {
    const m = all[i];
    if (m.kind !== "tool" || !m.sub) continue;
    const running = m.open !== false && !ENDED.includes(m.status);
    if (!running && !(m.endedAt != null && now - m.endedAt < linger)) continue;
    let doing = null;
    if (running) for (let j = all.length - 1; j > i && doing == null; j--) if (all[j].kind === "tool" && all[j].parent === m.toolCallId && !ENDED.includes(all[j].status)) doing = String(all[j].title ?? "").split("\n")[0].trim() || null;
    out.push({ id: m.id, toolCallId: m.toolCallId, title: String(m.title ?? "").split("\n")[0].trim() || "Subagent", running, failed: m.status === "failed",
      ms: Math.max(0, (running ? now : m.endedAt) - (m.startedAt ?? now)), doing });
  }
  return out;
}
