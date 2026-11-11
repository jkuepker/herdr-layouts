// The file panel: T3 Code's Files surface (apps/web/src/components/files and
// RightPanelTabs.tsx) in gpui-kit. One row: a button that shows or hides the file explorer,
// then a tab per open file (a dot on an unsaved one). The explorer sits on the left of the
// open file; with no file open it fills the panel. The side panel's own Files tab already
// names this surface, so the row has no Files tab of its own.
//
// The listing, the git marks and the folder watch are the shipped `files` mod's (Herdr,
// Apache-2.0), as Shepherdr's and xo-files' panels use them. New here: tabs, editing and
// saving. Files are written with writeTextFile, which works on this computer only, so a
// space on another machine opens its files read-only.

import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, pickFolder, shared, setShared } from "herdr";
import { tokens, alpha, icon, button, iconButton, shortPath } from "./look.js";
import { fileIcon } from "./fileicons.js";
import { chatPlace, showing, rememberClosed } from "./side.js";
import { recordRecent } from "./quick.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", yml: "yaml", htm: "html", markdown: "md", zsh: "sh", bash: "sh" };
const PER_FOLDER = 500, TOTAL = 5000;
const MAX_EDIT = 1000000; // readTextFile reads at most 1 MiB
const MAX_TABS = 12, MAX_INDEX = 20000, MAX_MATCHES = 200;
const ROW = 24; // @pierre/trees, compact density
const PAGE = 1500; // lines drawn at once in the Lines view
const LIST = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';

