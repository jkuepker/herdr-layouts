// The chat panel: T3 Code's thread view (apps/web/src/components/chat) in gpui-kit. A
// centered 736px lane; your messages as right-aligned bubbles, the agent's as plain
// markdown, its work as flat one-line rows that open, a "Working for 12s" line, and the
// composer card with its controls and the round Send / Stop button.
//
// The agent comes from one of two sources that give the same rows:
// - agent-term.js: an agent already running in a Herdr terminal (props.terminal);
// - agent-acp.js: an agent this pane starts over ACP (props.agent, cwd, machine, prompt).

import { div, list, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { run, openOverlay, appHome, home, exec, layout, settings, shared, setShared, notify } from "herdr";
import { MOD, tokens, alpha, icon, agentMark, button, iconButton, control, badge, workLine, divider, shortPath } from "./look.js";
import { AcpSource, detect, argvOf, forkChat } from "./agent-acp.js";
import { TermSource } from "./agent-term.js";
import { Reporter } from "./report.js";
import { fileIcon } from "./fileicons.js";
import { snapshot, turnStat } from "./checkpoint.js";
import { checkpointsOn, followUp } from "./settings.js";
import { addNotice, toMarkdown } from "./transcript.js";
import { limitModels, rememberModels } from "./settings.js";
import { agentOf, chatLike } from "./agent-acp.js";
import { repoOf } from "./launcher.js";

const LANE = 736; // --chat-content-max-width: 46rem
const DRAW_EVERY_MS = 80;
const DETAIL_MAX = 4000;
const TOOL_GLYPH = { read: "eye", edit: "square-pen", delete: "trash-2", move: "file", search: "search", execute: "terminal", think: "brain", fetch: "globe", switch_mode: "list-todo", other: "wrench" };
const OPTION_GLYPH = { model: "sparkles", mode: "lock", thought_level: "brain" };

// A message's text cut at its fenced code blocks, so each block can carry its own Copy button
// (chat/MessageCopyButton.tsx, ChatMarkdown's code header): [{ code, lang, text }]. A fence left
// open (still streaming) is a block to its end.
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
  if (code) out.push({ code: true, lang: code.lang, text: code.lines.join("\n") });
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

// T3's own commands (composer-logic.ts ComposerSlashCommand) that have a place here.
// How many rows the lane builds at first, and how many more each time you near the first of them.
const TAIL = 60;
// The rows a click does something to.
const CLICKS = ["earlier", "copy", "codehead", "fold", "tool", "thought"];

const LOCAL_COMMANDS = [
  { name: "model", description: "Switch the model for this chat", local: true },
  { name: "side", description: "Ask a side question in the right panel", local: true },
  { name: "new", description: "Start a new chat", local: true },
  { name: "rename", description: "Rename this thread", local: true, args: true },
  { name: "fork", description: "Continue this thread in a new chat", local: true },
  { name: "stash", description: "Park this draft, or bring one back", local: true },
  { name: "find", description: "Find in this thread", local: true },
  { name: "copy", description: "Copy this thread as Markdown", local: true },
  { name: "new", description: "New chat on this branch: same agent, same folder", local: true },
  { name: "usage", description: "Tokens and context: this chat and every agent", local: true },
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
// { queue: [{ text, blocks, files }] }, the messages waiting for the agent's turn to end.
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

// The prompt stash (T3's ComposerStashMenu): drafts parked to come back to, per project.
// shared("ht3-panels.stash"): { "<machine or empty>:<project folder>": [{ text, at }] }, newest first, at most 20.
const STASH = `${MOD}.stash`;
const since = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

// A project's badge, as T3's sidebar and header: two letters of its name ("fleetq" FL, "herdr-layouts" HL).
const initials = (name) => {
  const words = String(name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ((words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2)) || "?").toUpperCase();
};

export class ChatPanel {
  init(p, cx) {
    this.chatId = p.chat ?? null;
    this.source = null;
    this.phase = "loading"; // loading | empty | chat
    this.expanded = {};
    this.follow = true;
    this.picker = null; // option id whose choices are open
    this.since = null; // when the running turn was first seen
    this.hasText = false;
    // "Always allow this session" stays on over a reload (it is the person's word, not the agent's).
    this.autoAllow = keptOf(this.chatId).allow === true;
    // Messages queued before a reload wait on: they go out when the agent is back and ready.
    const waiting = keptOf(this.chatId).queue;
    if (Array.isArray(waiting) && waiting.length) this.queue = waiting.map((q) => ({ text: String(q.text ?? ""), blocks: q.blocks ?? [], files: q.files ?? [] }));
    // A chat tab's agent has no terminal: it tells the layout's lists how it is itself (report.js).
    // A side chat is no tab, and a terminal agent's chat has its terminal to speak for it.
    this.reporter = this.chatId && !p.terminal && !p.side ? new Reporter(this.chatId) : null;

    this.turnAt = null; // when the running turn of an ACP agent began
    this.hint = HINT;
    this.makeInput();
    // Find in thread (T3's ThreadFindBar): while its bar is open and has text, the lane holds the matching messages only.
    this.finding = false;
    this.findField = InputState.new({ placeholder: "Find in thread" });
    this.findField.on("change", (_e, cx) => { this.follow = true; cx.notify(); });
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
        const d = await detect(src.machine);
        src.target = d.target;
        src.remoteError = d.error;
        const argv = argvOf(p.agent, d.found);
        this.phase = "chat";
        if (argv) src.start(cx, argv, p.cwd ?? d.found.HOME ?? home(), p.prompt ?? null, p.set ?? null);
        else src.startError = d.error ?? `${Array.isArray(p.agent) ? p.agent[0] : p.agent ?? "The agent"} isn't installed.`;
        cx.notify();
      });
    } else {
      this.phase = "empty";
    }
    // The "Working for …" line counts seconds; nothing else here redraws on a timer.
    cx.timer.every(1000, (cx) => {
      // A revert done from its dialog: say so in the chat.
      const rv = shared(`${MOD}.reverted`);
      if (rv && rv.chat === this.chatId && rv.at !== this.revertSeen) {
        const first = this.revertSeen === undefined && Date.now() - rv.at > 5000;
        this.revertSeen = rv.at;
        if (!first && this.source.kind === "acp" && this.source.state) {
          addNotice(this.source.state.transcript, rv.ok ? `Files are back as they were before "${rv.label}". What was there is kept as checkpoint ${String(rv.undo ?? "").slice(0, 8)}. The agent still remembers what it did.` : `Couldn't revert: ${rv.error}`, rv.ok ? "info" : "error");
          this.source.changed?.(cx, true);
        }
      }
      // A hunk picked in the Diff surface with its comment (diff.js `quote`), for the chat of the shown tab: it goes
      // onto the end of the message box as a quoted block, to be read, changed and sent by the person.
      const qt = shared(`${MOD}.quote`);
      if (qt && qt.at !== this.quoteSeen) {
        this.quoteSeen = qt.at;
        if (qt.tab && qt.tab === this.reporter?.tab && Date.now() - qt.at < 10000) {
          const now = this.input.value().replace(/\s+$/, "");
          this.input.set_value(`${now ? `${now}\n\n` : ""}${qt.text}\n`);
          this.hasText = true;
          this.input.focus();
          cx.notify();
        }
      }
      // A name given elsewhere (the Inbox's thread menu) shows here and in the lists.
      if (this.named() !== (this.wasNamed ?? null)) { this.wasNamed = this.named(); this.report(); cx.notify(); }
      if (this.since != null || this.fitHint()) cx.notify();
      // A finished turn nobody saw is "done" until its tab is looked at.
      if (this.reporter?.tab) this.reporter.seen();
      else this.report();
    });
  }

  async close(_cx) {
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
      const script = `for d in "$HOME/.claude/skills" ${v?.cwd ? `"${String(v.cwd).replace(/["\\$\`]/g, "")}/.claude/skills"` : ""}; do for f in "$d"/*/SKILL.md; do [ -f "$f" ] && printf '%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(sed -n 's/^description: *//p' "$f" | head -1 | cut -c1-200)"; done; done`;
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
    const all = t.kind === "slash" ? [...LOCAL_COMMANDS.filter((c) => c.name !== "model" || v.options.some((o) => (o.category ?? o.id) === "model")), ...agent.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))]
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
      this.input.set_value(before);
      this.hasText = !!before.trim();
      if (item.name === "model") { const o = this.view?.options.find((x) => (x.category ?? x.id) === "model"); if (o) { this.picker = o.id; this.filter.set_value(""); if (o.choices.length > 8) this.filter.focus(); } }
      if (item.name === "side") run(`${MOD}.add:chat`);
      if (item.name === "new") openLauncher();
      if (item.name === "fork") this.fork(cx);
      if (item.name === "usage") run(`${MOD}.usage`);
      if (item.name === "find") return this.setFind(cx, true);
      if (item.name === "copy") this.copyThread(cx);
      if (item.name === "new" && this.source.kind === "acp") chatLike(this.source.state);
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
        const now = this.source.alive ? this.source.state?.permission : null, t = this.reporter?.tab;
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
    // new:here is "/new": a new chat with this one's agent in this one's folder (its branch).
    if (c === "new:here" && this.source.kind === "acp") chatLike(this.source.state);
    // copy:thread is "/copy": the thread as Markdown on the clipboard.
    if (c === "copy:thread") this.copyThread(cx);
    // find:<text> opens the find bar with that text (find alone: opens or closes it), find: closes it.
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
    // For scripts: type:<text> (as if typed into the message box), take:<n> (the open menu's nth row, from 0), send (the Send button),
    // menu-key:<up|down|enter|escape>.
    if (c.startsWith("type:")) { this.input.set_value(c.slice(5)); this.hasText = !!c.slice(5).trim(); this.typed(cx); }
    if (c === "send") this.send(cx);
    // hover:<item id>: as the pointer over that message (its copy icon shows); hover: alone, off.
    if (c.startsWith("hover:")) this.over = c.slice(6) || null;
    // queue:<steer|edit|drop>:<n>: a queued message's buttons (n from 0).
    if (c.startsWith("queue:")) { const [, what, n] = c.split(":"); this.queued(cx, what, Number(n) || 0); }
    // turn-diff:<last|item id> and revert:<last|item id>: "View diff" and "Revert" of a turn that changed files.
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

  // Draws at most every DRAW_EVERY_MS, at once when urgent.
  changed(cx, urgent) {
    this.report();
    this.models();
    this.clock();
    this.turnEnded(cx);
    this.drain(cx);
    this.asking(cx);
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
    if ((!text && !files.length) || !v?.alive) return;
    // Each file named with "@" goes along as an ACP resource link (the text keeps its "@path").
    const seen = new Set(), blocks = [];
    for (const s of this.source.kind === "acp" ? this.input.tokens() : []) {
      const path = s.token.id;
      if (seen.has(path)) continue;
      seen.add(path);
      const abs = path.startsWith("/") ? path : `${String(v.cwd ?? "").replace(/\/$/, "")}/${path}`;
      blocks.push({ type: "resource_link", uri: `file://${encodeURI(abs)}`, name: path.split("/").pop() });
    }
    this.input.set_value("");
    this.hasText = false;
    this.trig = null;
    this.follow = true;
    this.attached = [];
    const payload = { text, blocks, files };
    // An ACP agent takes one message per turn. One sent while it works waits in a queue for the turn to end
    // (QueuedRunsControl.tsx), or, with "Steer instead of queue" on, interrupts it and goes in at once.
    if (this.source.kind === "acp" && (v.status !== "ready" || this.sending || this.queue?.length)) {
      this.queue ??= [];
      if (followUp() === "steer" && ["working", "blocked"].includes(v.status)) { this.queue.unshift(payload); this.source.stop(); }
      else this.queue.push(payload);
      this.keepQueue();
      return cx.notify();
    }
    this.dispatch(cx, payload);
  }

  // The next queued message goes out once the agent is ready for one.
  drain(cx) {
    if (!this.queue?.length || this.sending || this.source.kind !== "acp" || !this.source.alive || this.source.word() !== "ready") return;
    const next = this.queue.shift();
    this.keepQueue();
    this.dispatch(cx, next);
  }

  keepQueue() {
    keep(this.chatId, { queue: (this.queue ?? []).map((q) => ({ text: q.text, blocks: q.blocks, files: q.files.map((a) => ({ name: a.name, path: a.path, image: a.image, thumb: a.thumb })) })) });
  }

  // A queued message's buttons: steer (it goes in now: the turn is interrupted), edit (back into the message box), drop.
  queued(cx, what, i) {
    const q = this.queue?.[i];
    if (!q) return;
    this.queue.splice(i, 1);
    if (what === "steer") { this.queue.unshift(q); if (this.source.word() === "ready") this.drain(cx); else this.source.stop(); }
    if (what === "edit") { this.input.set_value(q.text); this.hasText = !!q.text.trim(); this.attached = [...(this.attached ?? []), ...q.files]; this.input.focus(); }
    this.keepQueue();
    cx.notify();
  }

  // Sends one message: { text, blocks (ACP blocks for "@" files), files (attachments) }.
  dispatch(cx, { text, blocks, files }) {
    const v = this.view ?? this.source.view();
    this.follow = true;
    const att = files.length ? files.map((a) => ({ name: a.name, path: a.path, image: a.image, thumb: a.thumb })) : null;
    const where = this.source.kind === "acp" && checkpointsOn() && v.cwd ? { cwd: v.cwd, on: v.machine ?? undefined } : null;
    if (!files.length && !where) { this.source.send(cx, text, blocks); return cx.notify(); }
    // Reading the pictures and snapshotting the files take a moment: the box empties now and the message follows.
    this.sending = files;
    cx.spawn(async (cx) => {
      const more = files.length ? await this.attachmentBlocks(v).catch(() => []) : [];
      // The files as they are before this turn (checkpoint.js), for its diff and for "Revert".
      const n = (this.source.state?.transcript?.nextId ?? Date.now());
      const before = where ? await snapshot(where, this.chatId ?? "chat", `t${n}-before`) : null;
      this.sending = null;
      this.source.send(cx, text, [...blocks, ...more], att);
      const mine = [...(this.source.state?.transcript?.items ?? [])].reverse().find((m) => m.kind === "user");
      if (before && mine && !mine.cp) { mine.cp = { before, n }; this.cpOpen = { item: mine, where }; }
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
    return { badge: folder ? initials(folder) : null, folder, where, title, word, tone, branch: this.reporter?.where?.branch ?? this.branchHere ?? null, usage: v.usage?.size > 0 ? Math.round((100 * v.usage.used) / v.usage.size) : null };
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
  // Opens the find bar (with `text` in it), or closes it; the lane is whole again when it closes.
  setFind(cx, on, text = null) {
    this.finding = on;
    if (text != null) this.findField.set_value(text);
    if (on) this.findField.focus(); else { this.findField.set_value(""); this.input.focus(); }
    this.follow = true;
    cx.notify();
  }
  findBar(k) {
    const f = this.found, q = this.findQuery();
    return h_flex().w_full().flex_none().justify_center().px(16).pt(8)
      .child(h_flex().w_full().max_w(LANE).h(36).pl(10).pr(4).gap(8).items_center().rounded(10).border(1).border_color(k.input).bg(k.card).text_size(14)
        .on_key_down((e, cx) => { if (e.key === "escape") { this.setFind(cx, false); cx.stop_propagation?.(); } })
        .child(icon("search").size(14).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.findField)))
        .child(div().flex_none().text_size(12).text_color(q && f && !f.n ? k.destructiveText : k.muted).child(!q ? "type to narrow the thread" : f ? `${f.n} of ${f.of} message${f.of === 1 ? "" : "s"}` : ""))
        .child(iconButton(k, "find-close", "x", (cx) => this.setFind(cx, false), { tip: "Close (Esc)" })));
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
    const items = sought ? v.items.filter((m) => wordsOf(m).includes(sought)) : v.items, busy = !sought && (v.status === "working" || v.status === "blocked");
    this.found = sought ? { n: items.length, of: v.items.length } : null;
    const fold = (id, label, inside, rest) => {
      // With nothing under it, it is only the turn's time: no chevron, and nothing to open.
      // While finding, the matching work shows without its fold: there is nothing to open.
      if (sought) { for (const m of inside) rows.push(m); for (const m of rest) rows.push(m); return; }
      rows.push({ id, kind: "fold", label, open: inside.length > 0 && !!this.expanded[id], bare: !inside.length });
      if (inside.length && this.expanded[id]) for (const m of inside) rows.push(m);
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
          if (g.code) out.push({ id: `${m.id}:h${i}`, kind: "codehead", lang: g.lang, text: g.text });
          out.push({ id: `${m.id}:s${i}`, kind: "seg", code: g.code, lang: g.lang, text: g.text, whole: m.text });
        });
        if (m.text && !(busy && m === lastItem)) out.push({ id: `${m.id}:cp`, kind: "copy", text: m.text });
      } else if (m.kind === "user") {
        out.push(m);
        if (!m.pending) out.push({ id: `${m.id}:cp`, kind: "copy", text: m.text, right: true });
      } else out.push(m);
    }
    closeTurn();
    // The last message's copy icon stays in sight, dimmed by nothing: it is the one most often wanted.
    const lastCopy = [...out].reverse().find((r) => r.kind === "copy");
    if (lastCopy) lastCopy.always = true;
    return out;
  }

  timeline(k, v) {
    const rows = this.rows(v);
    if (!rows.length) {
      const text = this.findQuery() ? "No message in this thread has that." : v.status === "starting" ? "Starting the agent…" : v.error ? "" : "Send a message to start the conversation.";
      return this.centered(k, text);
    }
    // The lane keeps to its end by itself: gpui-kit's measured `list` can't be scrolled from code
    // (its scroll handle is a virtual list's), so a chat in one would stay at its first message. The
    // rows are a plain column pinned to the pane's bottom edge instead, and scrolling up moves that
    // column down by `off` pixels. Only the last `tail` rows are built; more as you near the first.
    const zoom = Number(settings()?.zoom) || 1;
    const n = Math.min(rows.length, this.tail ?? TAIL), shown = rows.slice(rows.length - n);
    const off = this.follow ? 0 : (this.off ?? 0);
    // Shorter than the pane: from the top, as T3's.
    const short = n === rows.length && (this.laneH != null && this.viewH != null ? this.laneH <= this.viewH : rows.length <= 6);
    const click = (m, cx) => {
      if (m.kind === "earlier") return this.source.earlier?.(cx);
      if (m.kind === "copy" || m.kind === "codehead") return this.copy(cx, m.id, m.text);
      if (m.kind === "fold") { this.expanded[m.id] = !this.expanded[m.id]; return cx.notify(); }
      if (m.kind !== "tool" && m.kind !== "thought") return;
      this.expanded[m.id] = !this.expanded[m.id];
      if (this.expanded[m.id]) this.source.expand(cx, m);
      cx.notify();
    };
    // A right-click on a message, a thought or a tool's output: Copy, for all of it.
    const copies = (m) => (m.kind === "seg" ? m.whole : m.kind === "tool" ? m.detail : ["user", "thought", "codehead", "copy", "notice"].includes(m.kind) ? m.text : null);
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
        const el = div().id(`row-${m.id}`).w_full().child(this.row(k, m, i === 0 && n === rows.length, i === shown.length - 1));
        const text = copies(m);
        // A message's rows (its text, its code blocks, its copy row) are one thing to the pointer: over any of them, its copy icon shows.
        const of = ["seg", "user", "copy", "codehead"].includes(m.kind) ? String(m.id).split(":")[0] : null;
        return (text ? el.on_mouse_down("right", (e) => this.copyMenu(e.position, copies(m), of)) : el)
          .when(of != null, (e) => e.on_hover((over, cx) => {
            if (over ? this.over === of : this.over !== of) return;
            this.over = over ? of : null;
            cx.notify();
          }))
          .when(CLICKS.includes(m.kind), (e) => e.on_click((_e, cx) => click(m, cx)));
      }));
    return v_flex().id("ht3-chat-lane").relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        const h = size.height / zoom;
        if (Math.abs(h - (this.viewH ?? 0)) < 1) return;
        this.viewH = h;
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => this.wheel(e.delta.y, rows.length, cx))
      .child(short ? lane.top(0) : lane.bottom(-off))
      // chat/TimelineOverlays.tsx: the glass pill over the end of the lane.
      .when(!this.follow, (el) => el.child(h_flex().absolute().bottom(6).left(0).right(0).justify_center()
        .child(h_flex().id("to-end").h(24).px(8).gap(4).items_center().rounded_full().border(1).border_color(alpha(k.border, 0.6))
          .bg(k.card).shadow_sm().text_size(12).font_medium().cursor_pointer().role("button").accessibility_label("Scroll to end").hover((s) => s.border_color(k.border))
          .on_click((_e, cx) => { this.follow = true; this.off = 0; cx.notify(); })
          .child(icon("chevron-down").size(14)).child("Scroll to end"))));
  }

  // The wheel (or `scroll:<px>`): up by `dy` pixels, down when negative; at the end it follows again.
  wheel(dy, total, cx) {
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
  // Parks what is in the message box (its text; files attached to it stay where they are) and empties the box.
  stash(cx) {
    const text = this.input.value().replace(/\/stash\s*$/, "").trim();
    if (!text) return;
    this.putStash([{ text, at: Date.now() }, ...this.stashed().filter((d) => d.text !== text)]);
    this.input.set_value("");
    this.hasText = false;
    this.trig = null;
    cx.notify();
  }
  // Brings the nth parked draft back into the box and takes it off the stash; a draft in the box changes places with it.
  unstash(cx, i) {
    const list = this.stashed(), d = list[i];
    if (!d) return;
    const now = this.input.value().trim();
    this.putStash([...(now ? [{ text: now, at: Date.now() }] : []), ...list.filter((_d, n) => n !== i)]);
    this.input.set_value(d.text);
    this.hasText = true;
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
    const list = this.stashed(), can = !!this.input.value().trim();
    const row = (id, body, onClick, enabled = true) => h_flex().id(id).min_h(28).px(8).gap(8).flex_none().items_center().rounded(4).text_size(14)
      .when(enabled, (el) => el.cursor_pointer().role("button").hover((st) => st.bg(k.accent)).on_click((_e, cx) => onClick(cx))).when(!enabled, (el) => el.opacity(0.5)).children(body);
    return h_flex().w_full().flex_none().justify_center().px(16).pb(6)
      .child(h_flex().w_full().max_w(LANE).justify_start()
        .child(v_flex().id("stash-menu").w(360).max_h(300).p(4).rounded(8).border(1).border_color(k.border).bg(k.popover).shadow_lg().overflow_y_scrollbar()
          .child(row("stash-put", [icon("archive").size(14).flex_none().text_color(k.muted), div().flex_1().child("Stash this draft"),
            div().flex_none().text_size(12).text_color(k.muted).child(can ? "/stash" : "nothing typed")], (cx) => { this.stash(cx); this.picker = null; }, can))
          .when(list.length > 0, (el) => el.child(div().mx(4).my(4).h(1).flex_none().bg(k.border)))
          .children(list.map((d, i) => row(`stash-${i}`, [
            v_flex().flex_1().min_w(0).py(4)
              .child(div().truncate().child(d.text.split("\n")[0]))
              .child(div().text_size(11).text_color(k.muted).child(`${since(d.at)}${d.text.includes("\n") ? ` · ${d.text.split("\n").length} lines` : ""}`)),
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
            .when(m.pending, (e) => e.opacity(0.6)).child(m.text))), m.pending ? 16 : 2);
      }
      case "seg":
        // A stretch of a reply: text you can select, or one code block (under its header row).
        return lane(div().px(4).py(m.code ? 0 : 2).text_size(14).line_height("23px")
          .child(TextView.markdown(`md-${m.id}`, m.code ? "```" + m.lang + "\n" + m.text + "\n```" : m.text).selectable(true)), 4);
      case "codehead":
        // ChatMarkdown's code header: Copy at the right (the block names its language itself).
        return lane(h_flex().mx(4).mt(4).h(28).pl(12).pr(6).items_center().justify_end().rounded_t(8).border(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.muted, 0.08))
          .child(this.copyMark(k, m.id, "Copy")), 0);
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
        return lane(h_flex().w_full().px(m.right ? 0 : 2).when(!!m.right, (el) => el.justify_end()).child(this.copyMark(k, m.id, null, m.always || this.over === String(m.id).split(":")[0])), 12);
      case "thought": {
        const open = this.expanded[m.id];
        // T3: the thought itself on one muted line; it opens to the whole of it.
        const line = (m.text ?? "").trim().split("\n")[0];
        return lane(v_flex()
          .child(workLine(k, "brain", line || (m.open ? "Thinking" : "Thought"), { trail: [chevron(open)] }))
          .when(open, (el) => el.child(div().ml(30).py(4).text_size(14).line_height("23px").text_color(alpha(k.foreground, 0.8)).child(m.text))), 8);
      }
      case "tool": {
        const failed = m.status === "failed";
        const running = m.status === "in_progress" || m.status === "pending";
        const open = this.expanded[m.id] && (m.detail || m.lazy);
        const can = !!(m.detail || m.lazy);
        const trail = [];
        if (failed) trail.push(icon("x").size(12).flex_none().text_color(k.destructive));
        if (can) trail.push(chevron(open));
        const detail = m.detail ?? (m.loading ? "Loading…" : "");
        return lane(v_flex()
          .child(workLine(k, TOOL_GLYPH[m.toolKind] ?? "wrench", m.title || "Working…", {
            color: failed ? k.destructive : running ? alpha(k.foreground, 0.8) : null, bold: failed, trail }))
          .when(open, (el) => el.child(div().ml(30).mt(2).mb(6).pb(8).text_size(12).line_height("18px").font_family(k.mono).text_color(k.muted)
            .child(detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) + "\n…" : detail))), 4);
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
    } else if (!v.alive && v.status !== "starting") {
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
      .role("button").accessibility_label(busy ? (followUp() === "steer" ? "Steer: interrupt and send" : "Queue message") : "Submit message")
      .when(can && busy, (el) => el.tooltip(followUp() === "steer" ? "Interrupt and send now" : "Queue for when the agent is done"))
      .when(can, (el) => el.shadow_xs().cursor_pointer().hover((s) => s.bg(alpha(k.primary, 0.9))).on_click((_e, cx) => this.send(cx)))
      .child(icon("arrow-up").size(14));
    const action = working && !(acp && has) ? stopBtn() : working ? h_flex().gap(6).flex_none().child(stopBtn()).child(sendBtn()) : sendBtn();

    // QueuedRunsControl.tsx: the waiting messages over the message box, at its right edge: the first three, then a count.
    const queue = acp ? this.queue ?? [] : [];
    const qBtn = (id, glyph, tip, fn) => h_flex().id(id).size(22).flex_none().items_center().justify_center().rounded(6).text_color(k.muted).cursor_pointer().role("button").accessibility_label(tip).tooltip(tip)
      .hover((s) => s.bg(k.accent).text_color(k.foreground)).on_click((_e, cx) => fn(cx)).child(icon(glyph).size(13));
    const queueRows = v_flex().w_full().items_end().gap(6).pb(8)
      .child(div().text_size(11).text_color(k.muted).child(`${queue.length} queued${v.status === "ready" ? "" : ": sent when the agent is done"}`))
      .children(queue.slice(0, 3).map((q, i) => h_flex().max_w("80%").min_w(0).h(34).pl(12).pr(4).gap(4).items_center().rounded(12).border(1).border_color(alpha(k.border, 0.8)).bg(alpha(k.message, 0.5)).text_size(13)
        .child(div().flex_1().min_w(0).truncate().text_color(alpha(k.foreground, 0.8)).child(q.text || `${q.files.length} file${q.files.length === 1 ? "" : "s"}`))
        .when(q.files.length > 0 && !!q.text, (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child(`+${q.files.length}`)))
        .child(qBtn(`q-steer-${i}`, "corner-down-left", "Send now: interrupt the agent", (cx) => this.queued(cx, "steer", i)))
        .child(qBtn(`q-edit-${i}`, "pen-line", "Edit: back into the message box", (cx) => this.queued(cx, "edit", i)))
        .child(qBtn(`q-drop-${i}`, "x", "Remove from the queue", (cx) => this.queued(cx, "drop", i)))))
      .when(queue.length > 3, (el) => el.child(div().text_size(11).text_color(k.muted).child(`and ${queue.length - 3} more`)));

    const plan = this.planMode();
    const stashKey = this.stashKey(), nStash = this.stashed().length;
    const controls = v.options.map((o) => {
      const cur = o.choices.find((c) => c.value === o.current);
      // A model named by its path ("provider/Model") shows as the model alone, as T3's "Qwen3.8 (tatooine-r9700)":
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
          if (!this.trig || e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
          if (this.menuKey(e.key.toLowerCase(), cx)) cx.stop_propagation?.();
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
        .when(!!plan, (el) => el.child(h_flex().id("plan-toggle").h(28).px(8).gap(6).flex_none().items_center().rounded(8).text_size(14).font_medium()
          .bg(plan.on ? alpha(k.primary, 0.14) : "#00000000").text_color(plan.on ? k.primary : alpha(k.foreground, 0.8)).cursor_pointer().role("button")
          .accessibility_label(plan.on ? "Plan mode is on" : "Plan mode").tooltip(plan.on ? "Plan mode is on: the agent plans and changes nothing. Click to leave it." : "Plan first: the agent proposes a plan and changes nothing")
          .hover((st) => st.bg(plan.on ? alpha(k.primary, 0.2) : k.accent)).on_click((_e, cx) => this.togglePlan(cx))
          .child(icon("list-todo").size(16).flex_none()).child("Plan")))
        .child(div().flex_1())
        .children(controls)
        .child(div().w(6).flex_none())
        .child(action));
    const box = drawer ? v_flex().child(drawer).child(card) : card;
    return lane(queue.length ? v_flex().child(queueRows).child(box) : box);
  }
}
