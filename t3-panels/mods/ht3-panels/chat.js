// The chat panel: T3 Code's thread view (apps/web/src/components/chat) in gpui-kit. A
// centered 736px lane; your messages as right-aligned bubbles, the agent's as plain
// markdown, its work as flat one-line rows that open, a "Working for 12s" line, and the
// composer card with its controls and the round Send / Stop button.
//
// The agent comes from one of two sources that give the same rows:
// - agent-term.js: an agent already running in a Herdr terminal (props.terminal);
// - agent-acp.js: an agent this pane starts over ACP (props.agent, cwd, machine, prompt).

import { div, list, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Scrollbar } from "gpui-base";
import { run, openOverlay, appHome, home, exec, layout, settings, shared, setShared, notify, focused, panes } from "herdr";
import { MOD, tokens, alpha, icon, agentMark, button, iconButton, control, badge, workLine, divider, shortPath } from "./look.js";
import { AcpSource, AGENTS, detect, argvOf, forkChat, agentOf, chatLike, askOnce } from "./agent-acp.js";
import { TermSource } from "./agent-term.js";
import { Reporter, paneIds, tabIds, placeNew } from "./report.js";
import { fileIcon } from "./fileicons.js";
import { snapshot, turnStat, undoRevert, prune, chatsWithRefs, safe as refName, KEEP } from "./checkpoint.js";
import { checkpointsOn, followUp, limitModels, rememberModels, prefs } from "./settings.js";
import { Diagrams, isMermaid, fit, INSTALL } from "./mermaid.js";
import { addNotice, toMarkdown, subagents } from "./transcript.js";
import { repoOf } from "./launcher.js";
import { ServerWatch, serversStrip } from "./servers.js";

const LANE = 736; // --chat-content-max-width: 46rem
const DRAW_EVERY_MS = 80;
const DETAIL_MAX = 4000;
const TOOL_GLYPH = { read: "eye", edit: "square-pen", delete: "trash-2", move: "file", search: "search", execute: "terminal", think: "brain", fetch: "globe", switch_mode: "list-todo", other: "wrench" };
const OPTION_GLYPH = { model: "sparkles", mode: "lock", thought_level: "brain" };

// A message's text cut at its fenced code blocks, so each block can carry its own Copy button
// (chat/MessageCopyButton.tsx, ChatMarkdown's code header): [{ code, lang, text }]. A fence left
// open (still streaming) is a block to its end, and says so (`open`).
export function segments(text) {
  const out = [];
  let buf = [], code = null;
  const flush = () => { if (buf.join("\n").trim()) out.push({ code: false, text: buf.join("\n") }); buf = []; };
  for (const line of String(text ?? "").split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
    if (!code && f) { flush(); code = { fence: f[1], lang: f[2], lines: [] }; }
    else if (code && f && f[1][0] === code.fence[0] && f[1].length >= code.fence.length && !f[2]) { out.push({ code: true, lang: code.lang, text: code.lines.join("\n") }); code = null; }
    else if (code) code.lines.push(line);
    else buf.push(line);
  }
  if (code) out.push({ code: true, lang: code.lang, text: code.lines.join("\n"), open: true });
  flush();
  return out;
}

// composer-logic.ts detectComposerTrigger: the word being typed opens a menu when it starts with
// "/" (commands), "$" (skills) or "@" (files). The text area doesn't tell where its caret is, so
// the word is the one the text ends in. -> { kind, query, start } or null.
export function trigger(text) {
  const start = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t")) + 1;
  const word = text.slice(start);
  if (word.startsWith("/")) return /^\/[\w:.-]*$/.test(word) ? { kind: "slash", query: word.slice(1), start } : null; // not a path such as /usr/bin
  if (word.startsWith("$")) return /^\$[A-Za-z_-][\w:.-]*$|^\$$/.test(word) ? { kind: "skill", query: word.slice(1), start } : null;
  if (word.startsWith("@")) return { kind: "path", query: word.slice(1), start };
  return null;
}

// chat/ComposerAttachmentStrip.tsx: what counts as a picture, and how big one may be sent as it is.
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const IMAGE_MAX = 1500000, ATTACH_MAX = 8;
const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;

// Whether the letters of `q` come in `s` in that order.
function subseq(q, s) {
  let at = 0;
  for (const ch of q) { at = s.indexOf(ch, at) + 1; if (!at) return false; }
  return true;
}

// How many rows the lane builds at first, and how many more each time you near the first of them.
const TAIL = 60;
// A tool's output as its row shows it (cut at DETAIL_MAX).
const detailOf = (m) => { const d = String(m.detail ?? ""); return d.length > DETAIL_MAX ? d.slice(0, DETAIL_MAX) + "\n…" : d; };
// The rows a click does something to.
const CLICKS = ["earlier", "copy", "codehead", "fold", "tool", "thought"];

// T3's own commands (composer-logic.ts ComposerSlashCommand) that have a place here.
const LOCAL_COMMANDS = [
  { name: "model", description: "Switch the model for this chat", local: true },
  { name: "side", description: "Ask a side question in the right panel", local: true },
  { name: "new", description: "Start a new chat", local: true },
  { name: "rename", description: "Rename this thread", local: true, args: true },
  { name: "title", description: "Have the agent give this thread a short title", local: true },
  { name: "fork", description: "Continue this thread in a new chat", local: true },
  { name: "stash", description: "Park this draft, or bring one back", local: true },
  { name: "find", description: "Find in this thread", local: true },
  { name: "copy", description: "Copy this thread as Markdown", local: true },
  { name: "branch", description: "New chat on this branch: same agent, same folder", local: true },
  { name: "terminal", description: "This chat's terminal, under the chat: open, hide or show it", local: true },
  { name: "send-new", description: "Send this draft as a new chat, and go there", local: true },
  { name: "send-background", description: "Send this draft as a new chat, and stay here", local: true },
  { name: "usage", description: "Tokens and context: this chat and every agent", local: true },
  { name: "clear", description: "Start a fresh session with your next message", local: true },
];

export function openLauncher() {
  openOverlay({ mod: MOD, kind: "dialog", width: 512, height: 660 });
}

// The composer's placeholder, T3's words, and the one for a lane too narrow to show them whole.
const HINT = "Ask anything. @ files, $ skills, / commands", HINT_SHORT = "Ask anything", HINT_ROOM = 360;
const seconds = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
// A finished turn's time, as T3 says it: "1.6s" under ten seconds.
const took = (ms) => (ms < 10000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : seconds(ms));
const isWork = (m) => m.kind === "thought" || m.kind === "tool";
// What a chat keeps across a reload of its pane (and of the app) that isn't the agent's to remember:
// shared("ht3-panels.kept")[chat id] = { allow: true } while "Always allow this session" is on, and
// { queue: [{ text, blocks, files }] }, the messages waiting for the agent's turn to end, { pin: true } while the
// chat is pinned (pinSync), and { history: [{ text, tokens? }] }, the prompts sent in it, oldest first (pushPrompt).
// Empty values aren't kept; a chat with nothing kept has no entry.
const KEPT = `${MOD}.kept`;
const keptOf = (id) => (id ? (shared(KEPT) ?? {})[id] ?? {} : {});
function keep(id, patch) {
  if (!id) return;
  const all = { ...(shared(KEPT) ?? {}) }, next = { ...(all[id] ?? {}), ...patch };
  for (const key of Object.keys(next)) if (next[key] == null || next[key] === false || (Array.isArray(next[key]) && !next[key].length)) delete next[key];
  if (Object.keys(next).length) all[id] = next; else delete all[id];
  if (JSON.stringify(all) !== JSON.stringify(shared(KEPT) ?? {})) setShared(KEPT, all);
}

// Where each chat's checkpoints are, so a chat deleted from Earlier chats can have its refs dropped in the repository
// they are in: shared("ht3-panels.cps") = { <chat id>: { cwd, on } }. Looked through at most every SWEEP_EVERY_MS a pane.
const CPS = `${MOD}.cps`, SWEEP_EVERY_MS = 10 * 60 * 1000;

// A reply as a quoted block for the message box (T3's AssistantSelectionToolbar cites the selected text; Herdr's
// text says nothing of a selection, so it is the reply, from its start): each line after "> ", at most `max` lines,
// then "> …". A code fence the cut falls in is closed first, so what you type after it is not code. "" for no text.
export const QUOTE_LINES = 40;
export function replyQuote(text, max = QUOTE_LINES) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length === 1 && !lines[0]) return "";
  const cut = lines.length > max, out = [];
  let fence = null; // the fence that is open: its mark, "```" or longer, or "~~~"
  for (const ln of cut ? lines.slice(0, max) : lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(ln);
    if (f && !fence) fence = f[1];
    else if (f && fence && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
    out.push(ln.trim() ? `> ${ln.replace(/\s+$/, "")}` : ">");
  }
  if (cut) {
    while (out.at(-1) === ">") out.pop();
    if (fence) out.push(`> ${fence}`);
    out.push("> …");
  }
  return out.join("\n");
}

// The three functions below are pure (no gpui, no panel), so a node test can run them as they are.
// Prompt history (T3's composerPromptHistory.ts): ↑ and ↓ in the message box walk one line of messages, oldest to
// newest: the prompts sent in this chat, then the messages still queued, then the draft that was in the box.
export const HISTORY_MAX = 100, HISTORY_TEXT_MAX = 20000;

// `list` with a sent prompt at its end: { text, tokens? } (its "@" chips, as a queued message's). The same text twice
// running is kept once, the newer; an empty one or a very long one is not remembered; at most `max`, the newest.
export function pushPrompt(list, entry, max = HISTORY_MAX) {
  const text = String(entry?.text ?? "").trim(), had = Array.isArray(list) ? list : [];
  if (!text || text.length > HISTORY_TEXT_MAX) return had;
  const tokens = Array.isArray(entry.tokens) ? entry.tokens.filter((t) => t?.range && t.range.end <= text.length) : [];
  const next = { text, ...(tokens.length ? { tokens } : {}) };
  return [...(had.at(-1)?.text === text ? had.slice(0, -1) : had), next].slice(-Math.max(1, max));
}

// Where a recalled prompt is in `list` now: where it was found, or, the list having moved, the newest with its text. -> -1 if gone.
export function findPrompt(list, at, text) {
  return list[at]?.text === text ? at : list.findLastIndex((e) => e.text === text);
}

// One step along the line. `history` and `queue`: how many there are of each (the queue counted with the one in the
// box). `at`: where the box's unchanged recalled message is on the line (history 0…, then the queue), or null when
// the box holds no such message; `empty`: the box has no text.
// -> { history: i } | { queue: i } | { draft: true } (the way out, past the newest), or null: the key is the caret's.
// T3's rules: a walk starts only from an empty box; a recalled prompt that was edited is a draft, and no step leaves it.
export function stepPrompt({ dir, history, queue, at, empty }) {
  const n = history + queue;
  if (at != null && (at < 0 || at >= n)) at = null;
  if (dir === "up" ? at == null && !empty : at == null) return null;
  const to = dir === "up" ? (at ?? n) - 1 : at + 1;
  if (to < 0) return null;
  if (to >= n) return { draft: true };
  return to < history ? { history: to } : { queue: to - history };
}

// A queued message's "@" files as the message box's chips: the spans it was typed with, where they still fit its
// text; for one kept by an older build (no spans), each linked file's "@path" found in the text again.
function chipsOf(q, cwd) {
  const text = String(q.text ?? "");
  const fits = (t) => t?.token?.id && Number.isInteger(t.range?.start) && t.range.start >= 0 && t.range.end <= text.length && text.slice(t.range.start, t.range.end) === t.token.text;
  if (Array.isArray(q.tokens)) return q.tokens.filter(fits);
  const out = [], root = String(cwd ?? "").replace(/\/$/, "");
  for (const b of q.blocks ?? []) {
    if (b.type !== "resource_link" || !String(b.uri ?? "").startsWith("file://")) continue;
    let abs; try { abs = decodeURI(b.uri.slice(7)); } catch { continue; }
    const rel = root && abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
    for (let at = text.indexOf(`@${rel}`); at >= 0; at = text.indexOf(`@${rel}`, at + 1)) {
      const end = at + rel.length + 1;
      // A whole word only: "@src/a.js" is not a chip inside "@src/a.json".
      if ((at === 0 || /\s/.test(text[at - 1])) && (end === text.length || /\s/.test(text[end])) && !out.some((t) => t.range.start < end && at < t.range.end))
        out.push({ range: { start: at, end }, token: { id: rel, text: `@${rel}`, label: rel.split("/").pop() } });
    }
  }
  return out.sort((a, b) => a.range.start - b.range.start);
}

// An attached file as it is kept (a queued message, a parked draft, a new chat's first message), and back from there.
const fileOf = (a) => ({ name: a.name, path: a.path, image: a.image === true, type: a.type ?? null, thumb: a.thumb ?? null });
const filesFrom = (list) => (Array.isArray(list) ? list : []).filter((a) => a?.path).slice(0, ATTACH_MAX)
  .map((a) => { const name = a.name ?? String(a.path).split("/").pop(); return { ...fileOf({ ...a, name }), type: a.type ?? IMAGE_TYPES[String(name).split(".").pop().toLowerCase()] ?? null }; });
// The chips of `tokens` that sit whole in the first `len` characters of their text.
const chipsWithin = (tokens, len) => (tokens ?? []).filter((t) => t?.range && t.range.start >= 0 && t.range.end <= len);

// A new chat's first message from its props (agent-acp.js chatLike): `prompt`, its text, and `draft`, what came with
// it from the message box it was typed in ({ blocks, tokens, files }: its "@" files and attachments). -> a message, or null.
export function firstMessage(p) {
  const text = String(p?.prompt ?? "").trim(), d = p?.draft ?? {}, files = filesFrom(d.files);
  if (!text && !files.length) return null;
  return { text, blocks: Array.isArray(d.blocks) ? d.blocks : [], files, tokens: Array.isArray(d.tokens) ? d.tokens : [] };
}

// The prompt stash (T3's ComposerStashMenu): drafts parked to come back to, per project.
// shared("ht3-panels.stash"): { "<machine or empty>:<project folder>": [{ text, at, tokens?, files? }] }, newest first,
// at most 20. `tokens`: the draft's "@" chips ({ range, token }, as a queued message's); `files`: what was attached to it.
const STASH = `${MOD}.stash`;
// How long after a background chat was made it may still step back from in front (init `back`).
const BACK_MS = 5000;
const since = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

// A project's badge, as T3's sidebar and header: two letters of its name ("fleetq" FL, "herdr-layouts" HL).
const initials = (name) => {
  const words = String(name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ((words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2)) || "?").toUpperCase();
};

export class ChatPanel {
  init(p, cx) {
    this.p = p; // kept for Retry, which starts a chat that never got an agent again (begin)
    this.chatId = p.chat ?? null;
    this.source = null;
    this.phase = "loading"; // loading | empty | chat
    this.expanded = {};
    this.follow = true;
    this.picker = null; // option id whose choices are open
    this.since = null; // when the running turn was first seen
    this.hasText = false;
    this.servers = new ServerWatch({ toast: true }).start(cx); // servers this chat's folder started, over the box
    // "Always allow this session" stays on over a reload (it is the person's word, not the agent's).
    this.autoAllow = keptOf(this.chatId).allow === true;
    // Messages queued before a reload wait on: they go out when the agent is back and ready.
    const waiting = keptOf(this.chatId).queue;
    if (Array.isArray(waiting) && waiting.length) this.queue = waiting.map((q) => ({ text: String(q.text ?? ""), blocks: q.blocks ?? [], ...(q.fresh ? { fresh: true } : {}), ...(Array.isArray(q.tokens) ? { tokens: q.tokens } : {}), files: (q.files ?? []).map((a) => ({ ...a, type: a.type ?? IMAGE_TYPES[String(a.name ?? "").split(".").pop().toLowerCase()] ?? null })) }));
    // "/clear" is armed: the next message starts a fresh session (armFresh). Kept, so a reload doesn't undo it.
    this.fresh = keptOf(this.chatId).fresh === true;
    // The prompts sent in this chat, for ↑ in the message box (pushPrompt); kept with the chat, so they outlive a reload.
    const sent = keptOf(this.chatId).history;
    this.history = Array.isArray(sent) ? sent.filter((e) => typeof e?.text === "string" && e.text).slice(-HISTORY_MAX) : [];
    this.recall = null; // the recalled message the box holds: { text, at } (a sent prompt) or { text, queue: true }
    // A chat tab's agent has no terminal: it tells the layout's lists how it is itself (report.js).
    // A side chat is no tab, and a terminal agent's chat has its terminal to speak for it.
    this.reporter = this.chatId && !p.terminal && !p.side ? new Reporter(this.chatId) : null;
    // Started in the background (sendNew): this copy began because its new tab was shown. It takes its place and
    // shows the tab it came from again, at once.
    if (this.reporter && p.back?.tab && Date.now() - Number(p.back.at) < BACK_MS) this.stepBack(cx, p.back.tab);

    this.turnAt = null; // when the running turn of an ACP agent began
    this.hint = HINT;
    this.makeInput();
    // Find in thread (T3's ThreadFindBar): while its bar is open and has text, the lane marks what matches.
    this.finding = false;
    this.findField = InputState.new({ placeholder: "Find in thread" });
    // Find marks every match in the lane and steps through them; a new word goes to its first match.
    this.findAt = 0;
    this.hits = [];
    this.hitAt = new Map();
    this.rowH = new Map(); // each built row's height, to scroll to one (goTo)
    // Mermaid blocks as pictures (mermaid.js): drawn off the UI thread, and each one that settles draws the chat again.
    this.diagrams = new Diagrams({ cli: () => prefs().mermaidCli });
    cx.spawn(async (cx) => { for (;;) { await this.diagrams.next(); cx.notify(); } });
    this.findField.on("change", (_e, cx) => { this.findAt = 0; this.findFresh = true; cx.notify(); });
    this.findField.on("submit", (e, cx) => this.findStep(cx, e?.shift ? -1 : 1));
    this.filter = InputState.new({ placeholder: "Search" });
    this.filter.on("change", (_e, cx) => cx.notify());

    const changed = (cx, urgent) => this.changed(cx, urgent);
    if (p.terminal) {
      this.source = new TermSource({ addr: p.terminal, changed });
      this.source.start(cx);
      this.phase = "chat";
    } else if (this.chatId) {
      const src = new AcpSource({ dir: `${appHome()}/data/${MOD}/chats/${this.chatId}`, machine: p.machine, changed });
      this.source = src;
      cx.spawn(async (cx) => {
        const had = await src.load();
        if (had) {
          this.phase = "chat";
          if (src.resumable) src.restart(cx);
          this.report();
          return cx.notify();
        }
        await this.begin(cx);
      });
    } else {
      this.phase = "empty";
    }
    // The "Working for …" line counts seconds; nothing else here redraws on a timer.
    // It ends with the chat: a side chat's panel closes while the view that made it (sidechat.js) lives on.
    this.tick = cx.timer.every(1000, (cx) => {
      if (this.closed) return;
      // A revert done from its dialog: say so in the chat.
      const rv = shared(`${MOD}.reverted`);
      if (rv && rv.chat === this.chatId && rv.at !== this.revertSeen) {
        const first = this.revertSeen === undefined && Date.now() - rv.at > 5000;
        this.revertSeen = rv.at;
        if (!first && this.source?.kind === "acp" && this.source.state) {
          // Only the newest revert can be undone: an older one's files are no longer what it left.
          const t = this.source.state.transcript, undo = rv.ok && /^[0-9a-f]{40,64}$/.test(String(rv.undo ?? "")) ? rv.undo : null;
          if (rv.ok) for (const m of t.items) if (m.undo) delete m.undo;
          addNotice(t, rv.ok ? `Files are back as they were before "${rv.label}". What was there is kept as checkpoint ${String(rv.undo ?? "").slice(0, 8)}. The agent still remembers what it did.` : `Couldn't revert: ${rv.error}`, rv.ok ? "info" : "error", undo ? { undo } : null);
          this.source.changed?.(cx, true);
        }
      }
      // A hunk picked in the Diff surface with its comment (diff.js `quote`), for the chat of the shown tab: it goes
      // onto the end of the message box as a quoted block, to be read, changed and sent by the person.
      const qt = shared(`${MOD}.quote`);
      if (qt && qt.at !== this.quoteSeen) {
        this.quoteSeen = qt.at;
        if (qt.tab && qt.tab === this.reporter?.tab && Date.now() - qt.at < 10000) {
          this.quoteIn(cx, qt.text);
        }
      }
      // "Regenerate title" in the card's menu (menus.js) asks this chat to name itself.
      const rt = shared(`${MOD}.retitle`);
      if (rt && rt.at !== this.retitleSeen) {
        const stale = this.retitleSeen === undefined && Date.now() - rt.at > 5000;
        this.retitleSeen = rt.at;
        if (!stale && rt.chat === this.chatId) this.retitle(cx);
      }
      // A name given elsewhere (the Inbox's thread menu) shows here and in the lists.
      if (this.named() !== (this.wasNamed ?? null)) { this.wasNamed = this.named(); this.report(); cx.notify(); }
      // The subagent bar counts seconds too, and lets go of a finished one a moment after the turn's end.
      if (this.since != null || this.fitHint() || this.subN) cx.notify();
      // A finished turn nobody saw is "done" until its tab is looked at.
      if (this.reporter?.tab) this.reporter.seen();
      else this.report();
      this.termSync(cx);
    });
  }

