// T3 Code's Diff surface (DiffPanel.tsx) in gpui-kit: what changed, one section per file with its
// status, its +/- counts and its hunks, the lines tinted green and red and colored with T3 Code's
// code colors. Files are collapsible; new (untracked) files show as added. What is compared is the
// header's choice: Changes (the working tree against the merge base with the default branch),
// Uncommitted (against HEAD), one turn of a chat (its two checkpoints), or one Commit of this branch
// (picked from a list of the recent ones shown in the panel itself, with Prev and Next arrows).
// Hide whitespace (the pilcrow button, setting "diffIgnoreWhitespace", on as T3's is) puts -w on every
// diff and show the panel runs; a file left with nothing says it was only whitespace.
//
// Runs git in the repository of the shown space's folder: `git diff <base or HEAD>`, and for
// untracked files `git diff --no-index /dev/null <file>`. Reads only. The listing follows the
// folder (watchFolder) and a 15 s timer. A hunk or some of its lines can be picked and sent to
// the shown chat's message box with a comment. The header's toggle shows the same rows Unified (one
// column) or Split (old on the left, new on the right), kept as the setting "diffLayout".
//
// In the uncommitted scope (the working tree against HEAD) each hunk has Stage and Revert and each file Revert
// (hunkpatch.js builds the patch of one hunk and runs `git apply`): a first click asks, the second within 4 s does it,
// and the last revert can be undone for 30 s. The buttons in a list row are zones of the row (a list row can't hold a
// click handler of its own): the press's place across the row says which one was meant.

import { div, list } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { exec, watchFolder, shared, setShared, focused } from "herdr";
import { tokens, alpha, icon, iconButton, button } from "./look.js";
import { fileIcon } from "./fileicons.js";
import { activeSpace, placeOf, showing } from "./side.js";
import { syntax } from "./editor.js";
import { prefs, setPref, diffHidesWhitespace } from "./settings.js";
import { parseDiff, MAX_LINES_FILE, hunkActions, applyHunk, revertFile, redo } from "./hunkpatch.js";

export { parseDiff };

const MAX_FILES = 200, MAX_ROWS = 12000, MAX_UNTRACKED = 40;
// The default branch's ref and the merge base with it, as "<ref> <sha>"; nothing when there is none.
const BASE = 'b=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); for c in "$b" origin/main origin/master main master; do [ -n "$c" ] && m=$(git merge-base HEAD "$c" 2>/dev/null) && [ -n "$m" ] && echo "$c $m" && break; done; true';
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const untracked = (ws) => `git ls-files -o --exclude-standard | head -n ${MAX_UNTRACKED} | while IFS= read -r f; do [ -f "$f" ] && [ "$(wc -c < "$f")" -lt 200000 ] && git diff --no-index --no-color -U3 ${ws ? "-w " : ""}-- /dev/null "$f"; done; true`;
const COMMITS = 50;
// The commit list: one commit a line, fields parted by the unit separator (the subject has no newline).
export const COMMIT_FORMAT = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%P";
const GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"];
// What the panel runs for a commit (`git show`): no header, a merge against its first parent (a combined diff is
// not something parseDiff reads), a root commit as everything added. -w when whitespace is hidden.
export const showArgs = (hash, ws, extra = []) => [...GIT, "show", "--no-color", "--no-ext-diff", "--format=", "--first-parent", "-m", "--find-renames", ...extra, ...(ws ? ["-w"] : []), hash, "--"];
// Hash or position: "3" is the 4th commit of the list (0 is the newest), anything longer is a hash or a ref.
export const isIndex = (s) => /^\d{1,3}$/.test(s);

// ---- a unified diff, parsed: parseDiff, in hunkpatch.js ----

// ---- a commit list, parsed ----

// `git log` in COMMIT_FORMAT: [{ hash, short, subject, author, date, merge }].
export function parseCommits(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const f = line.split("\x1f");
    if (f.length < 6 || !/^[0-9a-f]{7,64}$/.test(f[0])) continue;
    out.push({ hash: f[0], short: f[1], subject: f[2], author: f[3], date: f[4], merge: f[5].trim().split(/\s+/).filter(Boolean).length > 1 });
  }
  return out;
}

// Files `git diff -w` left out of its output because only whitespace changed: the ones the same diff without -w
// names and the parsed one doesn't, as files with no hunks (marked wsOnly), in path order with the rest.
export function withWhitespaceOnly(files, names) {
  const have = new Set(files.map((f) => f.path)), extra = [];
  for (const path of names) if (path && !have.has(path)) { have.add(path); extra.push({ path, old: null, status: "M", add: 0, del: 0, binary: false, hunks: [], lines: 0, cut: false, wsOnly: true }); }
  return extra.length ? [...files, ...extra].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) : files;
}

// ---- a small highlighter: comments, strings, numbers, keywords, types, calls ----

const KEYWORDS = new Set(("as async await break case catch class const continue def default defer del do elif else enum except export extends false finally fn for from func function go if impl import in interface is lambda let local match mod module new nil none null of or and not package pass private protected pub public raise return self static struct super switch then this throw trait true try type typeof use var void when where while with yield fi esac done echo set unset").split(" "));
const LINE_COMMENT = { js: "//", ts: "//", jsx: "//", tsx: "//", mjs: "//", cjs: "//", c: "//", h: "//", cpp: "//", cc: "//", hpp: "//", java: "//", go: "//", rs: "//", swift: "//", kt: "//", cs: "//", scss: "//", css: null, json: null,
  py: "#", sh: "#", bash: "#", zsh: "#", rb: "#", yml: "#", yaml: "#", toml: "#", mk: "#", conf: "#", sql: "--", lua: "--", hs: "--" };
const TOKEN = /\s+|\/\/.*|#.*|--.*|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?\b|[A-Za-z_$][\w$]*|[^\sA-Za-z_$\d"'`]+/g;

export function highlight(text, ext, colors) {
  const comment = LINE_COMMENT[ext];
  const out = [];
  const push = (s, c) => {
    const last = out[out.length - 1];
    if (last && last.c === c) last.s += s; else out.push({ s, c });
  };
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(text)) !== null;) {
    const s = m[0], ch = s[0];
    if (/^\s/.test(s)) push(s, null);
    else if ((ch === "/" && s[1] === "/" && comment === "//") || (ch === "#" && comment === "#") || (ch === "-" && s[1] === "-" && comment === "--")) { push(s + text.slice(TOKEN.lastIndex), colors.comment); break; }
    else if (ch === '"' || ch === "'" || ch === "`") push(s, colors.string);
    else if (/^\d/.test(s)) push(s, colors.number);
    else if (/^[A-Za-z_$]/.test(s)) {
      if (KEYWORDS.has(s)) push(s, colors.keyword);
      else if (text[TOKEN.lastIndex] === "(") push(s, colors.function);
      else if (/^[A-Z][a-z]/.test(s)) push(s, colors.type);
      else push(s, null);
    } else push(s, /^[{}()[\];,.]+$/.test(s) ? colors.punctuation : null);
  }
  return out;
}

// ---- Split: a hunk's lines as rows of two sides ----

// T3's pairing: a run of removals goes against the run of additions that follows it, line by line, and the
// shorter side is padded with nothing; a context line is on both sides. Each side is { l, li } (the line and
// its place in the hunk) or null.
export function pairLines(lines) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].t === " ") { rows.push({ L: { l: lines[i], li: i }, R: { l: lines[i], li: i } }); i++; continue; }
    let d = i;
    while (d < lines.length && lines[d].t === "-") d++;
    let a = d;
    while (a < lines.length && lines[a].t === "+") a++;
    for (let j = 0; j < Math.max(d - i, a - d); j++) rows.push({ L: i + j < d ? { l: lines[i + j], li: i + j } : null, R: d + j < a ? { l: lines[d + j], li: d + j } : null });
    i = a;
  }
  return rows;
}

