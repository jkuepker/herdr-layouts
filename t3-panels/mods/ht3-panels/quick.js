// Quick open (T3 Code's command-palette file picker, `mod+p` there): type a few letters of a file's name or path and
// open it in Files; go to a line.
// A dialog (`ht3-panels.quick-open`, an overlay with props.menu "quick"), modelled on the project search (search.js). The
// files are the project's: `git ls-files -co --exclude-standard` from the repository's top folder (tracked and new files,
// not the ignored ones), or, outside Git, a bounded walk of the folder (.git, node_modules and the like left out); at most
// CAP of them, on the space's machine (`on:`). They are matched with fuzzy.js.
//  - An empty box shows the files opened in Files most recently in this project (editor.js records each open, below), the
//    newest first, up to 20.
//  - `name:42` or `name:42:7` opens the file with line 42 picked (Files' Lines view: the editor has no cursor to move, and
//    no column); `:42` alone picks line 42 in the file that is open.
//  - `@` starts go-to-symbol: the open file's functions, classes, headings and the like (outline-parse.js, the Outline step's list),
//    fuzzy-filtered by the text after the `@`; Enter or a click picks that line in Files' Lines view (as `:42` does). The
//    file is Files', so the dialog asks the shown Files copy for its symbols (`ht3-panels.outline-share`, answered in shared
//    state: outline.js). `ht3-panels.quick-open:@` opens it in this mode.
//  - Enter opens the marked file, a click does too, Up and Down move, Esc closes. (There is no "to the side": a command
//    reaches every shown Files copy, so it can't name the second group's.)
// For scripts, while the dialog is open: `ht3-panels.quick-open` again closes it, `ht3-panels.quick-open:<text>` opens it
// with that typed, `ht3-panels.quick-q:<text>` types, `ht3-panels.quick-key:<up|down|enter|escape>` presses a key.
// Recent files: shared("ht3-panels.recent") = { "<machine>|<top folder>": [path relative to it, newest first] }, the key
// editor.js's contexts have too (`ctx.key`); the 30 projects used last are kept.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, closeOverlay, run, shared, setShared } from "herdr";
import { MOD, tokens, alpha, icon, iconButton, kbd, shortPath } from "./look.js";
import { fileIcon } from "./fileicons.js";
import { activeSpace, placeOf, spaceState, openSurface, GROUPS } from "./side.js";
import { rank, parseQuery, pieces, split, recordIn } from "./fuzzy.js";
import { rankSymbols } from "./outline-parse.js";
import { sharedOutline, kindBadge } from "./outline.js";

export const QUICK_SIZE = { width: 640, height: 500 };
export const CAP = 50000; // files listed at most
const SHOWN = 100; // rows drawn at most
const ROW = 28;

// $1: how many files at most. The first line says what listed them and from where: "#git\t<top folder>" or "#walk\t<folder>".
export const SCRIPT = `
cap=$1
if top=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ]; then
  cd "$top" || exit 3
  printf '#git\\t%s\\n' "$top"
  git -c core.quotepath=false ls-files -co --exclude-standard | head -n "$cap"
else
  printf '#walk\\t%s\\n' "$(pwd)"
  find . \\( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name .venv -o -name __pycache__ -o -name .DS_Store \\) -prune -o -type f -print | head -n "$cap" | sed 's|^\\./||'
fi
`;

// The listing's answer -> { root, tool, files, cut }.
export function parseList(stdout, cap = CAP) {
  const lines = String(stdout ?? "").split("\n");
  const head = /^#(git|walk)\t(.*)$/.exec(lines[0] ?? "");
  const seen = new Set(), files = [];
  for (const ln of lines.slice(head ? 1 : 0)) if (ln && !seen.has(ln)) { seen.add(ln); files.push(ln); }
  return { tool: head?.[1] ?? null, root: head?.[2] ?? null, files: files.slice(0, cap), cut: files.length > cap };
}

// ---- recent files ----

export const RECENT = `${MOD}.recent`;
export const recentOf = (key) => { const l = (shared(RECENT) ?? {})[key]; return Array.isArray(l) ? l : []; };
// editor.js calls this for every file it opens: `key` is the context's "<machine>|<root>", `path` relative to the root.
export function recordRecent(key, path) {
  if (!key || !path) return;
  try { setShared(RECENT, recordIn(shared(RECENT), key, path)); } catch { /* a note, not the open */ }
}