  // A chat with no saved state starts its agent: where it is installed is looked up, a first message goes the way every
  // message does, and the agent is started. Again from Retry on the banner, after the program was installed or the
  // machine came back.
  async begin(cx) {
    const p = this.p, src = this.source;
    src.startError = null;
    src.tried = { argv: Array.isArray(p.agent) ? p.agent : AGENTS.find((a) => a.id === p.agent)?.argv ?? [String(p.agent ?? "the agent")] };
    const d = await detect(src.machine);
    src.target = d.target;
    src.remoteError = d.error;
    const argv = argvOf(p.agent, d.found);
    this.phase = "chat";
    // A new chat's first message (a `prompt` prop: send as new chat, New chat on this branch) goes the way every
    // message does, as the first of the queue, sent once the agent is up: so its turn has a checkpoint too.
    // What was attached and named with "@" in the box it was typed in comes along (`draft`).
    const first = firstMessage(p);
    if (argv && first && !this.queue?.length) { this.queue = [first]; this.keepQueue(); }
    // A chat started from a pull request (pr.js): its text waits in the box, not sent. Only a chat with no saved state.
    if (argv && !first && p.seed && !this.input.value()) { this.input.set_value(String(p.seed)); this.hasText = true; }
    if (argv) src.start(cx, argv, p.cwd ?? d.found.HOME ?? home(), null, p.set ?? null);
    else src.startError = d.error ?? `${Array.isArray(p.agent) ? p.agent[0] : p.agent ?? "The agent"} isn't installed.`;
    cx.notify();
  }

  // The banner's Retry: the agent is started again where it ran (and, for a chat that never had one, looked for again).
  retry(cx) {
    const src = this.source;
    if (src?.kind !== "acp" || src.alive) return;
    this.statusHidden = null;
    if (src.state) src.restart(cx);
    else cx.spawn(async (cx) => { await this.begin(cx); cx.notify(); });
    cx.notify();
  }

  // T3's ComposerFreshSession: "/clear" arms a fresh session for the next message, and its banner takes it back.
  // Armed or not it is kept with the chat. `on`: arm; off: keep the current session.
  armFresh(cx, on) {
    if (this.source?.kind !== "acp") return;
    this.fresh = on;
    keep(this.chatId, { fresh: on });
    cx.notify();
  }

  async close(_cx) {
    this.closed = true;
    this.tick?.cancel?.();
    this.reporter?.close();
    await this.source?.close();
  }

  // How long each turn of an ACP agent took, kept on its message so the chat can say "Worked for 1.6s".
  clock() {
    const s = this.source?.kind === "acp" ? this.source.state : null;
    if (!s) return;
    const working = this.source.word() === "working";
    if (working) this.turnAt ??= Date.now();
    else if (this.turnAt != null) {
      const items = s.transcript.items;
      for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user") { items[i].took = Date.now() - this.turnAt; break; }
      // A turn that ends with nothing said (Pi does this when its model can't be reached) would read as if
      // the message was never sent.
      if (items.at(-1)?.kind === "user" && this.source.alive) addNotice(s.transcript, "The agent ended the turn without a reply. Check its model or its sign-in.", "warn");
      this.turnAt = null;
      this.whereabouts();
    }
    if (this.whereAsked == null) this.whereabouts();
  }

