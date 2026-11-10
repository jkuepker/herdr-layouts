// T3 Code's Diff surface (DiffPanel.tsx) in gpui-kit: the working tree against HEAD, one section
// per file with its status, its +/- counts and its hunks, the lines tinted green and red and
// colored with T3 Code's code colors. Files are collapsible; new (untracked) files show as added.
//
// Runs git in the repository of the shown space's folder: `git diff HEAD`, and for untracked
// files `git diff --no-index /dev/null <file>`. Reads only. The listing follows the folder
// (watchFolder) and a 15 s timer.

import { div, list } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { exec, watchFolder, shared } from "herdr";
import { tokens, alpha, icon, iconButton } from "./look.js";
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
    this.follow(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }
  close() {}
  // `ht3-panels.scope:branch|unstaged`: what the Diff compares, as its header's menu, for scripts and the popover.
  command(c, cx) {
    if (c === "scope:branch" || c === "scope:unstaged" || (c === "scope:turn" && this.turn)) this.setScope(cx, c.slice(6));
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
        }
      } catch (e) { if (turn || this.root === root) { this.error = String(e?.message ?? e); if (turn) this.files = []; } }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // The rows of the list: a header per file, then its hunks' lines.
  rows() {
    const rows = [];
    for (const f of this.files) {
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
    return h_flex().h(20).w_full().items_center().overflow_hidden().bg(tint).font_family(k.mono).text_size(12)
      .child(h_flex().flex_none().h_full().bg(gutter).child(num(l.o)).child(num(l.n)))
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
      .when(this.error, (el) => el.child(div().px(12).py(4).text_size(11).text_color(k.destructiveText).child(this.error)))
      .when(!files.length, (el) => el.child(v_flex().flex_1().items_center().justify_center().text_color(k.muted).child(this.scope === "branch" ? `Nothing changed against ${this.base ?? "the base"}.` : this.scope === "turn" ? "That turn changed no files." : "The working tree matches HEAD.")))
      .when(files.length > 0, (el) => el.child(v_flex().relative().flex_1().min_h(0)
        .child(list("ht3-diff-rows", rows.length, (i) => rows[i].id, (i) => {
          const r = rows[i];
          if (r.kind === "file") return this.fileHeader(k, r);
          if (r.kind === "line") return this.lineRow(k, r, colors);
          if (r.kind === "hunk") return h_flex().h(22).w_full().px(12).gap(8).items_center().overflow_hidden().bg(alpha(k.info, k.dark ? 0.1 : 0.06)).font_family(k.mono).text_size(11).text_color(k.muted)
            .child(div().flex_none().child(r.h.head.match(/^@@[^@]*@@/)?.[0] ?? "@@"))
            .child(div().min_w(0).truncate().child(r.h.ctx));
          return div().h(24).px(12).flex().items_center().text_size(11).text_color(k.muted).child(r.text);
        })
          .on_item_click((id, cx) => {
            if (!id.startsWith("f:")) return;
            const p = id.slice(2);
            if (this.shut.has(p)) this.shut.delete(p); else this.shut.add(p);
            cx.notify();
          }))
        .child(Scrollbar.vertical("ht3-diff-rows").absolute().inset_0())));
  }
}