async function directory(path, on) {
  const r = await exec("sh", ["-c", LIST, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Where the shown space works: the focused terminal's folder, else the first one in its tab.
function place() {
  const space = spaces().find((s) => s.active), f = focused();
  const all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const other = all.find((p) => p.tab === f?.tab && p.cwd);
  // On a chat tab, the folder its agent works in.
  const chat = chatPlace();
  if (chat) return { space: space?.id ?? null, on: chat.on, cwd: chat.cwd, fallback: null };
  return { space: space?.id ?? null, on: space?.machine ?? null, cwd: pane?.cwd || f?.cwd || null, fallback: other?.cwd || space?.folder || null };
}

// T3 Code's code colors: pierre-dark (@pierre/theme 2.0.0) on dark themes, and on light ones T3 Code's
// own t3-light (pierre-light darkened to 4.5:1 by its readableSyntaxTheme.ts), not the terminal's ANSI palette.
const PIERRE_DARK = { keyword: "#ff678d", string: "#5ecc71", "string.escape": "#61d5c0", comment: "#737373", function: "#9d6afb", type: "#d568ea", number: "#68cdf2", constant: "#ffd452", boolean: "#68cdf2", variable: "#ffa359", operator: "#08c0ef", punctuation: "#636363" };
const T3_LIGHT = { keyword: "#b12251", string: "#106a2b", "string.escape": "#0b685b", comment: "#5c5c5c", function: "#693acf", type: "#912ba7", number: "#0b5267", constant: "#735b02", boolean: "#0b5267", variable: "#8f4e17", operator: "#006781", punctuation: "#4b4b4b" };
export function syntax() {
  const bg = (theme().background || "#000000").slice(1, 7), [r, g, b] = [0, 2, 4].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const s = 0.299 * r + 0.587 * g + 0.114 * b > 128 ? T3_LIGHT : PIERRE_DARK;
  // gpui-component's finer captures, coloured as T3 Code colours them: Python docstrings are strings.
  return { ...s, "comment.doc": s.string, property: s.variable, "variable.special": s.constant, attribute: s.function, constructor: s.type, "string.special": s["string.escape"], "string.regex": s["string.escape"], "punctuation.bracket": s.punctuation, "punctuation.delimiter": s.punctuation, tag: s.keyword, title: s.function };
}

export class FilePanel {
  init(p, cx) {
    this.group = p?.group ?? "a";
    this.stale = false;
    this.ctxs = new Map(); // "<machine>|<root>" -> what is open there
    this.ctx = null;
    this.roots = new Map(); // "<machine>|<cwd>" -> its repo's top folder
    this.seen = null;
    this.wrap = false;
    this.search = InputState.new({ placeholder: "Search files" });
    this.search.on("change", (_e, cx) => { this.index(cx); cx.notify(); });
    // The Lines view's box under a picked line: text to insert after it, or a note for the agent (linesView).
    this.lineBox = TextareaState.new({ placeholder: "Text to insert after this line, or a note for the agent" });
    this.lineBox.set_auto_grow(1, 8);
    this.follow(cx);
    // Lists the folder and asks git only while the tab shows; back in view, at once (render).
    cx.timer.every(10000, (cx) => { if (showing(this.group, "files")) this.refresh(cx); else this.stale = true; });
  }

  close() {}

  // "save" (Cmd+S from keys.json), "tree" (shows or hides the explorer beside an open file), and "open:<path>" so a key, a script or another mod can
  // show a file: a path in the shown folder, or an absolute one anywhere (outside the shown folder,
  // Files moves to that file's repository, else its folder, as if picked with Open folder…).
  // For the Lines view (linesView): "lines" shows or hides it, "line:<n>" or "line:<a>-<b>" picks lines ("line:" lets go),
  // "line-text:<text>" fills the box (\n is a line break), "line-insert" and "line-chat" are its two buttons.
  command(c, cx) {
    const t = this.tab();
    if (c === "save") this.save(cx, t);
    else if (c === "tree") { if (this.ctx) this.ctx.tree = !this.ctx.tree; }
    else if (c === "lines") { if (t?.state) { t.lines = !t.lines; this.pickLine(cx, t, null); } }
    else if (c.startsWith("line:")) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(c.slice(5));
      if (t?.state) { t.lines = true; this.pickLine(cx, t, m ? Number(m[1]) : null, m?.[2] ? Number(m[2]) : null); }
    }
    else if (c.startsWith("line-text:")) this.lineBox.set_value(c.slice(10).replace(/\\n/g, "\n"));
    else if (c === "line-insert") this.insertLines(cx, t);
    else if (c === "line-chat") this.quoteLines(cx, t);
    else if (c === "close-file") { if (this.ctx?.active >= 0) this.shut(cx, this.ctx.active); } // as its ×
    else if (c.startsWith("open:") && this.ctx) {
      const path = c.slice(5), root = this.ctx.root + "/";
      if (!path.startsWith("/")) this.open(cx, path);
      else if (path.startsWith(root)) this.open(cx, path.slice(root.length));
      else if (!this.ctx.on) cx.spawn(async (cx) => {
        const dir = path.replace(/\/[^/]*$/, "") || "/";
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).catch(() => null);
        // (Git names the repository by its real path: through a symlink it isn't the start of `path`, so the folder is taken.)
        const base = top?.code === 0 && top.stdout.trim() && path.startsWith(top.stdout.trim() + "/") ? top.stdout.trim() : dir;
        this.pin(cx, base);
        this.open(cx, path.slice(base.length + 1));
        cx.notify();
      });
    }
    cx.notify();
  }

  // ---- which folder ----

  // Keeps to the folder it shows until a terminal somewhere else is focused, or the space
  // changes: focusing this panel or a chat pane must not swap the tree under an open file.
  // A folder picked here (Open folder, Up) holds per space until "Follow terminal"; it is kept in
  // shared state "ht3-files.pinned" so a reload keeps it.
  pinned(space) { return (shared("ht3-files.pinned") ?? {})[space ?? ""] ?? null; }
  pin(cx, root) {
    const p = place(), all = { ...(shared("ht3-files.pinned") ?? {}) };
    if (root) all[p.space ?? ""] = { root, on: p.on }; else delete all[p.space ?? ""];
    setShared("ht3-files.pinned", all);
    this.seen = null;
    if (root) { this.seen = `pin|${p.on ?? ""}|${root}`; this.enter(cx, root, p); } else { this.ctx = null; this.follow(cx); }
    cx.notify();
  }
  async pickRoot(cx) {
    const dir = await pickFolder({ prompt: "Folder to show in Files" });
    if (dir) this.pin(cx, dir.replace(/\/+$/, "") || "/");
  }

  follow(cx) {
    const p = place();
    const held = this.pinned(p.space);
    if (held) {
      const seen = `pin|${held.on ?? ""}|${held.root}`;
      if (seen !== this.seen) { this.seen = seen; this.enter(cx, held.root, { ...p, on: held.on }); }
      return;
    }
    const cwd = p.cwd ?? (this.ctx && this.ctx.space === p.space ? null : p.fallback);
    if (!cwd) return;
    const seen = `${p.on ?? ""}|${cwd}`;
    if (seen === this.seen) return;
    this.seen = seen;
    const known = this.roots.get(seen);
    if (known) return this.enter(cx, known, p);
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: p.on }).catch(() => null);
      const root = top?.code === 0 && top.stdout.trim() ? top.stdout.trim() : cwd;
      this.roots.set(seen, root);
      if (this.seen === seen) this.enter(cx, root, p);
      cx.notify();
    });
  }

  enter(cx, root, p) {
    const key = `${p.on ?? ""}|${root}`;
    if (this.ctx?.key === key) return;
    let c = this.ctxs.get(key);
    if (!c) {
      c = { key, root, on: p.on, space: p.space, entries: new Map(), folders: new Set(), pending: new Set(), marks: {}, ignored: new Set(), tabs: [], active: -1,
        tree: true, loading: false, limited: false, error: null, watched: false, files: null, indexing: false };
      this.ctxs.set(key, c);
    }
    c.space = p.space;
    this.ctx = c;
    this.search.set_value("");
    this.refresh(cx);
  }

  // ---- the tree (the shipped files mod's) ----

  watch(c, cx) {
    if (c.on || c.watched) return;
    c.watched = true;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(c.root);
          if (this.ctx === c) { this.refresh(cx); this.reread(cx, c); this.index(cx, true); } else c.files = null;
        }
      } catch { c.watched = false; }
    });
  }

  async loadFolder(c, path) {
    const entries = await directory(path ? `${c.root}/${path}` : c.root, c.on);
    if (path && !c.folders.has(path)) return;
    const used = [...c.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    c.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) c.limited = true;
  }

  refresh(cx) {
    const c = this.ctx;
    if (!c || c.loading) return;
    c.loading = true;
    c.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...c.folders]) await this.loadFolder(c, path);
        const marks = {};
        // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
        const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: c.root, on: c.on }).catch(() => null);
        if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
          const xy = entry.slice(0, 2);
          marks[entry.slice(3)] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
        }
        c.marks = marks;
        // Git-ignored files and folders (a folder is listed once, not its contents): drawn dimmed.
        const ign = await exec("git", ["--no-optional-locks", "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { cwd: c.root, on: c.on }).catch(() => null);
        c.ignored = new Set(ign?.code === 0 ? ign.stdout.split("\0").filter(Boolean).slice(0, TOTAL).map((x) => x.replace(/\/$/, "")) : []);
        c.error = null;
        this.watch(c, cx);
      } catch (e) { c.error = String(e?.message ?? e); }
      finally { c.loading = false; cx.notify(); }
    });
  }

  toggle(cx, path) {
    const c = this.ctx;
    if (c.folders.has(path)) {
      for (const folder of [...c.folders]) if (folder === path || folder.startsWith(path + "/")) { c.folders.delete(folder); c.entries.delete(folder); }
    } else {
      c.folders.add(path);
      if (!c.entries.has(path) && !c.pending.has(path)) {
        c.pending.add(path);
        cx.spawn(async (cx) => {
          try { await this.loadFolder(c, path); }
          catch (e) { c.error = String(e?.message ?? e); }
          finally { c.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Every file of the folder, for the search box: git's list where there is a repo. `again`: the folder
  // changed, so the list is made anew; a search that is open keeps the old one until the new one is in.
  index(cx, again = false) {
    const c = this.ctx;
    if (!c || c.indexing) return;
    if (!this.search.value().trim()) { if (again) c.files = null; return; }
    if (c.files && !again) return;
    c.indexing = true;
    cx.spawn(async (cx) => {
      try {
        let r = await exec("git", ["ls-files", "-co", "--exclude-standard"], { cwd: c.root, on: c.on }).catch(() => null);
        if (r?.code !== 0) r = await exec("sh", ["-c", `find . -type f -not -path './.git/*' | head -n ${MAX_INDEX} | sed 's|^\\./||'`], { cwd: c.root, on: c.on });
        c.files = r.stdout.split("\n").filter(Boolean).slice(0, MAX_INDEX);
      } catch (e) { c.files = []; c.error = String(e?.message ?? e); }
      finally { c.indexing = false; cx.notify(); }
    });
  }

  // ---- files ----

  tab() {
    const c = this.ctx;
    return c && c.active >= 0 ? c.tabs[c.active] : null;
  }

  editorFor(tab, value) {
    tab.state?.release();
    const ext = tab.path.includes(".") ? tab.path.split(".").pop().toLowerCase() : "txt";
    const k = tokens();
    tab.state = EditorState.new({ language: LANG[ext] ?? ext, value, readonly: tab.readonly, soft_wrap: this.wrap,
      font_family: k.mono, font_size: 13, syntax: syntax() });
    tab.wrap = this.wrap;
    tab.state.on("change", (_e, cx) => {
      const dirty = tab.state.value() !== tab.saved;
      if (dirty !== tab.dirty) { tab.dirty = dirty; if (!dirty) tab.conflict = null; cx.notify(); }
    });
  }

  open(cx, path) {
    const c = this.ctx;
    recordRecent(c.key, path); // for Quick open's empty box (quick.js)
    const at = c.tabs.findIndex((x) => x.path === path);
    if (at >= 0) { c.active = at; return cx.notify(); }
    if (c.tabs.length >= MAX_TABS) {
      const spare = c.tabs.findIndex((x) => !x.dirty);
      if (spare < 0) { c.error = `Save or close a file first: ${MAX_TABS} are open.`; return cx.notify(); }
      this.drop(c, spare, false); // making room is not a close the user can undo
    }
    const tab = { path, abs: `${c.root}/${path}`, state: null, saved: "", dirty: false, readonly: c.on != null, note: null, error: null, conflict: null, closing: false, loading: true };
    c.tabs.push(tab);
    c.active = c.tabs.length - 1;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const size = await exec("sh", ["-c", 'wc -c < "$1"', "size", tab.abs], { on: c.on });
        const bytes = Number(size.stdout.trim());
        if (size.code !== 0) throw new Error("This file is no longer available.");
        let text;
        if (bytes > MAX_EDIT) {
          const head = await exec("sh", ["-c", 'head -c 400000 "$1"', "head", tab.abs], { on: c.on });
          text = head.stdout;
          tab.readonly = true;
          tab.note = `Preview limited to the first 400 KB of a ${bytes.toLocaleString("en-US")} byte file. Read-only.`;
        } else {
          text = await readTextFile(tab.abs, { on: c.on });
          if (text === null) throw new Error("This file is no longer available.");
        }
        if (text.includes("\0")) throw new Error("Binary file: no text to show.");
        // Closed while it loaded: an editor made now would never be released.
        if (!c.tabs.includes(tab)) return;
        tab.saved = text;
        this.editorFor(tab, text);
      } catch (e) { tab.error = String(e?.message ?? e); }
      finally { tab.loading = false; cx.notify(); }
    });
  }

  drop(c, at, user = true) {
    if (user && c.tabs[at]?.abs) rememberClosed({ kind: "file", props: { path: c.tabs[at].abs } }); // reopen-closed
    c.tabs[at].state?.release();
    c.tabs.splice(at, 1);
    if (c.active === at) c.active = Math.min(at, c.tabs.length - 1);
    else if (c.active > at) c.active--;
  }

  // The x on a tab: an unsaved file asks first (in its banner).
  shut(cx, at) {
    const c = this.ctx, tab = c.tabs[at];
    if (tab.dirty && !tab.closing) { tab.closing = true; c.active = at; }
    else this.drop(c, at);
    cx.notify();
  }

  // Writes the file if it is still what was read; a file changed on disk meanwhile is a conflict.
  save(cx, tab, force = false) {
    if (!tab || !tab.state || tab.readonly || tab.saving || (!tab.dirty && !force)) return;
    const c = this.ctx;
    tab.saving = true;
    cx.spawn(async (cx) => {
      const text = tab.state.value();
      try {
        let expected = tab.saved;
        if (force) expected = await readTextFile(tab.abs);
        await writeTextFile(tab.abs, text, expected);
        tab.saved = text;
        tab.dirty = tab.state.value() !== text;
        tab.conflict = null;
        if (tab.closing && !tab.dirty) { const at = c.tabs.indexOf(tab); if (at >= 0) this.drop(c, at); }
      } catch (e) {
        tab.conflict = /stale|match|changed/i.test(String(e?.message ?? e)) ? "This file changed on disk since it was opened." : `Couldn't save: ${String(e?.message ?? e)}`;
      } finally { tab.saving = false; cx.notify(); }
    });
  }

  // Throws the edits away and reads the file again.
  reload(cx, c, tab) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(tab.abs, { on: c.on }).catch(() => null);
      if (text != null && c.tabs.includes(tab)) { tab.saved = text; tab.dirty = false; tab.conflict = null; tab.closing = false; tab.state?.set_value(text); }
      cx.notify();
    });
  }

  // The folder changed: an open file without edits follows what is on disk now.
  reread(cx, c) {
    const tab = c.active >= 0 ? c.tabs[c.active] : null;
    if (!tab || !tab.state || tab.dirty || tab.note || tab.saving) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(tab.abs).catch(() => null);
      if (text == null || text === tab.saved || tab.dirty || text.includes("\0") || !c.tabs.includes(tab)) return;
      tab.saved = text;
      tab.state.set_value(text);
      cx.notify();
    });
  }

  // ---- the Lines view: a + beside each line number, to insert lines after it or hand it to the chat ----
  // The editor is Herdr's own element: a mod can't draw in its gutter, and can't ask where it is scrolled or which
  // line the pointer is on. So the + lives in a second view of the same file, its lines drawn here as rows.

  // The file's lines as the editor holds them now (unsaved edits too); a last line break is not a line.
  linesOf(tab) {
    const v = tab.state.value();
    if (tab.lineCache?.v !== v) {
      const lines = v.split("\n");
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();
      tab.lineCache = { v, lines };
    }
    return tab.lineCache.lines;
  }

  // The + of line `from`: opens the box under it. The same + again closes it; with Shift held (`extend`) the picked
  // lines grow to reach it. `to` picks a range at once (the command). null lets go.
  pickLine(cx, tab, from, to = null, extend = false) {
    const n = this.linesOf(tab).length, was = tab.pick;
    tab.said = null;
    if (from == null || from < 1 || from > n) tab.pick = null;
    else if (extend && was) tab.pick = { from: Math.min(was.from, from), to: Math.max(was.to, from) };
    else if (was && to == null && was.from === from && was.to === from) tab.pick = null;
    else tab.pick = { from, to: Math.min(n, Math.max(from, to ?? from)) };
    if (tab.pick) { tab.page = Math.floor((tab.pick.to - 1) / PAGE); this.lineBox.focus(); }
    else this.lineBox.set_value("");
    cx.notify();
  }

  // "Insert line(s)": the box's text goes in after the last picked line, and the file is saved as Save saves it
  // (a file changed on disk meanwhile shows the conflict banner instead). An empty box inserts one empty line.
  insertLines(cx, tab) {
    const p = tab?.pick;
    if (!p || !tab.state || tab.readonly) return;
    const add = this.lineBox.value().replace(/\n$/, "").split("\n"), lines = tab.state.value().split("\n");
    lines.splice(p.to, 0, ...add);
    tab.state.set_value(lines.join("\n"));
    tab.dirty = true;
    tab.pick = null;
    this.lineBox.set_value("");
    tab.said = `Inserted ${add.length} line${add.length === 1 ? "" : "s"} after line ${p.to}.`;
    this.save(cx, tab);
    cx.notify();
  }

  // "Add to chat": the picked lines as a quoted block, then the box's text, onto the end of the message box of the
  // chat in the shown tab (chat.js takes shared "ht3-panels.quote", as it does a Diff hunk).
  quoteLines(cx, tab) {
    const p = tab?.pick;
    if (!p || !tab.state) return;
    const at = focused()?.tab, places = shared("ht3-panels.places") ?? {};
    if (!Object.values(places).some((x) => x.tab === at)) { tab.said = "The shown tab isn't a chat: show the chat this is for, then add it."; return cx.notify(); }
    const MAX = 80, all = this.linesOf(tab).slice(p.from - 1, p.to), shown = all.slice(0, MAX);
    const fence = shown.some((l) => l.includes("```")) ? "````" : "```";
    const ext = tab.path.includes(".") ? tab.path.split(".").pop().toLowerCase() : "";
    const where = p.from === p.to ? `line ${p.from}` : `lines ${p.from}-${p.to}`, note = this.lineBox.value().trim();
    const text = [`In \`${tab.path}\` (${where}):`, `${fence}${ext}`, ...shown, ...(all.length > MAX ? [`… ${all.length - MAX} more lines`] : []), fence, ...(note ? [note] : [])].join("\n");
    setShared("ht3-panels.quote", { tab: at, text, at: Date.now() });
    tab.pick = null;
    this.lineBox.set_value("");
    tab.said = `Added to the chat's message box: ${tab.path}, ${where}.`;
    cx.notify();
  }

  linesView(k, c, tab) {
    const all = this.linesOf(tab), n = all.length, pages = Math.max(1, Math.ceil(n / PAGE));
    const page = Math.min(tab.page ?? 0, pages - 1), start = page * PAGE, end = Math.min(n, start + PAGE);
    const p = tab.pick, blue = k.info;
    const turn = (id, label, to) => h_flex().id(id).h(24).mx(12).my(2).px(8).flex_none().items_center().rounded(6).text_size(12).text_color(k.muted).cursor_pointer()
      .role("button").accessibility_label(label).hover((s) => s.bg(k.accent).text_color(k.foreground)).on_click((_e, cx) => { tab.page = to; cx.notify(); }).child(label);
    const rows = [];
    if (page > 0) rows.push(turn("ln-prev", `Show lines ${start - PAGE + 1} to ${start}`, page - 1));
    for (let i = start; i < end; i++) {
      const no = i + 1, on = !!p && no >= p.from && no <= p.to;
      let text = div().flex_1().min_w(0).pr(12).child((all[i] || " ").replace(/\t/g, "    "));
      if (!this.wrap) text = text.whitespace_nowrap().overflow_hidden();
      rows.push(h_flex().id(`ln-${no}`).w_full().flex_none().items_start().font_family(k.mono).bg(on ? alpha(blue, k.dark ? 0.16 : 0.1) : "#00000000")
        .hover((s) => s.bg(on ? alpha(blue, k.dark ? 0.16 : 0.1) : alpha(k.foreground, 0.05)))
        // GitHub's blue square +: faint on every line, filled under the pointer and on the picked lines.
        .child(h_flex().id(`ln-add-${no}`).size(16).mt(2).ml(6).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
          .role("button").accessibility_label(`Line ${no}: insert after it, or add it to the chat`)
          .bg(on ? blue : "#00000000").text_color(on ? "#ffffff" : alpha(k.muted, 0.45))
          .hover((s) => s.bg(blue).text_color("#ffffff"))
          .on_click((e, cx) => this.pickLine(cx, tab, no, null, !!e?.modifiers?.shift))
          .child(icon("plus").size(12)))
        .child(div().w(44).flex_none().pr(12).text_right().text_color(on ? k.foreground : alpha(k.muted, 0.8)).child(String(no)))
        .child(text));
      if (p && no === p.to) rows.push(this.lineBoxView(k, tab, p, blue));
    }
    if (page < pages - 1) rows.push(turn("ln-next", `Show lines ${end + 1} to ${Math.min(n, end + PAGE)}`, page + 1));
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("ht3-file-lines").flex_1().min_h(0).overflow_y_scrollbar().py(4).text_size(13).line_height("20px").children(rows))
      .when(!!tab.said, (el) => el.child(div().flex_none().px(12).py(6).border_t(1).border_color(k.border).text_size(12).text_color(k.muted).child(tab.said)));
  }

  // The box under the picked line. Esc closes it.
  lineBoxView(k, tab, p, blue) {
    const where = p.from === p.to ? `line ${p.from}` : `lines ${p.from}-${p.to}`;
    return v_flex().id("ln-box").flex_none().my(4).ml(66).mr(12).p(8).gap(8).rounded(8).border(1).border_color(alpha(blue, 0.6)).bg(k.card)
      .on_key_down((e, cx) => { if (e.key === "escape") this.pickLine(cx, tab, null); })
      .child(h_flex().gap(6).items_center().text_size(12).line_height("16px").text_color(k.muted)
        .child(div().flex_1().min_w(0).truncate().child(`${tab.path.split("/").pop()} · ${where}`))
        .child(div().flex_none().text_size(11).child("Shift-click another + for a range")))
      .child(div().min_h(30).px(8).py(4).rounded(8).border(1).border_color(k.input).bg(k.background).text_size(13).line_height("20px").child(Textarea.new(this.lineBox)))
      .child(h_flex().gap(8).items_center().justify_end()
        .child(button(k, "ln-cancel", "Cancel", (cx) => this.pickLine(cx, tab, null), { variant: "outline", size: "sm" }))
        .child(button(k, "ln-chat", "Add to chat", (cx) => this.quoteLines(cx, tab), { variant: tab.readonly ? "default" : "outline", size: "sm", glyph: "message-square", tip: "Put these lines and this note into the shown chat's message box" }))
        .when(!tab.readonly, (el) => el.child(button(k, "ln-insert", p.from === p.to ? "Insert after this line" : `Insert after line ${p.to}`, (cx) => this.insertLines(cx, tab), { variant: "default", size: "sm", glyph: "plus", tip: "Write this text into the file after the line, and save" }))));
  }

  setWrap(cx) {
    this.wrap = !this.wrap;
    const tab = this.tab();
    if (tab?.state) this.editorFor(tab, tab.state.value());
    cx.notify();
  }

  // ---- drawing ----

  render(cx) {
    this.follow(cx);
    if (this.stale) { this.stale = false; this.refresh(cx); }
    const k = tokens();
    const c = this.ctx;
    const root = v_flex().id("ht3-files").size_full().min_h(0).overflow_hidden().bg(k.background).text_color(k.foreground).text_size(12);
    if (!c) return root.child(v_flex().flex_1().items_center().justify_center().text_color(k.muted).child(this.seen ? "Loading files…" : "No folder: focus a terminal to see its files."));
    const tab = this.tab();
    // A tab made before the wrap switch changed takes it on when shown.
    if (tab?.state && tab.wrap !== this.wrap) this.editorFor(tab, tab.state.value());
    return root
      .when(c.tabs.length > 0, (el) => el.child(this.strip(k, c)))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .when(!tab || c.tree, (el) => el.child(this.explorer(k, c, !tab)))
        .when(!!tab, (el) => el.child(this.fileView(k, c, tab))));
  }

  // RightPanelTabs.tsx: 24px tabs, 6 round, the active one filled.
  strip(k, c) {
    const tabEl = (id, on, glyph, title, { dirty = false, close = null, select, tip = null }) => {
      let el = h_flex().id(id).h(24).max_w(144).pl(6).pr(close ? 4 : 8).gap(4).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
        .bg(on ? k.accent : "#00000000").text_color(on ? k.foreground : k.muted)
        .hover((s) => s.bg(on ? k.accent : alpha(k.accent, 0.6)).text_color(k.foreground))
        .role("button").accessibility_label(`${title} tab`)
        .on_click((_e, cx) => select(cx))
        .child(h_flex().relative().size(16).flex_none().items_center().justify_center()
          .child(glyph === "file" ? fileIcon(title, k.dark, 12) : icon(glyph).size(12))
          .when(dirty, (d) => d.child(div().absolute().right(-1).bottom(-1).size(6).rounded_full().bg(k.foreground))))
        .child(div().min_w(0).truncate().child(title));
      if (tip) el = el.tooltip(tip);
      if (close) el = el.child(h_flex().id(`${id}-x`).size(16).flex_none().items_center().justify_center().rounded(4)
        .role("button").accessibility_label(`Close ${title}`)
        .hover((s) => s.bg(k.input)).on_click((_e, cx) => { cx.stop_propagation?.(); close(cx); }).child(icon("x").size(12)));
      return el;
    };
    const where = c.on ? `${c.on}:${c.root}` : shortPath(c.root);
    return h_flex().id("ht3-files-tabs").h(32).flex_none().pl(8).pr(12).gap(4).items_center().overflow_hidden().border_b(1).border_color(alpha(k.border, 0.6))
      .child(iconButton(k, "file-tree", "panel-left", (cx) => { c.tree = !c.tree; cx.notify(); }, { on: c.tree, tip: `${c.tree ? "Hide" : "Show"} file explorer · ${where}` }))
      .child(div().w(1).h(16).mx(2).flex_none().bg(alpha(k.border, 0.8)))
      .children(c.tabs.map((t, i) => tabEl(`tab-${t.path}`, c.active === i, "file", t.path.split("/").pop(), {
        dirty: t.dirty, tip: t.dirty ? `${t.path} · unsaved` : t.path,
        select: (cx) => { if (c.tabs[i] === t) c.active = i; cx.notify(); }, close: (cx) => this.shut(cx, i) })));
  }

  fileView(k, c, tab) {
    // The last folders and the name; a deep path starts with an ellipsis.
    const whole = tab.path.split("/");
    const parts = whole.length > 3 ? ["…", ...whole.slice(-2)] : whole;
    const banner = (text, color, bg, actions = []) => h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6)).bg(bg ?? "#00000000")
      .child(div().flex_1().min_w(0).text_size(11).line_height("16px").text_color(color).child(text)).children(actions);
    const head = h_flex().h(28).flex_none().px(12).gap(4).items_center().text_size(12)
      .child(h_flex().flex_1().min_w(0).items_center().overflow_hidden().tooltip(tab.path).children(parts.flatMap((p, i) => {
        const last = i === parts.length - 1;
        const el = div().flex_shrink(last || p === "…" ? 0 : 1).min_w(0).truncate().text_color(last ? k.foreground : k.muted).when(last, (e) => e.font_medium()).child(p);
        return last ? [el] : [el, icon("chevron-right").size(14).mx(4).flex_none().text_color(alpha(k.muted, 0.6))];
      })))
      .when(tab.dirty, (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child("Unsaved")))
      .when(!tab.readonly && !!tab.state, (el) => el.child(button(k, "file-save", tab.saving ? "Saving…" : "Save", (cx) => this.save(cx, tab),
        { variant: tab.dirty ? "default" : "outline", disabled: !tab.dirty || tab.saving, glyph: "save", tip: "Save file (Cmd+S)" })))
      .when(!!tab.state, (el) => el.child(iconButton(k, "file-lines", "list-plus", (cx) => { tab.lines = !tab.lines; this.pickLine(cx, tab, null); }, { on: !!tab.lines, tip: tab.lines ? "Back to the editor" : "Lines: a + beside each line, to insert after it or add it to the chat" })))
      .child(iconButton(k, "file-wrap", "text-wrap", (cx) => this.setWrap(cx), { on: this.wrap, tip: this.wrap ? "Disable word wrap" : "Enable word wrap" }));
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(head)
      .when(c.on != null, (el) => el.child(banner(`Read-only: this space is on ${c.on}, and Herdr can only write files on this computer.`, k.muted)))
      .when(!!tab.note, (el) => el.child(banner(tab.note, k.warningText, alpha(k.warning, k.dark ? 0.16 : 0.08))))
      .when(!!tab.conflict, (el) => el.child(banner(tab.conflict, k.destructiveText, alpha(k.destructive, k.dark ? 0.16 : 0.08), [
        button(k, "file-reload", "Reload", (cx) => this.reload(cx, c, tab)),
        button(k, "file-overwrite", "Overwrite", (cx) => this.save(cx, tab, true), { variant: "destructive" })])))
      .when(tab.closing && tab.dirty && !tab.conflict, (el) => el.child(banner("This file has unsaved changes.", k.warningText, alpha(k.warning, k.dark ? 0.16 : 0.08), [
        button(k, "file-keep", "Keep editing", (cx) => { tab.closing = false; cx.notify(); }),
        button(k, "file-discard", "Close without saving", (cx) => { this.drop(c, c.tabs.indexOf(tab)); cx.notify(); }, { variant: "destructive" }),
        button(k, "file-saveclose", "Save and close", (cx) => this.save(cx, tab), { variant: "default" })])))
      .child(tab.state && tab.lines ? this.linesView(k, c, tab) : tab.state ? Editor.new(tab.state).flex_1().min_h(0)
        : v_flex().flex_1().items_center().justify_center().px(16).text_size(12).text_color(tab.error ? k.destructiveText : k.muted).child(tab.error ?? "Loading…"));
  }

  treeRows(k, c, prefix, depth, out, open) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of c.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, isOpen = c.folders.has(path);
      out.push(this.fileRow(k, c, path, entry.name, { dir: entry.dir, isOpen, depth, selected: !entry.dir && path === open, loading: entry.dir && isOpen && c.pending.has(path) }));
      if (entry.dir && isOpen) this.treeRows(k, c, path, depth + 1, out, open);
    }
    return out;
  }

  // Ignored by Git: the path, or a folder above it, is in the ignored list.
  isIgnored(c, path) {
    if (!c.ignored.size) return false;
    for (let at = path.length; at > 0; at = path.lastIndexOf("/", at - 1)) if (c.ignored.has(path.slice(0, at))) return true;
    return false;
  }

  // @pierre/trees as T3 themes it: 24px rows, 12px text, 6 round, hover 7% and selected 12% of the text color.
  fileRow(k, c, path, name, { dir = false, isOpen = false, depth = 0, selected = false, loading = false, detail = null }) {
    const mark = c.marks[path];
    const hidden = name.startsWith(".");
    const ignored = this.isIgnored(c, path);
    return h_flex().id(`f-${path}`).h(ROW).flex_none().mx(2).pl(6 + depth * 12).pr(6).gap(4).items_center().rounded(6).cursor_pointer()
      .bg(selected ? alpha(k.foreground, 0.12) : "#00000000").hover((s) => s.bg(alpha(k.foreground, selected ? 0.12 : 0.07)))
      .role("button").accessibility_label(path)
      .on_click((_e, cx) => (dir ? this.toggle(cx, path) : this.open(cx, path)))
      .child(dir ? icon(isOpen ? "chevron-down" : "chevron-right").size(12).flex_none().text_color(k.muted) : div().w(12).flex_none())
      .child(dir ? icon(isOpen ? "folder-open" : "folder").size(14).flex_none().text_color(ignored ? alpha(k.muted, 0.5) : k.muted) : fileIcon(name, k.dark, 14).opacity(ignored ? 0.5 : 1))
      .child(div().flex_shrink(detail ? 0 : 1).min_w(0).truncate().text_color(mark === "D" ? k.destructiveText : ignored ? alpha(k.muted, 0.7) : hidden ? k.muted : k.foreground).child(name))
      .when(!!detail, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.muted).child(detail)))
      .when(!detail, (el) => el.child(div().flex_1()))
      .when(loading, (el) => el.child(icon("refresh-cw").size(12).flex_none().text_color(k.muted).spin(1000)))
      .when(!!mark, (el) => el.child(div().flex_none().text_size(11).font_medium()
        .text_color(mark === "A" ? k.successText : mark === "D" || mark === "U" ? k.destructiveText : k.warningText).child(mark)));
  }

  explorer(k, c, fill) {
    const q = this.search.value().trim().toLowerCase();
    const open = this.tab()?.path ?? null;
    const say = (text, color = k.muted) => div().px(12).py(4).text_size(12).text_color(color).child(text);
    let body;
    if (q) {
      const all = c.files ?? [];
      const hits = [];
      for (const f of all) { if (f.toLowerCase().includes(q)) { hits.push(f); if (hits.length > MAX_MATCHES) break; } }
      body = v_flex().id("ht3-files-hits").flex_1().min_h(0).overflow_y_scrollbar().py(4)
        .children(hits.slice(0, MAX_MATCHES).map((f) => {
          const at = f.lastIndexOf("/");
          return this.fileRow(k, c, f, f.slice(at + 1), { selected: f === open, detail: at >= 0 ? f.slice(0, at) : "" });
        }))
        .when(!c.files, (el) => el.child(say("Loading files…")))
        .when(!!c.files && !hits.length, (el) => el.child(say("No matching files.")))
        .when(hits.length > MAX_MATCHES, (el) => el.child(say("More matches available. Refine your search.")));
    } else {
      body = v_flex().id("ht3-files-tree").flex_1().min_h(0).overflow_y_scrollbar().py(4)
        .children(this.treeRows(k, c, "", 0, [], open))
        .when(!!c.error, (el) => el.child(say(c.error, k.destructiveText)))
        .when(!c.error && !c.entries.get("")?.length, (el) => el.child(say(c.loading ? "Loading files…" : "This folder is empty.")))
        .when(c.limited, (el) => el.child(say(`Showing at most ${PER_FOLDER} entries per folder and ${TOTAL.toLocaleString("en-US")} in all.`)));
    }
    let el = v_flex().min_h(0).bg(k.background);
    el = fill ? el.flex_1().min_w(0) : el.w(224).flex_none().border_r(1).border_color(alpha(k.border, 0.6));
    return el
      .child(h_flex().h(36).flex_none().px(8).gap(4).items_center()
        .child(iconButton(k, "files-refresh", "refresh-cw", (cx) => { c.files = null; this.refresh(cx); this.index(cx); }, { tip: c.loading ? "Refreshing…" : "Refresh files" }))
        .child(h_flex().flex_1().min_w(0).h(28).px(8).gap(6).items_center().rounded(8).text_size(12)
          .child(icon("search").size(14).flex_none().text_color(k.muted))
          .child(div().flex_1().min_w(0).child(Input.new(this.search))))
        .child(iconButton(k, "files-collapse", "chevrons-down-up", (cx) => { c.folders.clear(); for (const p of [...c.entries.keys()]) if (p) c.entries.delete(p); cx.notify(); }, { tip: "Collapse all folders" }))
        .when(!c.on, (el) => el.child(iconButton(k, "files-open", "folder-open", (cx) => { cx.spawn(async (cx) => this.pickRoot(cx)); }, { tip: "Open folder…" }))))
      .child(h_flex().h(26).flex_none().px(10).gap(4).items_center().text_size(11).text_color(k.muted)
        .child(iconButton(k, "files-up", "arrow-up", (cx) => this.pin(cx, c.root.replace(/\/[^/]*$/, "") || "/"), { size: "micro", tip: "Up one folder" }))
        .child(div().flex_1().min_w(0).truncate().child(c.on ? `${c.on}:${c.root}` : shortPath(c.root)))
        .when(!!this.pinned(c.space), (el) => el.child(iconButton(k, "files-follow", "square-terminal", (cx) => this.pin(cx, null), { size: "micro", tip: "Back to the terminal's folder" }))))
      .child(body);
  }
}
