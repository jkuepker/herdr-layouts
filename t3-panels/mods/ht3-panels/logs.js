// Logs (a surface of the side panel, `ht3-panels.logs`; not in T3 Code): a file followed like `tail -f`, filtered, and
// sent to the chat.
//
// - The file: a path in the shown folder (an absolute one, or `~/…`, also works), typed in the box or picked from the
//   suggestions: `*.log` files Git doesn't track (ignored ones too, outside node_modules) and what is in `logs/`, `log/`,
//   `tmp/` and `.next/`. (Servers started from the Project popover run in terminals of their own, whose output goes to
//   the terminal, not to a file this surface could read, so they can't be picked here.)
// - Following (logtail.js): the last 1000 lines are read with `tail -n 1000`, then once a second, while the surface is
//   shown and not paused, only the bytes after the offset read so far (`wc -c`, `tail -c +<offset>`), so a quiet file
//   costs one short command. A file that got shorter or was replaced (rotation) is read again from its end; a file that
//   isn't there yet is waited for. 5000 lines are kept.
// - The list: monospace, ANSI escapes removed, errors and warnings coloured, a bounded list that scrolls. The filter box
//   keeps the lines with that text (case ignored), or, when it starts with "/", those matching the regular expression
//   (`/timeout|refused/`, `/Error/` keeps the case). Pause stops reading, Clear empties the list (reading goes on from
//   where it was), Follow keeps the list at its end.
// - Send to chat: the last 50 or 200 (or all, at most 400) of the visible lines go into the message box of the shown tab's
//   chat, not sent (shared "ht3-panels.quote", as Diff's Add to chat and Checks' Send to chat do).
// For scripts: with the surface shown, `logs-open:<path>`, `logs-filter:<text>`, `logs-pause` (toggles), `logs-clear`,
// `logs-follow` (toggles), `logs-send:<50|200|all>`, `logs-suggest` (opens or closes the suggestions).

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, shared, setShared, focused, home } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, shortPath } from "./look.js";
import { activeSpace, placeOf, showing } from "./side.js";
import { Tailer, POLL, pollArgs, parseReply, makeFilter, visible, sendCount, sendText } from "./logtail.js";

const POLL_MS = 1000;
const ROW = 16;

// The folder's likely logs, one path per line, relative to the folder (at most 30).
const SUGGEST = 'cd "$1" || exit 0\n'
  + '{\n'
  + "  git ls-files -o --exclude-standard -- '*.log' 2>/dev/null\n"
  + "  git ls-files -o -i --exclude-standard -- '*.log' 'logs/*' 'log/*' 'tmp/*' '.next/*.log' '.next/trace' 2>/dev/null\n"
  + '  ls -1 logs/* log/* tmp/* .next/trace .next/*.log 2>/dev/null\n'
  + "} | grep -v 'node_modules/' | sort -u | while IFS= read -r p; do [ -f \"$p\" ] && printf '%s\\n' \"$p\"; done | head -30";

