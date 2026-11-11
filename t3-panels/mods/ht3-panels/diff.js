// T3 Code's Diff surface (DiffPanel.tsx) in gpui-kit: what changed, one section per file with its
// status, its +/- counts and its hunks, the lines tinted green and red and colored with T3 Code's
// code colors. Files are collapsible; new (untracked) files show as added. What is compared is the
// header's choice: Changes (the working tree against the merge base with the default branch),
// Uncommitted (against HEAD), or one turn of a chat (its two checkpoints).
//
// Runs git in the repository of the shown space's folder: `git diff <base or HEAD>`, and for
// untracked files `git diff --no-index /dev/null <file>`. Reads only. The listing follows the
// folder (watchFolder) and a 15 s timer. A hunk or some of its lines can be picked and sent to
// the shown chat's message box with a comment.

import { div, list } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { exec, watchFolder, shared, setShared, focused } from "herdr";
import { tokens, alpha, icon, iconButton, button } from "./look.js";
import { fileIcon } from "./fileicons.js";
import { activeSpace, placeOf, showing } from "./side.js";
import { syntax } from "./editor.js";

const MAX_FILES = 200, MAX_LINES_FILE = 1500, MAX_ROWS = 12000, MAX_UNTRACKED = 40;
// The default branch's ref and the merge base with it, as "<ref> <sha>"; nothing when there is none.
const BASE = 'b=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); for c in "$b" origin/main origin/master main master; do [ -n "$c" ] && m=$(git merge-base HEAD "$c" 2>/dev/null) && [ -n "$m" ] && echo "$c $m" && break; done; true';
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const UNTRACKED = `git ls-files -o --exclude-standard | head -n ${MAX_UNTRACKED} | while IFS= read -r f; do [ -f "$f" ] && [ "$(wc -c < "$f")" -lt 200000 ] && git diff --no-index --no-color -U3 -- /dev/null "$f"; done; true`;

// ---- a unified diff, parsed ----