  // The branch its folder is on, for its card in the lists: asked at the start and after each turn.
  whereabouts() {
    const s = this.source?.kind === "acp" ? this.source.state : null;
    if (!this.reporter || !s?.cwd || this.whereAsking) return;
    this.whereAsking = true;
    this.whereAsked = Date.now();
    exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: s.cwd, on: s.machine ?? null, timeout: 10000 })
      .then((r) => (r.code === 0 ? r.stdout.trim() : null), () => null)
      .then((branch) => {
        this.whereAsking = false;
        this.reporter.where = { branch: branch || null, machine: s.machine ?? null };
        this.report();
      });
  }

  // The composer's field. Its placeholder can't be changed once made and never wraps, so a lane too narrow
  // for the long one gets a field with the short one, swapped only while nothing is typed.
  makeInput() {
    this.input = TextareaState.new({ placeholder: this.hint });
    this.input.set_auto_grow(2, 8);
    // A textarea's Enter inserts a newline and then submits; Shift+Enter submits with `shift`.
    this.input.on("submit", (e, cx) => {
      if (e?.shift) return;
      // With a menu open Enter takes its marked row (the newline Enter left goes with the word).
      const items = this.trig && this.view ? this.menuItems(this.view) : [];
      if (items.length) { const v = this.input.value(); if (v.endsWith("\n")) { this.input.set_value(v.slice(0, -1)); this.trig = trigger(v.slice(0, -1)); } return this.choose(cx, items[Math.min(this.hot ?? 0, items.length - 1)]); }
      this.send(cx);
    });
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.input.on("change", (_e, cx) => {
      const has = this.input.value().trim().length > 0;
      const changed = this.typed(cx);
      // A recalled message that was edited is a draft like any other (recalled).
      if (this.recall && this.input.value() !== this.recall.text) this.recall = null;
      // A queued message being edited that was emptied, with no draft to return to, is no edit any more.
      if (this.editing && !this.parked && !has && !this.attached?.length) { this.editing = null; cx.notify(); }
      if (has !== this.hasText || changed) { this.hasText = has; cx.notify(); }
    });
  }

  // After each edit: which menu the word being typed opens, if any. -> whether it changed.
  typed(cx) {
    const t = trigger(this.input.value()), was = this.trig;
    this.trig = t;
    if (t?.kind !== was?.kind || t?.query !== was?.query) { this.hot = 0; if (t?.kind === "skill") this.findSkills(cx); if (t?.kind === "path") this.findFiles(cx); return true; }
    return false;
  }

  // The skills on disk where the chat runs: Claude Code's (~/.claude/skills and the project's
  // .claude/skills), each a folder with a SKILL.md. Looked up once per chat, when "$" is first typed.
  findSkills(cx) {
    if (this.skills) return;
    this.skills = [];
    const v = this.view, on = v?.machine ?? undefined;
    cx.spawn(async (cx) => {
      const script = `for d in "$HOME/.claude/skills" ${v?.cwd ? shq(`${String(v.cwd).replace(/\/$/, "")}/.claude/skills`) : ""}; do for f in "$d"/*/SKILL.md; do [ -f "$f" ] && printf '%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(sed -n 's/^description: *//p' "$f" | head -1 | cut -c1-200)"; done; done`;
      const r = await exec("/bin/sh", ["-c", script], { on }).catch(() => null);
      const seen = new Set();
      this.skills = String(r?.stdout ?? "").split("\n").filter(Boolean).map((l) => { const [name, description] = l.split("\t"); return { name, description: (description ?? "").replace(/^["']|["']$/g, ""), skill: true }; })
        .filter((x) => !seen.has(x.name) && seen.add(x.name));
      cx.notify();
    });
  }

  // Files dropped on the chat, picked with the paperclip or pasted (a picture on the clipboard).
  addFiles(cx, paths) {
    this.attached ??= [];
    for (const path of paths ?? []) {
      if (this.attached.length >= ATTACH_MAX || this.attached.some((a) => a.path === path)) continue;
      const name = String(path).split("/").pop(), ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      const a = { path, name, image: ext in IMAGE_TYPES, type: IMAGE_TYPES[ext] ?? null, thumb: null };
      this.attached.push(a);
      // image() shows files under Herdr's own folder only: a small copy there is the thumbnail.
      if (a.image && this.chatId) cx.spawn(async (cx) => {
        const rel = `data/${MOD}/chats/${this.chatId}/attachments`, file = `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`;
        const r = await exec("/bin/sh", ["-c", `mkdir -p ${shq(`${appHome()}/${rel}`)} && sips -Z 256 -s format png ${shq(path)} --out ${shq(`${appHome()}/${rel}/${file}`)} >/dev/null 2>&1`]).catch(() => null);
        if (r?.code === 0) { a.thumb = `${rel}/${file}`; cx.notify(); }
      });
    }
    cx.notify();
  }

  // The paperclip: the system's file dialog (Herdr's own picks folders only).
  pickFiles(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("osascript", ["-e", 'set out to ""', "-e", "repeat with f in (choose file with prompt \"Attach files\" with multiple selections allowed)", "-e", "set out to out & POSIX path of f & linefeed", "-e", "end repeat", "-e", "return out"]).catch(() => null);
      if (r?.code === 0) this.addFiles(cx, r.stdout.split("\n").map((x) => x.trim()).filter(Boolean));
    });
  }

  // Cmd+V with a picture on the clipboard (the text area says "paste_other"): saved as a PNG in the chat's folder, then attached.
  pasteImage(cx) {
    if (!this.chatId) return;
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/data/${MOD}/chats/${this.chatId}/attachments`, file = `${dir}/pasted-${Date.now()}.png`;
      const r = await exec("/bin/sh", ["-c", `mkdir -p ${shq(dir)} && osascript -e 'set d to the clipboard as «class PNGf»' -e 'set fh to open for access POSIX file ${JSON.stringify(file)} with write permission' -e 'write d to fh' -e 'close access fh'`]).catch(() => null);
      if (r?.code === 0) this.addFiles(cx, [file]);
    });
  }

  // What goes to the agent for the attached files: a picture as an ACP image block when the agent
  // takes them (shrunk first when large), anything else as a resource link to the file.
  async attachmentBlocks(v) {
    const blocks = [];
    for (const a of this.sending ?? []) {
      if (a.image && v.images) {
        const dir = `${appHome()}/data/${MOD}/chats/${this.chatId}/attachments`, small = `${dir}/sent-${Date.now()}.jpg`;
        const script = `if [ "$(stat -f%z ${shq(a.path)})" -gt ${IMAGE_MAX} ]; then mkdir -p ${shq(dir)} && sips -Z 1568 -s format jpeg ${shq(a.path)} --out ${shq(small)} >/dev/null 2>&1 && printf 'image/jpeg\\n' && base64 -i ${shq(small)}; else printf '%s\\n' ${shq(a.type)} && base64 -i ${shq(a.path)}; fi`;
        const r = await exec("/bin/sh", ["-c", script]).catch(() => null);
        const at = r?.code === 0 ? r.stdout.indexOf("\n") : -1;
        if (at > 0) { blocks.push({ type: "image", mimeType: r.stdout.slice(0, at), data: r.stdout.slice(at + 1).replace(/\s+/g, "") }); continue; }
      }
      blocks.push({ type: "resource_link", uri: `file://${encodeURI(a.path)}`, name: a.name, ...(a.type ? { mimeType: a.type } : {}) });
    }
    return blocks;
  }

  // The files "@" can name: the folder's tracked and untracked files (not the ignored), where the
  // chat runs; without git, what `find` gives. Listed when "@" is typed, again after 30 seconds.
  findFiles(cx) {
    const v = this.view, f = this.files;
    if (!v?.cwd || f?.loading || (f?.list && Date.now() - f.at < 30000)) return;
    this.files = { list: f?.list ?? null, at: f?.at ?? 0, loading: true };
    const opt = { cwd: v.cwd, on: v.machine ?? undefined };
    cx.spawn(async (cx) => {
      let list = [];
      try {
        let r = await exec("git", ["ls-files", "-co", "--exclude-standard"], opt).catch(() => null);
        if (r?.code !== 0) r = await exec("sh", ["-c", "find . -type f -not -path './.git/*' -not -path '*/node_modules/*' | head -n 20000 | sed 's|^\\./||'"], opt);
        list = r.stdout.split("\n").filter(Boolean).slice(0, 20000);
      } catch {}
      this.files = { list, at: Date.now(), loading: false };
      cx.notify();
    });
  }

  // What the open menu lists (chat/ComposerCommandMenu.tsx): T3's own commands and the agent's for
  // "/", the skills for "$" (as T3: the agent's commands that are skills, and those on disk).
  menuItems(v) {
    const t = this.trig;
    if (!t) return [];
    const q = t.query.toLowerCase();
    if (t.kind === "path") {
      // The name first, then the path; a name that starts with what was typed before one that only has it.
      const out = [];
      for (const path of this.files?.list ?? []) {
        const low = path.toLowerCase(), base = low.slice(low.lastIndexOf("/") + 1);
        const rank = !q ? 2 : base.startsWith(q) ? 0 : base.includes(q) ? 1 : low.includes(q) ? 2 : subseq(q, low) ? 3 : 4;
        if (rank < 4) out.push({ name: path, file: true, rank });
      }
      // Letters merely in order count only when little else matches.
      const near = out.filter((x) => x.rank < 3);
      return (near.length >= 5 ? near : out).sort((a, b) => a.rank - b.rank || a.name.length - b.name.length).slice(0, 50);
    }
    const agent = (v.commands ?? []).map((c) => ({ name: c.name, description: c.description ?? "" }));
    const all = t.kind === "slash" ? [...LOCAL_COMMANDS.filter((c) => (c.name !== "model" || v.options.some((o) => (o.category ?? o.id) === "model")) && (c.name !== "clear" || this.source.kind === "acp")), ...agent.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))]
      : [...(this.skills ?? []), ...agent.filter((c) => /skill/i.test(c.name) && !(this.skills ?? []).some((s) => s.name === c.name)).map((c) => ({ ...c, skill: true }))];
    const rank = (c) => (c.name.toLowerCase().startsWith(q) ? 0 : c.name.toLowerCase().includes(q) ? 1 : (c.description ?? "").toLowerCase().includes(q) ? 2 : 3);
    return all.filter((c) => !q || rank(c) < 3).sort((a, b) => rank(a) - rank(b)).slice(0, 50);
  }

  // Enter, Tab or a click on a row of the menu. T3's own commands run at once; an agent's command or a
  // skill takes the word's place as "/name " so its arguments can follow, and Enter sends it.
  choose(cx, item) {
    const t = this.trig, text = this.input.value();
    if (!t || !item) return;
    const before = text.slice(0, t.start);
    this.trig = null;
    if (item.file) {
      // chat/FileTagChip.tsx: the file becomes a chip in the text; it goes to the agent as a resource link.
      this.input.replace_range_with_token({ start: t.start, end: text.length }, { id: item.name, text: `@${item.name}`, label: item.name.split("/").pop() });
      this.input.replace(" ");
      this.hasText = true;
      this.input.focus();
      return cx.notify();
    }
    if (item.local && !item.args) {
      // The command's word goes; what was typed before it stays, with its "@" chips.
      this.input.set_value({ text: before, tokens: chipsWithin(this.input.content().tokens, before.length) });
      this.hasText = !!before.trim();
      if (item.name === "model") this.openPicker("model", true);
      if (item.name === "clear") this.armFresh(cx, true);
      if (item.name === "side") run(`${MOD}.add:chat`);
      if (item.name === "new") openLauncher();
      if (item.name === "fork") this.fork(cx);
      if (item.name === "usage") run(`${MOD}.usage`);
      if (item.name === "find") return this.setFind(cx, true);
      if (item.name === "copy") this.copyThread(cx);
      if (item.name === "branch" && this.source.kind === "acp" && this.source.state) chatLike(this.source.state);
      if (item.name === "terminal") this.toggleTerminal(cx);
      if (item.name === "title") this.retitle(cx);
      if (item.name === "send-new" || item.name === "send-background") return this.sendNew(cx, item.name === "send-background");
      // With a draft before "/stash" it is parked; alone, the parked drafts open.
      if (item.name === "stash") { if (before.trim()) this.stash(cx); else this.picker = "__stash"; }
    } else {
      this.input.set_value(`${before}/${item.name} `);
      this.hasText = true;
      this.input.focus();
    }
    cx.notify();
  }

  // Not while drawing: a field can't be made then. From the field's size changing and the one-second timer.
  fitHint() {
    const hint = this.fieldW != null && this.fieldW < HINT_ROOM ? HINT_SHORT : HINT;
    if (hint === this.hint || this.input.value() !== "") return false;
    this.hint = hint;
    this.makeInput();
    return true;
  }

  // The thread's own name (threadActionMenu "Rename thread"), kept by chat in shared("ht3-panels.named");
  // without one a chat goes by its first message.
  named() {
    return (this.chatId && shared(`${MOD}.named`)?.[this.chatId]) || null;
  }

  rename(cx, name) {
    if (!this.chatId) return;
    const all = { ...(shared(`${MOD}.named`) ?? {}) }, to = String(name ?? "").trim().slice(0, 120);
    if (to) all[this.chatId] = to; else delete all[this.chatId];
    setShared(`${MOD}.named`, all);
    this.report();
    cx.notify();
  }

  // What the agent offers as models, for Settings to list: remembered when it changes.
  models() {
    const s = this.source?.kind === "acp" ? this.source.state : null, o = s?.configOptions?.find((x) => x.type === "select" && (x.category ?? x.id) === "model");
    if (!o || o.options === this.modelsSeen) return;
    this.modelsSeen = o.options;
    rememberModels(agentOf(s.agentArgv)?.id, [{ id: o.id, category: o.category, choices: o.options.map((c) => ({ value: c.value, name: c.name })) }]);
  }

  // Waiting for a permission is "blocked": the session itself still says working.
  report() {
    const s = this.source?.state;
    if (this.reporter && s) this.reporter.update(s.permission && this.source.alive ? "blocked" : this.source.word(), s.agentArgv, s.agentInfo?.title ?? s.agentInfo?.name,
      this.named() ?? s.transcript.items.find((m) => m.kind === "user")?.text,
      { cwd: s.cwd, machine: s.machine ?? null, ask: s.permission?.title ?? null, crumb: this.crumb({ cwd: s.cwd, machine: s.machine, items: s.transcript.items, status: this.source.word(), permission: s.permission, usage: s.transcript.usage, name: "Agent" }) });
  }

  // An approval the agent waits for: told to the lists (shared "ht3-panels.asks", report.js) so the Inbox card can
  // answer it, and answered at once while "Always allow this session" is on. While it waits, the lists'
  // answers (shared "ht3-panels.answers") are looked for three times a second; nothing polls otherwise.
  asking(cx) {
    if (this.source?.kind !== "acp") return;
    const p = this.source.alive ? this.source.state?.permission ?? null : null, tab = this.reporter?.tab;
    if (p && p !== this.askFor) { this.askFor = p; this.askId = `${Date.now()}`; }
    if (!p) this.askFor = null;
    if (p && this.autoAllow) {
      const yes = p.options.find((o) => o.kind === "allow_once") ?? p.options.find((o) => o.kind?.startsWith("allow"));
      if (yes) { addNotice(this.source.state.transcript, `Allowed automatically: ${p.title}`); return this.source.answer(cx, yes.optionId); }
    }
    if (!tab) return;
    const all = shared(`${MOD}.asks`) ?? {}, mine = p ? { id: this.askId, title: p.title, options: p.options } : null;
    if (JSON.stringify(all[tab] ?? null) !== JSON.stringify(mine)) {
      const next = { ...all };
      if (mine) next[tab] = mine; else delete next[tab];
      setShared(`${MOD}.asks`, next);
    }
    if (p && !this.askWatch) {
      this.askWatch = true;
      const look = (cx) => {
        const now = this.source.alive && !this.closed ? this.source.state?.permission : null, t = this.reporter?.tab;
        if (!now) { this.askWatch = false; return; }
        const answers = shared(`${MOD}.answers`) ?? {}, a = t ? answers[t] : null;
        if (a && a.ask === this.askId) {
          const rest = { ...answers };
          delete rest[t];
          setShared(`${MOD}.answers`, rest);
          if (a.always) this.allow(true);
          this.askWatch = false;
          this.source.answer(cx, a.optionId);
          return cx.notify();
        }
        cx.timer.after(300, look);
      };
      cx.timer.after(300, look);
    }
  }

  // "focus" from pane.go. For scripts, as the `+` menu's key:<key>: `ht3-panels.say:<text>` sends a
  // message in the shown chat, `pick:<option id>` (pick:model) opens or closes that control's choices,
  // `choose:<option id>=<value>` picks one, `answer:<answer id>` answers an approval, `stop` is the stop
  // button, and `fold:<row id>` opens or closes a row (a work row's id, `__startup`, `__worked-<message id>`).
  command(c, cx) {
    if (c === "focus") this.input.focus();
    // No chat here yet: nothing else has anything to act on.
    if (!this.source) return cx.notify();
    if (c.startsWith("say:")) { this.input.set_value(c.slice(4)); this.hasText = true; this.send(cx); }
    if (c.startsWith("pick:")) { this.picker = this.picker === c.slice(5) ? null : c.slice(5); this.filter.set_value(""); }
    if (c.startsWith("answer:")) this.source?.answer(cx, c.slice(7));
    if (c === "stop") this.source?.stop();
    // allow-always: the drawer's "Always allow this session"; ask-again turns it off.
    if (c === "allow-always") this.allowAlways(cx);
    if (c === "ask-again") this.allow(false);
    // stash parks the draft, stash:menu opens or closes the parked drafts, unstash:<n> brings the nth back, stash:drop:<n> deletes it.
    if (c === "stash") this.stash(cx);
    if (c === "stash:menu") this.picker = this.picker === "__stash" ? null : "__stash";
    if (c.startsWith("unstash:")) this.unstash(cx, Number(c.slice(8)));
    if (c.startsWith("stash:drop:")) this.dropStash(cx, Number(c.slice(11)));
    // title is "/title": the agent names the thread (retitle).
    if (c === "title") this.retitle(cx);
    // clear is "/clear": the next message starts a fresh session; keep-session takes it back (the banner's button).
    // retry, copy-command, open-terminal: the agent status banner's buttons (statusBanner).
    if (c === "clear") this.armFresh(cx, true);
    if (c === "keep-session") this.armFresh(cx, false);
    if (c === "retry") this.retry(cx);
    if (c === "copy-command") { const pr = this.source.view().problem; if (pr) this.copy(cx, "status-cmd", pr.command); }
    if (c === "open-terminal" && this.reporter?.pane) this.openTerminal(this.reporter.pane);
    // chat:effort-up, chat:effort-down, chat:mode (the agent's next mode) and chat:model (its picker): the composer's keys
    // (keys.json: "ht3-panels.chat:effort-up"). They act on the chat of the focused tab (chatKey).
    if (c.startsWith("chat:")) this.chatKey(cx, c.slice(5));
    // term: the chat's own terminal under it (toggleTerminal); the layout's key.
    if (c === "term") this.toggleTerminal(cx);
    // send:new and send:background: the draft becomes the first message of a new chat (sendNew); the layout's keys.
    if (c === "send:new" || c === "send:background") this.sendNew(cx, c === "send:background");
    // new:here is "/branch": a new chat with this one's agent in this one's folder (its branch).
    if (c === "new:here" && this.source.kind === "acp" && this.source.state) chatLike(this.source.state);
    // copy:thread is "/copy": the thread as Markdown on the clipboard.
    if (c === "copy:thread") this.copyThread(cx);
    // find:<text> opens the find bar with that text (find alone: opens or closes it), find: closes it.
    // find:next and find:prev step through the matches (Enter and Shift+Enter in the bar); goto:<row id> scrolls to a row.
    if (c === "find:next" || c === "find:prev") { this.findStep(cx, c === "find:next" ? 1 : -1); return cx.notify(); }
    if (c.startsWith("goto:")) { this.goTo(c.slice(5)); return cx.notify(); }
    if (c === "find") this.setFind(cx, !this.finding);
    if (c.startsWith("find:")) this.setFind(cx, !!c.slice(5), c.slice(5));
    // plan: the composer's Plan toggle; implement: the last plan card's "Implement this plan".
    if (c === "plan") this.togglePlan(cx);
    if (c === "implement") this.implementPlan(cx);
    if (c.startsWith("choose:")) { const at = c.indexOf("=", 7); if (at > 0) { this.source?.setOption(c.slice(7, at), c.slice(at + 1)); this.picker = null; } }
    if (c.startsWith("fold:")) this.expanded[c.slice(5)] = !this.expanded[c.slice(5)];
    // For scripts, what the Copy buttons, a right-click and Cmd+V do: copy:last (the last reply),
    // copy:code (its last code block), copy:<row id>, ctx:last (the right-click menu of the last
    // reply), paste (the clipboard's text into the message box, at the caret).
    if (c.startsWith("copy:") || c === "ctx:last") {
      const items = this.view?.items ?? [], what = c.slice(c.indexOf(":") + 1);
      const last = [...items].reverse().find((m) => m.kind === "agent");
      const m = what === "last" || what === "code" ? last : items.find((x) => String(x.id) === what);
      const text = what === "code" ? segments(m?.text).filter((x) => x.code).pop()?.text : m?.text;
      if (text != null && c.startsWith("ctx:")) this.copyMenu({ x: 600, y: 300 }, text, m.id);
      else if (text != null) this.copy(cx, `${m.id}:cp`, text);
    }
    // quote:last and quote:<item id>: a reply's Quote. subagent:<n>: a click on the nth subagent in the bar (from 0).
    if (c.startsWith("quote:")) {
      const items = this.view?.items ?? [], w = c.slice(6);
      const m = w === "last" ? [...items].reverse().find((x) => x.kind === "agent") : items.find((x) => x.kind === "agent" && String(x.id) === w);
      if (m?.text) this.quoteReply(cx, `${m.id}:cp`, m.text);
    }
    if (c.startsWith("subagent:")) { const s = subagents(this.view?.items ?? [])[Number(c.slice(9)) || 0]; if (s) this.subJump(cx, s.id); }
    // For scripts: type:<text> (as if typed into the message box), take:<n> (the open menu's nth row, from 0), send (the Send button),
    // menu-key:<up|down|enter|escape>.
    if (c.startsWith("type:")) { this.input.set_value(c.slice(5)); this.hasText = !!c.slice(5).trim(); this.typed(cx); }
    if (c === "send") this.send(cx);
    // hover:<item id>: as the pointer over that message (its copy icon shows); hover: alone, off.
    if (c.startsWith("hover:")) this.over = c.slice(6) || null;
    // queue:<steer|up|down|edit|drop>:<n>: a queued message's buttons (n from 0, or "last"). queue:back: the message
    // being edited goes back to the queue and the draft it took the place of returns (backToDraft).
    if (c === "queue:back") this.backToDraft(cx);
    else if (c.startsWith("queue:")) { const [, what, n] = c.split(":"); this.queued(cx, what, n === "last" ? (this.queue?.length ?? 1) - 1 : Number(n) || 0); }
    // turn-diff:<last|item id> and revert:<last|item id>: "View diff" and "Revert" of a turn that changed files.
    // undo-revert: the Undo of the last revert's note.
    if (c === "undo-revert") this.undoRevert(cx, this.source.state?.transcript?.items.findLast((m) => m.undo));
    if (c.startsWith("turn-diff:") || c.startsWith("revert:")) {
      const w = c.slice(c.indexOf(":") + 1);
      const m = [...(this.view?.items ?? [])].reverse().find((x) => x.kind === "user" && x.cp?.after && x.cp.files > 0 && (w === "last" || String(x.id) === w));
      if (m && c.startsWith("turn")) this.turnDiff(m); else if (m) this.askRevert({ x: 700, y: 400 }, m);
    }
    // fork (the whole thread), fork:last (up to the last reply), fork:<item id> (up to that message).
    if (c === "fork" || c.startsWith("fork:")) { const w = c.slice(5); this.fork(cx, !w ? null : w === "last" ? [...(this.view?.items ?? [])].reverse().find((m) => m.kind === "agent")?.id : w); }
    if (c.startsWith("rename:")) this.rename(cx, c.slice(7));
    // attach:<path> (as a dropped file), detach:<n>, paste-image (as Cmd+V with a picture on the clipboard).
    if (c.startsWith("attach:")) this.addFiles(cx, [c.slice(7)]);
    if (c.startsWith("detach:")) this.attached?.splice(Number(c.slice(7)), 1);
    if (c === "paste-image") this.pasteImage(cx);
    if (c.startsWith("take:")) this.choose(cx, this.menuItems(this.view)[Number(c.slice(5))]);
    if (c.startsWith("menu-key:")) this.menuKey(c.slice(9), cx);
    if (c.startsWith("scroll:")) { if (c === "scroll:end") { this.follow = true; this.off = 0; } else this.wheel(Number(c.slice(7)) || 0, 1e9, cx); }
    if (c === "paste") { const text = cx.read_from_clipboard(); if (text) { this.input.replace(text); this.hasText = !!this.input.value().trim(); } }
    cx.notify();
  }

  // A chat's pin outlives its tab. The lists keep pins by address (shared "agents.pins": `pane:<id>`), and a chat
  // reopened from Earlier chats has a new pane. So the chat keeps its own pin by chat id (kept `pin`): once it knows
  // its pane it puts a kept pin back on the new address, and from then on follows what the lists say.
  pinSync() {
    const pane = this.reporter?.pane;
    if (!pane || !this.chatId) return;
    const me = `pane:${pane}`, pins = shared("agents.pins") ?? [], on = pins.includes(me);
    if (this.pinFor !== me) {
      this.pinFor = me;
      if (keptOf(this.chatId).pin === true && !on) return setShared("agents.pins", [...pins, me]);
    }
    if (on !== (keptOf(this.chatId).pin === true)) keep(this.chatId, { pin: on });
  }

  // Draws at most every DRAW_EVERY_MS, at once when urgent.
  changed(cx, urgent) {
    this.report();
    this.models();
    this.clock();
    this.turnEnded(cx);
    this.drain(cx);
    this.asking(cx);
    this.pinSync();
    this.termSync(cx);
    const draw = (cx) => {
      cx.notify();
    };
    if (urgent) return draw(cx);
    if (this.drawSoon) return;
    this.drawSoon = true;
    cx.timer.after(DRAW_EVERY_MS, (cx) => { this.drawSoon = false; draw(cx); });
  }

  send(cx) {
    const v = this.view;
    const text = this.input.value().trim(), files = this.source.kind === "acp" ? this.attached ?? [] : [];
    // "/rename New name" is T3's own: it names the thread, nothing is sent ("/rename" alone: its first message again).
    const naming = /^\/rename(?:\s+([\s\S]*))?$/.exec(text);
    if (naming) { this.input.set_value(""); this.hasText = false; this.trig = null; return this.rename(cx, naming[1] ?? ""); }
    // "/clear" is T3's own as well (ComposerFreshSession): the next message starts a fresh session. Not on an agent that is a terminal's.
    if (/^\/clear$/.test(text) && this.source.kind === "acp") { this.input.set_value(""); this.hasText = false; this.trig = null; return this.armFresh(cx, true); }
    if ((!text && !files.length) || !v?.alive) return;
    const payload = this.boxMessage(v);
    // Armed by "/clear": this message begins a fresh session, once the agent is ready for it (dispatch). Once it is sent
    // the next ones are the new session's.
    if (this.fresh && this.source.kind === "acp") { payload.fresh = true; this.armFresh(cx, false); }
    // A queued message that was being edited goes back to its place; the draft it was set before returns to the box.
    const editing = this.editing, parked = this.parked;
    this.editing = this.parked = this.recall = null;
    this.input.set_value(parked?.content ?? "");
    this.hasText = !!parked?.content.text.trim();
    this.trig = null;
    this.follow = true;
    this.attached = parked?.files ?? [];
    // An ACP agent takes one message per turn. One sent while it works waits in a queue for the turn to end
    // (QueuedRunsControl.tsx), or, with "Steer instead of queue" on, interrupts it and goes in at once.
    // A new chat still setting its model holds its messages too (agent-acp.js `settingUp`).
    if (this.source.kind === "acp" && (v.status !== "ready" || this.sending || this.queue?.length || this.source.settingUp)) {
      this.queue ??= [];
      // Steer: into the running turn where the agent takes it, else the turn ends and this is the next message (session.js steer).
      if (followUp() === "steer" && ["working", "blocked"].includes(v.status) && !this.sending && !payload.fresh) return this.dispatch(cx, payload, true);
      this.queue.splice(Math.min(editing?.at ?? this.queue.length, this.queue.length), 0, payload);
      this.keepQueue();
      this.drain(cx);
      return cx.notify();
    }
    this.dispatch(cx, payload);
  }

  // What the message box holds, as a message: { text, blocks, files, tokens }.
  boxMessage(v) {
    const raw = this.input.value(), text = raw.trim(), lead = raw.length - raw.trimStart().length;
    const acp = this.source.kind === "acp", spans = acp ? this.input.tokens() : [];
    // Each file named with "@" goes along as an ACP resource link (the text keeps its "@path").
    const seen = new Set(), blocks = [];
    for (const s of spans) {
      const path = s.token.id;
      if (seen.has(path)) continue;
      seen.add(path);
      const abs = path.startsWith("/") ? path : `${String(v.cwd ?? "").replace(/\/$/, "")}/${path}`;
      blocks.push({ type: "resource_link", uri: `file://${encodeURI(abs)}`, name: path.split("/").pop() });
    }
    // Where the chips sit in the trimmed text, so a queued message edited again gets them back (chipsOf).
    const tokens = spans.map((s) => ({ range: { start: s.range.start - lead, end: s.range.end - lead }, token: { id: s.token.id, text: s.token.text, ...(s.token.label ? { label: s.token.label } : {}) } }))
      .filter((s) => s.range.start >= 0 && s.range.end <= text.length);
    return { text, blocks, files: acp ? [...(this.attached ?? [])] : [], tokens };
  }

  // The next queued message goes out once the agent is ready for one.
  drain(cx) {
    if (!this.queue?.length || this.sending || this.source.kind !== "acp" || !this.source.alive || this.source.word() !== "ready" || this.source.settingUp) return;
    const next = this.queue.shift();
    this.keepQueue();
    this.dispatch(cx, next);
  }

  keepQueue() {
    keep(this.chatId, { queue: (this.queue ?? []).map((q) => ({ text: q.text, blocks: q.blocks, ...(q.fresh ? { fresh: true } : {}), ...(Array.isArray(q.tokens) ? { tokens: q.tokens } : {}), files: q.files.map(fileOf) })) });
  }

  // A queued message's buttons: steer (it goes in now), up and down (its place), edit (back into the message box), drop.
  queued(cx, what, i) {
    const q = this.queue?.[i];
    if (!q) return;
    this.queue.splice(i, 1);
    // Only a running turn can be steered: before one (the agent still starting, or a message on its way) it goes to the front.
    if (what === "steer") { if (this.source.word() !== "working" || this.sending) { this.queue.unshift(q); this.drain(cx); } else this.dispatch(cx, q, true); }
    // up and down: its place in the queue.
    if (what === "up" || what === "down") this.queue.splice(Math.max(0, Math.min(this.queue.length, i + (what === "up" ? -1 : 1))), 0, q);
    if (what === "edit") {
      // A sent prompt recalled with ↑ and left as it was is no draft: it gives way.
      const again = this.recalled() && !this.recall.queue;
      const now = this.input.content(), files = again ? [] : this.attached ?? [], has = !again && (!!now.text.trim() || files.length > 0);
      // The box is not empty. If it holds another queued message being edited, that one goes back to the queue, where
      // this one was. Else it is a draft: it is set aside, whole (its "@" files and attachments), and comes back
      // when this message is sent or put back (backToDraft).
      if (has && this.editing) this.queue.splice(Math.min(i, this.queue.length), 0, this.boxMessage(this.view ?? this.source.view()));
      else if (has) this.parked = { content: { text: now.text, tokens: now.tokens ?? [] }, files };
      this.editing = { at: i };
      this.recall = { text: q.text, queue: true };
      this.attached = [...q.files];
      // Its "@" files come back as chips, so sending it again links them again.
      this.input.set_value({ text: q.text, tokens: chipsOf(q, (this.view ?? this.source.view()).cwd) });
      this.hasText = !!q.text.trim();
      this.trig = null;
      this.input.focus();
    }
    this.keepQueue();
    cx.notify();
  }

  // "Back to draft" over the message box while a queued message is being edited: the message goes back to the queue
  // where it was (an emptied box drops it), and the draft that was set aside returns.
  // The same for a sent prompt recalled over a draft: the prompt is dropped and the draft returns.
  backToDraft(cx) {
    if (!this.editing && !this.parked) return;
    const msg = this.boxMessage(this.view ?? this.source.view()), parked = this.parked;
    if (this.editing && (msg.text || msg.files.length)) { this.queue ??= []; this.queue.splice(Math.min(this.editing.at, this.queue.length), 0, msg); }
    this.editing = this.parked = this.recall = null;
    this.attached = parked?.files ?? [];
    this.input.set_value(parked?.content ?? "");
    this.hasText = !!parked?.content.text.trim();
    this.trig = null;
    this.keepQueue();
    this.drain(cx);
    cx.notify();
  }

  // Whether the box still holds the message ↑ or ↓ (or a queued message's Edit) put there, as it was put: a queued
  // message being edited, or a sent prompt with nothing attached to it since.
  recalled() {
    const r = this.recall;
    return !!r && this.input.value() === r.text && (r.queue ? !!this.editing : !this.editing && !this.attached?.length);
  }

  // ↑ ("up") and ↓ ("down") in the message box (stepPrompt). ↑ in an empty box brings back the last queued message
  // to be edited, then the ones before it, then the prompts sent in this chat, newest first; ↓ walks forward again
  // and, past the newest, returns the draft the walk began on (its attachments; the box had no text). A queued message
  // passed by goes back to its place in the queue. -> whether the key was taken (else it is the caret's).
  recallKey(cx, dir) {
    const on = this.recalled(), r = on ? this.recall : null, list = this.history ?? [];
    // An edited queued message, or one emptied: the arrows are the caret's, and its own buttons the way out.
    if (!on && this.editing) return false;
    const waiting = (this.queue?.length ?? 0) + (r?.queue ? 1 : 0);
    const at = !r ? null : r.queue ? list.length + Math.min(this.editing.at, waiting - 1) : findPrompt(list, r.at, r.text);
    const step = stepPrompt({ dir, history: list.length, queue: waiting, at: at != null && at < 0 ? null : at, empty: !this.input.value().trim() });
    if (!step) return false;
    const v = this.view ?? this.source.view();
    // What the box held leaves it: a queued message goes back where it was, a sent prompt is only dropped, and a
    // draft (the files attached to an empty box) is set aside, to return past the newest or when a message is sent.
    if (r?.queue) this.queue.splice(Math.min(this.editing.at, this.queue.length), 0, this.boxMessage(v));
    else if (!r && this.attached?.length) this.parked = { content: { text: "", tokens: [] }, files: this.attached };
    this.editing = this.recall = null;
    this.attached = [];
    this.trig = null;
    if (step.queue != null) {
      this.input.set_value("");
      this.queued(cx, "edit", step.queue);
    } else {
      const e = step.draft ? null : list[step.history], parked = step.draft ? this.parked : null;
      if (step.draft) this.parked = null;
      else this.recall = { text: e.text, at: step.history };
      if (parked) this.attached = parked.files ?? [];
      // A sent prompt's "@" files come back as chips, so sending it again links them again.
      this.input.set_value(e ? { text: e.text, tokens: this.source.kind === "acp" ? chipsOf(e, v.cwd) : [] } : parked?.content ?? "");
      this.hasText = !!this.input.value().trim();
      this.trig = null;
      this.keepQueue();
      this.drain(cx);
    }
    // The caret at the end, as a shell leaves it: ↓ goes on from there, ↑ climbs the lines first where the box moves it.
    try { const n = this.input.value().length; this.input.set_selected_range({ start: n, end: n }); } catch {}
    cx.notify();
    return true;
  }

  // Sends one message: { text, blocks (ACP blocks for "@" files), files (attachments) }. `steer`: for the turn that is running.
  dispatch(cx, msg, steer = false) {
    const { text, blocks, files, tokens } = msg;
    // A message that begins a fresh session: the session is made first (agent-acp.js freshSession), then the message
    // goes on as any other. Nothing else is sent meanwhile (`sending`). When no session could be made the message is
    // not sent to the old one: it is back in the box, and "/clear" is armed again.
    if (msg.fresh && this.source.kind === "acp") {
      this.sending = files ?? [];
      this.source.freshSession(cx).then((ok) => {
        this.sending = null;
        if (ok) this.dispatch(cx, { ...msg, fresh: false });
        else {
          if (!this.input.value().trim()) { this.input.set_value(text); this.hasText = !!text.trim(); }
          this.armFresh(cx, true);
        }
        cx.notify();
      });
      return cx.notify();
    }
    // It is remembered for ↑ in the message box, with the chat (kept); a chat with no id remembers it while its pane lives.
    const sent = pushPrompt(this.history, { text, tokens });
    if (sent !== this.history) { this.history = sent; keep(this.chatId, { history: sent }); }
    const out = (...args) => (steer && this.source.steer ? this.source.steer(...args) : this.source.send(...args));
    // The chat as it is now, not as last drawn: a new chat's first message may go out before its pane was drawn with a folder.
    const v = this.source.view();
    this.follow = true;
    const att = files.length ? files.map((a) => ({ name: a.name, path: a.path, image: a.image, thumb: a.thumb })) : null;
    // A steering message is part of the turn it goes into: that turn's checkpoint stays the open one.
    const where = !steer && this.source.kind === "acp" && checkpointsOn() && v.cwd ? { cwd: v.cwd, on: v.machine ?? undefined } : null;
    if (!files.length && !where) { out(cx, text, blocks); return cx.notify(); }
    // Reading the pictures and snapshotting the files take a moment: the box empties now and the message follows.
    this.sending = files;
    cx.spawn(async (cx) => {
      const more = files.length ? await this.attachmentBlocks(v).catch(() => []) : [];
      // The files as they are before this turn (checkpoint.js), for its diff and for "Revert".
      const n = (this.source.state?.transcript?.nextId ?? Date.now());
      const before = where ? await snapshot(where, this.chatId ?? "chat", `t${n}-before`) : null;
      this.sending = null;
      out(cx, text, [...blocks, ...more], att);
      const mine = [...(this.source.state?.transcript?.items ?? [])].reverse().find((m) => m.kind === "user");
      if (before && mine && !mine.cp) { mine.cp = { before, n }; this.cpOpen = { item: mine, where }; }
      // Where this chat's checkpoints are, for the day it is deleted (tidy).
      const known = shared(CPS) ?? {};
      if (before && this.chatId && (known[this.chatId]?.cwd !== where.cwd || (known[this.chatId]?.on ?? null) !== (where.on ?? null))) setShared(CPS, { ...known, [this.chatId]: { cwd: where.cwd, on: where.on ?? null } });
      cx.notify();
    });
    cx.notify();
  }

  // The turn is over: the files as they are now, and what the turn changed.
  turnEnded(cx) {
    const open = this.cpOpen;
    if (!open || this.cpBusy || ["working", "blocked", "starting"].includes(this.source.word())) return;
    this.cpOpen = null;
    this.cpBusy = true;
    cx.spawn(async (cx) => {
      try {
        const after = await snapshot(open.where, this.chatId ?? "chat", `t${open.item.cp.n}-after`);
        if (after) Object.assign(open.item.cp, { after, ...(await turnStat(open.where, open.item.cp.before, after)), cwd: open.where.cwd, on: open.where.on ?? null });
        this.source.changed?.(cx, true);
      } finally { this.cpBusy = false; cx.notify(); }
      // A short turn that ended while this one's snapshot was taken found it busy: its own is taken now.
      this.turnEnded(cx);
      // Not waited for: a message sent now takes its own snapshot beside it.
      this.tidy(open.where).catch(() => {});
    });
  }

  // Old checkpoints go when a turn has ended, the quiet moment: this chat keeps its newest KEEP refs, and chats
  // deleted from Earlier chats lose theirs. Nothing waits on it.
  async tidy(where) {
    if (!this.chatId) return;
    await prune(where, this.chatId, KEEP);
    if (Date.now() - (this.sweptAt ?? 0) < SWEEP_EVERY_MS) return;
    this.sweptAt = Date.now();
    const r = await exec("/bin/sh", ["-c", "cd \"$1\" && ls -1", "sh", `${appHome()}/data/${MOD}/chats`]).catch(() => null);
    const here = new Set(String(r?.stdout ?? "").split("\n").filter(Boolean).map(refName));
    // A listing that failed, or one without this very chat in it, proves nothing: no ref is dropped on its word.
    if (r?.code !== 0 || !here.has(refName(this.chatId))) return;
    // The deleted chats this app took checkpoints for, each in its own repository, a few at a time. One whose
    // machine can't be reached now stays on the list for a later turn.
    const known = shared(CPS) ?? {}, done = [];
    for (const id of Object.keys(known).filter((id) => !here.has(refName(id))).slice(0, 8))
      if (await prune({ cwd: known[id]?.cwd, on: known[id]?.on ?? undefined }, id, 0)) done.push(id);
    if (done.length) { const next = { ...(shared(CPS) ?? {}) }; for (const id of done) delete next[id]; setShared(CPS, next); }
    // Chats from before that list was kept: those with refs in this repository and no folder any more. On this
    // computer only: a repository on another machine may hold the chats of that machine's own Herdr.
    if (!where.on) {
      const stale = ((await chatsWithRefs(where)) ?? []).filter((id) => !here.has(id));
      if (stale.length) await prune(where, stale, 0);
    }
  }

  // "Undo" on a revert's note: the files go back to what the revert replaced (its undo-<time> snapshot). Git refuses
  // when anything changed since the revert, and then nothing is touched.
  undoRevert(cx, m) {
    const s = this.source.kind === "acp" ? this.source.state : null;
    if (!m?.undo || !s?.cwd || this.undoing) return;
    this.undoing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await undoRevert({ cwd: s.cwd, on: s.machine ?? undefined }, m.undo), kept = String(m.undo).slice(0, 8);
        // The Undo stays while it may still work: after "files changed" they can be put back by hand and Undo pressed again.
        if (r.ok || r.gone) delete m.undo;
        if (r.ok) addNotice(s.transcript, "Revert undone: the files are as they were before it.");
        else if (r.changed) addNotice(s.transcript, `Couldn't undo the revert: files changed since it, and undoing would lose those changes. Nothing was touched.\nWhat the revert replaced is still kept as checkpoint ${kept}.`, "warn");
        else addNotice(s.transcript, `Couldn't undo the revert: ${r.error}`, "error");
      } finally {
        this.undoing = false;
        this.source.changed?.(cx, true);
      }
    });
  }

  // "View diff" on a turn's row: the Diff surface in the side panel, on that turn's two snapshots.
  turnDiff(m) {
    const cp = m?.cp;
    if (!cp?.after) return;
    setShared(`${MOD}.turn`, { at: Date.now(), from: cp.before, to: cp.after, root: cp.cwd, on: cp.on ?? null, label: String(m.text ?? "").trim().split("\n")[0].slice(0, 60) });
    run(`${MOD}.add:diff`);
  }

  // "Revert" on a turn's row: asks first (menus.js RevertMenu), which puts the files back as they were before that message.
  askRevert(at, m) {
    const cp = m?.cp;
    if (!cp?.before) return;
    openOverlay({ mod: MOD, kind: "popup", at: { x: at.x, y: at.y }, width: 340, height: 172,
      props: { menu: "revert", chat: this.chatId, sha: cp.before, cwd: cp.cwd, on: cp.on ?? null, item: m.id, label: String(m.text ?? "").trim().split("\n")[0].slice(0, 60) } });
  }

  // ---- drawing ----

  render(cx) {
    const k = tokens();
    // A chat learns which pane is its own by being drawn in it (report.js).
    if (this.reporter && !this.reporter.tab && !this.placing) {
      this.placing = true;
      this.reporter.drawn();
      cx.timer.after(0, () => { this.placing = false; this.reporter.drawn(); this.report(); });
    }
    const root = v_flex().id("ht3-chat").size_full().bg(k.background).text_color(k.foreground).text_size(14);
    if (this.phase === "loading") return root.child(this.centered(k, "Loading…"));
    if (this.phase === "empty") return root.child(this.empty(k));
    const v = (this.view = this.source.view());
    // The pin is read while drawing too: the lists change it, and a draw follows a change of shared state.
    if (this.pinSeen !== JSON.stringify(shared("agents.pins") ?? [])) { this.pinSeen = JSON.stringify(shared("agents.pins") ?? []); cx.timer.after(0, () => this.pinSync()); }
    // Settings may cut an agent's models to a list of the person's (settings.js).
    if (this.source.kind === "acp") v.options = limitModels(agentOf(this.source.state?.agentArgv)?.id, v.options);
    if (v.status === "working") this.since ??= this.turnAt ?? Date.now();
    else this.since = null;
    // The lane first: it counts what the find bar says.
    const lane = this.timeline(k, v);
    return root
      // In a tab of the Herdr T3 layout the pane's header draws it (report.js `crumb`): one header, as T3's.
      .when(!this.headed(), (el) => el.child(this.header(k, v)))
      .when(this.finding, (el) => el.child(this.findBar(k)))
      .when(!!this.problemOf(v), (el) => el.child(this.statusBanner(k, v)))
      .child(lane)
      .when(this.picker != null, (el) => el.child(this.pickerPanel(k, v)))
      // The "/", "$", "@" menu floats over the end of the lane (it is drawn after it), its foot on the message box's top.
      .child(div().relative().w_full().flex_none()
        .child(this.composer(k, v))
        .when(this.picker == null && !!this.trig, (el) => el.child(div().absolute().left(0).right(0).bottom("100%").child(this.triggerPanel(k, v)))));
  }

  centered(k, text) {
    return v_flex().flex_1().items_center().justify_center().text_size(14).text_color(k.muted).child(text);
  }

  empty(k) {
    return v_flex().flex_1().items_center().justify_center().gap(12)
      .child(div().text_size(14).font_medium().child("No chat here yet"))
      .child(div().text_size(12).text_color(k.muted).child("Show a terminal agent's conversation, or start an agent."))
      .child(button(k, "empty-new", "New chat", () => openLauncher(), { variant: "default", size: "sm", glyph: "square-pen" }));
  }

  // T3's breadcrumb header, at the height of this layout's bars: folder / agent, then what
  // applies to the chat.
  // Whether the pane's own header says all this: the layout's pane header is ht3-pane and this chat reports to it.
  headed() {
    if (!this.reporter?.tab) return false;
    const has = (x) => x?.content?.pane?.header?.content?.mod === "ht3-pane" || (x?.children ?? []).some(has);
    return has(layout());
  }

  // What the header says, for this one and for the pane header's.
  crumb(v) {
    const folder = v.cwd ? shortPath(v.cwd).split("/").filter(Boolean).pop() ?? "~" : null;
    // T3's header: the project's badge and name, then the thread's title, its first message.
    const said = v.items.find((m) => m.kind === "user")?.text?.trim().split("\n")[0] ?? "";
    const title = this.named() ? this.named() : said ? (said.length > 80 ? said.slice(0, 80) + "…" : said) : (this.source.kind === "acp" && agentOf(this.source.state?.agentArgv)?.name) || v.name;
    const where = v.cwd ? (v.machine ? `${v.machine}:${v.cwd}` : shortPath(v.cwd)) : "";
    // An ACP agent waiting for an approval still says working; the badge says what it waits for.
    const state = v.permission && v.status === "working" ? "blocked" : v.status;
    // Working says so in the timeline ("Working for 3s"), as T3's header says nothing of it.
    const word = { starting: "Starting", blocked: "Waiting for you", exited: "Stopped", stopped: "Stopped" }[state] ?? null;
    const tone = { blocked: "warning", exited: "error", stopped: "error", working: "info" }[state] ?? null;
    return { badge: folder ? initials(folder) : null, folder, where, title, word, tone, branch: this.reporter?.where?.branch ?? null, usage: v.usage?.size > 0 ? Math.round((100 * v.usage.used) / v.usage.size) : null };
  }

  header(k, v) {
    const { folder, where, title, word, tone, branch } = this.crumb(v);
    return h_flex().h(40).flex_none().px(16).gap(8).items_center().text_size(14).font_medium()
      .when(!!folder, (el) => el
        .child(h_flex().h(16).min_w(16).px(2).flex_none().items_center().justify_center().rounded(4).bg(alpha(k.info, 0.16)).text_size(9).font_bold().text_color(k.info).child(initials(folder)))
        .child(div().max_w(160).truncate().text_color(k.muted).tooltip(where).child(folder))
        .child(div().text_color(alpha(k.muted, 0.6)).child("/")))
      .child(div().min_w(0).truncate().tooltip(v.name).child(title))
      .when(!!branch, (el) => el.child(h_flex().flex_none().max_w(180).gap(4).items_center().text_size(12).font_weight(400).text_color(k.muted).tooltip(`On branch ${branch}`)
        .child(icon("git-branch").size(12).flex_none()).child(div().min_w(0).truncate().font_family(k.mono).child(branch))))
      .when(!!word, (el) => el.child(badge(k, word, tone)))
      .child(div().flex_1())
      .when(v.usage?.size > 0, (el) => el.child(div().text_size(12).font_weight(400).text_color(k.muted)
        .child(`${Math.round((100 * v.usage.used) / v.usage.size)}% context`)))
      .when(!!v.terminal, (el) => el.child(iconButton(k, "to-term", "square-terminal", () => run("pane.focus", { terminal: v.terminal }), { tip: `Go to its terminal (${v.terminal})` })))
      .child(iconButton(k, "new-chat", "square-pen", () => openLauncher(), { tip: "New chat" }));
  }

  // T3's "Regenerate title": a short title for the thread from its first messages, asked of the chat's own agent in
  // a session of its own that is thrown away (agent-acp.js askOnce), on the chat's model. The chat's session and
  // transcript are not touched; the title is kept as a rename is (shared "ht3-panels.named"). This computer only.
  retitle(cx) {
    const s = this.source?.kind === "acp" ? this.source.state : null;
    if (!s || this.titling) return;
    const said = s.transcript.items.filter((m) => (m.kind === "user" || m.kind === "agent") && String(m.text ?? "").trim()).slice(0, 6);
    if (!said.length) return;
    if (s.machine) return notify({ title: "No title", body: "A chat on another machine can't be titled yet.", level: "warning" });
    this.titling = true;
    const model = s.configOptions?.find((o) => (o.category ?? o.id) === "model" && !o.legacyMode);
    const text = `Reply with only a short title for the conversation below: 3 to 6 words, plain text, no quotes, no period, no explanation. Do not use any tools.\n\n<conversation>\n${
      said.map((m) => `${m.kind === "user" ? "User" : "Assistant"}: ${String(m.text).trim().slice(0, 600)}`).join("\n\n")}\n</conversation>`;
    notify({ title: "Asking for a title…", body: this.named() ?? said[0].text.trim().split("\n")[0].slice(0, 80), level: "info", timeout: 2500 });
    cx.spawn(async (cx) => {
      try {
        const answer = await askOnce(s.agentArgv, s.cwd ?? home(), text, { set: model?.currentValue != null ? { [model.id]: model.currentValue } : null,
          timer: new Promise((ok) => cx.timer.after(90000, () => ok())) });
        const title = answer.split("\n").map((l) => l.trim()).filter(Boolean).pop().replace(/^(title:\s*)/i, "").replace(/^["'“‘*_#\s]+|["'”’*_.\s]+$/g, "").slice(0, 80);
        if (!title) throw new Error("The agent gave no title.");
        setShared(`${MOD}.named`, { ...(shared(`${MOD}.named`) ?? {}), [this.chatId]: title });
        notify({ title: "Thread titled", body: title, level: "success", timeout: 3000 });
      } catch (e) {
        notify({ title: "No title", body: String(e?.message ?? e).slice(0, 160), level: "error" });
      }
      this.titling = false;
      this.report();
      cx.notify();
    });
  }

  // A terminal of the chat's own (T3's ThreadTerminalDrawer), with nothing added to the layout: the chat's tab is split
  // and a shell started in the chat's folder is put under the chat. It is a pane of the chat's tab, so it stays with
  // the chat and ends when the tab is closed. Hiding it is the tab's zoom on the chat (the shell keeps running);
  // showing it again takes the zoom off. A second terminal split in by hand rides along.
  terminals() {
    const tab = this.reporter?.tab;
    return tab ? panes().filter((p) => p.tab === tab && p.terminal) : [];
  }
  toggleTerminal(cx) {
    const pane = this.reporter?.pane, me = pane ? panes().find((p) => p.pane === pane) : null;
    if (!me) return;
    if (!this.terminals().length) this.openTerminal(pane);
    else {
      // Zoomed on the chat: the terminal is hidden. Otherwise it shows, and the toggle hides it.
      run("pane.zoom", { pane });
      if (me.zoomed) { const t = this.terminals()[0]; if (t) cx.timer.after(60, () => run("pane.focus", { pane: t.pane })); }
    }
    cx.notify();
  }
  openTerminal(pane) {
    const cwd = this.view?.cwd ?? this.source.state?.cwd ?? this.p?.cwd;
    run("pane.focus", { pane });
    run("terminal.open", { place: "down", name: "Terminal", ...(cwd ? { folder: cwd } : {}) });
  }

  // The chat's terminal outlives its tab as a note: the chat keeps that it has one (kept `term`, by chat id), and a
  // chat reopened from Earlier chats, in a new pane with none, gets one again in its folder, once its tab is the shown
  // one (a split is made in the focused tab). The keyboard goes back to the chat. A pane that was there before (a
  // reload, the app started again) still has its terminal and opens nothing. From the chat's timer and its changes.
  termSync(cx) {
    const r = this.reporter, pane = r?.pane;
    if (!pane || !this.chatId || this.source?.kind !== "acp" || !this.source.state) return;
    // Its pane is gone or not listed (the tab is closing, the app is starting): nothing is known, nothing is noted.
    if (!panes().some((p) => p.pane === pane)) return;
    const has = this.terminals().length > 0, kept = keptOf(this.chatId).term === true;
    if (this.termFor !== pane) {
      // A place just taken, not one known from before: this pane is new to the chat.
      if (kept && !has && r.fresh && this.termBack == null) this.termBack = Date.now();
      this.termFor = pane;
    }
    if (this.termBack != null) {
      if (has) this.termBack = null;
      // A moment after it is placed, so a terminal that is only late to be listed isn't opened twice; then as soon as its tab shows.
      else if (Date.now() - this.termBack >= 400 && focused()?.tab === r.tab) {
        this.termBack = null;
        this.openTerminal(pane);
        cx.timer.after(150, () => { if (focused()?.tab === r.tab) { run("pane.focus", { pane }); this.input.focus(); } });
      }
      return;
    }
    // Gone is believed once it has stayed gone for a while: a split takes a moment to be listed, and a tab that is
    // closing may lose its terminal a moment before its chat.
    if (has || !kept) this.termGone = null; else this.termGone ??= Date.now();
    if (has !== kept && (has || Date.now() - this.termGone > 2500)) keep(this.chatId, { term: has });
  }

  // T3's composer.sendAndNewThread and composer.sendBackground: the draft is not sent here. It becomes the first
  // message of a new chat with this one's agent, in this one's folder, whole: its text, its "@" files and what was
  // attached to it. In the background the new chat's tab is made, the new chat steps back from in front as soon as it
  // has started (stepBack) and this chat places it (report.js placeNew); a toast says it started.
  sendNew(cx, background) {
    const s = this.source.kind === "acp" ? this.source.state : null;
    if (!s) return;
    const m = this.boxMessage(this.view ?? this.source.view());
    if (!m.text && !m.files.length) return;
    const here = this.reporter?.tab ?? focused()?.tab, known = paneIds(), tabs = tabIds();
    const id = chatLike(s, focused()?.space, { text: m.text, blocks: m.blocks, tokens: m.tokens, files: m.files.map(fileOf) }, background && here ? { back: { tab: here, at: Date.now() } } : null);
    if (!id) return;
    this.input.set_value("");
    this.attached = [];
    this.hasText = false;
    this.trig = null;
    if (background) {
      // A copy starts when it first shows, so the new tab is in front until its chat has started: a frame or two.
      // This chat says which pane is the new one's, so it has its name and state in the lists without being drawn,
      // and takes the keyboard back. Should the new chat not step back by itself, this one shows its tab again.
      const began = Date.now(), mine = this.reporter?.pane;
      const watch = (cx) => {
        if (this.closed) return;
        const at = placeNew(id, known), now = focused()?.tab, age = Date.now() - began;
        if (here && now && now !== here && age > 400 && (at ? now === at.tab : !tabs.has(now))) run("tab.select", { id: here });
        if (here && at && now === here) { if (mine) run("pane.focus", { pane: mine }); this.input.focus(); return cx.notify(); }
        if (age < 3000) cx.timer.after(16, watch);
      };
      cx.timer.after(0, watch);
      notify({ title: "Started in the background", body: (m.text.split("\n")[0] || m.files.map((a) => a.name).join(", ")).slice(0, 120), level: "info", timeout: 3000 });
    }
    cx.notify();
  }

  // A chat started in the background, as its copy begins (its tab was just shown for that): it takes its place, the
  // one chat pane of the shown tab that no chat has, and shows the tab it was sent from again. Not placed within a
  // fifth of a second, it goes back all the same.
  stepBack(cx, tab) {
    let n = 0;
    const go = (cx) => {
      if (this.closed) return;
      this.reporter.drawn();
      const placed = this.reporter.place();
      if (placed ? focused()?.tab === this.reporter.tab : ++n >= 12) return void run("tab.select", { id: tab });
      if (!placed) cx.timer.after(16, go);
    };
    go(cx);
  }

  // "/copy": the whole thread as Markdown on the clipboard (transcript.js `toMarkdown`), said by a toast.
  copyThread(cx) {
    const v = this.view;
    if (!v?.items?.length) return;
    const md = toMarkdown({ title: this.named() ?? v.items.find((m) => m.kind === "user")?.text, agent: v.name, cwd: v.cwd, machine: v.machine, branch: this.reporter?.where?.branch, items: v.items });
    cx.write_to_clipboard(md);
    notify({ title: "Thread copied as Markdown", body: `${md.split("\n").length} lines`, level: "success", timeout: 2500 });
    cx.notify();
  }

  findQuery() {
    return this.finding ? this.findField.value().trim().toLowerCase() : "";
  }
  // Opens the find bar (with `text` in it), or closes it; the marks go when it closes, the lane stays where it is.
  setFind(cx, on, text = null) {
    this.finding = on;
    if (text != null) this.findField.set_value(text);
    if (on) this.findField.focus(); else { this.findField.set_value(""); this.input.focus(); }
    this.findAt = 0;
    this.findFresh = on;
    cx.notify();
  }
  // The next match (d 1) or the one before (d -1), round and round; the lane scrolls to it.
  findStep(cx, d) {
    const n = this.hits.length, now = Date.now();
    // Enter reaches the bar twice where the field both submits and lets the key through.
    if (!n || now - (this.stepAt ?? 0) < 60) return;
    this.stepAt = now;
    this.findAt = (this.findAt + d + n) % n;
    this.goTo(this.hits[this.findAt]);
    cx.notify();
  }
  // Scrolls the lane to a row by its id: timeline() builds the rows up to it, and once their heights are
  // measured puts it in the middle of the pane (a row taller than the pane: its start near the top).
  goTo(id) {
    this.want = id;
    this.wantOff = null;
  }
  findBar(k) {
    const n = this.hits.length, q = this.findQuery();
    const step = (id, glyph, tip, d) => h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(6).text_color(n ? k.muted : alpha(k.muted, 0.4))
      .role("button").accessibility_label(tip).when(n > 0, (el) => el.cursor_pointer().tooltip(tip).hover((st) => st.bg(k.accent).text_color(k.foreground)).on_click((_e, cx) => this.findStep(cx, d)))
      .child(icon(glyph).size(14));
    return h_flex().w_full().flex_none().justify_center().px(16).pt(8)
      .child(h_flex().w_full().max_w(LANE).h(36).pl(10).pr(4).gap(4).items_center().rounded(10).border(1).border_color(k.input).bg(k.card).text_size(14)
        .on_key_down((e, cx) => {
          const key = String(e.key ?? "").toLowerCase();
          if (key === "escape") { this.setFind(cx, false); cx.stop_propagation?.(); }
          if (key === "enter") { this.findStep(cx, e.modifiers?.shift ? -1 : 1); cx.stop_propagation?.(); }
        })
        .child(icon("search").size(14).flex_none().mr(4).text_color(k.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.findField)))
        .child(div().flex_none().px(4).text_size(12).text_color(q && !n ? k.destructiveText : k.muted).child(!q ? "Enter: next · Shift+Enter: previous" : n ? `${this.findAt + 1} of ${n}` : "No matches"))
        .child(step("find-prev", "chevron-up", "Previous match (Shift+Enter)", -1))
        .child(step("find-next", "chevron-down", "Next match (Enter)", 1))
        .child(iconButton(k, "find-close", "x", (cx) => this.setFind(cx, false), { tip: "Close (Esc)" })));
  }
  // Text with every match of the find word marked (the one find is on, stronger). TextView can't mark a part of
  // its text, so this is the text as words in rows that wrap: plain, not Markdown. `at`: the index, among all the
  // lane's matches, of this text's first one. `one`: a single line that doesn't wrap (a tool's title).
  marked(k, text, at, one = false) {
    const q = this.findQuery(), nb = (t) => t.replace(/ /g, "\u00a0").replace(/\t/g, "\u00a0\u00a0");
    let n = at;
    const line = (ln) => {
      const low = ln.toLowerCase(), kids = [];
      const plain = (t) => { for (const w of t.match(/\S+\s*|\s+/g) ?? []) kids.push(div().flex_none().child(nb(w))); };
      let i = 0;
      for (let j; q && (j = low.indexOf(q, i)) >= 0; i = j + q.length) {
        plain(ln.slice(i, j));
        const cur = n++ === this.findAt;
        kids.push(div().flex_none().rounded(3).bg(cur ? k.warning : alpha(k.warning, 0.3)).when(cur, (el) => el.text_color("#000000")).child(nb(ln.slice(j, j + q.length))));
      }
      plain(ln.slice(i));
      return one ? h_flex().min_w(0).overflow_hidden().children(kids) : h_flex().w_full().min_w(0).flex_wrap().children(kids);
    };
    if (one) return line(String(text ?? "").split("\n")[0]);
    return v_flex().w_full().min_w(0).children(String(text ?? "").split("\n").map((ln) => (ln ? line(ln) : div().h(10))));
  }

  rows(v) {
    const rows = [];
    if (v.earlier) rows.push({ id: "__earlier", kind: "earlier" });
    else if (v.dropped > 0) rows.push({ id: "__dropped", kind: "notice", level: "info", text: `${v.dropped} earlier messages not shown` });
    // T3's turns: your message, then "Working for 3s" over the work while it runs; once done, the work
    // folds under "Worked for 1.6s" and the answer stays. What an agent says before any message (a
    // startup banner: its version, skills, extensions) folds the same way.
    const sought = this.findQuery();
    const wordsOf = (m) => [m.text, m.title, m.detail, ...(m.entries ?? []).map((e) => e.content)].filter(Boolean).join("\n").toLowerCase();
    const items = v.items, busy = v.status === "working" || v.status === "blocked";
    const hot = (m) => !!sought && wordsOf(m).includes(sought);
    const fold = (id, label, inside, rest) => {
      // With nothing under it, it is only the turn's time: no chevron, and nothing to open.
      // While finding, a fold with a match under it is open.
      const open = inside.length > 0 && (!!this.expanded[id] || inside.some(hot));
      rows.push({ id, kind: "fold", label, open, bare: !inside.length });
      if (open) for (const m of inside) rows.push(m);
      for (const m of rest) rows.push(m);
    };
    let at = items.findIndex((m) => m.kind === "user");
    const before = items.slice(0, at < 0 ? items.length : at);
    const quiet = before.filter((m) => m.kind !== "notice");
    if (quiet.length && !(busy && at < 0)) fold("__startup", "Startup notes", quiet, before.filter((m) => m.kind === "notice"));
    else for (const m of before) rows.push(m);
    while (at >= 0 && at < items.length) {
      let end = at + 1;
      while (end < items.length && items[end].kind !== "user") end++;
      const user = items[at], rest = items.slice(at + 1, end);
      rows.push(user);
      if (end === items.length && busy) {
        rows.push({ id: "__working", kind: "working", doing: v.doing });
        for (const m of rest) rows.push(m);
      } else {
        const work = rest.filter(isWork);
        if (work.length || user.took != null) fold(`__worked-${user.id}`, user.took != null ? `Worked for ${took(user.took)}` : "Worked", work, rest.filter((m) => !isWork(m)));
        else for (const m of rest) rows.push(m);
      }
      at = end;
    }
    // The same note several times running (a session begun anew at each restart) is said once.
    const said = rows.filter((m, i) => !(m.kind === "notice" && rows[i - 1]?.kind === "notice" && rows[i - 1].text === m.text));
    // A handler can't sit inside a list row (gpui-kit: one on_item_click for the list), so what T3
    // draws as buttons on a message are rows of their own here: a reply is one row per stretch of
    // text and per code block, each block under a header row that copies it, and every message
    // ends in a slim row that copies all of it (chat/MessageCopyButton.tsx).
    const out = [], lastItem = items[items.length - 1];
    // A turn that changed files ends in a row that says so (its diff, and Revert).
    let turn = null;
    const closeTurn = () => {
      if (turn?.cp?.after && turn.cp.files > 0) {
        let at = out.length; // over the notes that came after the turn
        while (at > 0 && out[at - 1].kind === "notice") at--;
        out.splice(at, 0, { id: `${turn.id}:files`, kind: "files", of: turn });
      }
      turn = null;
    };
    for (const m of said) {
      if (m.kind === "user") { closeTurn(); turn = m; }
      if (m.kind === "agent") {
        segments(m.text || "(empty response)").forEach((g, i) => {
          // A mermaid block whose fence has closed is a diagram (one still being written stays code).
          const diagram = g.code && !g.open && isMermaid(g.lang) && !!g.text.trim();
          if (g.code) out.push({ id: `${m.id}:h${i}`, kind: diagram ? "diaghead" : "codehead", lang: g.lang, text: g.text, seg: `${m.id}:s${i}` });
          out.push({ id: `${m.id}:s${i}`, kind: "seg", code: g.code, lang: g.lang, text: g.text, whole: m.text, ...(diagram ? { diagram } : {}) });
        });
        // A reply's row has Quote beside Copy: two buttons, so the row itself takes no click.
        if (m.text && !(busy && m === lastItem)) out.push({ id: `${m.id}:cp`, kind: "copy", text: m.text, quote: true });
      } else if (m.kind === "user") {
        out.push(m);
        if (!m.pending) out.push({ id: `${m.id}:cp`, kind: "copy", text: m.text, right: true });
      } else out.push(m);
    }
    closeTurn();
    // The last message's copy icon stays in sight, dimmed by nothing: it is the one most often wanted.
    const lastCopy = [...out].reverse().find((r) => r.kind === "copy");
    if (lastCopy) lastCopy.always = true;
    // Find: every match in what the rows show, in order: this.hits[i] is the row of match i, this.hitAt its row's first.
    this.hits = [];
    this.hitAt = new Map();
    if (sought) {
      const count = (t) => { const low = String(t ?? "").toLowerCase(); let c = 0; for (let i = low.indexOf(sought); i >= 0; i = low.indexOf(sought, i + sought.length)) c++; return c; };
      for (const r of out) {
        const c = r.kind === "user" || r.kind === "seg" || r.kind === "thought" ? count(r.text) : r.kind === "tool" ? count(String(r.title ?? "").split("\n")[0]) + count(detailOf(r)) : 0;
        if (!c) continue;
        this.hitAt.set(r.id, this.hits.length);
        for (let i = 0; i < c; i++) this.hits.push(r.id);
      }
      if (this.findAt >= this.hits.length) this.findAt = 0;
      if (this.findFresh && this.hits.length) this.goTo(this.hits[this.findAt]);
    }
    this.findFresh = false;
    return out;
  }

  timeline(k, v) {
    const rows = this.rows(v);
    if (!rows.length) {
      const text = v.status === "starting" ? "Starting the agent…" : v.error ? "" : "Send a message to start the conversation.";
      return this.centered(k, text);
    }
    // The lane keeps to its end by itself: gpui-kit's measured `list` can't be scrolled from code
    // (its scroll handle is a virtual list's), so a chat in one would stay at its first message. The
    // rows are a plain column pinned to the pane's bottom edge instead, and scrolling up moves that
    // column down by `off` pixels. Only the last `tail` rows are built; more as you near the first.
    const zoom = Number(settings()?.zoom) || 1;
    // A row to go to (goTo): the rows are built up to it; with their heights known, the lane moves so it is in view.
    let want = this.want != null ? rows.findIndex((r) => r.id === this.want) : -1;
    if (want < 0) this.want = null;
    else if ((this.tail ?? TAIL) < rows.length - want + 2) { this.tail = rows.length - want + 2; this.grew = true; }
    const n = Math.min(rows.length, this.tail ?? TAIL), shown = rows.slice(rows.length - n);
    // Shorter than the pane: from the top, as T3's.
    const short = n === rows.length && (this.laneH != null && this.viewH != null ? this.laneH <= this.viewH : rows.length <= 6);
    if (want >= 0 && this.viewH != null && this.laneH != null) {
      let below = 0, known = this.rowH.has(rows[want].id);
      for (let i = rows.length - 1; i > want && known; i--) { const h = this.rowH.get(rows[i].id); if (h == null) known = false; else below += h; }
      if (short) this.want = null;
      else if (known) {
        const h = this.rowH.get(rows[want].id), max = Math.max(0, this.laneH - this.viewH);
        const to = Math.round(Math.max(0, Math.min(max, h < this.viewH - 128 ? below - (this.viewH - h) / 2 : below + h - this.viewH + 64)));
        this.follow = to === 0;
        this.off = to;
        // Settled once two draws agree (the heights of rows just built come in after the first).
        if (this.wantOff === to) { this.want = null; this.wantOff = null; } else this.wantOff = to;
      }
    }
    const off = this.follow ? 0 : (this.off ?? 0);
    const click = (m, cx) => {
      if (m.kind === "earlier") return this.source.earlier?.(cx);
      if (m.kind === "copy" && m.quote) return;
      if (m.kind === "copy" || m.kind === "codehead") return this.copy(cx, m.id, m.text);
      if (m.kind === "fold") { this.expanded[m.id] = !this.expanded[m.id]; return cx.notify(); }
      if (m.kind !== "tool" && m.kind !== "thought") return;
      this.expanded[m.id] = !this.expanded[m.id];
      if (this.expanded[m.id]) this.source.expand(cx, m);
      cx.notify();
    };
    // A right-click on a message, a thought or a tool's output: Copy, for all of it.
    const copies = (m) => (m.kind === "seg" ? m.whole : m.kind === "tool" ? m.detail : ["user", "thought", "codehead", "diaghead", "copy", "notice"].includes(m.kind) ? m.text : null);
    const lane = v_flex().absolute().left(0).right(0)
      .on_size_change((size, cx) => {
        const h = size.height / zoom;
        if (Math.abs(h - (this.laneH ?? 0)) < 1) return;
        // What arrives while you read further up must not move what you read.
        if (!this.follow && this.laneH != null && !this.grew) this.off = Math.max(0, (this.off ?? 0) + h - this.laneH);
        this.grew = false;
        this.laneH = h;
        cx.notify();
      })
      .children(shown.map((m, i) => {
        const el = div().id(`row-${m.id}`).w_full().child(this.row(k, m, i === 0 && n === rows.length, i === shown.length - 1))
          .on_size_change((size, cx) => {
            const h = size.height / zoom;
            if (Math.abs((this.rowH.get(m.id) ?? -1) - h) < 0.5) return;
            this.rowH.set(m.id, h);
            if (this.want != null) cx.notify();
          });
        const text = copies(m);
        // A message's rows (its text, its code blocks, its copy row) are one thing to the pointer: over any of them, its copy icon shows.
        const of = ["seg", "user", "copy", "codehead", "diaghead"].includes(m.kind) ? String(m.id).split(":")[0] : null;
        return (text ? el.on_mouse_down("right", (e) => this.copyMenu(e.position, copies(m), of)) : el)
          .when(of != null, (e) => e.on_hover((over, cx) => {
            if (over ? this.over === of : this.over !== of) return;
            this.over = over ? of : null;
            cx.notify();
          }))
          .when(CLICKS.includes(m.kind) && !m.quote, (e) => e.on_click((_e, cx) => click(m, cx)));
      }));
    return v_flex().id("ht3-chat-lane").relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        const h = size.height / zoom, w = size.width / zoom;
        if (Math.abs(h - (this.viewH ?? 0)) < 1 && Math.abs(w - (this.viewW ?? 0)) < 1) return;
        this.viewH = h;
        this.viewW = w; // a diagram is fitted to the lane's width
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => this.wheel(e.delta.y, rows.length, cx))
      .child(short ? lane.top(0) : lane.bottom(-off))
      .when(!short, (el) => { const map = this.minimap(k, rows, off); return map ? el.child(map) : el; })
      // chat/TimelineOverlays.tsx: the glass pill over the end of the lane.
      .when(!this.follow, (el) => el.child(h_flex().absolute().bottom(6).left(0).right(0).justify_center()
        .child(h_flex().id("to-end").h(24).px(8).gap(4).items_center().rounded_full().border(1).border_color(alpha(k.border, 0.6))
          .bg(k.card).shadow_sm().text_size(12).font_medium().cursor_pointer().role("button").accessibility_label("Scroll to end").hover((s) => s.border_color(k.border))
          .on_click((_e, cx) => { this.follow = true; this.off = 0; this.want = null; cx.notify(); })
          .child(icon("chevron-down").size(14)).child("Scroll to end"))));
  }

  // chat/TimelineMinimap.tsx: down the lane's right edge, a mark for each of your messages, placed by where it is
  // in the thread (by row, since rows not built yet have no height); a click goes there. A faint band is what the
  // pane shows now. Only in a thread of three messages or more that is longer than the pane.
  minimap(k, rows, off) {
    const mine = [];
    rows.forEach((r, i) => { if (r.kind === "user") mine.push([r, i]); });
    const H = (this.viewH ?? 0) - 24;
    if (mine.length < 3 || H < 80) return null;
    const y = (i) => Math.round((i / Math.max(1, rows.length - 1)) * (H - 8));
    // The rows in view, from the heights known (the built ones, at the lane's end).
    let acc = 0, first = null, last = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const h = this.rowH.get(rows[i].id);
      if (h == null) break;
      if (acc + h > off && acc < off + (this.viewH ?? 0)) { last ??= i; first = i; }
      acc += h;
    }
    return div().absolute().top(12).right(3).w(10).h(H)
      .when(first != null, (el) => el.child(div().absolute().left(0).right(0).top(y(first)).h(Math.max(10, y(last) - y(first) + 8)).rounded(3).bg(alpha(k.foreground, 0.07))))
      .children(mine.map(([r, i]) => {
        const seen = first != null && i >= first && i <= last, said = String(r.text ?? "").trim().split("\n")[0];
        return h_flex().id(`map-${r.id}`).absolute().left(0).right(0).top(y(i)).h(8).items_center().justify_center().cursor_pointer().role("button")
          .accessibility_label(`Go to your message: ${said.slice(0, 60)}`).tooltip(said.length > 70 ? said.slice(0, 70) + "…" : said || "Your message")
          .on_click((_e, cx) => { this.goTo(r.id); cx.notify(); })
          .child(div().w(8).h(2).rounded_full().bg(alpha(k.foreground, seen ? 0.7 : 0.3)));
      }));
  }

  // The wheel (or `scroll:<px>`): up by `dy` pixels, down when negative; at the end it follows again.
  wheel(dy, total, cx) {
    this.want = null;
    const max = Math.max(0, (this.laneH ?? 0) - (this.viewH ?? 0));
    let off = (this.follow ? 0 : this.off ?? 0) + dy;
    // Near the first row built: build more, and the column's growth is not new output.
    if (off > max - 400 && (this.tail ?? TAIL) < total) { this.tail = (this.tail ?? TAIL) + TAIL; this.grew = true; }
    off = Math.max(0, Math.min(off, max));
    if (off === (this.off ?? 0) && this.follow === (off <= 0) && !this.grew) return;
    this.off = off;
    this.follow = off <= 0;
    cx.notify();
  }

  // A quoted block onto the end of the message box, the caret after it: a hunk or lines from Diff and Files
  // (shared "ht3-panels.quote"), a reply's Quote. What is in the box stays as it is, its "@" chips too.
  quoteIn(cx, text) {
    const had = this.input.content(), now = String(had.text ?? "").replace(/\s+$/, "");
    this.input.set_value({ text: `${now ? `${now}\n\n` : ""}${text}\n`, tokens: chipsWithin(had.tokens, now.length) });
    this.hasText = true;
    this.input.focus();
    try { const n = this.input.value().length; this.input.set_selected_range({ start: n, end: n }); } catch {}
    cx.notify();
  }

  // Quote, beside a reply's Copy: the reply into the message box as a "> " block (replyQuote), an empty line after
  // it to answer on. The button shows a check for a moment, as Copy does.
  quoteReply(cx, id, text) {
    const q = replyQuote(text);
    if (!q) return;
    this.quoteIn(cx, `${q}\n`);
    this.copied = `${id}:q`;
    cx.timer.after(1500, (cx) => { if (this.copied === `${id}:q`) { this.copied = null; cx.notify(); } });
  }
  quoteMark(k, id, shown = true) {
    const done = this.copied === `${id}:q`;
    return h_flex().h(20).px(4).gap(4).flex_none().items_center().rounded(4).cursor_pointer().text_size(12).text_color(done ? k.successText : alpha(k.muted, 0.8))
      .when(!shown && !done, (el) => el.opacity(0))
      .hover((s) => s.bg(k.accent).text_color(done ? k.successText : k.foreground))
      .child(icon(done ? "check" : "quote").size(12).flex_none()).when(done, (el) => el.child("Quoted"));
  }

  // The lane goes to a subagent's tool call (a click in the bar over the message box). Its turn's work is opened
  // when it has folded under "Worked for …".
  subJump(cx, id) {
    const items = this.view?.items ?? [], at = items.findIndex((m) => m.id === id);
    if (at < 0) return;
    let u = at;
    while (u >= 0 && items[u].kind !== "user") u--;
    const busy = this.view.status === "working" || this.view.status === "blocked", last = !items.slice(at).some((m) => m.kind === "user");
    if (!(busy && last)) this.expanded[u >= 0 ? `__worked-${items[u].id}` : "__startup"] = true;
    this.goTo(id);
    cx.notify();
  }

  // T3's ProviderSubagentBar, as a slim list tucked on the message box: the subagents at work (Claude Code's Task
  // and Agent calls: transcript.js `subagents`), each a turning arc, what it is for, what it runs now, and its time;
  // one that ended stays a moment with a check. A click goes to its tool call. -> an element, or null with none.
  subBar(k, v) {
    const subs = this.source?.kind === "acp" ? subagents(v.items) : [];
    this.subN = subs.length;
    if (!subs.length) return null;
    const MAX = 3, live = subs.filter((s) => s.running).length, shown = subs.slice(0, MAX);
    const line = alpha(k.foreground, k.dark ? 0.1 : 0.08);
    return v_flex().id("ht3-subagents").mx(12).mb(-1).px(6).py(3).rounded_t(12).border(1).border_color(line).bg(alpha(k.card, 0.7)).text_size(12)
      .role("status").accessibility_label(live ? `${live} subagent${live === 1 ? "" : "s"} running` : "Subagents finished")
      .children(shown.map((s) => h_flex().id(`sub-${s.toolCallId ?? s.id}`).h(24).px(6).gap(8).items_center().rounded(6).cursor_pointer().role("button")
        .accessibility_label(`${s.title}: ${s.running ? "running" : s.failed ? "failed" : "finished"}. Show it in the thread`).tooltip("Show in the thread")
        .hover((st) => st.bg(k.accent)).on_click((_e, cx) => this.subJump(cx, s.id))
        .child(h_flex().size(14).flex_none().items_center().justify_center().text_color(s.running ? k.muted : s.failed ? k.destructiveText : k.successText)
          .child(s.running ? icon("loader-circle").size(13).flex_none().spin(1000) : icon(s.failed ? "x" : "check").size(13).flex_none()))
        .child(div().flex_none().max_w("55%").truncate().text_color(alpha(k.foreground, s.running ? 0.9 : 0.6)).child(s.title))
        .child(div().flex_1().min_w(0).truncate().text_color(k.muted).child(s.running ? s.doing ?? "" : s.failed ? "Failed" : "Done"))
        // A fixed width, so the seconds going by move nothing.
        .child(h_flex().w(56).flex_none().justify_end().font_family(k.mono).text_size(11).text_color(k.muted).child(seconds(s.ms)))))
      .when(subs.length > MAX, (el) => el.child(div().h(20).px(6).flex().items_center().text_size(11).text_color(k.muted).child(`and ${subs.length - MAX} more`)));
  }

  // Copies, and the button that did shows a check for a moment (chat/MessageCopyButton.tsx).
  copy(cx, id, text) {
    cx.write_to_clipboard(String(text ?? ""));
    this.copied = id;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === id) { this.copied = null; cx.notify(); } });
  }

  // The mark of a row that copies: the icon, a check for a moment once it did.
  // `shown`: false hides it until its message is under the pointer (chat/MessageCopyButton.tsx: opacity-0, group-hover:opacity-100).
  copyMark(k, id, label = null, shown = true) {
    const done = this.copied === id;
    return h_flex().h(20).px(4).gap(4).flex_none().items_center().rounded(4).cursor_pointer().text_size(12).text_color(done ? k.successText : alpha(k.muted, 0.8))
      .when(!shown && !done, (el) => el.opacity(0))
      .hover((s) => s.bg(k.accent).text_color(done ? k.successText : k.foreground))
      .child(icon(done ? "check" : "copy").size(12).flex_none()).when(label != null || done, (el) => el.child(done ? "Copied" : label));
  }

  // A right-click on a message: a one-row Copy menu at the pointer (menus.js CopyMenu).
  // `upto`: the message it was opened on, which the menu's "Fork from here" forks up to (an ACP chat's own tab or side chat).
  copyMenu(at, text, upto = null) {
    const fork = upto != null && this.source.kind === "acp" && this.chatId ? { chat: this.chatId, upto } : null;
    if (fork) this.source.save?.();
    openOverlay({ mod: MOD, kind: "popup", at: { x: at.x, y: at.y }, width: 180, height: fork ? 64 : 36, props: { menu: "copy", text: String(text ?? "").slice(0, 400000), fork } });
  }

  // The agent's plan mode, when it offers one: its mode control and the choice that plans (Claude Code's "plan",
  // Codex's "Plan"...). T3's composer has this as a one-click toggle beside the mode picker.
  // Opens one control's choices, or closes them when they are open: by the option's category ("model", "mode",
  // "thought_level"). `force`: open, as "/model" does. -> whether the agent has that option.
  openPicker(category, force = false) {
    const o = (this.view ?? this.source.view()).options.find((x) => (x.category ?? x.id) === category && !x.readonly);
    if (!o) return false;
    this.picker = !force && this.picker === o.id ? null : o.id;
    this.filter.set_value("");
    if (this.picker && o.choices.length > 8) this.filter.focus();
    return true;
  }

  // The composer's effort control: the agent's `thought_level` option, else one named for effort or reasoning.
  effortOption(v) {
    const free = v.options.filter((o) => !o.readonly && o.choices.length > 1);
    return free.find((o) => o.category === "thought_level") ?? free.find((o) => !["model", "mode"].includes(o.category ?? o.id) && /effort|reasoning|thinking/i.test(`${o.id} ${o.name}`)) ?? null;
  }

  // The next choice of an option, in the order the agent lists them, round to the first at the end (T3 steps its effort so):
  // a key pressed again before the agent has answered goes on from the choice just made, not from the old one.
  cycle(o, dir) {
    const n = o.choices.length, wanted = this.want?.[o.id], base = wanted && Date.now() - wanted.at < 2000 ? wanted.value : o.current;
    const at = o.choices.findIndex((c) => c.value === base);
    const next = o.choices[at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n];
    this.want = { ...this.want, [o.id]: { value: next.value, at: Date.now() } };
    this.source.setOption(o.id, next.value);
    return next;
  }

  // The keys of keys.json for the composer (T3: composer.increaseEffort, composer.decreaseEffort, composer.mode,
  // modelPicker.toggle). Every shown chat is sent them: the one in the focused tab acts (a side chat has no tab of its
  // own and always does). A chat whose agent isn't running, or has no such control, says so in a toast.
  chatKey(cx, key) {
    const tab = this.reporter?.tab, now = focused()?.tab;
    if ((tab && now && tab !== now) || this.source.kind !== "acp" || !["effort-up", "effort-down", "mode", "model"].includes(key)) return;
    const v = this.view ?? this.source.view();
    const say = (body) => notify({ title: "Chat", body, level: "info", timeout: 2500 });
    if (!v.alive) return say("The agent isn't running.");
    if (key === "model") { if (!this.openPicker("model")) say("This agent has no model to switch."); return cx.notify(); }
    const o = key === "mode" ? v.options.find((x) => (x.category ?? x.id) === "mode" && !x.readonly && x.choices.length > 1) : this.effortOption(v);
    if (!o) return say(key === "mode" ? "This agent has no modes." : "This agent has no effort setting.");
    this.cycle(o, key === "effort-down" ? -1 : 1);
    cx.notify();
  }

  planMode() {
    const o = this.source?.kind === "acp" ? this.view?.options.find((x) => (x.category ?? x.id) === "mode" && !x.readonly) : null;
    const plan = o?.choices.find((c) => /^plan\b/i.test(String(c.value)) || /^plan\b/i.test(String(c.name ?? "")));
    return plan ? { o, plan, on: o.current === plan.value } : null;
  }

  // On: the mode it had is remembered. Off: back to that one, else the agent's first other mode.
  togglePlan(cx) {
    const p = this.planMode();
    if (!p) return;
    if (p.on) {
      const back = p.o.choices.find((c) => c.value === this.modeBefore && c.value !== p.plan.value) ?? p.o.choices.find((c) => c.value !== p.plan.value);
      if (back) this.source.setOption(p.o.id, back.value);
    } else {
      this.modeBefore = p.o.current;
      this.source.setOption(p.o.id, p.plan.value);
    }
    cx.notify();
  }

  // A plan card's "Implement this plan": out of plan mode, then the message. Both go down the one connection
  // in that order, so the agent has left plan mode when it reads the message.
  implementPlan(cx) {
    const p = this.planMode();
    if (!p || this.view?.status !== "ready") return;
    if (p.on) this.togglePlan(cx);
    this.input.set_value("Implement this plan.");
    this.hasText = true;
    this.send(cx);
  }

  // The project a chat's drafts are parked under: its folder's repository (the main checkout, so worktrees share),
  // else the folder. Asked once; until the answer is there, the folder itself.
  stashKey() {
    const v = this.view, cwd = v?.cwd;
    if (!cwd) return null;
    if (this.projectAt?.cwd !== cwd) {
      this.projectAt = { cwd, root: null };
      const at = this.projectAt;
      repoOf(cwd, v.machine ?? null).then((root) => { at.root = root ?? cwd; }, () => { at.root = cwd; });
    }
    return `${v.machine ?? ""}:${this.projectAt.root ?? cwd}`;
  }
  stashed() {
    const key = this.stashKey(), list = key ? (shared(STASH) ?? {})[key] : null;
    return Array.isArray(list) ? list : [];
  }
  putStash(list) {
    const key = this.stashKey();
    if (!key) return;
    const all = { ...(shared(STASH) ?? {}) };
    if (list.length) all[key] = list.slice(0, 20); else delete all[key];
    setShared(STASH, all);
  }
  // What is in the message box as a parked draft: its text, its "@" chips and the files attached to it.
  // `cut`: a word at its end that isn't part of it ("/stash" typed and sent by hand).
  boxDraft(cut = null) {
    const m = this.boxMessage(this.view ?? this.source.view());
    const text = cut ? m.text.replace(cut, "").trimEnd() : m.text, tokens = chipsWithin(m.tokens, text.length), files = m.files.map(fileOf);
    if (!text && !files.length) return null;
    return { text, at: Date.now(), ...(tokens.length ? { tokens } : {}), ...(files.length ? { files } : {}) };
  }
  // Parks what is in the message box, whole (text, "@" chips, attached files), and empties the box.
  stash(cx) {
    const d = this.boxDraft(/\/stash\s*$/);
    if (!d) return;
    const same = (x) => x.text === d.text && JSON.stringify((x.files ?? []).map((a) => a.path)) === JSON.stringify((d.files ?? []).map((a) => a.path));
    this.putStash([d, ...this.stashed().filter((x) => !same(x))]);
    this.input.set_value("");
    this.attached = [];
    this.hasText = false;
    this.trig = null;
    cx.notify();
  }
  // Brings the nth parked draft back into the box, with its chips and files, and takes it off the stash; a draft in
  // the box changes places with it. A terminal agent's chat takes no files: those stay parked, and a toast says so.
  unstash(cx, i) {
    const list = this.stashed(), d = list[i];
    if (!d) return;
    const now = this.boxDraft(), acp = this.source.kind === "acp", files = filesFrom(d.files);
    const left = !acp && files.length ? [{ text: "", at: d.at, files: files.map(fileOf) }] : [];
    if (left.length) notify({ title: "Attached files stay parked", body: "This chat's agent runs in a terminal and takes no attachments.", level: "warning", timeout: 4000 });
    this.putStash([...(now ? [now] : []), ...left, ...list.filter((_d, n) => n !== i)]);
    this.input.set_value({ text: String(d.text ?? ""), tokens: acp ? chipsOf(d, (this.view ?? this.source.view()).cwd) : [] });
    this.attached = acp ? files : [];
    this.hasText = !!String(d.text ?? "").trim();
    this.trig = null;
    this.picker = null;
    this.input.focus();
    cx.notify();
  }
  dropStash(cx, i) {
    this.putStash(this.stashed().filter((_d, n) => n !== i));
    cx.notify();
  }

  // The stash's menu, over the left end of the message box where its button is.
  stashPanel(k) {
    const list = this.stashed(), can = !!this.input.value().trim() || (this.source.kind === "acp" && this.attached?.length > 0);
    const nFiles = (d) => (d.files?.length ? ` · ${d.files.length} file${d.files.length === 1 ? "" : "s"}` : "");
    const row = (id, body, onClick, enabled = true) => h_flex().id(id).min_h(28).px(8).gap(8).flex_none().items_center().rounded(4).text_size(14)
      .when(enabled, (el) => el.cursor_pointer().role("button").hover((st) => st.bg(k.accent)).on_click((_e, cx) => onClick(cx))).when(!enabled, (el) => el.opacity(0.5)).children(body);
    return h_flex().w_full().flex_none().justify_center().px(16).pb(6)
      .child(h_flex().w_full().max_w(LANE).justify_start()
        .child(v_flex().id("stash-menu").w(360).max_h(300).p(4).rounded(8).border(1).border_color(k.border).bg(k.popover).shadow_lg().overflow_y_scrollbar()
          .child(row("stash-put", [icon("archive").size(14).flex_none().text_color(k.muted), div().flex_1().child("Stash this draft"),
            div().flex_none().text_size(12).text_color(k.muted).child(can ? "/stash" : "nothing to park")], (cx) => { this.stash(cx); this.picker = null; }, can))
          .when(list.length > 0, (el) => el.child(div().mx(4).my(4).h(1).flex_none().bg(k.border)))
          .children(list.map((d, i) => row(`stash-${i}`, [
            v_flex().flex_1().min_w(0).py(4)
              .child(div().truncate().child(d.text.split("\n")[0] || (d.files ?? []).map((a) => a.name).join(", ")))
              .child(div().text_size(11).text_color(k.muted).child(`${since(d.at)}${d.text.includes("\n") ? ` · ${d.text.split("\n").length} lines` : ""}${nFiles(d)}`)),
            h_flex().id(`stash-x-${i}`).size(22).flex_none().items_center().justify_center().rounded(6).text_color(k.muted).cursor_pointer().role("button").accessibility_label("Delete this draft")
              .hover((st) => st.bg(k.accent).text_color(k.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.dropStash(cx, i); }).child(icon("x").size(12)),
          ], (cx) => this.unstash(cx, i))))
          .when(!list.length, (el) => el.child(div().px(8).py(6).text_size(12).line_height("16px").text_color(k.muted).child("No drafts parked for this project. A parked draft waits here, for any chat of the project.")))));
  }

  allow(on) {
    this.autoAllow = on;
    keep(this.chatId, { allow: on });
  }

  // "Always allow this session": this approval and every later one of this chat's agent, until
  // "Ask again" is pressed; it is kept per chat, so a reload leaves it on. The agent's own "always" option, when it has one, is a button of its own.
  allowAlways(cx) {
    const p = this.source.state?.permission;
    this.allow(true);
    const yes = p?.options.find((o) => o.kind === "allow_once") ?? p?.options.find((o) => o.kind?.startsWith("allow"));
    if (yes) this.source.answer(cx, yes.optionId);
    cx.notify();
  }

  // Fork this thread into a new chat tab: all of it, or up to and with item `upto`.
  fork(cx, upto = null) {
    if (this.source.kind !== "acp" || !this.chatId) return;
    cx.spawn(async () => {
      await this.source.save?.();
      await forkChat(this.chatId, upto).catch(() => null);
    });
  }

  // One timeline row in the lane. Rows carry their own space below, as T3's do (16 after a
  // message, 8 after work, 6 after the working line).
  row(k, m, first, last) {
    const lane = (body, pb) => h_flex().w_full().justify_center().px(16).pt(first ? 12 : 0).pb(pb + (last ? 12 : 0))
      .child(v_flex().w_full().max_w(LANE).min_w(0).child(body));
    const chevron = (open) => h_flex().size(16).flex_none().items_center().justify_center().text_color(alpha(k.muted, 0.7))
      .child(icon(open ? "chevron-down" : "chevron-right").size(12));
    switch (m.kind) {
      case "user": {
        // chat/MessagesTimeline.tsx: what was attached sits over the bubble, at its right edge.
        const att = m.attachments ?? [];
        return lane(v_flex().w_full().items_end().gap(6)
          .when(att.length > 0, (el) => el.child(h_flex().max_w("80%").gap(6).flex_wrap().justify_end().children(att.map((a) => (a.image
            ? (a.thumb ? h_flex().size(96).flex_none().rounded(12).overflow_hidden().items_center().justify_center().border(1).border_color(alpha(k.border, 0.8)).child(image(a.thumb).w(96)) : h_flex().h(28).px(8).gap(6).flex_none().items_center().rounded(8).border(1).border_color(alpha(k.border, 0.8)).text_size(12).child(a.name))
            : h_flex().h(28).px(8).gap(6).flex_none().max_w(220).items_center().rounded(8).border(1).border_color(alpha(k.border, 0.8)).text_size(12)
              .child(fileIcon(a.name, k.dark, 14)).child(div().min_w(0).truncate().child(a.name)))))))
          .when(!!m.text, (el) => el.child(div().max_w("80%").min_w(0).p(12).rounded(16).bg(k.message).text_size(14).line_height("23px")
            .when(m.pending, (e) => e.opacity(0.6)).child(this.hitAt.has(m.id) ? this.marked(k, m.text, this.hitAt.get(m.id)) : m.text)))
          // It went into the turn that was running (the agent's steering extension).
          .when(!!m.steered, (el) => el.child(div().text_size(11).text_color(k.muted).child("Sent into the running turn"))), m.pending ? 16 : 2);
      }
      case "seg":
        // While find has a match in it: its paragraphs with a match as marked plain text, the others as they were.
        if (this.hitAt.has(m.id)) {
          const q = this.findQuery();
          let at = this.hitAt.get(m.id);
          const parts = m.code ? [m.text] : m.text.split(/\n{2,}/);
          const el = v_flex().px(m.code ? 12 : 4).py(m.code ? 8 : 2).gap(m.code ? 0 : 10).text_size(m.code ? 13 : 14).line_height(m.code ? "20px" : "23px")
            .when(!!m.code, (e) => e.mx(4).rounded_b(8).border(1).border_color(alpha(k.border, 0.6)).font_family(k.mono))
            .children(parts.map((p, j) => {
              const low = p.toLowerCase();
              let c = 0;
              for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, i + q.length)) c++;
              if (!c) return TextView.markdown(`md-${m.id}-p${j}`, p).selectable(true);
              const first = at;
              at += c;
              return this.marked(k, p, first);
            }));
          return lane(el, 4);
        }
        if (m.diagram) {
          // A mermaid block: its picture once drawn, fitted to the lane and no higher than 480; until then, and
          // when it can't be drawn or its source is asked for, the code with a line that says why.
          const d = this.diagrams.get(m.text, k.dark);
          if (d.state === "ready" && !this.expanded[m.id]) {
            const size = fit(d.w, d.h, Math.max(80, Math.min(LANE, (this.viewW ?? LANE + 32) - 32) - 34));
            return lane(h_flex().mx(4).p(12).justify_center().rounded_b(8).border(1).border_color(alpha(k.border, 0.6)).overflow_hidden()
              .child(image(d.path).w(size.w).h(size.h).flex_none()), 4);
          }
          const note = d.state === "wait" ? "Rendering diagram…" : d.state === "missing" ? `Mermaid CLI not found. To see diagrams: ${INSTALL}` : d.state === "error" ? `Diagram not drawn: ${d.error}` : null;
          return lane(v_flex().px(4).text_size(14).line_height("23px")
            .child(TextView.markdown(`md-${m.id}`, "```" + m.lang + "\n" + m.text + "\n```").selectable(true))
            .when(note != null, (el) => el.child(div().px(12).pb(2).text_size(12).line_height("18px").text_color(d.state === "error" ? k.destructiveText : k.muted).child(note))), 4);
        }
        // A stretch of a reply: text you can select, or one code block (under its header row).
        return lane(div().px(4).py(m.code ? 0 : 2).text_size(14).line_height("23px")
          .child(TextView.markdown(`md-${m.id}`, m.code ? "```" + m.lang + "\n" + m.text + "\n```" : m.text).selectable(true)), 4);
      case "codehead":
        // ChatMarkdown's code header: Copy at the right (the block names its language itself).
        return lane(h_flex().mx(4).mt(4).h(28).pl(12).pr(6).items_center().justify_end().rounded_t(8).border(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.muted, 0.08))
          .child(this.copyMark(k, m.id, "Copy")), 0);
      case "diaghead": {
        // A diagram's header: the picture or its source, and Copy for the source. Two buttons, so the row itself takes no click.
        const d = this.diagrams.get(m.text, k.dark), code = !!this.expanded[m.seg] || this.hitAt.has(m.seg);
        return lane(h_flex().mx(4).mt(4).h(28).pl(12).pr(6).gap(4).items_center().rounded_t(8).border(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.muted, 0.08))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child("mermaid"))
          .when(d.state === "ready", (el) => el.child(h_flex().id(`dg-${m.id}`).h(20).px(4).gap(4).flex_none().items_center().rounded(4).cursor_pointer().text_size(12).text_color(alpha(k.muted, 0.8))
            .role("button").accessibility_label(code ? "Show diagram" : "Show code").hover((s) => s.bg(k.accent).text_color(k.foreground))
            .on_click((_e, cx) => { this.expanded[m.seg] = !this.expanded[m.seg]; cx.notify(); })
            .child(icon(code ? "eye" : "code-xml").size(12).flex_none()).child(code ? "Show diagram" : "Show code")))
          .child(div().id(`dc-${m.id}`).flex_none().role("button").accessibility_label("Copy the diagram's source").on_click((_e, cx) => this.copy(cx, m.id, m.text)).child(this.copyMark(k, m.id, "Copy"))), 0);
      }
      case "files": {
        // T3's changed-files card at the end of a turn: what the turn changed, its diff, and Revert.
        const cp = m.of.cp;
        return lane(h_flex().h(40).pl(12).pr(6).gap(8).items_center().rounded(12).border(1).border_color(alpha(k.border, 0.7)).bg(alpha(k.card, 0.6)).text_size(13)
          .child(icon("file-diff").size(14).flex_none().text_color(k.muted))
          .child(div().flex_none().child(`${cp.files} file${cp.files === 1 ? "" : "s"} changed`))
          .child(h_flex().flex_1().gap(6).font_family(k.mono).text_size(11)
            .child(div().text_color(k.successText).child(`+${cp.add}`)).child(div().text_color(k.destructiveText).child(`−${cp.del}`)))
          .child(button(k, `turn-diff-${m.id}`, "View diff", () => this.turnDiff(m.of), { variant: "ghost" }))
          .child(div().id(`turn-revert-${m.id}`).h(28).px(8).flex().items_center().rounded(6).text_size(13).text_color(k.muted).cursor_pointer().role("button")
            .accessibility_label("Revert the files to before this message").tooltip("Put the files back as they were before this message")
            .hover((s) => s.bg(k.accent).text_color(k.foreground)).on_mouse_down("left", (e) => this.askRevert(e.position, m.of)).child("Revert")), 12);
      }
      case "copy":
        // chat/MessageCopyButton.tsx, under the message: its right edge for yours, its left for a reply.
        if (m.quote) {
          const shown = m.always || this.over === String(m.id).split(":")[0];
          return lane(h_flex().w_full().px(2).gap(2)
            .child(div().id(`cp-${m.id}`).flex_none().role("button").accessibility_label("Copy this reply").on_click((_e, cx) => this.copy(cx, m.id, m.text)).child(this.copyMark(k, m.id, null, shown)))
            .child(div().id(`qt-${m.id}`).flex_none().role("button").accessibility_label("Quote this reply in the message box").tooltip("Quote in the message box")
              .on_click((_e, cx) => this.quoteReply(cx, m.id, m.text)).child(this.quoteMark(k, m.id, shown))), 12);
        }
        return lane(h_flex().w_full().px(m.right ? 0 : 2).when(!!m.right, (el) => el.justify_end()).child(this.copyMark(k, m.id, null, m.always || this.over === String(m.id).split(":")[0])), 12);
      case "thought": {
        const found = this.hitAt.has(m.id), open = this.expanded[m.id] || found;
        // T3: the thought itself on one muted line; it opens to the whole of it.
        const line = (m.text ?? "").trim().split("\n")[0];
        return lane(v_flex()
          .child(workLine(k, "brain", line || (m.open ? "Thinking" : "Thought"), { trail: [chevron(open)] }))
          .when(open, (el) => el.child(div().ml(30).py(4).text_size(14).line_height("23px").text_color(alpha(k.foreground, 0.8)).child(found ? this.marked(k, m.text, this.hitAt.get(m.id)) : m.text))), 8);
      }
      case "tool": {
        const failed = m.status === "failed";
        const running = m.status === "in_progress" || m.status === "pending";
        const found = this.hitAt.has(m.id), title = String(m.title ?? "").split("\n")[0];
        const inTitle = found ? title.toLowerCase().split(this.findQuery()).length - 1 : 0;
        const open = (this.expanded[m.id] || (found && !!m.detail && detailOf(m).toLowerCase().includes(this.findQuery()))) && (m.detail || m.lazy);
        const can = !!(m.detail || m.lazy);
        const trail = [];
        if (failed) trail.push(icon("x").size(12).flex_none().text_color(k.destructive));
        if (can) trail.push(chevron(open));
        const detail = m.detail ?? (m.loading ? "Loading…" : "");
        return lane(v_flex()
          .child(workLine(k, TOOL_GLYPH[m.toolKind] ?? "wrench", inTitle ? this.marked(k, title, this.hitAt.get(m.id), true) : m.title || "Working…", {
            color: failed ? k.destructive : running ? alpha(k.foreground, 0.8) : null, bold: failed, trail }))
          .when(open, (el) => el.child(div().ml(30).mt(2).mb(6).pb(8).text_size(12).line_height("18px").font_family(k.mono).text_color(k.muted)
            .child(found && m.detail ? this.marked(k, detailOf(m), this.hitAt.get(m.id) + inTitle) : detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) + "\n…" : detail))), 4);
      }
      case "plan":
        // chat/ProposedPlanCard.tsx
        return lane(v_flex().p(16).gap(12).rounded(16).border(1).border_color(alpha(k.border, 0.8)).bg(alpha(k.card, 0.7))
          .child(h_flex().gap(8).items_center().child(badge(k, "Plan")).child(div().text_size(14).font_medium().child("Plan")))
          .child(v_flex().gap(4).children(m.entries.map((e) => h_flex().gap(8).items_start().text_size(14).line_height("23px")
            .child(h_flex().size(16).mt(3).flex_none().items_center().justify_center().rounded(4).border(1)
              .border_color(e.status === "completed" ? k.primary : k.input).bg(e.status === "completed" ? k.primary : "#00000000")
              .text_color(k.primaryText).when(e.status === "completed", (el) => el.child(icon("check").size(12))))
            .child(div().flex_1().min_w(0).text_color(e.status === "completed" ? k.muted : e.status === "in_progress" ? k.foreground : alpha(k.foreground, 0.8))
              .when(e.status === "in_progress", (el) => el.font_medium()).child(e.content)))))
          // The newest plan, made in plan mode, with the agent waiting: one click leaves plan mode and says go.
          .when(this.planMode()?.on === true && this.view?.status === "ready" && this.source.state?.transcript.items.findLast((i) => i.kind === "plan")?.entries === m.entries, (el) => el
            .child(h_flex().justify_end().child(button(k, "plan-implement", "Implement this plan", (cx) => this.implementPlan(cx), { variant: "default", size: "sm", glyph: "hammer" })))), 16);
      case "notice":
        // A revert's note, while it can be undone: its words and Undo, as the changed-files row it answers.
        if (m.undo) return lane(h_flex().min_h(40).pl(12).pr(6).py(8).gap(8).items_center().rounded(12).border(1).border_color(alpha(k.border, 0.7)).bg(alpha(k.card, 0.6)).text_size(13)
          .child(icon("rotate-ccw").size(14).flex_none().text_color(k.muted))
          .child(div().flex_1().min_w(0).line_height("18px").text_color(alpha(k.foreground, 0.8)).child(m.text))
          .child(div().id(`undo-revert-${m.id}`).h(28).px(8).flex().flex_none().items_center().rounded(6).text_size(13).text_color(k.muted).cursor_pointer().role("button")
            .accessibility_label("Undo the revert").tooltip("Put the files back as they were before the revert. Refused if files changed since.")
            .hover((s) => s.bg(k.accent).text_color(k.foreground)).on_mouse_down("left", (_e, cx) => this.undoRevert(cx, m)).child(this.undoing ? "Undoing…" : "Undo")), 12);
        if (m.level === "info") return lane(divider(k, m.text), 0);
        return lane(v_flex()
          .child(workLine(k, "circle-alert", m.text.split("\n")[0], { color: m.level === "error" ? k.destructive : k.warning, bold: true }))
          .when(m.text.includes("\n"), (el) => el.child(div().ml(30).py(4).text_size(14).line_height("23px").text_color(alpha(k.foreground, 0.8))
            .child(m.text.split("\n").slice(1).join("\n").trim()))), 8);
      case "earlier":
        return lane(divider(k, "Show earlier messages"), 0);
      case "fold":
        // chat/TimelineWorkGroupRows.tsx: the words, a chevron, and a hairline under them.
        return lane(h_flex().pt(4).pb(8).border_b(1).border_color(alpha(k.border, 0.6))
          .child(h_flex().h(24).px(4).gap(6).items_center().rounded(6).text_size(14).line_height("23px").text_color(k.muted).when(!m.bare, (el) => el.cursor_pointer())
            .child(m.label).when(!m.bare, (el) => el.child(icon(m.open ? "chevron-down" : "chevron-right").size(12).flex_none()))), m.open ? 6 : 12);
      case "working":
        // chat/TimelineWorkGroupRows.tsx: words and a timer, no spinner.
        return lane(h_flex().pt(4).pb(8).border_b(1).border_color(alpha(k.border, 0.6))
          .child(div().h(24).px(4).text_size(14).line_height("23px").text_color(k.muted)
            .child(`Working for ${seconds(Date.now() - (this.since ?? Date.now()))}${m.doing ? ` · ${m.doing}` : ""}`)), 6);
    }
    return lane(div(), 0);
  }

  // The keys of the open menu. -> whether the key was the menu's.
  menuKey(key, cx) {
    const items = this.trig && this.view ? this.menuItems(this.view) : [];
    if (!this.trig) return false;
    if (key === "escape") { this.trig = null; cx.notify(); return true; }
    if (!items.length) return false;
    if (key === "down" || key === "up") { this.hot = ((this.hot ?? 0) + (key === "down" ? 1 : -1) + items.length) % items.length; cx.notify(); return true; }
    if (key === "enter" || key === "tab") { this.choose(cx, items[Math.min(this.hot ?? 0, items.length - 1)]); return true; }
    return false;
  }

  // chat/ComposerCommandMenu.tsx: a surface over the message box, as wide as it; rows 32 high with
  // 8px corners: an icon, the name (12px medium), what it does (12px, muted).
  triggerPanel(k, v) {
    const t = this.trig, items = this.menuItems(v);
    const empty = t.kind === "skill" ? "No skills found. Try / to browse provider commands."
      : t.kind === "path" ? (this.files?.list ? "No matching files or folders." : "Searching workspace files...") : "No matching command.";
    const rowH = 32, h = items.length ? Math.min(288, items.length * rowH + 8) : 44;
    return h_flex().w_full().flex_none().justify_center().px(16).pb(6)
      .child(v_flex().id("ht3-composer-menu").w_full().max_w(LANE).h(h).p(4).rounded(12).border(1).border_color(alpha(k.foreground, k.dark ? 0.1 : 0.08)).bg(k.popover).shadow_lg()
        .when(!items.length, (el) => el.child(div().px(12).py(8).text_size(12).text_color(k.muted).child(empty)))
        .when(items.length > 0, (el) => el.child(v_flex().relative().flex_1().min_h(0)
          .child(list("ht3-composer-menu-rows", items.length, (i) => `${i}:${items[i].name}`, (i) => {
            const c = items[i], on = i === Math.min(this.hot ?? 0, items.length - 1);
            if (c.file) {
              const cut = c.name.lastIndexOf("/");
              return h_flex().h(rowH).px(8).gap(8).items_center().rounded(8).bg(on ? k.accent : "#00000000")
                .child(fileIcon(c.name.slice(cut + 1), k.dark, 16))
                .child(div().flex_none().max_w("60%").truncate().text_size(12).font_medium().child(c.name.slice(cut + 1)))
                .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(cut > 0 ? c.name.slice(0, cut) : ""));
            }
            return h_flex().h(rowH).px(8).gap(8).items_center().rounded(8).bg(on ? k.accent : "#00000000")
              .child(icon(c.skill ? "sparkles" : c.local ? "corner-down-left" : "terminal").size(16).flex_none().text_color(k.muted))
              .child(div().flex_none().max_w("45%").truncate().text_size(12).font_medium().child(`/${c.name}`))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(c.description ?? ""));
          }).on_item_click((key, cx) => this.choose(cx, items[Number(String(key).split(":")[0])])))
          .child(Scrollbar.vertical("ht3-composer-menu-rows").absolute().inset_0()))));
  }

  // The choices of one composer control, as T3's menus look: 4 in, radius 8, 28px rows.
  pickerPanel(k, v) {
    if (this.picker === "__stash") return this.stashPanel(k);
    const opt = v.options.find((o) => o.id === this.picker);
    if (!opt) return div();
    const f = this.filter.value().toLowerCase();
    const choices = opt.choices.filter((c) => !f || c.name.toLowerCase().includes(f) || String(c.value).toLowerCase().includes(f));
    const search = opt.choices.length > 8;
    return h_flex().w_full().flex_none().justify_center().px(16).pb(6)
      .child(h_flex().w_full().max_w(LANE).justify_end()
        .child(v_flex().w(320).h(Math.min(300, (search ? 44 : 8) + Math.max(1, choices.length) * 28)).p(4).rounded(8).border(1).border_color(k.border).bg(k.popover).shadow_lg()
          .when(search, (el) => el.child(div().h(32).px(8).mb(4).border_b(1).border_color(k.border).text_size(14).child(Input.new(this.filter))))
          .child(v_flex().relative().flex_1().min_h(0)
            .child(list(`pick-${opt.id}`, choices.length, (i) => String(choices[i].value), (i) => {
              const c = choices[i];
              const on = c.value === opt.current;
              return h_flex().h(28).px(8).gap(8).items_center().rounded(4).text_size(14).bg(on ? k.accent : "#00000000")
                .child(div().flex_1().min_w(0).truncate().child(c.name))
                .when(on, (el) => el.child(icon("check").size(14).flex_none().text_color(k.muted)));
            }).on_item_click((value, cx) => {
              this.source.setOption(opt.id, value);
              this.picker = null;
              cx.notify();
            }))
            .child(Scrollbar.vertical(`pick-${opt.id}`).absolute().inset_0())
            .when(!choices.length, (el) => el.child(div().px(8).py(4).text_size(12).text_color(k.muted).child("No matches."))))));
  }

  // chat/ComposerUsageLimits.tsx: a line over the message box when a limit is near or reached. Only what the agent
  // says is known: Claude Code's adapter sends the account's rate limit (status, how much is used, when it resets),
  // any agent's refusal for a limit comes as an error, and every agent that reports its context says how full it is.
  // -> an element, or null. The × hides that one state until it changes.
  limitLine(k, v) {
    const l = v.limit, full = v.usage?.size > 0 ? v.usage.used / v.usage.size : 0;
    const when = (at) => { const d = new Date(at * 1000), mins = Math.round((at * 1000 - Date.now()) / 60000);
      return mins <= 0 ? "" : ` · resets ${mins < 60 ? `in ${mins} min` : mins < 24 * 60 ? `at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : `in ${Math.round(mins / 1440)} d`}`; };
    const kind = { five_hour: "5-hour limit", seven_day: "weekly limit", seven_day_opus: "weekly Opus limit", seven_day_sonnet: "weekly Sonnet limit", overage: "extra-usage limit" }[l?.type] ?? "usage limit";
    let say = null;
    if (l?.status === "rejected") say = { bad: true, text: l.text ? `The agent says a limit is reached: ${l.text}` : `The ${kind} is reached${l.resetsAt ? when(l.resetsAt) : ""}`, key: `r${l.type ?? ""}${l.resetsAt ?? l.text ?? ""}` };
    else if (l?.status === "allowed_warning") say = { text: `Near the ${kind}${l.utilization != null ? `: ${Math.round(100 * l.utilization)}% used` : ""}${l.resetsAt ? when(l.resetsAt) : ""}`, key: `w${l.type ?? ""}${Math.round(20 * (l.utilization ?? 0))}` };
    else if (full >= 0.9) say = { bad: full >= 0.97, text: `Context ${Math.round(100 * full)}% full: the agent may compact or stop soon. /compact where the agent has it, or start fresh.`, key: `c${full >= 0.97 ? 2 : 1}`, fresh: true };
    if (!say || this.limitHidden === say.key) return null;
    const c = say.bad ? k.destructiveText : k.warningText;
    return h_flex().id("ht3-limit").mx(12).mb(-1).px(12).h(32).gap(8).items_center().rounded_t(12).border(1).border_color(alpha(c, 0.35)).bg(alpha(c, 0.08)).text_size(12).text_color(c)
      .role("status").accessibility_label(say.text)
      .child(icon(say.bad ? "circle-alert" : "clock").size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().tooltip(say.text).child(say.text))
      // ComposerFreshSession: the context is full, so the next message may begin a fresh session instead.
      .when(!!say.fresh && !this.fresh && this.source.kind === "acp" && v.alive, (el) => el.child(button(k, "limit-fresh", "Start fresh", (cx) => this.armFresh(cx, true), { variant: "ghost", glyph: "eraser" })))
      .child(h_flex().id("limit-hide").size(20).flex_none().items_center().justify_center().rounded(5).cursor_pointer().role("button").accessibility_label("Hide this notice").tooltip("Hide")
        .hover((st) => st.bg(alpha(c, 0.15))).on_click((_e, cx) => { this.limitHidden = say.key; cx.notify(); }).child(icon("x").size(12)));
  }

  // chat/ComposerFreshSession.tsx: over the box while "/clear" is armed. Its button keeps the current session.
  freshBanner(k) {
    if (!this.fresh || this.source.kind !== "acp") return null;
    const c = k.info;
    return h_flex().id("ht3-fresh").mx(22).px(16).py(8).gap(10).items_center().rounded_t(16).border(1).border_color(alpha(c, 0.32)).bg(k.card)
      .role("status").accessibility_label("Your next message starts a fresh session")
      .child(icon("eraser").size(16).flex_none().text_color(c))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_medium().child("Your next message starts a fresh session"))
        .child(div().text_size(12).text_color(k.muted).child("The agent won't see earlier messages in this thread.")))
      .child(button(k, "fresh-keep", "Keep the current session", (cx) => this.armFresh(cx, false), { variant: "outline" }));
  }

  // The problem to show for an agent that isn't running (agent-acp.js diagnose), unless it was dismissed (×) until it changes.
  problemOf(v) {
    const pr = this.source.kind === "acp" ? v.problem : null;
    return pr && this.statusHidden !== `${pr.kind}:${pr.title}:${pr.detail.slice(-40)}` ? pr : null;
  }

  // chat/ProviderStatusBanner.tsx: when the agent can't be there, a banner at the top of the chat that says in plain
  // words what is wrong, the command Herdr tried, and what to do: Retry, Copy command, a terminal in the chat's folder.
  statusBanner(k, v) {
    const pr = this.problemOf(v);
    if (!pr) return null;
    const c = k.destructiveText, shown = (what) => (this.copied === what ? "Copied" : null);
    const printed = pr.detail.split("\n").slice(-8).join("\n");
    const where = v.machine ? `on ${v.machine}` : v.cwd ? `in ${shortPath(v.cwd)}` : null;
    const canTerm = !!this.reporter?.pane && !v.machine;
    return h_flex().id("ht3-agent-status").w_full().flex_none().justify_center().px(16).pt(12)
      .child(v_flex().w_full().max_w(LANE).p(12).gap(8).rounded(12).border(1).border_color(alpha(c, 0.35)).bg(alpha(c, k.dark ? 0.08 : 0.05)).role("alert").accessibility_label(`${pr.title}. ${pr.message}`)
        .child(h_flex().gap(8).items_start()
          .child(icon(pr.kind === "auth" ? "key-round" : "triangle-alert").size(16).mt(2).flex_none().text_color(c))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().text_size(14).font_medium().text_color(c).child(pr.title))
            .child(div().text_size(13).line_height("19px").text_color(alpha(k.foreground, 0.85)).child(pr.message)))
          .child(h_flex().id("status-hide").size(20).flex_none().items_center().justify_center().rounded(5).cursor_pointer().role("button").accessibility_label("Dismiss").tooltip("Dismiss")
            .hover((st) => st.bg(alpha(c, 0.15))).on_click((_e, cx) => { this.statusHidden = `${pr.kind}:${pr.title}:${pr.detail.slice(-40)}`; cx.notify(); }).child(icon("x").size(12))))
        .when(pr.kind !== "remote", (el) => el.child(v_flex().gap(3)
          .child(div().text_size(11).text_color(k.muted).child(where ? `Command tried, ${where}` : "Command tried"))
          .child(div().px(8).py(6).rounded(8).border(1).border_color(alpha(k.border, 0.8)).bg(k.card).text_size(12).font_family(k.mono).child(pr.command))))
        .when(!!printed, (el) => el.child(v_flex().gap(3)
          .child(div().text_size(11).text_color(k.muted).child("What it printed"))
          .child(div().px(8).py(6).rounded(8).border(1).border_color(alpha(k.border, 0.8)).bg(k.card).text_size(11).line_height("16px").font_family(k.mono).text_color(alpha(k.foreground, 0.8)).child(printed))))
        .child(h_flex().gap(6).flex_wrap().justify_end()
          .child(button(k, "status-settings", "Settings", () => run(`${MOD}.settings`), { variant: "ghost-muted" }))
          .when(canTerm, (el) => el.child(button(k, "status-terminal", "Open a terminal here", () => this.openTerminal(this.reporter.pane), { variant: "outline", glyph: "square-terminal" })))
          .when(!!pr.install, (el) => el.child(button(k, "status-install", shown("status-install") ?? "Copy install command", (cx) => this.copy(cx, "status-install", pr.install), { variant: "outline", glyph: "copy" })))
          .when(pr.kind !== "remote", (el) => el.child(button(k, "status-copy", shown("status-cmd") ?? "Copy command", (cx) => this.copy(cx, "status-cmd", pr.command), { variant: "outline", glyph: "copy" })))
          .child(button(k, "status-retry", "Retry", (cx) => this.retry(cx), { variant: "default", glyph: "rotate-ccw" }))));
  }

  // chat/ComposerSurface.tsx and ComposerPrimaryActions.tsx.
  composer(k, v) {
    const lane = (body) => h_flex().w_full().flex_none().justify_center().px(16).pb(12).child(v_flex().w_full().max_w(LANE).child(body));
    const line = alpha(k.foreground, k.dark ? 0.1 : 0.08);

    // The drawer tucked on top of the card: an approval, or why the agent isn't there.
    let drawer = null;
    if (v.permission) {
      const p = v.permission;
      drawer = v_flex().mx(22).px(16).pt(8).pb(10).gap(8).rounded_t(16).border(1).border_color(line).bg(k.card)
        .child(h_flex().gap(6).items_center().text_size(12).text_color(k.muted)
          .child(icon("shield").size(12).text_color(k.warning)).child("Waiting for approval"))
        .child(div().text_size(14).line_height("23px").child(p.title))
        .when(!!p.note, (el) => el.child(div().text_size(12).text_color(k.muted).child(p.note)))
        .child(h_flex().gap(6).flex_wrap().justify_end()
          .when(this.source.kind === "acp" && p.options.some((o) => o.kind?.startsWith("allow")), (el) => el.child(button(k, "perm-always-session", "Always allow this session", (cx) => this.allowAlways(cx), { variant: "ghost-muted" })))
          .children(p.options.map((o) =>
            button(k, `perm-${o.optionId}`, o.name, (cx) => this.source.answer(cx, o.optionId), { variant: o.kind?.startsWith("allow") ? "default" : "outline" }))));
    } else if (this.autoAllow && v.alive) {
      // Said while it is on, with the way back.
      drawer = h_flex().mx(22).px(16).h(32).gap(6).items_center().rounded_t(16).border(1).border_color(line).bg(k.card).text_size(12).text_color(k.muted)
        .child(icon("shield-off").size(12).flex_none().text_color(k.warning)).child(div().flex_1().min_w(0).truncate().child("Approvals are allowed automatically this session"))
        .child(button(k, "perm-ask-again", "Ask again", (cx) => { this.allow(false); cx.notify(); }, { variant: "ghost-muted" }));
    } else if (!v.alive && v.status !== "starting" && !this.problemOf(v)) {
      drawer = v_flex().mx(22).px(16).pt(8).pb(10).gap(8).rounded_t(16).border(1).border_color(alpha(k.destructive, 0.32)).bg(k.card)
        .when(!!v.error, (el) => el.child(div().text_size(12).line_height("18px").text_color(k.destructiveText).child(String(v.error).slice(0, 1200))))
        .child(h_flex().gap(6).justify_end()
          .when(this.source.kind === "acp" && !!this.source.state, (el) => el.child(button(k, "restart", "Restart agent", (cx) => this.source.restart(cx), { variant: "default", glyph: "rotate-ccw" })))
          .child(button(k, "drawer-new", "New chat", () => openLauncher(), { variant: "outline" }))
          .when(this.source.kind === "acp", (el) => el.child(button(k, "drawer-settings", "Settings", () => run(`${MOD}.settings`), { variant: "outline" }))));
    }

    const working = v.status === "working";
    const acp = this.source.kind === "acp";
    const has = this.hasText || (acp && this.attached?.length > 0);
    // While an ACP agent works, a message can still be sent: it queues (or steers). Stop stays beside Send then.
    const busy = acp && ["working", "blocked", "starting"].includes(v.status);
    const can = v.alive && has && (acp || this.source.kind === "term");
    const stopBtn = () => h_flex().id("stop").size(32).flex_none().items_center().justify_center().rounded_full().bg(alpha(k.destructive, 0.9)).text_color("#ffffff")
      .shadow_xs().cursor_pointer().tooltip("Interrupt").role("button").accessibility_label("Stop generation").hover((s) => s.bg(k.destructive))
      .on_click(() => this.source.stop()).child(icon("stop").size(12));
    const sendBtn = () => h_flex().id("send").size(32).flex_none().items_center().justify_center().rounded_full()
      .bg(can ? k.primary : alpha(k.foreground, 0.12)).text_color(can ? k.primaryText : k.muted)
      .role("button").accessibility_label(busy ? (followUp() === "steer" ? (v.steering ? "Steer: send into the running turn" : "Steer: interrupt and send") : "Queue message") : "Submit message")
      .when(can && busy, (el) => el.tooltip(followUp() === "steer" ? (v.steering ? "Send into the running turn" : "Interrupt and send now") : "Queue for when the agent is done"))
      .when(can, (el) => el.shadow_xs().cursor_pointer().hover((s) => s.bg(alpha(k.primary, 0.9))).on_click((_e, cx) => this.send(cx)))
      .child(icon("arrow-up").size(14));
    const action = working && !(acp && has) ? stopBtn() : working ? h_flex().gap(6).flex_none().child(stopBtn()).child(sendBtn()) : sendBtn();

    // QueuedRunsControl.tsx: the waiting messages over the message box, at its right edge: the first three, then a count.
    const queue = acp ? this.queue ?? [] : [];
    const qBtn = (id, glyph, tip, fn) => h_flex().id(id).size(22).flex_none().items_center().justify_center().rounded(6).text_color(k.muted).cursor_pointer().role("button").accessibility_label(tip).tooltip(tip)
      .hover((s) => s.bg(k.accent).text_color(k.foreground)).on_click((_e, cx) => fn(cx)).child(icon(glyph).size(13));
    const queueRows = v_flex().w_full().items_end().gap(6).pb(8)
      .child(div().text_size(11).text_color(k.muted).child(`${queue.length} queued${v.status === "ready" ? "" : ": sent when the agent is done"} · ↑ in an empty box edits the last, then earlier messages`))
      .children(queue.slice(0, 3).map((q, i) => h_flex().max_w("80%").min_w(0).h(34).pl(12).pr(4).gap(4).items_center().rounded(12).border(1).border_color(alpha(k.border, 0.8)).bg(alpha(k.message, 0.5)).text_size(13)
        .child(div().flex_1().min_w(0).truncate().text_color(alpha(k.foreground, 0.8)).child(q.text || `${q.files.length} file${q.files.length === 1 ? "" : "s"}`))
        .when(q.files.length > 0 && !!q.text, (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child(`+${q.files.length}`)))
        .when(i > 0, (el) => el.child(qBtn(`q-up-${i}`, "arrow-up", "Move up: send it sooner", (cx) => this.queued(cx, "up", i))))
        .child(qBtn(`q-steer-${i}`, "corner-down-left", v.steering ? "Send now, into the running turn" : "Send now: interrupt the agent", (cx) => this.queued(cx, "steer", i)))
        .child(qBtn(`q-edit-${i}`, "pen-line", "Edit: back into the message box", (cx) => this.queued(cx, "edit", i)))
        .child(qBtn(`q-drop-${i}`, "x", "Remove from the queue", (cx) => this.queued(cx, "drop", i)))))
      .when(queue.length > 3, (el) => el.child(div().text_size(11).text_color(k.muted).child(`and ${queue.length - 3} more`)));

    const plan = this.planMode();
    const stashKey = this.stashKey(), nStash = this.stashed().length;
    const nTerm = this.terminals().length, termShown = nTerm > 0 && !panes().find((p) => p.pane === this.reporter?.pane)?.zoomed;
    const controls = v.options.map((o) => {
      const cur = o.choices.find((c) => c.value === o.current);
      // A model named by its path ("provider/Model") shows as the model alone, as T3 Code shows it:
      // the start of the path says least and would push the name out of the control. The menu lists the whole names.
      const whole = String(cur?.name ?? o.current ?? o.name), cut = (o.category ?? o.id) === "model" ? whole.lastIndexOf("/") : -1;
      const named = cut > 0 && cut < whole.length - 1 ? { label: whole.slice(cut + 1) } : { label: whole };
      return control(k, `opt-${o.id}`, {
        glyph: OPTION_GLYPH[o.category ?? o.id] ?? (o.id === "model" ? "sparkles" : "lock"),
        // T3's model control leads with the harness's own icon.
        mark: (o.category ?? o.id) === "model" && this.source.kind === "acp" ? agentMark(agentOf(this.source.state?.agentArgv), 16, alpha(k.foreground, 0.8)) : null,
        label: named.label, suffix: o.suffix ?? null, open: this.picker === o.id,
        onClick: o.readonly ? null : (cx) => {
          this.picker = this.picker === o.id ? null : o.id;
          this.filter.set_value("");
          if (this.picker && o.choices.length > 8) this.filter.focus();
          cx.notify();
        },
      });
    });

    // chat/ComposerAttachmentStrip.tsx: pictures as 56px thumbnails, other files as chips, each with its ×.
    const files = this.source.kind === "acp" ? this.attached ?? [] : [];
    const strip = h_flex().px(12).pt(12).gap(8).flex_wrap().children(files.map((a, i) => {
      const x = h_flex().id(`att-x-${i}`).absolute().top(-6).right(-6).size(16).items_center().justify_center().rounded_full().border(1).border_color(k.border).bg(k.popover)
        .text_color(k.muted).cursor_pointer().role("button").accessibility_label(`Remove ${a.name}`).hover((s) => s.text_color(k.foreground))
        .on_click((_e, cx) => { this.attached.splice(i, 1); cx.notify(); }).child(icon("x").size(10));
      return a.image
        ? div().relative().size(56).flex_none().rounded(8).border(1).border_color(alpha(k.border, 0.8)).when(!!a.thumb, (el) => el.child(h_flex().size(54).rounded(7).overflow_hidden().items_center().justify_center().child(image(a.thumb).w(54)))).child(x)
        : h_flex().relative().h(28).pl(8).pr(10).gap(6).flex_none().max_w(220).items_center().rounded(8).border(1).border_color(alpha(k.border, 0.8)).bg(alpha(k.accent, 0.5)).text_size(12)
          .child(fileIcon(a.name, k.dark, 14)).child(div().min_w(0).truncate().child(a.name)).child(x);
    }));
    const clip = this.source.kind === "acp"
      ? iconButton(k, "attach", "plus", (cx) => this.pickFiles(cx), { size: "sm", tip: "Attach files (or drop them here, or paste a picture)" }) : null;
    const card = v_flex().rounded(16).border(1).border_color(line).bg(k.card).shadow_xs()
      .on_drop((e, cx) => { if (this.source.kind === "acp") this.addFiles(cx, e.paths); })
      .when(files.length > 0, (el) => el.child(strip))
      .when(this.sending?.length > 0, (el) => el.child(div().px(16).pt(10).text_size(12).text_color(k.muted).child(`Sending ${this.sending.length} file${this.sending.length === 1 ? "" : "s"}…`)))
      .child(div().px(16).pt(14).pb(8).text_size(14).line_height("23px")
        .on_size_change((size, cx) => {
          const w = size.width / (Number(settings()?.zoom) || 1);
          if (Math.abs(w - (this.fieldW ?? 0)) < 1) return;
          this.fieldW = w;
          if (this.fitHint()) cx.notify();
        })
        // The open menu's arrows, Tab and Esc, where the text area lets them through (Enter comes as its submit).
        .on_key_down((e, cx) => {
          const key = String(e.key ?? "").toLowerCase(), mod = e.modifiers ?? {};
          if (mod.platform || mod.control) return;
          // ↑ and ↓ walk the queued messages and the prompts sent before (recallKey). An open menu has the arrows
          // first, unless the box holds a recalled message as it came (a recalled "/word" opens the menu by itself).
          // With alt they are the caret's, but for alt+↑ in an empty box (T3's key for the last queued message).
          if ((key === "up" || key === "down") && !mod.shift && (!mod.alt || !this.input.value()) && (!this.trig || this.recalled()) && this.recallKey(cx, key)) return cx.stop_propagation?.();
          if (!this.trig || mod.alt) return;
          if (this.menuKey(key, cx)) cx.stop_propagation?.();
        })
        .child(Textarea.new(this.input).token((tok) => h_flex().h(20).px(4).gap(4).items_center().rounded(4).border(1).border_color(alpha(k.border, 0.8))
          .bg(alpha(k.accent, 0.6)).text_size(12).child(fileIcon(tok.token.label ?? tok.token.id, k.dark, 12)).child(tok.token.label ?? tok.token.id))))
      .child(h_flex().px(8).pb(8).gap(2).items_center()
        .when(!!clip, (el) => el.child(clip))
        // chat/ComposerStashMenu.tsx: the parked drafts of this project, with how many there are.
        .when(!!stashKey, (el) => el.child(h_flex().id("stash").h(28).px(6).gap(4).flex_none().items_center().rounded(8).text_size(12).cursor_pointer().role("button")
          .bg(this.picker === "__stash" ? k.accent : "#00000000").text_color(nStash ? alpha(k.foreground, 0.8) : k.muted)
          .accessibility_label("Prompt stash").tooltip(nStash ? `${nStash} parked draft${nStash === 1 ? "" : "s"} for this project` : "Park this draft to come back to it (/stash)")
          .hover((st) => st.bg(k.accent).text_color(k.foreground)).on_click((_e, cx) => { this.picker = this.picker === "__stash" ? null : "__stash"; cx.notify(); })
          .child(icon("archive").size(14).flex_none()).when(nStash > 0, (e) => e.child(String(nStash)))))
        // The chat's own terminal: lit while it shows under the chat.
        .when(this.source.kind === "acp" && !!this.reporter?.tab, (el) => el.child(h_flex().id("chat-term").size(28).flex_none().items_center().justify_center().rounded(8).cursor_pointer().role("button")
          .bg(termShown ? k.accent : "#00000000").text_color(termShown ? k.foreground : k.muted)
          .accessibility_label("This chat's terminal").tooltip(!nTerm ? "Open a terminal for this chat, under it" : termShown ? "Hide this chat's terminal (it keeps running)" : "Show this chat's terminal")
          .hover((st) => st.bg(k.accent).text_color(k.foreground)).on_click((_e, cx) => this.toggleTerminal(cx))
          .child(icon("square-terminal").size(14).flex_none())))
        .when(!!plan, (el) => el.child(h_flex().id("plan-toggle").h(28).px(8).gap(6).flex_none().items_center().rounded(8).text_size(14).font_medium()
          .bg(plan.on ? alpha(k.primary, 0.14) : "#00000000").text_color(plan.on ? k.primary : alpha(k.foreground, 0.8)).cursor_pointer().role("button")
          .accessibility_label(plan.on ? "Plan mode is on" : "Plan mode").tooltip(plan.on ? "Plan mode is on: the agent plans and changes nothing. Click to leave it." : "Plan first: the agent proposes a plan and changes nothing")
          .hover((st) => st.bg(plan.on ? alpha(k.primary, 0.2) : k.accent)).on_click((_e, cx) => this.togglePlan(cx))
          .child(icon("list-todo").size(16).flex_none()).child("Plan")))
        .child(div().flex_1())
        .children(controls)
        .child(div().w(6).flex_none())
        .child(action));
    const limit = this.limitLine(k, v), subs = this.subBar(k, v), srv = v.cwd ? serversStrip(k, this.servers.at({ cwd: v.cwd, on: v.machine ?? null })) : null;
    const fresh = this.freshBanner(k);
    const box = drawer || limit || subs || srv || fresh ? v_flex().when(!!limit, (el) => el.child(limit)).when(!!srv, (el) => el.child(srv)).when(!!subs, (el) => el.child(subs)).when(!!fresh, (el) => el.child(fresh)).when(!!drawer, (el) => el.child(drawer)).child(card) : card;
    // While a queued message is in the box: what it is, where a draft went, and the way back.
    const editLine = this.editing ? h_flex().w_full().justify_end().items_center().gap(6).pb(6).text_size(11).text_color(k.muted)
      .child(div().min_w(0).truncate().child(this.parked ? "Editing a queued message · your draft comes back when it is sent" : "Editing a queued message"))
      .child(button(k, "q-back", this.parked ? "Back to draft" : "Put it back", (cx) => this.backToDraft(cx), { variant: "ghost-muted" }))
      // A sent prompt recalled over a draft (files attached to an empty box): the same line, the same way back.
      : this.parked ? h_flex().w_full().justify_end().items_center().gap(6).pb(6).text_size(11).text_color(k.muted)
        .child(div().min_w(0).truncate().child("A message you sent before · your draft comes back with ↓ or when it is sent"))
        .child(button(k, "q-back", "Back to draft", (cx) => this.backToDraft(cx), { variant: "ghost-muted" })) : null;
    return lane(queue.length || editLine ? v_flex().when(queue.length > 0, (el) => el.child(queueRows)).when(!!editLine, (el) => el.child(editLine)).child(box) : box);
  }
}
