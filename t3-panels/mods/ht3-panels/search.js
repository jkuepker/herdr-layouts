// Project content search (T3 Code's ProjectContentSearchDialog, `projectSearch.toggle`, mod+shift+f): text or a
// regular expression looked for in the files of the shown space's project, the hits as lines under their file,
// and a hit opens its file in Files with the line picked.
// A dialog, as in T3 (`ht3-panels.search`, an overlay with props.menu "search"). The search itself is one `sh -c`
// run through Herdr's exec in the project's folder with `on:` the space's machine, so a remote space is searched
// on its machine: `git grep -n -I --column` from the repository's top folder (tracked and untracked files, not
// the ignored ones); outside Git `rg --vimgrep`, and without ripgrep `grep -rnI`. Binary files are passed over.
// For scripts, while the dialog is open: `ht3-panels.q:<text>` types, `ht3-panels.regex` and `ht3-panels.case`
// flip the two toggles, `ht3-panels.key:<up|down|enter|escape>` presses a key.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, closeOverlay, run, shared, setShared } from "herdr";
import { MOD, tokens, alpha, icon, iconButton, kbd, shortPath } from "./look.js";
import { activeSpace, placeOf, spaceState, openSurface, GROUPS } from "./side.js";

export const SEARCH_SIZE = { width: 760, height: 580 };
export const CAP = 500; // hits shown at most
const WAIT_MS = 250; // after the last key before it searches
const MIN = 2; // characters before it searches
const ROW = 24;
const SHOWN = 220; // characters of a matched line that are drawn
const SEP = "\x1f"; // what the script turns the tools' NUL after a file name into

// $1 the words, $2 F (plain) or E (a regular expression), $3 -i or nothing, $4 how many lines at most.
// The first line it prints says which tool searched and from where: "#git\t<top folder>".
// A file name ends with a NUL in all three (-z, -0, --null), so a name with a colon in it reads right.
export const SCRIPT = `
q=$1; mode=$2; ic=$3; n=$4
out() { head -n "$n" | tr '\\000' '\\037' | LC_ALL=C cut -b 1-1500; }
if top=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ]; then
  cd "$top" || exit 3
  printf '#git\\t%s\\n' "$top"
  git --no-pager grep -n -I -z --column --no-color --untracked $ic "-$mode" -e "$q" | out
elif command -v rg >/dev/null 2>&1; then
  printf '#rg\\t%s\\n' "$(pwd)"
  fx=; [ "$mode" = F ] && fx=-F
  rg --vimgrep -0 --color never $fx \${ic:--s} -e "$q" ./ | out
else
  printf '#grep\\t%s\\n' "$(pwd)"
  grep -rnI --null --exclude-dir=.git $ic "-$mode" -e "$q" . | out
fi
`;

// The exec call of a search: [program, args].
export function searchCall(query, { regex = false, cased = false, cap = CAP } = {}) {
  // One line more than the cap, to know that more were there.
  return ["sh", ["-c", SCRIPT, "search", query, regex ? "E" : "F", cased ? "" : "-i", String(cap + 1)]];
}

// Where the words are in a line: [[from, to], …] in characters. Plain words are looked for as typed; an expression
// is tried as JavaScript's (git's and ripgrep's are close to it); one JavaScript can't read marks nothing.
export function marksOf(text, query, { regex = false, cased = false } = {}) {
  const out = [];
  if (!query) return out;
  if (!regex) {
    const hay = cased ? text : text.toLowerCase(), q = cased ? query : query.toLowerCase();
    for (let i = 0, j; (j = hay.indexOf(q, i)) >= 0 && out.length < 20; i = j + q.length) out.push([j, j + q.length]);
    return out;
  }
  let re;
  try { re = new RegExp(query, cased ? "g" : "gi"); } catch { return out; }
  for (let m; (m = re.exec(text)) && out.length < 20;) {
    if (m[0].length) out.push([m.index, m.index + m[0].length]); else re.lastIndex++;
  }
  return out;
}