export function parseDiff(text) {
  const files = [];
  let file = null, hunk = null, o = 0, n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = { path: m ? m[2] : line.slice(11), old: m ? m[1] : null, status: "M", add: 0, del: 0, binary: false, hunks: [], lines: 0, cut: false };
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (!hunk && line.startsWith("new file")) file.status = "A";
    else if (!hunk && line.startsWith("deleted file")) file.status = "D";
    else if (!hunk && line.startsWith("rename from ")) { file.status = "R"; file.old = line.slice(12); }
    else if (!hunk && line.startsWith("Binary files")) file.binary = true;
    else if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
      o = m ? Number(m[1]) : 0;
      n = m ? Number(m[2]) : 0;
      hunk = { head: line, ctx: m?.[3] ?? "", lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (file.lines >= MAX_LINES_FILE) { file.cut = true; continue; }
      const c = line[0];
      if (c === "+") { hunk.lines.push({ t: "+", text: line.slice(1), n: n++ }); file.add++; file.lines++; }
      else if (c === "-") { hunk.lines.push({ t: "-", text: line.slice(1), o: o++ }); file.del++; file.lines++; }
      else if (c === " ") { hunk.lines.push({ t: " ", text: line.slice(1), o: o++, n: n++ }); file.lines++; }
      // "\ No newline at end of file" and the like are left out.
    }
  }
  return files;
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
    this.pick = false;
    this.watched = null;
    this.more = 0;
    this.seen = null;
    // A hunk as context for the agent: a click on a hunk's header picks it, a comment is written under the list,
    // and both go into the shown chat's message box as a quoted block (chat.js takes shared "ht3-panels.quote").
    this.picked = null; // the picked hunk's row id, "h:<path>:<n>", or a picked line's, "l:<path>:<hunk>:<line>"
    this.pickedTo = null; // with a picked line: the last line of the range, when it is more than one
    this.said = null; // what happened to the last one
    this.note = InputState.new({ placeholder: "What should the agent do about this change?" });
    this.note.on("change", (_e, cx) => cx.notify());
    this.note.on("submit", (_e, cx) => this.quote(cx));
    this.follow(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }
  close() {}
  // `ht3-panels.scope:branch|unstaged`: what the Diff compares, as its header's menu, for scripts and the popover.
  command(c, cx) {
    if (c === "scope:branch" || c === "scope:unstaged" || (c === "scope:turn" && this.turn)) this.setScope(cx, c.slice(6));
    // hunk:<n> picks the nth hunk shown (from 0; hunk: lets go of it), comment:<text> sends it to the chat with that comment.
    // diffline:<n> picks the nth diff line shown (from 0), as a click on it; a second one in the same hunk makes a range.
    if (c.startsWith("diffline:")) { const ids = this.rows().filter((r) => r.kind === "line").map((r) => r.id); this.pickLine(cx, ids[Number(c.slice(9))] ?? null); }
    if (c.startsWith("hunk:")) { const ids = this.rows().filter((r) => r.kind === "hunk").map((r) => r.id); this.pickHunk(cx, c.slice(5) === "" ? null : ids[Number(c.slice(5))] ?? null); }
    if (c.startsWith("comment:")) { this.note.set_value(c.slice(8)); this.quote(cx); }
  }

  pickHunk(cx, id) {
    this.picked = id && id !== this.picked ? id : null;
    this.pickedTo = null;
    this.said = null;
    this.note.set_value("");
    if (this.picked) this.note.focus();
    cx.notify();
  }
  // A diff line's + (a click anywhere on the line): picks that line to comment on. A second line of the same hunk
  // makes it a range from the first to that one; the picked line again lets go.
  pickLine(cx, id) {
    const m = /^l:(.*):(\d+):(\d+)$/.exec(id ?? ""), was = /^l:(.*):(\d+):(\d+)$/.exec(this.picked ?? "");
    if (!m) return;
    if (was && this.pickedTo == null && was[1] === m[1] && was[2] === m[2] && was[3] !== m[3]) {
      const a = Math.min(Number(was[3]), Number(m[3])), b = Math.max(Number(was[3]), Number(m[3]));
      this.picked = `l:${m[1]}:${m[2]}:${a}`;
      this.pickedTo = b;
      this.said = null;
      this.note.focus();
      return cx.notify();
    }
    const same = this.picked === id && this.pickedTo == null;
    this.pickHunk(cx, same ? null : id);
  }
  // Whether a line row is among the picked lines.
  isPicked(id) {
    const m = /^l:(.*):(\d+):(\d+)$/.exec(id), was = /^l:(.*):(\d+):(\d+)$/.exec(this.picked ?? "");
    return !!m && !!was && m[1] === was[1] && m[2] === was[2] && Number(m[3]) >= Number(was[3]) && Number(m[3]) <= (this.pickedTo ?? Number(was[3]));
  }
  // What is picked: { path, h, lines, from, to } (a whole hunk, or some of its lines; from and to are lines in the
  // new file, or in the old one for a removal), or null once it is gone.
  hunkAt() {
    const m = /^h:(.*):(\d+)$/.exec(this.picked ?? ""), ml = m ? null : /^l:(.*):(\d+):(\d+)$/.exec(this.picked ?? ""), at = m ?? ml;
    const f = at ? this.files?.find((x) => x.path === at[1]) : null, h = f?.hunks[Number(at?.[2])];
    if (!h) return null;
    const lines = ml ? h.lines.slice(Number(ml[3]), (this.pickedTo ?? Number(ml[3])) + 1) : h.lines;
    if (!lines.length) return null;
    const ns = lines.map((l) => l.n ?? null).filter((n) => n != null), os = lines.map((l) => l.o ?? null).filter((n) => n != null);
    const span = ns.length ? ns : os;
    return { path: f.path, h, lines, from: span[0] ?? 0, to: span.at(-1) ?? 0 };
  }
  // Into the message box of the chat in the shown tab: the hunk as a diff block, then the comment.
  quote(cx) {
    const at = this.hunkAt(), tab = focused()?.tab, places = shared("ht3-panels.places") ?? {};
    if (!at) return;
    if (!Object.values(places).some((p) => p.tab === tab)) { this.said = "The shown tab isn't a chat: show the chat this is for, then add it."; return cx.notify(); }
    const MAX = 80, lines = at.lines.slice(0, MAX).map((l) => `${l.t}${l.text}`);
    const fence = lines.some((l) => l.includes("```")) ? "````" : "```";
    const text = [`In \`${at.path}\` (${at.from === at.to ? `line ${at.from}` : `lines ${at.from}-${at.to}`}):`, `${fence}diff`, at.h.head.match(/^@@[^@]*@@/)?.[0] ?? "@@", ...lines,
      ...(at.lines.length > MAX ? [`… ${at.lines.length - MAX} more lines`] : []), fence, this.note.value().trim()].filter((l) => l !== "").join("\n");
    setShared("ht3-panels.quote", { tab, text, at: Date.now() });
    this.picked = null;
    this.pickedTo = null;
    this.note.set_value("");
    this.said = `Added to the chat's message box: ${at.path}, ${at.from === at.to ? `line ${at.from}` : `lines ${at.from}-${at.to}`}.`;
    cx.notify();
  }
  setScope(cx, scope) {
    this.pick = false;
    if (scope !== this.scope) { this.scope = scope; this.files = null; this.refresh(cx); }
    cx.notify();
  }

  // The repository of the shown space's folder.
  follow(cx) {
    const sp = activeSpace(), where = placeOf(sp);
    const key = `${where.on ?? ""}|${where.cwd ?? ""}`;
    if (key === this.seen || !where.cwd) return;
    this.seen = key;
    this.files = null;
    this.error = null;
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
          if (this.root === root) this.refresh(cx);
        }
      } catch { if (this.watched === root) this.watched = null; }
    });
  }

  // Runs git only while the tab shows; back in view, at once.
  refresh(cx) {
    if (this.loading || !(this.root || (this.scope === "turn" && this.turn))) return;
    if (!showing(this.group, "diff")) { this.stale = true; return; }
    this.stale = false;
    const scope = this.scope, turn = scope === "turn" ? this.turn : null;
    const root = turn ? turn.root : this.root, on = turn ? turn.on ?? undefined : this.on;
    this.loading = true;
    cx.spawn(async (cx) => {
      // What this run found is dropped when the scope or the folder changed meanwhile: then it runs again.
      let used = false;
      try {
        const flags = ["--no-optional-locks", "-c", "core.fsmonitor=false", "diff", "--no-color", "--no-ext-diff", "-U3", "--find-renames"];
        let from = "HEAD", base = null;
        if (scope === "branch") {
          const b = await exec("sh", ["-c", BASE], { cwd: root, on }).catch(() => null);
          const [ref, sha] = (b?.stdout ?? "").trim().split(" ");
          if (sha) { from = sha; base = ref; }
        }
        let r = await exec("git", turn ? [...flags, turn.from, turn.to] : [...flags, from], { cwd: root, on });
        if (r.code !== 0 && !turn) r = await exec("git", [...flags, EMPTY_TREE], { cwd: root, on });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "git diff failed");
        const extra = turn ? null : await exec("sh", ["-c", UNTRACKED], { cwd: root, on, timeout: 20000 }).catch(() => null);
        const files = parseDiff(r.stdout + "\n" + (extra?.stdout ?? ""));
        if ((turn ? this.turn === turn : this.root === root) && this.scope === scope) {
          this.base = base;
          this.files = files.slice(0, MAX_FILES);
          this.more = files.length - this.files.length;
          this.error = null;
          used = true;
        }
      } catch (e) { if (turn ? this.turn === turn : this.root === root) { used = this.scope === scope; this.error = String(e?.message ?? e); if (turn) this.files = []; } }
      finally { this.loading = false; if (!used) this.stale = true; cx.notify(); }
    });
  }

  // The rows of the list: a header per file, then its hunks' lines.
  rows() {
    const rows = [];
    for (const f of this.files ?? []) {
      const open = !this.shut.has(f.path);
      rows.push({ id: `f:${f.path}`, kind: "file", f, open });
      if (!open) continue;
      if (f.binary) rows.push({ id: `b:${f.path}`, kind: "note", text: "Binary file not shown." });
      f.hunks.forEach((h, hi) => {
        rows.push({ id: `h:${f.path}:${hi}`, kind: "hunk", h });
        h.lines.forEach((l, li) => rows.push({ id: `l:${f.path}:${hi}:${li}`, kind: "line", l, ext: extOf(f.path) }));
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
      .when(f.del > 0, (el) => el.child(div().flex_none().font_family(k.mono).text_size(11).text_color(k.destructiveText).child(`−${f.del}`)));
  }

  lineRow(k, r, colors) {
    const l = r.l;
    const add = l.t === "+", del = l.t === "-";
    const tint = add ? alpha(k.success, k.dark ? 0.14 : 0.12) : del ? alpha(k.destructive, k.dark ? 0.14 : 0.1) : "#00000000";
    const gutter = add ? alpha(k.success, k.dark ? 0.22 : 0.2) : del ? alpha(k.destructive, k.dark ? 0.22 : 0.18) : "#00000000";
    const num = (v) => div().w(40).flex_none().h_full().pr(6).text_right().text_size(11).text_color(alpha(k.muted, 0.8)).child(v == null ? "" : String(v));
    // The + of the line (GitHub's blue square): faint, filled under the pointer and on a picked line. The click is the row's.
    const on = this.isPicked(r.id), blue = k.info;
    return h_flex().h(20).w_full().items_center().overflow_hidden().bg(on ? alpha(blue, k.dark ? 0.3 : 0.18) : tint).font_family(k.mono).text_size(12).cursor_pointer()
      .child(h_flex().flex_none().h_full().bg(gutter)
        .child(h_flex().size(16).ml(2).flex_none().items_center().justify_center().rounded(4).bg(on ? blue : "#00000000").text_color(on ? "#ffffff" : alpha(k.muted, 0.45))
          .hover((s) => s.bg(blue).text_color("#ffffff")).child(icon("plus").size(12)))
        .child(num(l.o)).child(num(l.n)))
      .child(div().w(16).flex_none().text_center().text_color(add ? k.successText : del ? k.destructiveText : k.dim).child(l.t === " " ? "" : l.t))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(highlight(l.text, r.ext, colors).map((t) => div().flex_none().text_color(t.c ?? k.foreground).child(t.s))));
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
    if (this.stale) this.refresh(cx);
    const k = tokens(), colors = syntax();
    const root = v_flex().id("ht3-diff").size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(12);
    const say = (text, color = k.muted) => root.child(v_flex().flex_1().items_center().justify_center().px(24).gap(8).text_size(12).text_color(color).child(text));
    if (!this.seen) return say("No folder: focus a terminal to see its changes.");
    if (this.error && !this.files?.length) return say(this.error);
    if (!this.files) return say("Looking at the changes…");
    const files = this.files;
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const rows = files.length ? this.rows() : [];
    const allShut = files.length > 0 && files.every((f) => this.shut.has(f.path));
    const picked = this.hunkAt();
    return root
      .child(h_flex().h(40).flex_none().px(16).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
        .child(icon("file-diff").size(14).flex_none().text_color(k.muted))
        // T3's scope menu: Changes (the branch against its base) or Uncommitted.
        .child(h_flex().id("diff-scope").h(24).px(6).ml(-6).gap(4).flex_none().items_center().rounded(6).font_medium().text_size(13).cursor_pointer()
          .role("button").accessibility_label(`Showing ${this.scope === "branch" ? "Changes" : this.scope === "turn" ? "This turn" : "Uncommitted"}. Change what is compared`)
          .hover((s) => s.bg(k.accent)).on_click((_e, cx) => { this.pick = !this.pick; cx.notify(); })
          .child(this.scope === "branch" ? "Changes" : this.scope === "turn" ? "This turn" : "Uncommitted")
          .child(icon(this.pick ? "chevron-up" : "chevron-down").size(12).flex_none().text_color(k.muted)))
        .when(this.scope === "turn" && !!this.turn?.label, (el) => el.child(div().flex_none().max_w(160).truncate().text_size(12).text_color(k.muted).tooltip("What the agent changed while it answered this message").child(`“${this.turn.label}”`)))
        .when(this.scope === "branch" && !!this.base, (el) => el.child(div().flex_none().max_w(140).truncate().text_size(12).font_family(k.mono).text_color(k.muted).tooltip(`Compared with the merge base with ${this.base}`).child(this.base)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted)
          .child(files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "No changes"))
        .when(files.length > 0, (el) => el.child(h_flex().flex_none().gap(6).mr(4).font_family(k.mono).text_size(11)
          .child(div().text_color(k.successText).child(`+${add}`)).child(div().text_color(k.destructiveText).child(`−${del}`))))
        .child(iconButton(k, "diff-collapse", allShut ? "chevrons-up-down" : "chevrons-down-up", (cx) => {
          if (allShut) this.shut.clear(); else for (const f of files) this.shut.add(f.path);
          cx.notify();
        }, { size: "sm", tip: allShut ? "Expand all files" : "Collapse all files" }))
        .child(iconButton(k, "diff-refresh", "refresh-cw", (cx) => this.refresh(cx), { size: "sm", tip: this.loading ? "Refreshing…" : "Refresh" })))
      .when(this.pick, (el) => el.child(v_flex().mx(10).my(4).p(4).w(200).flex_none().rounded(8).border(1).border_color(k.border).bg(k.popover).shadow_lg()
        .children([["branch", "Changes", "The branch against its base"], ["unstaged", "Uncommitted", "The working tree against HEAD"], ...(this.turn ? [["turn", "This turn", "What the agent changed in one turn of a chat"]] : [])].map(([id, label, about]) =>
          h_flex().id(`diff-scope-${id}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
            .role("button").accessibility_label(`${label}: ${about}`).tooltip(about).hover((s) => s.bg(k.accent))
            .on_click((_e, cx) => this.setScope(cx, id))
            .child(div().flex_1().child(label))
            .when(this.scope === id, (e) => e.child(icon("check").size(14).flex_none().text_color(k.muted)))))))
      .when(!!this.error, (el) => el.child(div().px(12).py(4).text_size(11).text_color(k.destructiveText).child(this.error)))
      .when(!files.length, (el) => el.child(v_flex().flex_1().items_center().justify_center().text_color(k.muted).child(this.scope === "branch" ? `Nothing changed against ${this.base ?? "the base"}.` : this.scope === "turn" ? "That turn changed no files." : "The working tree matches HEAD.")))
      .when(files.length > 0, (el) => el.child(v_flex().relative().flex_1().min_h(0)
        .child(list("ht3-diff-rows", rows.length, (i) => rows[i].id, (i) => {
          const r = rows[i];
          if (r.kind === "file") return this.fileHeader(k, r);
          if (r.kind === "line") return this.lineRow(k, r, colors);
          // A hunk's header: a click picks the hunk to comment on for the agent.
          if (r.kind === "hunk") return h_flex().h(22).w_full().px(12).gap(8).items_center().overflow_hidden().bg(alpha(k.info, r.id === this.picked ? 0.28 : k.dark ? 0.1 : 0.06)).font_family(k.mono).text_size(11).text_color(r.id === this.picked ? k.foreground : k.muted)
            .cursor_pointer().hover((s) => s.bg(alpha(k.info, 0.2)))
            .child(div().flex_none().child(r.h.head.match(/^@@[^@]*@@/)?.[0] ?? "@@"))
            .child(div().flex_1().min_w(0).truncate().child(r.h.ctx))
            .child(h_flex().flex_none().gap(4).items_center().child(icon("message-square").size(12).flex_none()).child(r.id === this.picked ? "Commenting" : "Comment"));
          return div().h(24).px(12).flex().items_center().text_size(11).text_color(k.muted).child(r.text);
        })
          .on_item_click((id, cx) => {
            if (id.startsWith("h:")) return this.pickHunk(cx, id);
            if (id.startsWith("l:")) return this.pickLine(cx, id);
            if (!id.startsWith("f:")) return;
            const p = id.slice(2);
            if (this.shut.has(p)) this.shut.delete(p); else this.shut.add(p);
            cx.notify();
          }))
        .child(Scrollbar.vertical("ht3-diff-rows").absolute().inset_0())))
      // The comment on the picked hunk, under the list; Enter or the button puts both into the shown chat's message box.
      .when(!!picked, (el) => el.child(v_flex().flex_none().px(12).py(10).gap(8).border_t(1).border_color(k.border).bg(k.card)
        .on_key_down((e, cx) => { if (e.key === "escape") this.pickHunk(cx, null); })
        .child(h_flex().gap(6).items_center().text_size(12).text_color(k.muted)
          .child(icon("message-square").size(14).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(`${picked.path} · ${picked.from === picked.to ? `line ${picked.from}` : `lines ${picked.from}-${picked.to}`} · ${picked.lines.length} line${picked.lines.length === 1 ? "" : "s"} of diff`)))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).h(30).px(8).rounded(8).border(1).border_color(k.input).bg(k.background).text_size(13).child(Input.new(this.note)))
          .child(button(k, "hunk-cancel", "Cancel", (cx) => this.pickHunk(cx, null), { variant: "outline", size: "sm" }))
          .child(button(k, "hunk-add", "Add to chat", (cx) => this.quote(cx), { variant: "default", size: "sm" })))))
      .when(!!this.said, (el) => el.child(div().flex_none().px(12).py(6).border_t(1).border_color(k.border).text_size(12).text_color(k.muted).child(this.said)));
  }
}