// ---- opening ----

// The keeper's (main.js `quick-line:<n>`): Files shows (the group that has it), then picks the line of its open file.
export function showLine(line, cx) {
  const st = spaceState(activeSpace()?.id);
  const group = GROUPS.find((g) => st[g].tabs.some((t) => t.kind === "files")) ?? "a";
  openSurface(group, "files");
  if (line > 0) for (const ms of [400, 1200]) cx.timer.after(ms, () => run(`${MOD}.line:${line}-${line}`));
}

// Whether the dialog is open: it says so every second while it is.
const OPEN = `${MOD}.quick-open-open`;
export const quickOpen = () => Date.now() - (shared(OPEN) ?? 0) < 2500;

// The lists already read, by "<machine>|<folder>": shown at once on the next open while the new one is read.
const cache = new Map();

export class QuickOpen {
  init(p, cx) {
    this.overlay = p.overlay;
    setShared(OPEN, Date.now());
    cx.timer.every(1000, () => setShared(OPEN, Date.now()));
    this.where = placeOf(activeSpace()); // { on, cwd }: fixed while the dialog is open
    this.ckey = `${this.where?.on ?? ""}|${this.where?.cwd ?? ""}`;
    const known = cache.get(this.ckey);
    this.list = known ?? null; // { root, tool, files, cut }
    this.loading = false;
    this.error = null;
    this.rows = []; // [{ path, at }]
    this.at = 0;
    this.range = null;
    this.sym = null; // symbol mode (a query that starts with @): { since, got, late }
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search files by name or path…  (name:42 goes to a line, :42 to a line of the open file, @ to a symbol in it)" });
    this.input.on("change", (_e, cx) => this.typed(cx));
    cx.timer.after(0, () => this.input.focus());
    if (p.query) this.input.set_value(String(p.query));
    this.typed(cx);
    this.load(cx);
  }
  close() { setShared(OPEN, 0); }
  shut() { setShared(OPEN, 0); closeOverlay(this.overlay); }

  command(c, cx) {
    if (c === "quick-open") return this.shut(); // the key again closes it
    if (c.startsWith("quick-q:")) { this.input.set_value(c.slice(8)); this.typed(cx); }
    else if (c.startsWith("quick-key:")) this.key(c.slice(10), cx);
    cx.notify();
  }

  query() { return this.input.value(); }