// What the script printed -> { tool, root, hits: [{ path, line, col, text }], cut }. `col` is the tool's column of
// the first match (1-based, in bytes), or null (grep gives none). One hit per line of a file: ripgrep's --vimgrep
// prints a line once per match.
export function parseHits(stdout, cap = CAP) {
  const lines = String(stdout ?? "").split("\n");
  const head = /^#(git|rg|grep)\t(.*)$/.exec(lines[0] ?? "");
  const tool = head?.[1] ?? null, root = head?.[2] ?? null;
  const hits = [], seen = new Set();
  let raw = 0;
  for (const ln of lines.slice(head ? 1 : 0)) {
    const at = ln.indexOf(SEP);
    if (at <= 0) continue;
    const path = ln.slice(0, at).replace(/^\.\//, ""), rest = ln.slice(at + 1);
    // git: line NUL column NUL text (an old git: line:column:text); ripgrep: line:column:text; grep: line:text.
    const m = tool === "grep" ? /^(\d+):()(.*)$/.exec(rest) : /^(\d+)[\x1f:](\d+)[\x1f:](.*)$/.exec(rest);
    if (!m) continue;
    raw++;
    const key = `${path}${SEP}${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hits.length < cap) hits.push({ path, line: Number(m[1]), col: m[2] ? Number(m[2]) : null, text: m[3].replace(/\r$/, "") });
  }
  return { tool, root, hits, cut: raw > cap };
}

// The hits under their files, in the order they came: [{ kind: "file", path, n } | { kind: "hit", i, hit }].
export function rowsOf(hits) {
  const rows = [];
  let head = null;
  hits.forEach((hit, i) => {
    if (head?.path !== hit.path) rows.push((head = { kind: "file", path: hit.path, n: 0 }));
    head.n++;
    rows.push({ kind: "hit", i, hit });
  });
  return rows;
}

// A matched line for a row: no indent, at most SHOWN characters around the first match, as pieces
// [{ text, on }] with the matches `on`.
export function piecesOf(text, marks) {
  const lead = text.length - text.trimStart().length;
  const first = marks[0]?.[0] ?? lead;
  const from = first - lead > SHOWN - 60 ? Math.max(lead, first - 40) : lead, to = Math.min(text.length, from + SHOWN);
  const out = [];
  if (from > lead) out.push({ text: "…", on: false });
  let i = from;
  for (const [a, b] of marks) {
    if (b <= i) continue;
    if (a >= to) break;
    if (a > i) out.push({ text: text.slice(i, a), on: false });
    out.push({ text: text.slice(Math.max(a, i), Math.min(b, to)), on: true });
    i = Math.min(b, to);
  }
  if (i < to) out.push({ text: text.slice(i, to), on: false });
  if (to < text.length) out.push({ text: "…", on: false });
  return out;
}

// What went wrong, in words.
export function explain(err, { on = null, cwd = null, regex = false } = {}) {
  const text = String(err?.message ?? err ?? "").trim();
  if (/unreachable|timed out|timeout|connection|cannot reach|not connected/i.test(text)) return on ? `${on} can't be reached, so its files weren't searched.` : "The search took too long and was stopped.";
  if (/No such file or directory|cannot run|cannot start|can't start|ENOENT/i.test(text) && !/grep|rg:|fatal/i.test(text)) return `The folder ${cwd ?? ""} is gone${on ? ` on ${on}` : ""}.`.replace("  ", " ");
  if (regex && /regex|unmatched|invalid|parenthes|brace|bracket|repetition|trailing backslash|parse error/i.test(text)) return `That isn't a regular expression the search can read: ${text.split("\n")[0].replace(/^fatal: (command line, )?/, "")}`;
  return text.split("\n")[0] || "The search failed.";
}

// One search, start to end: -> { tool, root, hits, cut, error }. `error` is words, or null.
export async function searchProject(query, { cwd, on = null, regex = false, cased = false, cap = CAP } = {}) {
  const [program, args] = searchCall(query, { regex, cased, cap });
  let r;
  try { r = await exec(program, args, { cwd, on, timeout: 30000 }); }
  catch (e) { return { tool: null, root: null, hits: [], cut: false, error: explain(e, { on, cwd, regex }) }; }
  const res = parseHits(r.stdout, cap);
  // No hit and something said on stderr: the tool refused the words (an expression it can't read), or couldn't start.
  const said = String(r.stderr ?? "").trim();
  const error = !res.hits.length && said ? explain(said, { on, cwd, regex }) : !res.tool ? explain(said || "The search didn't run.", { on, cwd, regex }) : null;
  return { ...res, error };
}

// The keeper's (main.js, `goto:<line>:<absolute path>`): Files shows the file, then picks the line in its Lines
// view (editor.js `open:` and `line:`). The file is read after `open:`, so the line is asked for twice; a range
// `n-n` picks and never lets go, so twice is as good as once.
export function showHit(spec, cx) {
  const at = spec.indexOf(":"), line = Number(spec.slice(0, at)), path = spec.slice(at + 1);
  if (at < 0 || !path) return;
  const st = spaceState(activeSpace()?.id);
  const group = GROUPS.find((g) => st[g].tabs.some((t) => t.kind === "files")) ?? "a";
  openSurface(group, "files");
  cx.timer.after(500, () => run(`${MOD}.open:${path}`));
  if (line > 0) for (const ms of [1000, 2000]) cx.timer.after(ms, () => run(`${MOD}.line:${line}-${line}`));
}

// Whether the dialog is open: it says so every second while it is (a dialog that ended badly stops saying it).
const OPEN = `${MOD}.search-open`;
export const searchOpen = () => Date.now() - (shared(OPEN) ?? 0) < 2500;

export class Search {
  init(p, cx) {
    this.overlay = p.overlay;
    setShared(OPEN, Date.now());
    cx.timer.every(1000, () => setShared(OPEN, Date.now()));
    const sp = activeSpace();
    this.where = placeOf(sp); // { on, cwd }: fixed while the dialog is open
    this.regex = false;
    this.cased = false;
    this.res = null; // the last search's answer
    this.asked = ""; // the words it answers
    this.rows = [];
    this.at = 0; // the marked hit
    this.seq = 0; // the newest search asked for; an older one's answer is dropped
    this.busy = false;
    this.again = false;
    this.range = null; // the rows on screen, as the list last drew them
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search project contents…" });
    this.input.on("change", (_e, cx) => this.typed(cx));
    cx.timer.after(0, () => this.input.focus());
    if (p.query) { this.input.set_value(String(p.query)); this.typed(cx); }
  }
  close() { this.seq++; setShared(OPEN, 0); }
  shut() { setShared(OPEN, 0); closeOverlay(this.overlay); }

  command(c, cx) {
    // The key again closes it (T3's projectSearch.toggle).
    if (c === "search") return this.shut();
    if (c.startsWith("q:")) { this.input.set_value(c.slice(2)); this.typed(cx); }
    else if (c === "regex") this.flip(cx, "regex");
    else if (c === "case") this.flip(cx, "cased");
    else if (c.startsWith("key:")) this.key(c.slice(4), cx);
    cx.notify();
  }

  query() { return this.input.value(); }
  flip(cx, what) { this[what] = !this[what]; this.typed(cx, 0); this.input.focus(); }

  // Waits for the typing to stop, then searches; what was asked before is no longer wanted.
  typed(cx, wait = WAIT_MS) {
    const mine = ++this.seq;
    cx.timer.after(wait, (cx) => { if (mine === this.seq) this.search(cx); });
    cx.notify();
  }

  search(cx) {
    const q = this.query();
    if (!this.where?.cwd || q.trim().length < MIN) { this.res = null; this.asked = ""; this.rows = []; this.at = 0; return cx.notify(); }
    // One search at a time on the machine: a newer one waits for the running one, whose answer it replaces.
    if (this.busy) { this.again = true; return; }
    const mine = this.seq, opts = { cwd: this.where.cwd, on: this.where.on ?? null, regex: this.regex, cased: this.cased };
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let res;
      try { res = await searchProject(q, opts); } catch (e) { res = { tool: null, root: null, hits: [], cut: false, error: explain(e, opts) }; }
      this.busy = false;
      if (mine === this.seq) {
        for (const h of res.hits) h.marks = marksOf(h.text, q, opts);
        this.res = res; this.asked = q; this.rows = rowsOf(res.hits); this.at = 0; this.range = null;
        if (this.rows.length) this.scroll.scroll_to_item(0, "top");
      }
      if (this.again) { this.again = false; this.search(cx); }
      cx.notify();
    });
  }

  // Up and Down move the mark over the hits (round the ends), Enter opens the marked one, Esc closes.
  key(key, cx) {
    const n = this.res?.hits.length ?? 0;
    if (key === "escape") return this.shut();
    if (key === "enter") return this.open(this.res?.hits[this.at]);
    if ((key !== "down" && key !== "up") || !n) return;
    this.at = (this.at + (key === "down" ? 1 : -1) + n) % n;
    const row = this.rows.findIndex((r) => r.kind === "hit" && r.i === this.at);
    // Brought into view only when it is out of it; the file's name comes along for a file's first hit.
    const r = this.range;
    if (!r || row - 1 < r.start || row + 1 >= r.end) this.scroll.scroll_to_item(Math.max(0, row - (this.rows[row - 1]?.kind === "file" ? 1 : 0)), !r || row < r.start ? "top" : "center");
    cx.notify();
  }

  // The keeper shows the file (showHit above): what this copy started would end with the dialog.
  open(hit) {
    if (!hit || !this.res?.root) return;
    run(`${MOD}.goto:${hit.line}:${this.res.root}/${hit.path}`);
    this.shut();
  }

  // What the body says when there is no list.
  words() {
    const q = this.query().trim(), w = this.where, res = this.res;
    if (!w?.cwd) return { glyph: "folder", text: "This space has no folder, so there is nothing to search. Open a terminal or a chat in a project first." };
    if (!q) return { glyph: "search", text: "Type to search the text of this project's files. Up and Down move through the hits, Enter opens one." };
    if (q.length < MIN) return { glyph: "search", text: `Type at least ${MIN} characters.` };
    if (!res) return { glyph: "search", text: "Searching…" };
    if (res.error) return { glyph: "circle-alert", text: res.error, bad: true };
    if (!res.hits.length) return { glyph: "search", text: `Nothing in this project matches "${this.asked}"${this.regex ? " as a regular expression" : ""}${this.cased ? ", with capitals as typed" : ""}.` };
    return null;
  }

  render(_cx) {
    const k = tokens(), w = this.where, res = this.res, hits = res?.hits ?? [], rows = this.rows;
    const nb = (t) => t.replace(/ /g, " ").replace(/\t/g, "  ");
    const toggle = (id, glyph, on, tip, what) => h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .role("button").accessibility_label(tip).tooltip(tip)
      .bg(on ? alpha(k.primary, k.dark ? 0.3 : 0.16) : "#00000000").text_color(on ? k.foreground : k.muted)
      .hover((s) => s.bg(on ? alpha(k.primary, k.dark ? 0.36 : 0.22) : k.accent).text_color(k.foreground))
      .on_click((_e, cx) => { this.flip(cx, what); cx.notify(); })
      .child(icon(glyph).size(15));

    const fileRow = (r) => h_flex().h(ROW).px(12).gap(6).items_center().text_size(12)
      .child(icon("file").size(13).flex_none().text_color(k.muted))
      .child(div().min_w(0).truncate().font_medium().child(r.path))
      .child(div().flex_none().text_color(k.muted).child(String(r.n)));
    const hitRow = (r) => {
      const on = r.i === this.at, h = r.hit;
      return h_flex().h(ROW).mx(4).pl(8).pr(8).gap(8).items_center().rounded(6).cursor_pointer().font_family(k.mono).text_size(12)
        .bg(on ? k.accent : "#00000000").hover((s) => s.bg(on ? k.accent : alpha(k.foreground, 0.05)))
        .child(div().w(44).flex_none().text_color(k.muted).child(h_flex().justify_end().child(String(h.line))))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().children(piecesOf(h.text, h.marks ?? []).map((p) => p.on
          ? div().flex_none().rounded(3).bg(alpha(k.warning, k.dark ? 0.4 : 0.35)).child(nb(p.text))
          : div().flex_none().text_color(on ? k.foreground : alpha(k.foreground, 0.85)).child(nb(p.text)))));
    };

    const said = this.words();
    const stale = !!res && this.asked !== this.query();
    const name = w?.cwd ? (res?.root ?? w.cwd) : null;
    const count = hits.length ? `${hits.length}${res.cut ? "+" : ""} hit${hits.length === 1 ? "" : "s"} in ${rows.length - hits.length} file${rows.length - hits.length === 1 ? "" : "s"}` : "";
    const tool = res?.tool === "git" ? "git grep" : res?.tool === "rg" ? "ripgrep" : res?.tool === "grep" ? "grep" : null;

    return v_flex().id("ht3-search").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .on_key_down((e, cx) => {
        if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
        const key = String(e.key ?? "").toLowerCase();
        if (["up", "down", "enter", "escape"].includes(key)) { this.key(key, cx); cx.stop_propagation?.(); }
      })
      .child(h_flex().h(48).pl(14).pr(8).gap(6).flex_none().items_center().border_b(1).border_color(k.border)
        .child(icon("search").size(16).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.input)))
        .child(toggle("search-case", "case-sensitive", this.cased, this.cased ? "Capitals count: on" : "Capitals count: off", "cased"))
        .child(toggle("search-regex", "regex", this.regex, this.regex ? "Regular expression: on" : "Regular expression: off", "regex"))
        .child(iconButton(k, "search-close", "x", () => this.shut(), { tip: "Close (Esc)" })))
      .child(h_flex().h(28).px(14).gap(8).flex_none().items_center().text_size(12).text_color(k.muted)
        .child(div().flex_1().min_w(0).truncate().child(name ? `${w.on ? `${w.on}: ` : ""}${shortPath(name) || name}` : "No folder"))
        .when(this.busy || stale, (el) => el.child(div().flex_none().child("Searching…")))
        .when(!!count && !this.busy && !stale, (el) => el.child(div().flex_none().child(count))))
      .when(!!said, (el) => el.child(v_flex().flex_1().min_h(0).px(48).gap(10).items_center().justify_center()
        .child(icon(said.glyph).size(22).text_color(said.bad ? k.destructiveText : alpha(k.muted, 0.7)))
        .child(div().text_size(13).line_height("18px").text_color(said.bad ? k.destructiveText : k.muted).child(said.text))))
      .when(!said, (el) => el.child(v_flex().relative().flex_1().min_h(0)
        .child(v_virtual_list("ht3-search-list", rows.length, ROW,
          (i) => (rows[i].kind === "file" ? `f:${rows[i].path}` : `h:${rows[i].i}`),
          (range) => { this.range = { start: range.start, end: range.end }; return rows.slice(range.start, range.end).map((r) => (r.kind === "file" ? fileRow(r) : hitRow(r))); })
          .track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => { if (key.startsWith("h:")) { this.at = Number(key.slice(2)); this.open(hits[this.at]); cx.notify(); } }))
        .child(Scrollbar.vertical("ht3-search-list").absolute().inset_0())))
      .child(h_flex().h(36).px(14).gap(6).flex_none().items_center().border_t(1).border_color(k.border).text_size(12).text_color(k.muted)
        .child(div().flex_1().min_w(0).truncate().child(res?.cut ? `Only the first ${CAP} hits are shown. Type more to narrow it down.` : tool ? `Searched with ${tool}${res.tool === "git" ? ": tracked and new files, not the ignored ones" : ""}.` : ""))
        .child(kbd(k, "↑")).child(kbd(k, "↓")).child(div().flex_none().mr(6).child("move"))
        .child(kbd(k, "↵")).child(div().flex_none().mr(6).child("open"))
        .child(kbd(k, "esc")).child(div().flex_none().child("close")));
  }
}