export class LogsPanel {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.where = null; // { on, cwd }
    this.seen = null;
    this.path = null; // the file followed, as typed
    this.paths = new Map(); // folder key -> the file last followed there
    this.tail = new Tailer();
    this.ver = 0; // changes whenever the lines do
    this.paused = false;
    this.follow_ = true;
    this.polling = false;
    this.said = null; // { text, bad }
    this.suggestions = null; // paths, or null until asked
    this.suggestOpen = false;
    this.cache = { ver: -1, q: null, rows: [], filter: null };
    this.pathBox = InputState.new({ placeholder: "Path in the project, e.g. logs/dev.log" });
    this.pathBox.on("submit", (_e, cx) => { this.open(this.pathBox.value(), cx); });
    this.pathBox.on("change", (_e, cx) => cx.notify());
    this.filterBox = InputState.new({ placeholder: "Filter: text, or /regex/" });
    this.filterBox.on("change", (_e, cx) => cx.notify());
    this.scroll = VirtualListScrollHandle.new();
    this.followFolder(cx);
    cx.timer.every(POLL_MS, (cx) => { if (showing(this.group, "logs")) this.poll(cx); });
  }
  close() { this.paused = true; }

  // The folder shown: a new one remembers the file it last followed, and starts that again.
  followFolder(cx) {
    const where = placeOf(activeSpace());
    const key = `${where.on ?? ""}|${where.cwd ?? ""}`;
    if (key === this.seen) return;
    if (this.seen != null && this.path) this.paths.set(this.seen, this.path);
    this.seen = key;
    this.where = where.cwd ? { on: where.on ?? null, cwd: where.cwd } : null;
    this.suggestions = null;
    this.suggestOpen = false;
    this.said = null;
    this.tail = new Tailer();
    this.ver++;
    const was = this.paths.get(key) ?? null;
    this.path = was;
    this.pathBox.set_value(was ?? "");
  }

  // The path as a folder on the machine the file is on: as typed, relative to the shown folder.
  absolute(rel) {
    const p = String(rel ?? "").trim();
    if (!p) return null;
    if (p.startsWith("/")) return p;
    if (p === "~" || p.startsWith("~/")) return this.where?.on ? p : `${home()}${p.slice(1)}`;
    return `${this.where.cwd.replace(/\/+$/, "")}/${p.replace(/^\.\//, "")}`;
  }

  open(rel, cx) {
    const p = String(rel ?? "").trim();
    if (!p || !this.where) return;
    this.path = p;
    this.pathBox.set_value(p);
    this.tail = new Tailer();
    this.ver++;
    this.said = null;
    this.suggestOpen = false;
    this.paused = false;
    cx.notify();
    this.poll(cx, true);
  }

  // One look at the file: the header and the new bytes in one command, and, when the file got shorter or was replaced, a
  // second one that reads its end again. At most one runs at a time.
  poll(cx, force = false) {
    if (!this.path || !this.where || this.polling || (this.paused && !force)) return;
    const abs = this.absolute(this.path), where = this.where, tail = this.tail, path = this.path;
    this.polling = true;
    const ask = (t) => exec("sh", ["-c", POLL, "sh", ...pollArgs(abs, t)], { cwd: where.cwd, on: where.on ?? undefined, timeout: 15000 });
    cx.spawn(async (acx) => {
      try {
        let r = parseReply((await ask(tail)).stdout), mode = tail.plan(r);
        if (mode === "again") { r = parseReply((await ask({ offset: null, ino: null })).stdout); mode = r ? (r.missing ? "missing" : "again") : "idle"; }
        // The file was changed (another picked) while this ran: this answer is for the old one.
        if (tail === this.tail && path === this.path) {
          const was = this.tail.missing;
          const got = this.tail.take(mode, r ?? { missing: false, size: tail.size, ino: tail.ino, body: "" });
          if (got.added || got.replaced || was !== this.tail.missing) { this.ver++; if (got.replaced && mode === "again") this.said = { text: "The file was truncated or replaced: read again from its end.", bad: false }; }
        }
      } catch (e) {
        if (tail === this.tail) this.said = { text: `Couldn't read it: ${String(e?.message ?? e).split("\n").pop()}`, bad: true };
      }
      this.polling = false;
      acx.notify();
    });
  }

  suggest(cx) {
    this.suggestOpen = !this.suggestOpen;
    if (this.suggestOpen && this.suggestions == null && this.where) this.loadSuggestions(cx);
    cx.notify();
  }
  loadSuggestions(cx) {
    const where = this.where, seen = this.seen;
    cx.spawn(async (acx) => {
      const r = await exec("sh", ["-c", SUGGEST, "sh", where.cwd], { cwd: where.cwd, on: where.on ?? undefined, timeout: 15000 }).catch(() => null);
      if (this.seen === seen) { this.suggestions = r?.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []; acx.notify(); }
    });
  }

  // The lines the filter keeps (cached until the lines or the filter change).
  rows() {
    const q = this.filterBox.value(), c = this.cache;
    if (c.ver === this.ver && c.q === q) return c;
    const filter = makeFilter(q);
    this.cache = { ver: this.ver, q, filter, rows: visible(this.tail.lines, filter) };
    return this.cache;
  }

  togglePause(cx) {
    this.paused = !this.paused;
    if (!this.paused) this.poll(cx, true);
    cx.notify();
  }
  clear(cx) { this.tail.clear(); this.ver++; cx.notify(); }

  // Send to chat: `n` (50, 200 or "all") of the visible lines go into the message box of the shown tab's chat.
  send(n, cx) {
    const { rows } = this.rows(), count = sendCount(n, rows.length);
    if (!count || !this.path) { this.said = { text: "No lines to send.", bad: true }; return cx.notify(); }
    const tab = focused()?.tab, places = shared(`${MOD}.places`) ?? {};
    if (!Object.values(places).some((p) => p.tab === tab)) { this.said = { text: "The shown tab isn't a chat: show the chat this is for, then send it.", bad: true }; return cx.notify(); }
    setShared(`${MOD}.quote`, { tab, text: sendText(this.path, rows, count, { filter: this.filterBox.value() }), at: Date.now() });
    this.said = { text: `Put the last ${count} line${count === 1 ? "" : "s"} into the chat's message box, not sent.`, bad: false };
    cx.notify();
  }

  // For scripts: see the header.
  command_(c, cx) {
    if (c.startsWith("logs-open:")) return this.open(c.slice(10), cx);
    if (c.startsWith("logs-filter:")) this.filterBox.set_value(c.slice(12));
    else if (c === "logs-pause") this.togglePause(cx);
    else if (c === "logs-clear") this.clear(cx);
    else if (c === "logs-follow") this.follow_ = !this.follow_;
    else if (c.startsWith("logs-send:")) this.send(c.slice(10) === "all" ? "all" : Number(c.slice(10)), cx);
    else if (c === "logs-suggest") this.suggest(cx);
    cx.notify();
  }
  command(c, cx) { if (showing(this.group, "logs")) this.command_(c, cx); }

  // ---- drawing ----

  head(k) {
    const w = this.where;
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
      .child(icon("scroll-text").size(14).flex_none().text_color(k.muted))
      .child(div().flex_none().font_medium().text_size(13).child("Logs"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(w ? `${w.on ? `${w.on}: ` : ""}${shortPath(w.cwd)}` : ""));
  }

  pathRow(k) {
    return h_flex().flex_none().px(12).py(6).gap(6).items_center()
      .child(div().flex_1().min_w(0).h(28).px(8).rounded(8).border(1).border_color(k.input).text_size(12).font_family(k.mono).child(Input.new(this.pathBox)))
      .child(iconButton(k, "logs-suggest", this.suggestOpen ? "chevron-up" : "chevron-down", (cx) => this.suggest(cx), { size: "sm", tip: "Suggested files", on: this.suggestOpen }))
      .child(button(k, "logs-open", "Open", (cx) => this.open(this.pathBox.value(), cx), { variant: "default", size: "sm", disabled: !this.pathBox.value().trim(), tip: "Follow this file" }));
  }

  suggestions_(k) {
    const list = this.suggestions;
    return v_flex().id("ht3-logs-suggest").flex_none().max_h(168).mx(12).mb(6).p(4).gap(1).rounded(8).border(1).border_color(k.border).overflow_y_scrollbar()
      .when(list == null, (el) => el.child(div().px(6).py(4).text_size(12).text_color(k.muted).child("Looking…")))
      .when(list != null && !list.length, (el) => el.child(div().px(6).py(4).text_size(12).line_height("16px").text_color(k.muted).child("No log file found here. Type a path above.")))
      .children((list ?? []).map((p, i) => h_flex().id(`logs-pick-${i}`).h(26).px(6).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(k.accent)).role("button").accessibility_label(`Follow ${p}`).on_click((_e, cx) => this.open(p, cx))
        .child(icon("file").size(14).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).truncate().font_family(k.mono).text_size(12).child(p))));
  }

  toolbar(k, c) {
    return h_flex().flex_none().px(12).pb(6).gap(6).items_center()
      .child(div().flex_1().min_w(0).h(26).px(8).rounded(8).border(1).border_color(c.filter?.error ? k.destructive : k.input).text_size(12).font_family(k.mono).child(Input.new(this.filterBox)))
      .child(iconButton(k, "logs-pause", this.paused ? "play" : "pause", (cx) => this.togglePause(cx), { size: "sm", tip: this.paused ? "Resume reading" : "Pause reading", on: this.paused }))
      .child(iconButton(k, "logs-clear", "eraser", (cx) => this.clear(cx), { size: "sm", tip: "Clear the list (reading goes on from where it was)" }))
      .child(iconButton(k, "logs-follow", "arrow-down", (cx) => { this.follow_ = !this.follow_; cx.notify(); }, { size: "sm", tip: this.follow_ ? "Following the end: click to stop" : "Follow the end", on: this.follow_, ring: true }));
  }

  lineRow(k, r) {
    const color = r.level === "error" ? k.destructiveText : r.level === "warn" ? k.warningText : alpha(k.foreground, 0.85);
    return div().h(ROW).px(8).flex_none().overflow_hidden().whitespace_nowrap().font_family(k.mono).text_size(11).text_color(color)
      .child(r.line.replace(/ /g, " ").replace(/\t/g, "  ") || " ");
  }

  list(k, c) {
    const t = this.tail, rows = c.rows;
    const none = !this.path ? "Pick a file above to follow it: type a path in the project, or open the suggestions."
      : t.missing ? `${this.path} isn't there (yet). It shows up here when it appears.`
      : t.offset == null ? "Reading…"
      : !t.lines.length ? "No lines yet. New ones show up here as they are written."
      : !rows.length ? "No line matches the filter."
      : null;
    if (none) return v_flex().flex_1().min_h(0).px(24).items_center().justify_center().text_size(12).line_height("18px").text_center().text_color(k.muted).child(none);
    if (this.follow_) this.scroll.scroll_to_bottom();
    return v_flex().relative().flex_1().min_h(0).bg(alpha(k.card, 0.5)).border_t(1).border_color(alpha(k.border, 0.6))
      .child(v_virtual_list("ht3-logs-lines", rows.length, ROW, (i) => `l:${rows[i]?.i ?? i}`, (range) => rows.slice(range.start, range.end).map((r) => this.lineRow(k, r)))
        .track_scroll(this.scroll).size_full())
      .child(Scrollbar.vertical("ht3-logs-lines").absolute().inset_0());
  }

  footer(k, c) {
    const t = this.tail, shown = c.rows.length, total = t.lines.length;
    const bits = [this.path ? `${total}${t.dropped ? "+" : ""} line${total === 1 ? "" : "s"}` : null, c.filter && !c.filter.empty ? `${shown} shown` : null,
      this.paused ? "paused" : this.path ? "reading every second" : null, t.rotations ? `read again ${t.rotations}×` : null].filter(Boolean);
    const can = shown > 0;
    return v_flex().flex_none().border_t(1).border_color(alpha(k.border, 0.6))
      .when(!!c.filter?.error, (el) => el.child(div().px(12).pt(4).text_size(11).text_color(k.destructiveText).child(`Not a regular expression: ${c.filter.error}. All lines are shown.`)))
      .when(!!this.said, (el) => el.child(div().px(12).pt(4).text_size(11).line_height("15px").text_color(this.said.bad ? k.destructiveText : k.muted).child(this.said.text)))
      .child(h_flex().h(36).px(12).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.muted).child(bits.join(" · ")))
        .child(div().flex_none().text_size(11).text_color(k.muted).child("Send to chat"))
        .child(button(k, "logs-send-50", "50", (cx) => this.send(50, cx), { size: "xs", disabled: !can, tip: "The last 50 visible lines go into the chat's message box, not sent" }))
        .child(button(k, "logs-send-200", "200", (cx) => this.send(200, cx), { size: "xs", disabled: !can, tip: "The last 200 visible lines" }))
        .child(button(k, "logs-send-all", "All", (cx) => this.send("all", cx), { size: "xs", disabled: !can, glyph: "message-square", tip: "All visible lines, at most 400" })));
  }

  render(cx) {
    this.followFolder(cx);
    const k = tokens();
    const root = v_flex().id("ht3-logs").size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(13);
    if (!this.where) return root.child(this.head(k)).child(v_flex().flex_1().items_center().justify_center().px(24).text_size(12).text_color(k.muted).child("No folder: focus a terminal or a chat in a project."));
    const c = this.rows();
    return root.child(this.head(k)).child(this.pathRow(k))
      .when(this.suggestOpen, (el) => el.child(this.suggestions_(k)))
      .child(this.toolbar(k, c))
      .child(this.list(k, c))
      .child(this.footer(k, c));
  }
}