  // The files of the project, read once per open (the old list shows meanwhile).
  load(cx) {
    if (!this.where?.cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", SCRIPT, "quick", String(CAP + 1)], { cwd: this.where.cwd, on: this.where.on ?? null, timeout: 30000 });
        const list = parseList(r.stdout);
        if (!list.tool) throw new Error(String(r.stderr ?? "").trim().split("\n")[0] || "The files weren't listed.");
        this.list = list;
        cache.set(this.ckey, list);
        this.error = null;
      } catch (e) { this.error = String(e?.message ?? e).split("\n")[0]; if (!this.list) this.list = { root: null, tool: null, files: [], cut: false }; }
      this.loading = false;
      this.typed(cx);
      cx.notify();
    });
  }

  // The project the recent files are kept under: editor.js's context key.
  projectKey() { return this.list?.root ? `${this.where?.on ?? ""}|${this.list.root}` : null; }

  // What the box says now, as rows.
  typed(cx) {
    const text = this.query().trimStart();
    if (text.startsWith("@")) return this.typedSymbols(cx, text.slice(1));
    this.sym = null;
    const q = parseQuery(this.query()), files = this.list?.files ?? [];
    this.line = q.line;
    this.term = q.term;
    if (!q.term) {
      // Empty (or ":42"): the recent files, the ones the project still has.
      const key = this.projectKey();
      const have = this.list?.files?.length ? new Set(files) : null;
      this.rows = q.line ? [] : (key ? recentOf(key) : []).filter((p) => !have || have.has(p)).slice(0, 20).map((path) => ({ path, at: [] }));
    } else this.rows = rank(q.term, files, { limit: SHOWN });
    this.at = 0;
    this.range = null;
    if (this.rows.length) this.scroll.scroll_to_item(0, "top");
    cx.notify();
  }

  // `@<text>`: the open file's symbols that <text> matches. The first time, Files is asked for them and answers within a moment.
  typedSymbols(cx, term) {
    if (!this.sym) {
      this.sym = { since: Date.now(), got: null, late: false };
      run(`${MOD}.outline-share`);
      for (const ms of [120, 400, 1000, 2200]) cx.timer.after(ms, (cx) => {
        const s = this.sym;
        if (!s || s.got) return;
        s.got = sharedOutline(s.since);
        s.late = !s.got && ms >= 2200;
        if (s.got || s.late) { this.typed(cx); cx.notify(); }
      });
    }
    this.line = null;
    this.term = `@${term}`;
    const s = this.sym;
    this.rows = s.got ? rankSymbols(term, s.got.symbols, { limit: 500 }).map((h) => ({ path: h.sym.name, at: h.at, sym: h.sym })) : [];
    this.at = 0;
    this.range = null;
    if (this.rows.length) this.scroll.scroll_to_item(0, "top");
    cx.notify();
  }

  key(key, cx) {
    const n = this.rows.length;
    if (key === "escape") return this.shut();
    if (key === "enter") return this.line && !this.term ? this.pick(null) : this.pick(this.rows[this.at]);
    if ((key !== "down" && key !== "up") || !n) return;
    this.at = (this.at + (key === "down" ? 1 : -1) + n) % n;
    const r = this.range;
    if (!r || this.at - 1 < r.start || this.at + 1 >= r.end) this.scroll.scroll_to_item(this.at, !r || this.at < r.start ? "top" : "center");
    cx.notify();
  }

  // The keeper does the opening (main.js `goto`, `quick-line`): what this copy started would end with the dialog.
  pick(row) {
    if (row?.sym) { run(`${MOD}.quick-line:${row.sym.line}`); this.shut(); return; }
    if (this.sym) return;
    if (!row) {
      if (this.line && !this.term) { run(`${MOD}.quick-line:${this.line}`); this.shut(); }
      return;
    }
    if (!this.list?.root) return;
    run(`${MOD}.goto:${this.line ?? 0}:${this.list.root}/${row.path}`);
    this.shut();
  }

  // What the body says when there is no list.
  words() {
    if (!this.where?.cwd && !this.sym) return { glyph: "folder", text: "This space has no folder, so there are no files to open. Open a terminal or a chat in a project first." };
    if (this.sym) {
      const s = this.sym;
      if (this.rows.length) return null;
      if (!s.got) return s.late ? { glyph: "list-tree", text: "Files isn't showing a file. Open one in Files, then type @ again." } : { glyph: "list-tree", text: "Reading the open file's symbols…" };
      if (!s.got.path) return { glyph: "list-tree", text: "No file is open in Files." };
      if (!s.got.symbols.length) return { glyph: "list-tree", text: `No symbols found in ${s.got.path}.` };
      return { glyph: "search", text: `No symbol in ${s.got.path} matches "${this.term.slice(1)}".` };
    }
    if (this.rows.length) return null;
    if (this.error && !this.list?.files.length) return { glyph: "circle-alert", text: this.error, bad: true };
    if (!this.list || (this.loading && !this.list.files.length)) return { glyph: "search", text: "Reading the project's files…" };
    if (this.line && !this.term) return { glyph: "list-plus", text: `Enter picks line ${this.line} in the open file.` };
    if (!this.term) return { glyph: "search", text: "Nothing opened here yet. Type a few letters of a file's name or path." };
    return { glyph: "search", text: `No file in this project matches "${this.term}".` };
  }

  render(_cx) {
    const k = tokens(), w = this.where, rows = this.rows, said = this.words();
    const dir = this.list?.root ?? w?.cwd;
    const symRow = (i) => {
      const r = rows[i], on = i === this.at;
      return h_flex().h(ROW).mx(4).pl(8).pr(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(13)
        .bg(on ? k.accent : "#00000000").hover((s) => s.bg(on ? k.accent : alpha(k.foreground, 0.05)))
        .child(kindBadge(k, r.sym.kind))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_color(on ? k.foreground : alpha(k.foreground, 0.85))
          .children(pieces(r.path, r.at, 0).map((p) => (p.on ? div().flex_none().font_bold().text_color(k.foreground).child(p.text) : div().flex_none().child(p.text)))))
        .child(div().flex_none().text_size(12).text_color(k.muted).child(`line ${r.sym.line}`));
    };
    const row = (i) => {
      if (rows[i].sym) return symRow(i);
      const r = rows[i], on = i === this.at, { dir: d, name } = split(r.path);
      const piece = (p, muted) => (p.on
        ? div().flex_none().font_bold().text_color(k.foreground).child(p.text)
        : div().flex_none().text_color(muted ? alpha(k.muted, 0.9) : on ? k.foreground : alpha(k.foreground, 0.85)).child(p.text));
      return h_flex().h(ROW).mx(4).pl(8).pr(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(13)
        .bg(on ? k.accent : "#00000000").hover((s) => s.bg(on ? k.accent : alpha(k.foreground, 0.05)))
        .child(fileIcon(name, k.dark, 14))
        .child(h_flex().flex_none().max_w(300).overflow_hidden().whitespace_nowrap().children(pieces(name, r.at, d.length).map((p) => piece(p, false))))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(12).children(pieces(d, r.at, 0).map((p) => piece(p, true))))
        .when(on && this.line, (el) => el.child(div().flex_none().text_size(12).text_color(k.muted).child(`line ${this.line}`)));
    };
    const foot = this.list?.cut ? `Only the first ${CAP.toLocaleString("en-US")} files are searched.` : this.list?.tool === "git" ? "Tracked and new files, not the ignored ones." : this.list?.tool === "walk" ? "Not a Git folder: every file but .git and node_modules." : "";
    const empty = !this.term && !this.line, sg = this.sym?.got;

    return v_flex().id("ht3-quick").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .on_key_down((e, cx) => {
        if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
        const key = String(e.key ?? "").toLowerCase();
        if (["up", "down", "enter", "escape"].includes(key)) { this.key(key, cx); cx.stop_propagation?.(); }
      })
      .child(h_flex().h(48).pl(14).pr(8).gap(6).flex_none().items_center().border_b(1).border_color(k.border)
        .child(icon(this.sym ? "list-tree" : "file").size(16).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.input)))
        .child(iconButton(k, "quick-close", "x", () => this.shut(), { tip: "Close (Esc)" })))
      .child(h_flex().h(28).px(14).gap(8).flex_none().items_center().text_size(12).text_color(k.muted)
        .child(div().flex_1().min_w(0).truncate().child(this.sym ? (sg?.path ? `Symbols in ${sg.path}` : "Symbols in the open file") : dir ? `${w?.on ? `${w.on}: ` : ""}${shortPath(dir) || dir}` : "No folder"))
        .child(div().flex_none().child(this.sym ? (rows.length ? `${rows.length} of ${sg?.symbols.length ?? 0} symbols` : "") : empty ? (rows.length ? "Recent files" : "") : rows.length ? `${rows.length}${rows.length >= SHOWN ? "+" : ""} of ${(this.list?.files.length ?? 0).toLocaleString("en-US")} files` : "")))
      .when(!!said, (el) => el.child(v_flex().flex_1().min_h(0).px(48).gap(10).items_center().justify_center()
        .child(icon(said.glyph).size(22).text_color(said.bad ? k.destructiveText : alpha(k.muted, 0.7)))
        .child(div().text_size(13).line_height("18px").text_color(said.bad ? k.destructiveText : k.muted).child(said.text))))
      .when(!said, (el) => el.child(v_flex().relative().flex_1().min_h(0)
        .child(v_virtual_list("ht3-quick-list", rows.length, ROW, (i) => `r:${i}:${rows[i].path}`,
          (range) => { this.range = { start: range.start, end: range.end }; return Array.from({ length: range.end - range.start }, (_, n) => row(range.start + n)); })
          .track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => { const i = Number(key.split(":")[1]); this.at = i; this.pick(rows[i]); cx.notify(); }))
        .child(Scrollbar.vertical("ht3-quick-list").absolute().inset_0())))
      .child(h_flex().h(36).px(14).gap(6).flex_none().items_center().border_t(1).border_color(k.border).text_size(12).text_color(k.muted)
        .child(div().flex_1().min_w(0).truncate().child(this.sym ? "" : foot))
        .child(kbd(k, "↑")).child(kbd(k, "↓")).child(div().flex_none().mr(6).child("move"))
        .child(kbd(k, "↵")).child(div().flex_none().mr(6).child(this.sym ? "go to symbol" : this.line && !this.term ? "go to line" : "open"))
        .child(kbd(k, "esc")).child(div().flex_none().child("close")));
  }
}