// ---- what is picked ----

const LINE = /^l:(.*):(\d+):(\d+)$/, HUNK = /^h:(.*):(\d+)$/;
// The picked lines of one file, first to last as [hunk, line]: from a picked line's id and the id of the line a
// Shift-click took the range to (in the same file; either order). Null when no line is picked.
export function spanOf(picked, pickedTo = null) {
  const a = LINE.exec(picked ?? ""), b = LINE.exec(pickedTo ?? "") ?? a;
  if (!a || b[1] !== a[1]) return null;
  const p = [Number(a[2]), Number(a[3])], q = [Number(b[2]), Number(b[3])];
  const swap = q[0] < p[0] || (q[0] === p[0] && q[1] < p[1]);
  return { path: a[1], from: swap ? q : p, to: swap ? p : q };
}
// What is picked in `files`: { path, parts: [{ h, lines }], h, lines, from, to }: a whole hunk, or a range of lines
// that may run over several hunks of one file (a part per hunk). from and to are lines in the new file, or in the
// old one when only removals are picked. Null once it is gone.
export function pickedAt(files, picked, pickedTo = null) {
  const m = HUNK.exec(picked ?? "");
  const s = m ? { path: m[1], from: [Number(m[2]), 0], to: [Number(m[2]), Infinity] } : spanOf(picked, pickedTo);
  const f = s ? files?.find((x) => x.path === s.path) : null;
  if (!f) return null;
  const parts = [];
  for (let hi = s.from[0]; hi <= s.to[0] && hi < f.hunks.length; hi++) {
    const h = f.hunks[hi];
    const lines = h.lines.slice(hi === s.from[0] ? s.from[1] : 0, hi === s.to[0] ? s.to[1] + 1 : undefined);
    if (lines.length) parts.push({ h, lines });
  }
  const lines = parts.flatMap((x) => x.lines);
  if (!lines.length) return null;
  const ns = lines.filter((l) => l.n != null).map((l) => l.n), os = lines.filter((l) => l.o != null).map((l) => l.o);
  const span = ns.length ? ns : os;
  return { path: f.path, parts, h: parts[0].h, lines, from: span[0] ?? 0, to: span.at(-1) ?? 0 };
}
const where = (at) => (at.from === at.to ? `line ${at.from}` : `lines ${at.from}-${at.to}`);
// The picked lines as the block the chat's message box gets: where they are, one fenced diff with each hunk's
// header before its lines (at most `max` lines), then the comment.
// `commit` ("abc1234 subject"): the lines are from that commit, not the working tree.
export function quoteText(at, note = "", max = 80, commit = null) {
  const out = [];
  let left = max;
  for (const part of at.parts) {
    if (left <= 0) break;
    out.push(part.h.head.match(/^@@[^@]*@@/)?.[0] ?? "@@", ...part.lines.slice(0, left).map((l) => `${l.t}${l.text}`));
    left -= part.lines.length;
  }
  const fence = out.some((l) => l.includes("```")) ? "````" : "```";
  return [`In \`${at.path}\` (${where(at)}${commit ? `, commit ${commit}` : ""}):`, `${fence}diff`, ...out, ...(at.lines.length > max ? [`… ${at.lines.length - max} more lines`] : []), fence, note.trim()].filter((l) => l !== "").join("\n");
}

// Narrower than this, Split shows as Unified: two columns of code don't fit.
export const SPLIT_MIN = 640;

// The picker's list element.
function list_(commits, k, shown, pick) {
  return list("ht3-diff-commit-rows", commits.length, (i) => commits[i].hash, (i) => {
    const c = commits[i], on = c.hash === shown;
    return h_flex().h(44).w_full().px(16).gap(10).items_center().overflow_hidden().border_b(1).border_color(alpha(k.border, 0.4)).cursor_pointer()
      .bg(on ? alpha(k.accent, 0.6) : "#00000000").hover((s) => s.bg(k.accent))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().min_w(0).truncate().text_size(13).font_medium().child(c.subject || "(no message)"))
          .when(c.merge, (e) => e.child(div().flex_none().text_size(11).text_color(k.muted).child("merge"))))
        .child(h_flex().gap(8).items_center().min_w(0).text_size(11).text_color(k.muted)
          .child(div().flex_none().font_family(k.mono).child(c.short))
          .child(div().min_w(0).truncate().child(c.author))
          .child(div().flex_none().child(c.date))))
      .when(on, (e) => e.child(icon("check").size(14).flex_none().text_color(k.muted)));
  }).on_item_click((id, cx) => pick(id, cx));
}

// The buttons in a row: widths and the row's right padding, which zoneAt measures from.
const ZR = 52, ZS = 44, ZGAP = 6, ZPAD = 12;
const extOf = (path) => (path.includes(".") ? path.split(".").pop().toLowerCase() : "");

export class DiffPanel {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.stale = false;
    this.root = null;
    this.on = null;
    this.files = null;
    this.error = null;
    this.loading = false;
    this.shut = new Set(); // collapsed files
    // As T3's Diff: "branch" is its Changes (everything against the merge base with the default branch, what
    // the Project popover counts), "unstaged" its Uncommitted (the working tree against HEAD).
    this.scope = "branch";
    this.base = null; // the ref Changes compares with
    // Commit scope: the commit shown ({ hash, short, subject, author, date, merge }), the recent commits of this branch
    // (null until read), and whether the picker (a list of them, in place of the files) is open.
    this.commit = null;
    this.commits = null;
    this.picking = false;
    this.commitNote = null; // why a commit could not be chosen
    this.usedSig = null; // what the files shown were run for (scope, commit, whitespace)
    this.pick = false;
    this.watched = null;
    this.more = 0;
    this.seen = null;
    // A hunk as context for the agent: a click on a hunk's header picks it, a comment is written under the list,
    // and both go into the shown chat's message box as a quoted block (chat.js takes shared "ht3-panels.quote").
    this.picked = null; // the picked hunk's row id, "h:<path>:<n>", or a picked line's, "l:<path>:<hunk>:<line>"
    this.pickedTo = null; // with a picked line: the id of the line a Shift-click took the range to (same file, any hunk)
    this.shift = false; // whether Shift was down at the last press on the list (on_item_click doesn't say)
    this.side = null; // Split: the half that press was on, "L" or "R"
    this.width = null; // the surface's own, for Split's fallback
    this.said = null; // what happened to the last one
    this.saidBad = false; // ...and whether it went wrong
    // Revert / Stage: whether the files shown are the working tree against HEAD (live), which of them have staged
    // changes, whether that diff hid whitespace, the click that asked (armed: { key, text, until }), the work running,
    // the last revert's way back (undo: { label, steps, until }), and where the last press was across the list.
    this.live = false;
    this.staged = new Set();
    this.untrackedPaths = new Set();
    this.diffWs = false;
    this.armed = null;
    this.busy = false;
    this.undo = null;
    this.again = false;
    this.press = null;
    this.note = InputState.new({ placeholder: "What should the agent do about this change?" });
    this.note.on("change", (_e, cx) => cx.notify());
    this.note.on("submit", (_e, cx) => this.quote(cx));
    this.follow(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx, true));
  }
  close() {}
  // `ht3-panels.scope:branch|unstaged`: what the Diff compares, as its header's menu, for scripts and the popover.
  command(c, cx) {
    if (c === "scope:branch" || c === "scope:unstaged" || (c === "scope:turn" && this.turn)) this.setScope(cx, c.slice(6));
    // commit:<n> shows the nth recent commit of this branch (0 the newest), commit:<hash> any commit (a hash or ref),
    // commit:prev and commit:next go one older or newer, commit:list opens the picker.
    // ws:on hides whitespace changes (-w), ws:off shows them, ws:toggle flips it.
    if (c.startsWith("commit:")) this.commitCommand(cx, c.slice(7));
    if (c === "ws:on" || c === "ws:off" || c === "ws:toggle") this.setWhitespace(cx, c === "ws:toggle" ? !diffHidesWhitespace() : c === "ws:on");
    // hunk:<n> picks the nth hunk shown (from 0; hunk: lets go of it), comment:<text> sends it to the chat with that comment.
    // diffline:<n> picks the nth diff line shown (from 0, counted as Unified lists them, in either view), as a click on
    // its +; diffline:<a>-<b> picks a and Shift-clicks b (a range, in one file); diffline: lets go.
    // view:split|unified is the header's toggle.
    if (c === "view:split" || c === "view:unified") this.setView(cx, c.slice(5));
    if (c.startsWith("diffline:")) {
      const ids = this.rows(false).filter((r) => r.kind === "line").map((r) => r.id), [a, b] = c.slice(9).split("-");
      if (a === "") this.pickHunk(cx, null);
      else { this.pickLine(cx, ids[Number(a)] ?? null); if (b != null) this.pickLine(cx, ids[Number(b)] ?? null, true); }
    }
    if (c.startsWith("hunk:")) { const ids = this.rows(false).filter((r) => r.kind === "hunk").map((r) => r.id); this.pickHunk(cx, c.slice(5) === "" ? null : ids[Number(c.slice(5))] ?? null); }
    if (c.startsWith("comment:")) { this.note.set_value(c.slice(8)); this.quote(cx); }
    // hunk-revert:<file>:<n> and hunk-stage:<file>:<n> (the nth hunk of the file, from 0), file-revert:<file>: as the
    // buttons; a revert asks first and the same command again within 4 s does it. undo-revert puts the last one back,
    // revert-yes and revert-no answer the question.
    if (c.startsWith("hunk-revert:") || c.startsWith("hunk-stage:")) {
      const kind = c.startsWith("hunk-revert:") ? "revert" : "stage", rest = c.slice(c.indexOf(":") + 1), at = rest.lastIndexOf(":");
      this.act(cx, kind === "revert" ? "hunk-revert" : "hunk-stage", rest.slice(0, at), Number(rest.slice(at + 1)));
    }
    if (c.startsWith("file-revert:")) this.act(cx, "file-revert", c.slice(12), 0);
    if (c === "undo-revert") this.undoRevert(cx);
    if (c === "revert-yes") this.answer(cx, true);
    if (c === "revert-no") this.answer(cx, false);
  }

  // ---- Revert and Stage ----
  say(cx, text, bad = false) { this.said = text; this.saidBad = bad; cx.notify(); }
  armedNow() { return this.armed && this.armed.until > Date.now() ? this.armed : null; }
  // What can be done to a hunk of a shown file: { revert, stage, why }.
  hunkActs(f, hi) { return hunkActions(f, hi, { worktree: this.live && !this.picking, staged: this.staged.has(f.path) }); }
  // A hunk button or command: Stage goes at once, a revert asks first (the second ask within 4 s, or Yes, does it).
  act(cx, kind, path, n) {
    const f = this.files?.find((x) => x.path === path);
    if (!f) return this.say(cx, `No file ${path} in the diff.`, true);
    if (!this.live || this.picking) return this.say(cx, "Only the uncommitted changes can be reverted or staged: switch the scope to Uncommitted.", true);
    if (this.busy) return;
    if (kind !== "file-revert") {
      const a = this.hunkActs(f, n);
      if (kind === "hunk-revert" && !a.revert) return this.say(cx, a.why ?? "This hunk can't be reverted.", true);
      if (kind === "hunk-stage" && !a.stage) return this.say(cx, a.why ?? (this.staged.has(f.path) ? `${path} already has staged changes: this diff can't tell which hunks they are. Stage it with git.` : "This hunk can't be staged."), true);
    } else if (f.quoted) return this.say(cx, "This file's name needs quoting; use git itself.", true);
    const key = `${kind}:${path}:${n}`;
    if (kind !== "hunk-stage") {
      const was = this.armedNow();
      if (!was || was.key !== key) {
        const untracked = kind === "file-revert" && f.status === "A" && this.untrackedPaths.has(path);
        const what = kind === "hunk-revert" ? `Revert hunk ${n + 1} of ${path}? It is dropped from the file.` : untracked ? `Delete ${path}? It is a new file git doesn't track: it is removed from disk.` : `Revert ${path}? Its changes, staged and not, are thrown away.`;
        this.armed = { key, kind, path, n, text: what, until: Date.now() + 4000 };
        cx.timer.after(4050, (cx) => cx.notify());
        return cx.notify();
      }
    }
    this.armed = null;
    this.run(cx, kind, f, n);
  }
  answer(cx, yes) {
    const a = this.armedNow();
    this.armed = null;
    if (yes && a) this.act(cx, a.kind, a.path, a.n);
    else cx.notify();
  }
  run(cx, kind, f, n) {
    const root = this.root, ctx = { cwd: root, on: this.on }, ws = this.diffWs;
    this.busy = true;
    this.said = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try {
        if (kind === "file-revert") r = await revertFile(exec, ctx, f);
        else r = await applyHunk(exec, ctx, f, n, kind === "hunk-revert" ? "revert" : "stage", ws);
      } catch (e) { r = { ok: false, err: String(e?.message ?? e) }; }
      this.busy = false;
      if (this.root !== root) return;
      const label = kind === "file-revert" ? f.path : `hunk ${n + 1} of ${f.path}`;
      if (r.ok) {
        this.picked = null;
        this.pickedTo = null;
        if (kind === "hunk-stage") { this.undo = null; this.say(cx, `Staged ${label}.`); }
        else {
          this.undo = { label, steps: r.undo, until: Date.now() + 30000 };
          cx.timer.after(30050, (cx) => cx.notify());
          this.say(cx, r.untracked ? `Deleted ${f.path}.` : `Reverted ${label}.`);
        }
      } else this.say(cx, `Couldn't ${kind === "hunk-stage" ? "stage" : "revert"} ${label}: ${r.err} The diff may be out of date: refreshed.`, true);
      this.reload(cx);
    });
  }
  // The last revert's way back, while it shows (30 s).
  undoRevert(cx) {
    const u = this.undo;
    if (!u || u.until <= Date.now() || this.busy || !this.root) return;
    const root = this.root, ctx = { cwd: root, on: this.on };
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await redo(exec, ctx, u.steps); } catch (e) { r = { ok: false, err: String(e?.message ?? e) }; }
      this.busy = false;
      if (this.root !== root) return;
      if (r.ok) { this.undo = null; this.say(cx, `Put back ${u.label}.`); }
      else this.say(cx, `Couldn't undo the revert of ${u.label}: ${r.err} The diff may be out of date: refreshed.`, true);
      this.reload(cx);
    });
  }
  // Read the diff again after a change: now, or when the read already running is done (it may have started before).
  reload(cx) { if (this.loading) this.again = true; else { this.stale = true; this.refresh(cx); } }
  // The hunk the picked row is in: { f, hi }.
  pickedHunk() {
    const m = HUNK.exec(this.picked ?? "") ?? LINE.exec(this.picked ?? "");
    const f = m ? this.files?.find((x) => x.path === m[1]) : null;
    return f ? { f, hi: Number(m[2]) } : null;
  }

  pickHunk(cx, id) {
    this.picked = id && id !== this.picked ? id : null;
    this.pickedTo = null;
    this.said = null;
    this.note.set_value("");
    if (this.picked) this.note.focus();
    cx.notify();
  }
  // A diff line's + (a click anywhere on the line): picks that line to comment on; the picked line again lets go.
  // With Shift held (`extend`) and a line of the same file picked, the range runs from that line to this one,
  // over the hunks between; another Shift-click moves its end.
  pickLine(cx, id, extend = false) {
    const m = LINE.exec(id ?? ""), was = LINE.exec(this.picked ?? "");
    if (!m) return;
    if (extend && was && was[1] === m[1]) {
      this.pickedTo = id === this.picked ? null : id;
      this.said = null;
      this.note.focus();
      return cx.notify();
    }
    const same = this.picked === id && this.pickedTo == null;
    this.pickHunk(cx, same ? null : id);
  }
  // Whether line `li` of hunk `hi` of the file is among the picked lines.
  isPicked(path, hi, li) {
    const key = `${this.picked}\n${this.pickedTo}`;
    if (this.spanKey !== key) { this.spanKey = key; this.span = spanOf(this.picked, this.pickedTo); }
    const s = this.span;
    return !!s && s.path === path && (hi > s.from[0] || (hi === s.from[0] && li >= s.from[1])) && (hi < s.to[0] || (hi === s.to[0] && li <= s.to[1]));
  }
  hunkAt() { return pickedAt(this.files, this.picked, this.pickedTo); }
  // Into the message box of the chat in the shown tab: the picked lines as a diff block, then the comment.
  quote(cx) {
    const at = this.hunkAt(), tab = focused()?.tab, places = shared("ht3-panels.places") ?? {};
    if (!at) return;
    if (!Object.values(places).some((p) => p.tab === tab)) { this.said = "The shown tab isn't a chat: show the chat this is for, then add it."; return cx.notify(); }
    setShared("ht3-panels.quote", { tab, text: quoteText(at, this.note.value(), 80, this.scope === "commit" && this.commit ? `${this.commit.short} "${this.commit.subject.slice(0, 60)}"` : null), at: Date.now() });
    this.picked = null;
    this.pickedTo = null;
    this.note.set_value("");
    this.said = `Added to the chat's message box: ${at.path}, ${where(at)}.`;
    cx.notify();
  }
  // Unified or Split, as chosen (the setting "diffLayout"), and what shows: Split needs the width.
  view() { return prefs().diffLayout === "split" ? "split" : "unified"; }
  split() { return this.view() === "split" && !(this.width != null && this.width < SPLIT_MIN); }
  setView(cx, view) {
    if (view !== this.view()) setPref("diffLayout", view);
    cx.notify();
  }
  setScope(cx, scope) {
    this.pick = false;
    this.picking = false;
    if (scope !== this.scope) { this.scope = scope; this.files = null; this.picked = null; this.pickedTo = null; this.refresh(cx); }
    cx.notify();
  }
  // The header's Hide whitespace toggle; the setting is on unless it is false. The next render sees the change in
  // `sig()` and runs the diff again.
  setWhitespace(cx, hide) {
    if (hide !== diffHidesWhitespace()) setPref("diffIgnoreWhitespace", hide ? undefined : false);
    cx.notify();
  }
  sig() { return `${this.scope}|${this.scope === "commit" ? this.commit?.hash ?? "" : ""}|${diffHidesWhitespace() ? "w" : ""}`; }

  // ---- Commit scope ----
  // The recent commits of HEAD's branch, newest first.
  loadCommits(cx) {
    const root = this.root, on = this.on;
    if (!root) return Promise.resolve([]);
    return exec("git", [...GIT, "log", "-n", String(COMMITS), COMMIT_FORMAT], { cwd: root, on }).then((r) => {
      if (this.root !== root) return this.commits ?? [];
      this.commits = r.code === 0 ? parseCommits(r.stdout) : [];
      if (r.code !== 0) this.commitNote = r.stderr.trim().split("\n")[0] || "git log failed";
      cx.notify();
      return this.commits;
    }).catch((e) => { this.commitNote = String(e?.message ?? e); this.commits = []; cx.notify(); return []; });
  }
  // The picker step: the list shows in place of the files, read again each time it opens.
  openPicker(cx) {
    this.pick = false;
    this.picking = true;
    this.picked = null;
    this.pickedTo = null;
    this.commitNote = null;
    this.loadCommits(cx);
    cx.notify();
  }
  closePicker(cx) { this.picking = false; cx.notify(); }
  // One commit of the list, or by its hash or ref (an old one the list doesn't reach).
  async chooseCommit(cx, ref) {
    ref = String(ref ?? "").trim();
    this.commitNote = null;
    if (!ref || ref.startsWith("-")) { this.commitNote = "No such commit."; return cx.notify(); }
    let info = null;
    if (isIndex(ref)) {
      const list = this.commits ?? await this.loadCommits(cx);
      info = list[Number(ref)] ?? null;
    } else {
      info = (this.commits ?? []).find((c) => c.hash.startsWith(ref)) ?? null;
      if (!info && this.root) {
        const r = await exec("git", [...GIT, "log", "-n", "1", COMMIT_FORMAT, ref, "--"], { cwd: this.root, on: this.on }).catch(() => null);
        info = r?.code === 0 ? parseCommits(r.stdout)[0] ?? null : null;
      }
    }
    if (!info) { this.commitNote = `No commit ${ref}.`; return cx.notify(); }
    this.setCommit(cx, info);
  }
  setCommit(cx, info) {
    const was = this.scope;
    this.pick = false;
    this.picking = false;
    this.commit = info;
    this.scope = "commit";
    this.picked = null;
    this.pickedTo = null;
    this.said = null;
    // Another scope's files must not stand in for the commit's; from one commit to the next they stay until it is read.
    if (was !== "commit") this.files = null;
    if (!this.commits) this.loadCommits(cx);
    this.refresh(cx);
    cx.notify();
  }
  // Prev is the older commit (further down the list), Next the newer; null at either end or for a commit the list doesn't hold.
  neighbour(by) {
    const i = (this.commits ?? []).findIndex((c) => c.hash === this.commit?.hash);
    return i < 0 ? null : this.commits[i + by] ?? null;
  }
  commitCommand(cx, arg) {
    if (arg === "list" || arg === "") this.openPicker(cx);
    else if (arg === "prev" || arg === "next") {
      const go = () => { const n = this.neighbour(arg === "prev" ? 1 : -1); if (n) this.setCommit(cx, n); };
      if (this.commits) go(); else this.loadCommits(cx).then(go);
    } else this.chooseCommit(cx, arg);
  }

  // The repository of the shown space's folder.
  follow(cx) {
    const sp = activeSpace(), where = placeOf(sp);
    const key = `${where.on ?? ""}|${where.cwd ?? ""}`;
    if (key === this.seen || !where.cwd) return;
    this.seen = key;
    this.files = null;
    this.error = null;
    this.commits = null;
    this.commit = null;
    this.picking = false;
    this.undo = null;
    this.armed = null;
    this.live = false;
    if (this.scope === "commit") this.scope = "branch";
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: where.cwd, on: where.on }).catch(() => null);
      if (this.seen !== key) return;
      this.root = top?.code === 0 ? top.stdout.trim() : null;
      this.on = where.on;
      this.error = this.root ? null : "This folder is not a Git repository.";
      this.files = this.root ? null : [];
      cx.notify();
      if (this.root) { this.refresh(cx); this.watch(cx); }
    });
  }

  // One watch at a time: the loop of a folder left behind ends at its next wake.
  watch(cx) {
    const root = this.root;
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.root === root) this.refresh(cx, true);
        }
      } catch { if (this.watched === root) this.watched = null; }
    });
  }

  // Runs git only while the tab shows; back in view, at once.
  // `auto`: the timer's or the folder watch's; a commit doesn't change under them, so it isn't read again.
  refresh(cx, auto = false) {
    if (this.loading || !(this.root || (this.scope === "turn" && this.turn))) return;
    if (auto && this.scope === "commit" && this.files && this.usedSig === this.sig()) return;
    if (this.scope === "commit" && !this.commit) return;
    if (!showing(this.group, "diff")) { this.stale = true; return; }
    this.stale = false;
    const scope = this.scope, turn = scope === "turn" ? this.turn : null, commit = scope === "commit" ? this.commit : null;
    const ws = diffHidesWhitespace(), sig = this.sig();
    const root = turn ? turn.root : this.root, on = turn ? turn.on ?? undefined : this.on;
    this.loading = true;
    cx.spawn(async (cx) => {
      // What this run found is dropped when the scope or the folder changed meanwhile: then it runs again.
      let used = false;
      try {
        const flags = [...GIT, "diff", "--no-color", "--no-ext-diff", "-U3", "--find-renames", ...(ws ? ["-w"] : [])];
        // Without -w, the same diff by name: git leaves a file whose only change is whitespace out of the -w one.
        const names = async (args) => {
          if (!ws) return [];
          const n = await exec("git", args, { cwd: root, on }).catch(() => null);
          return n?.code === 0 ? n.stdout.split("\n").map((x) => x.replace(/\r$/, "")).filter(Boolean) : [];
        };
        if (commit) {
          const r = await exec("git", showArgs(commit.hash, ws, ["-U3"]), { cwd: root, on });
          if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "git show failed");
          const files = withWhitespaceOnly(parseDiff(r.stdout), await names(showArgs(commit.hash, false, ["--name-only"])));
          if (this.root === root && this.scope === scope && this.commit?.hash === commit.hash) {
            this.files = files.slice(0, MAX_FILES);
            this.more = files.length - this.files.length;
            this.error = null;
            this.live = false;
            this.usedSig = sig;
            used = true;
          }
          return;
        }
        let from = "HEAD", base = null;
        if (scope === "branch") {
          const b = await exec("sh", ["-c", BASE], { cwd: root, on }).catch(() => null);
          const [ref, sha] = (b?.stdout ?? "").trim().split(" ");
          if (sha) { from = sha; base = ref; }
        }
        let r = await exec("git", turn ? [...flags, turn.from, turn.to] : [...flags, from], { cwd: root, on });
        let at = turn ? [turn.from, turn.to] : [from];
        if (r.code !== 0 && !turn) { r = await exec("git", [...flags, EMPTY_TREE], { cwd: root, on }); at = [EMPTY_TREE]; }
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "git diff failed");
        const extra = turn ? null : await exec("sh", ["-c", untracked(ws)], { cwd: root, on, timeout: 20000 }).catch(() => null);
        const files = withWhitespaceOnly(parseDiff(r.stdout + "\n" + (extra?.stdout ?? "")), await names([...GIT, "diff", "--name-only", "--find-renames", ...at]));
        // Revert and Stage work on the working tree against HEAD (or against nothing, before the first commit).
        const live = !turn && (at[0] === "HEAD" || at[0] === EMPTY_TREE);
        let staged = new Set(), untrackedPaths = new Set();
        if (live) {
          const sg = await exec("git", [...GIT, "diff", "--cached", "--name-only", "--find-renames"], { cwd: root, on }).catch(() => null);
          if (sg?.code === 0) staged = new Set(sg.stdout.split("\n").map((x) => x.replace(/\r$/, "")).filter(Boolean));
          else if (sg) staged = new Set(files.map((f) => f.path)); // can't tell: no Stage
          const ut = await exec("git", [...GIT, "ls-files", "-o", "--exclude-standard"], { cwd: root, on }).catch(() => null);
          if (ut?.code === 0) untrackedPaths = new Set(ut.stdout.split("\n").filter(Boolean));
        }
        if ((turn ? this.turn === turn : this.root === root) && this.scope === scope) {
          this.live = live;
          this.staged = staged;
          this.untrackedPaths = untrackedPaths;
          this.diffWs = ws;
          this.usedSig = sig;
          this.base = base;
          this.files = files.slice(0, MAX_FILES);
          this.more = files.length - this.files.length;
          this.error = null;
          used = true;
        }
      } catch (e) { if (turn ? this.turn === turn : this.root === root) { used = this.scope === scope; this.error = String(e?.message ?? e); if (turn) this.files = []; } }
      finally { this.loading = false; if (!used || this.again) this.stale = true; this.again = false; cx.notify(); }
    });
  }

  // The rows of the list: a header per file, then its hunks' lines; in Split a row is a pair of lines.
  rows(split = this.split()) {
    const rows = [];
    for (const f of this.files ?? []) {
      const open = !this.shut.has(f.path);
      rows.push({ id: `f:${f.path}`, kind: "file", f, open });
      if (!open) continue;
      if (f.binary) rows.push({ id: `b:${f.path}`, kind: "note", text: "Binary file not shown." });
      else if (!f.hunks.length) rows.push({ id: `e:${f.path}`, kind: "note", text: f.wsOnly ? "Only whitespace changed here, and whitespace changes are hidden." : "No content changes." });
      f.hunks.forEach((h, hi) => {
        rows.push({ id: `h:${f.path}:${hi}`, kind: "hunk", h, f, hi });
        if (split) pairLines(h.lines).forEach((p, pi) => rows.push({ id: `p:${f.path}:${hi}:${pi}`, kind: "pair", L: p.L, R: p.R, path: f.path, hi, ext: extOf(f.path) }));
        else h.lines.forEach((l, li) => rows.push({ id: `l:${f.path}:${hi}:${li}`, kind: "line", l, path: f.path, hi, li, ext: extOf(f.path) }));
      });
      if (f.cut) rows.push({ id: `c:${f.path}`, kind: "note", text: `Only the first ${MAX_LINES_FILE} changed lines are shown.` });
      if (rows.length > MAX_ROWS) { rows.push({ id: "cut", kind: "note", text: "More changes than fit: the rest is not shown." }); return rows; }
    }
    if (this.more > 0) rows.push({ id: "more", kind: "note", text: `${this.more} more changed file${this.more === 1 ? " is" : "s are"} not shown.` });
    return rows;
  }

  fileHeader(k, r) {
    const f = r.f, dark = k.dark;
    const at = f.path.lastIndexOf("/");
    const mark = { A: ["Added", k.successText], D: ["Deleted", k.destructiveText], R: ["Renamed", k.info], M: [null, null] }[f.status];
    return h_flex().h(32).pl(8).pr(12).gap(6).items_center().bg(k.card).border_b(1).border_color(alpha(k.border, 0.6))
      .child(icon(r.open ? "chevron-down" : "chevron-right").size(14).flex_none().text_color(k.muted))
      .child(fileIcon(f.path.slice(at + 1), dark, 14))
      .child(h_flex().flex_1().min_w(0).items_center().overflow_hidden().text_size(12)
        .when(at >= 0, (el) => el.child(div().min_w(0).truncate().text_color(k.muted).child(f.path.slice(0, at + 1))))
        .child(div().flex_none().font_medium().child(f.path.slice(at + 1))))
      .when(!!mark[0], (el) => el.child(div().flex_none().text_size(11).text_color(mark[1]).child(mark[0])))
      .when(f.add > 0, (el) => el.child(div().flex_none().font_family(k.mono).text_size(11).text_color(k.successText).child(`+${f.add}`)))
      .when(f.del > 0, (el) => el.child(div().flex_none().font_family(k.mono).text_size(11).text_color(k.destructiveText).child(`−${f.del}`)))
      .when(this.live && !this.picking && !f.quoted, (el) => el.child(this.zone(k, "Revert", this.armedNow()?.key === `file-revert:${f.path}:0`, ZR, "Revert this file to HEAD: its staged and unstaged changes are thrown away (a new file is deleted)")));
  }

  // A button drawn as part of a list row (the row has no click handler of its own: onItemClick finds it by where the
  // press was). Armed: it asks "Sure?" for 4 s.
  zone(k, label, armed, w, tip) {
    return div().w(w).h(20).flex_none().flex().items_center().justify_center().rounded(4).text_size(11).font_medium().whitespace_nowrap().cursor_pointer()
      .bg(armed ? k.destructive : alpha(k.foreground, k.dark ? 0.1 : 0.07)).text_color(armed ? "#ffffff" : label === "Revert" ? k.destructiveText : k.foreground)
      .hover((s) => s.bg(armed ? alpha(k.destructive, 0.9) : alpha(k.foreground, 0.18))).tooltip(tip).child(armed ? "Sure?" : label);
  }
  // Which button of a row the last press was on, from its distance to the row's right edge: "revert", "stage" or null.
  zoneAt(kind) {
    const p = this.press;
    if (!p || p.w == null || p.x == null) return null;
    const d = p.w - p.x;
    if (kind === "file") return d <= ZPAD + ZR + 2 ? "revert" : null;
    if (d <= ZPAD + ZR + ZGAP / 2) return "revert";
    if (d <= ZPAD + ZR + ZGAP + ZS + 2) return "stage";
    return null;
  }

  lineRow(k, r, colors) {
    const l = r.l;
    const add = l.t === "+", del = l.t === "-";
    const tint = add ? alpha(k.success, k.dark ? 0.14 : 0.12) : del ? alpha(k.destructive, k.dark ? 0.14 : 0.1) : "#00000000";
    const gutter = add ? alpha(k.success, k.dark ? 0.22 : 0.2) : del ? alpha(k.destructive, k.dark ? 0.22 : 0.18) : "#00000000";
    const num = (v) => div().w(40).flex_none().h_full().pr(6).text_right().text_size(11).text_color(alpha(k.muted, 0.8)).child(v == null ? "" : String(v));
    // The + of the line (GitHub's blue square): faint, filled under the pointer and on a picked line. The click is the row's.
    const on = this.isPicked(r.path, r.hi, r.li), blue = k.info;
    return h_flex().h(20).w_full().items_center().overflow_hidden().bg(on ? alpha(blue, k.dark ? 0.3 : 0.18) : tint).font_family(k.mono).text_size(12).cursor_pointer()
      .child(h_flex().flex_none().h_full().bg(gutter)
        .child(h_flex().size(16).ml(2).flex_none().items_center().justify_center().rounded(4).bg(on ? blue : "#00000000").text_color(on ? "#ffffff" : alpha(k.muted, 0.45))
          .hover((s) => s.bg(blue).text_color("#ffffff")).child(icon("plus").size(12)))
        .child(num(l.o)).child(num(l.n)))
      .child(div().w(16).flex_none().text_center().text_color(add ? k.successText : del ? k.destructiveText : k.dim).child(l.t === " " ? "" : l.t))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(highlight(l.text, r.ext, colors).map((t) => div().flex_none().text_color(t.c ?? k.foreground).child(t.s))));
  }

  // A Split row: the old line on the left with its number, the new one on the right with its; a side with no line
  // is hatched grey. Each side has its own + and is tinted on its own when picked.
  pairRow(k, r, colors) {
    const blue = k.info;
    const cell = (c, left) => {
      const base = h_flex().h_full().flex_1().min_w(0).items_center().overflow_hidden();
      if (!c) return base.bg(alpha(k.muted, k.dark ? 0.08 : 0.06));
      const l = c.l, add = l.t === "+", del = l.t === "-", on = this.isPicked(r.path, r.hi, c.li);
      const tint = add ? alpha(k.success, k.dark ? 0.14 : 0.12) : del ? alpha(k.destructive, k.dark ? 0.14 : 0.1) : "#00000000";
      const gutter = add ? alpha(k.success, k.dark ? 0.22 : 0.2) : del ? alpha(k.destructive, k.dark ? 0.22 : 0.18) : "#00000000";
      return base.bg(on ? alpha(blue, k.dark ? 0.3 : 0.18) : tint)
        .child(h_flex().flex_none().h_full().bg(gutter)
          .child(h_flex().size(16).ml(2).flex_none().items_center().justify_center().rounded(4).bg(on ? blue : "#00000000").text_color(on ? "#ffffff" : alpha(k.muted, 0.45))
            .hover((s) => s.bg(blue).text_color("#ffffff")).child(icon("plus").size(12)))
          .child(div().w(40).flex_none().h_full().pr(6).text_right().text_size(11).text_color(alpha(k.muted, 0.8)).child(String((left ? l.o : l.n) ?? ""))))
        .child(div().w(16).flex_none().text_center().text_color(add ? k.successText : del ? k.destructiveText : k.dim).child(l.t === " " ? "" : l.t))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
          .children(highlight(l.text, r.ext, colors).map((t) => div().flex_none().text_color(t.c ?? k.foreground).child(t.s))));
    };
    return h_flex().h(20).w_full().items_center().overflow_hidden().font_family(k.mono).text_size(12).cursor_pointer()
      .child(cell(r.L, true)).child(div().w(1).h_full().flex_none().bg(alpha(k.border, 0.6))).child(cell(r.R, false));
  }
  // The line a click on a Split row means: the one on the side pressed, else the new side's, else the old side's
  // (a removal with nothing against it).
  pairLine(r) {
    const c = (this.side === "L" ? r.L : null) ?? r.R ?? r.L;
    return c ? `l:${r.path}:${r.hi}:${c.li}` : null;
  }

  // The commit list, 44px rows: the subject, then the short hash, author and relative date; the shown commit is ticked.
  commitPicker(k) {
    const list = this.commits;
    const head = h_flex().h(32).flex_none().px(16).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6)).text_size(12).text_color(k.muted)
      .child(div().flex_1().min_w(0).truncate().child(list == null ? "Reading the commits…" : list.length ? `The last ${list.length} commit${list.length === 1 ? "" : "s"} on this branch` : "No commits yet."))
      .child(button(k, "diff-commit-close", "Close", (cx) => this.closePicker(cx), { variant: "ghost-muted" }));
    const body = !list?.length ? div().flex_1() : v_flex().id("ht3-diff-commits").relative().flex_1().min_h(0)
      .child(list_(list, k, this.scope === "commit" ? this.commit?.hash : null, (id, cx) => this.chooseCommit(cx, id)))
      .child(Scrollbar.vertical("ht3-diff-commit-rows").absolute().inset_0());
    return v_flex().flex_1().min_h(0)
      .child(head)
      .when(!!this.commitNote, (el) => el.child(div().px(16).py(4).text_size(11).text_color(k.destructiveText).child(this.commitNote)))
      .child(body);
  }

  render(cx) {
    this.follow(cx);
    // A chat's "View diff" on a turn (chat.js turnDiff): that turn's two snapshots, as a third scope.
    const turn = shared("ht3-panels.turn");
    // Only a fresh request: a Diff opened later starts on Changes, not on a turn someone looked at before.
    if (turn && turn.at !== this.turnSeen) {
      this.turnSeen = turn.at;
      if (Date.now() - turn.at < 15000) { this.turn = turn; this.scope = "turn"; this.files = null; this.stale = true; }
    }
    if (this.files && this.usedSig && this.usedSig !== this.sig()) this.stale = true; // whitespace was switched elsewhere (Settings, a script)
    if (this.stale) this.refresh(cx);
    const k = tokens(), colors = syntax();
    const root = v_flex().id("ht3-diff").size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(12)
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) >= 1) { this.width = size.width; cx.notify(); } })
      // Esc lets go of what is picked (the comment field has the focus while something is).
      .on_key_down((e, cx) => { if (e.key === "escape" && this.picking) this.closePicker(cx); else if (e.key === "escape" && this.armed) { this.armed = null; cx.notify(); } else if (e.key === "escape" && this.picked) this.pickHunk(cx, null); })
      .on_modifiers_changed((e) => { this.shift = !!e.modifiers?.shift; });
    const say = (text, color = k.muted) => root.child(v_flex().flex_1().items_center().justify_center().px(24).gap(8).text_size(12).text_color(color).child(text));
    if (!this.seen) return say("No folder: focus a terminal to see its changes.");
    if (this.error && !this.files?.length && !this.picking) return say(this.error);
    if (!this.files && !this.picking) return say(this.scope === "commit" && this.commit ? `Reading ${this.commit.short}…` : "Looking at the changes…");
    const files = this.files ?? [];
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const view = this.view(), split = this.split(), narrow = view === "split" && !split;
    const rows = files.length ? this.rows(split) : [];
    const byId = split ? new Map(rows.filter((r) => r.kind === "pair").map((r) => [r.id, r])) : null;
    const allShut = files.length > 0 && files.every((f) => this.shut.has(f.path));
    const picked = this.hunkAt(), ph = picked ? this.pickedHunk() : null, ask = this.armedNow(), undo = this.undo && this.undo.until > Date.now() ? this.undo : null;
    const hideWs = diffHidesWhitespace();
    const scopeLabel = this.scope === "branch" ? "Changes" : this.scope === "turn" ? "This turn" : this.scope === "commit" ? "Commit" : "Uncommitted";
    const older = this.scope === "commit" ? this.neighbour(1) : null, newer = this.scope === "commit" ? this.neighbour(-1) : null;
    return root
      .child(h_flex().h(40).flex_none().px(16).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
        .child(icon("file-diff").size(14).flex_none().text_color(k.muted))
        // T3's scope menu: Changes (the branch against its base) or Uncommitted.
        .child(h_flex().id("diff-scope").h(24).px(6).ml(-6).gap(4).flex_none().items_center().rounded(6).font_medium().text_size(13).cursor_pointer()
          .role("button").accessibility_label(`Showing ${scopeLabel}. Change what is compared`)
          .hover((s) => s.bg(k.accent)).on_click((_e, cx) => { this.pick = !this.pick; cx.notify(); })
          .child(scopeLabel)
          .child(icon(this.pick ? "chevron-up" : "chevron-down").size(12).flex_none().text_color(k.muted)))
        .when(this.scope === "turn" && !!this.turn?.label, (el) => el.child(div().flex_none().max_w(160).truncate().text_size(12).text_color(k.muted).tooltip("What the agent changed while it answered this message").child(`“${this.turn.label}”`)))
        .when(this.scope === "branch" && !!this.base, (el) => el.child(div().flex_none().max_w(140).truncate().text_size(12).font_family(k.mono).text_color(k.muted).tooltip(`Compared with the merge base with ${this.base}`).child(this.base)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted)
          .child(files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "No changes"))
        .when(files.length > 0, (el) => el.child(h_flex().flex_none().gap(6).mr(4).font_family(k.mono).text_size(11)
          .child(div().text_color(k.successText).child(`+${add}`)).child(div().text_color(k.destructiveText).child(`−${del}`))))
        // T3's Hide whitespace (a pilcrow): -w on every diff the panel runs.
        .child(iconButton(k, "diff-whitespace", "pilcrow", (cx) => this.setWhitespace(cx, !hideWs), { size: "sm", on: hideWs, tip: hideWs ? "Show whitespace changes" : "Hide whitespace changes" }))
        // T3's layout toggle (its Stacked and Split): one column, or old beside new.
        .child(h_flex().flex_none().gap(2)
          .child(iconButton(k, "diff-unified", "rows-3", (cx) => this.setView(cx, "unified"), { size: "sm", on: view === "unified", tip: "Unified: one column" }))
          .child(iconButton(k, "diff-split", "columns-2", (cx) => this.setView(cx, "split"), { size: "sm", on: view === "split",
            tip: narrow ? `Split needs ${SPLIT_MIN} px and this panel is ${Math.round(this.width)} wide: showing Unified until it is wider`
              : this.width != null && this.width < SPLIT_MIN ? `Split: old beside new (shows once the panel is ${SPLIT_MIN} px wide; it is ${Math.round(this.width)})` : "Split: old beside new" }).when(narrow, (e) => e.opacity(0.5))))
        .child(iconButton(k, "diff-collapse", allShut ? "chevrons-up-down" : "chevrons-down-up", (cx) => {
          if (allShut) this.shut.clear(); else for (const f of files) this.shut.add(f.path);
          cx.notify();
        }, { size: "sm", tip: allShut ? "Expand all files" : "Collapse all files" }))
        .child(iconButton(k, "diff-refresh", "refresh-cw", (cx) => this.refresh(cx), { size: "sm", tip: this.loading ? "Refreshing…" : "Refresh" })))
      // Commit scope: which commit (its subject, hash and where it is in the list), with Prev (older) and Next (newer).
      .when(this.scope === "commit" && !!this.commit, (el) => el.child(h_flex().h(32).flex_none().px(16).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
        .child(icon("git-commit-horizontal").size(14).flex_none().text_color(k.muted))
        .child(div().id("diff-commit-title").flex_1().min_w(0).truncate().text_size(13).font_medium().cursor_pointer().tooltip(`${this.commit.subject}\n${this.commit.author}, ${this.commit.date}. Pick another commit`)
          .on_click((_e, cx) => (this.picking ? this.closePicker(cx) : this.openPicker(cx))).child(this.commit.subject))
        .when(this.commit.merge, (e) => e.child(div().flex_none().text_size(11).text_color(k.muted).tooltip("A merge: shown against its first parent").child("merge")))
        .child(div().flex_none().text_size(12).font_family(k.mono).text_color(k.muted).tooltip(this.commit.hash).child(this.commit.short))
        .when(this.loading, (e) => e.child(div().flex_none().text_size(11).text_color(k.muted).child("Loading…")))
        .child(h_flex().flex_none().gap(2)
          .child(iconButton(k, "diff-commit-prev", "chevron-left", (cx) => { if (older) this.setCommit(cx, older); }, { size: "sm", tip: older ? `Older: ${older.short} ${older.subject}` : "No older commit in the list" }).when(!older, (e) => e.opacity(0.4)))
          .child(iconButton(k, "diff-commit-next", "chevron-right", (cx) => { if (newer) this.setCommit(cx, newer); }, { size: "sm", tip: newer ? `Newer: ${newer.short} ${newer.subject}` : "No newer commit in the list" }).when(!newer, (e) => e.opacity(0.4))))))
      .when(this.pick, (el) => el.child(v_flex().mx(10).my(4).p(4).w(200).flex_none().rounded(8).border(1).border_color(k.border).bg(k.popover).shadow_lg()
        .children([["branch", "Changes", "The branch against its base"], ["unstaged", "Uncommitted", "The working tree against HEAD"], ["commit", "Commit…", "One of the recent commits on this branch"], ...(this.turn ? [["turn", "This turn", "What the agent changed in one turn of a chat"]] : [])].map(([id, label, about]) =>
          h_flex().id(`diff-scope-${id}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
            .role("button").accessibility_label(`${label}: ${about}`).tooltip(about).hover((s) => s.bg(k.accent))
            .on_click((_e, cx) => (id === "commit" ? this.openPicker(cx) : this.setScope(cx, id)))
            .child(div().flex_1().child(label))
            .when(this.scope === id, (e) => e.child(icon("check").size(14).flex_none().text_color(k.muted)))))))
      .when(!!this.error, (el) => el.child(div().px(12).py(4).text_size(11).text_color(k.destructiveText).child(this.error)))
      // The picker step: the recent commits of this branch in place of the files; a click shows one.
      .when(this.picking, (el) => el.child(this.commitPicker(k)))
      .when(!files.length && !this.picking, (el) => el.child(v_flex().flex_1().items_center().justify_center().text_color(k.muted).child(this.scope === "branch" ? `Nothing changed against ${this.base ?? "the base"}.` : this.scope === "turn" ? "That turn changed no files." : this.scope === "commit" ? "That commit changed no files." : "The working tree matches HEAD.")))
      .when(files.length > 0 && !this.picking, (el) => el.child(v_flex().id("ht3-diff-list").relative().flex_1().min_h(0)
        // The list's click handler gets the row only: the press before it says whether Shift is held and, for Split, which half.
        .on_mouse_down("left", (e) => {
          this.shift = !!e.modifiers?.shift;
          this.side = e.local_position && e.bounds?.width ? (e.local_position.x < e.bounds.width / 2 ? "L" : "R") : null;
          this.press = e.local_position && e.bounds?.width ? { x: e.local_position.x, w: e.bounds.width } : null;
        })
        .child(list("ht3-diff-rows", rows.length, (i) => rows[i].id, (i) => {
          const r = rows[i];
          if (r.kind === "file") return this.fileHeader(k, r);
          if (r.kind === "line") return this.lineRow(k, r, colors);
          if (r.kind === "pair") return this.pairRow(k, r, colors);
          // A hunk's header: a click picks the hunk to comment on for the agent.
          if (r.kind === "hunk") return h_flex().h(22).w_full().px(12).gap(8).items_center().overflow_hidden().bg(alpha(k.info, r.id === this.picked ? 0.28 : k.dark ? 0.1 : 0.06)).font_family(k.mono).text_size(11).text_color(r.id === this.picked ? k.foreground : k.muted)
            .cursor_pointer().hover((s) => s.bg(alpha(k.info, 0.2)))
            .child(div().flex_none().child(r.h.head.match(/^@@[^@]*@@/)?.[0] ?? "@@"))
            .child(div().flex_1().min_w(0).truncate().child(r.h.ctx))
            .child(h_flex().flex_none().gap(4).items_center().child(icon("message-square").size(12).flex_none()).when(!(this.live && !this.picking), (e) => e.child(r.id === this.picked ? "Commenting" : "Comment")))
            .when(this.live && !this.picking && this.hunkActs(r.f, r.hi).revert, (e) => {
              const a = this.hunkActs(r.f, r.hi), arm = this.armedNow();
              return e.child(h_flex().flex_none().gap(ZGAP).items_center()
                .when(a.stage, (z) => z.child(this.zone(k, "Stage", false, ZS, "Stage this hunk: git apply --cached")))
                .child(this.zone(k, "Revert", arm?.key === `hunk-revert:${r.f.path}:${r.hi}`, ZR, "Revert this hunk in the working tree: git apply -R")));
            });
          return div().h(24).px(12).flex().items_center().text_size(11).text_color(k.muted).child(r.text);
        })
          .on_item_click((id, cx) => {
            const z = id.startsWith("h:") || id.startsWith("f:") ? this.zoneAt(id[0] === "f" ? "file" : "hunk") : null;
            this.press = null;
            if (z && this.live && !this.picking) {
              if (id.startsWith("f:")) return this.act(cx, "file-revert", id.slice(2), 0);
              const m = HUNK.exec(id), f = m ? this.files?.find((x) => x.path === m[1]) : null, a = f ? this.hunkActs(f, Number(m[2])) : null;
              if (a?.revert && (z === "revert" || a.stage)) return this.act(cx, z === "stage" ? "hunk-stage" : "hunk-revert", m[1], Number(m[2]));
            }
            if (id.startsWith("h:")) return this.pickHunk(cx, id);
            if (id.startsWith("l:")) return this.pickLine(cx, id, this.shift);
            if (id.startsWith("p:")) { const r = byId?.get(id); return r ? this.pickLine(cx, this.pairLine(r), this.shift) : undefined; }
            if (!id.startsWith("f:")) return;
            const p = id.slice(2);
            if (this.shut.has(p)) this.shut.delete(p); else this.shut.add(p);
            cx.notify();
          }))
        .child(Scrollbar.vertical("ht3-diff-rows").absolute().inset_0())))
      // The comment on the picked hunk, under the list; Enter or the button puts both into the shown chat's message box.
      .when(!!picked, (el) => el.child(v_flex().flex_none().px(12).py(10).gap(8).border_t(1).border_color(k.border).bg(k.card)
        .child(h_flex().gap(6).items_center().text_size(12).text_color(k.muted)
          .child(icon("message-square").size(14).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(`${picked.path} · ${where(picked)} · ${picked.lines.length} line${picked.lines.length === 1 ? "" : "s"} of diff${picked.parts.length > 1 ? ` in ${picked.parts.length} hunks` : ""}`))
          .when(!!this.picked?.startsWith("l:"), (e) => e.child(div().flex_none().text_size(11).child(this.pickedTo ? "Shift-click moves the end · Esc clears" : "Shift-click another + for a range")))
          // The hunk's own buttons, for when the one in its row is hard to hit.
          .when(!!ph && this.live && this.hunkActs(ph.f, ph.hi).revert, (e) => e.child(h_flex().flex_none().gap(4).items_center()
            .when(this.hunkActs(ph.f, ph.hi).stage, (z) => z.child(button(k, "hunk-stage", "Stage hunk", (cx) => this.act(cx, "hunk-stage", ph.f.path, ph.hi), { variant: "ghost-muted" })))
            .child(button(k, "hunk-revert", "Revert hunk", (cx) => this.act(cx, "hunk-revert", ph.f.path, ph.hi), { variant: "ghost-muted" })))))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).h(30).px(8).rounded(8).border(1).border_color(k.input).bg(k.background).text_size(13).child(Input.new(this.note)))
          .child(button(k, "hunk-cancel", "Cancel", (cx) => this.pickHunk(cx, null), { variant: "outline", size: "sm" }))
          .child(button(k, "hunk-add", "Add to chat", (cx) => this.quote(cx), { variant: "default", size: "sm" })))))
      // A revert asks: Yes (or the same button again within 4 s) does it.
      .when(!!ask, (el) => el.child(h_flex().flex_none().px(12).py(6).gap(8).items_center().border_t(1).border_color(k.border).bg(k.card).text_size(12)
        .child(icon("triangle-alert").size(14).flex_none().text_color(k.destructiveText))
        .child(div().flex_1().min_w(0).child(ask.text))
        .child(button(k, "revert-no", "No", (cx) => this.answer(cx, false), { variant: "outline" }))
        .child(button(k, "revert-yes", "Yes", (cx) => this.answer(cx, true), { variant: "destructive" }))))
      // The last revert can be put back for 30 s.
      .when(!!undo && !ask, (el) => el.child(h_flex().flex_none().px(12).py(6).gap(8).items_center().border_t(1).border_color(k.border).bg(k.card).text_size(12)
        .child(icon("rotate-ccw").size(14).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(k.muted).child(`Reverted ${undo.label}.`))
        .child(button(k, "undo-revert", "Undo revert", (cx) => this.undoRevert(cx), { variant: "outline" }))))
      .when(!!this.said && !(undo && !this.saidBad && this.said.startsWith("Reverted ")), (el) => el.child(div().flex_none().px(12).py(6).border_t(1).border_color(k.border).text_size(12).text_color(this.saidBad ? k.destructiveText : k.muted).child(this.said)));
  }
}
