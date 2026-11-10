// The Dashboard surface: widgets on a grid, described by JSON files, each polling a source that only reads.
// Not in T3 Code: it is this layout's own surface, in T3's look (cards as the Usage dialog's, 12px text).
//
// - A dashboard is a file in <app home>/data/ht3-dashboards/*.json: { title, refresh, widgets: [...] }.
//   t3-panels/dashboards/ has examples; RECIPE.md has the format.
// - A widget: { type, title, w (1-4 columns), refresh (seconds), source, pick, … }. Types: stat, table, list, bars,
//   line, status. Its data goes source (dash-sources.js) -> pick -> filter -> sort (dash-data.js) -> drawn here.
// - Charts are divs: gpui-kit has no chart element, and its paths are placed in window coordinates.
// - Polls only while its tab shows (side.js showing); a widget keeps what it last had beside an error.
// - The picked dashboard is kept per panel group in shared "ht3-panels.dashboard".

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome, shared, setShared, run } from "herdr";
import { MOD, tokens, alpha, icon, iconButton, shortPath } from "./look.js";
import { showing } from "./side.js";
import { pick, field, num, show, level, stateLevel, keep, sortRows, age, readDashboard } from "./dash-data.js";
import { fetchSource } from "./dash-sources.js";

const TICK_MS = 5000, SHARE_MS = 4000; // widgets asking for the same source within a tick share one answer
const KEEP = 40; // values a stat keeps for its sparkline
const CHART_H = 96, COLS = 60;
const dir = () => `${appHome()}/data/ht3-dashboards`;

export class DashboardPanel {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.files = null; // [{ name, dash } | { name, error }]
    this.filesError = null;
    this.menu = false;
    this.state = new Map(); // widget id -> { data, error, at, tried, loading, past }
    this.answers = new Map(); // a source as JSON -> { at, promise }
    this.loadFiles(cx);
    cx.timer.every(TICK_MS, (cx) => { if (showing(this.group, "dashboard")) { this.poll(cx); cx.notify(); } });
  }
  close() {}

  // For scripts: `dashboard:<file name without .json>` shows that one, `dashboard-refresh` reads the files again
  // and asks every source now, `dashboard-menu` opens or closes the picker.
  command(c, cx) {
    if (c.startsWith("dashboard:")) this.choose(cx, c.slice(10));
    else if (c === "dashboard-refresh") this.loadFiles(cx, true);
    else if (c === "dashboard-menu") this.menu = !this.menu;
    cx.notify();
  }

  loadFiles(cx, force = false) {
    if (this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && ls -1 *.json 2>/dev/null; true', "ls", dir()]);
        const names = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".json")).sort();
        const files = [];
        for (const f of names.slice(0, 50)) {
          const name = f.replace(/\.json$/, "");
          try {
            const text = await readTextFile(`${dir()}/${f}`);
            if (text == null) throw new Error(`${name}: couldn't be read (over 1 MiB?)`);
            files.push({ name, dash: readDashboard(text, name) });
          } catch (e) { files.push({ name, error: String(e?.message ?? e) }); }
        }
        this.files = files;
        this.filesError = null;
      } catch (e) { this.files = this.files ?? []; this.filesError = String(e?.message ?? e); }
      this.reading = false;
      if (force) { this.answers.clear(); this.poll(cx, true); }
      cx.notify();
    });
  }

  current() {
    const ok = (this.files ?? []).filter((f) => f.dash);
    const want = (shared(`${MOD}.dashboard`) ?? {})[this.group];
    return ok.find((f) => f.name === want) ?? ok[0] ?? null;
  }
  choose(cx, name) {
    setShared(`${MOD}.dashboard`, { ...(shared(`${MOD}.dashboard`) ?? {}), [this.group]: name });
    this.menu = false;
    this.poll(cx);
    cx.notify();
  }

  of(id) {
    let st = this.state.get(id);
    if (!st) this.state.set(id, (st = { data: undefined, error: null, at: 0, tried: 0, loading: false, past: [] }));
    return st;
  }

  // Asks every widget of the shown dashboard whose answer is older than its refresh (all of them with `force`).
  poll(cx, force = false) {
    const cur = this.current();
    if (!cur) return;
    const now = Date.now();
    for (const w of cur.dash.widgets) {
      const st = this.of(w.id), every = (w.refresh ?? cur.dash.refresh) * 1000;
      if (!w.type || st.loading || (!force && st.tried && now - st.tried < every - 500)) continue;
      st.loading = true;
      cx.spawn(async (cx) => {
        try {
          const raw = await this.ask(w.source, cur.dash);
          let data = pick(raw, w.pick);
          if (Array.isArray(data)) data = sortRows(keep(data, w.filter), w.sort);
          if (Array.isArray(data) && w.limit) data = data.slice(0, Math.max(1, Number(w.limit) || 1));
          st.data = data;
          st.error = null;
          st.at = Date.now();
          if (w.type === "stat") { const v = num(this.statValue(w, data)); if (v != null) st.past = [...st.past, v].slice(-KEEP); }
        } catch (e) { st.error = String(e?.message ?? e).split("\n")[0].slice(0, 200); }
        st.loading = false;
        st.tried = Date.now();
        cx.notify();
      });
    }
  }
  ask(source, dash) {
    const key = JSON.stringify(source ?? null), had = this.answers.get(key), now = Date.now();
    if (had && now - had.at < SHARE_MS) return had.promise;
    const promise = fetchSource(source, { prometheus: dash.prometheus });
    this.answers.set(key, { at: now, promise });
    if (this.answers.size > 200) this.answers.delete(this.answers.keys().next().value);
    return promise;
  }

  // ---- drawing ----

  render(cx) {
    const k = tokens();
    const shown = showing(this.group, "dashboard");
    // Shown again after a while behind another tab: ask now, not at the next tick.
    if (shown && !this.wasShown) cx.timer.after(0, (cx) => { this.poll(cx); cx.notify(); });
    this.wasShown = shown;
    const cur = this.current(), files = this.files ?? [];
    const root = v_flex().id(`ht3-dash-${this.group}`).size_full().min_h(0).overflow_hidden().bg(k.background).text_color(k.foreground).text_size(12);
    const widgets = cur?.dash.widgets ?? [];
    const ats = widgets.map((w) => this.state.get(w.id)?.at ?? 0).filter(Boolean);
    const failing = widgets.filter((w) => this.state.get(w.id)?.error).length;
    const said = !cur ? "" : !shown ? "Paused" : !ats.length ? "Loading…" : `Updated ${age((Date.now() - Math.max(...ats)) / 1000)} ago${failing ? ` · ${failing} failing` : ""}`;
    const head = h_flex().h(40).flex_none().px(16).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
      .child(icon("layout-dashboard").size(14).flex_none().text_color(k.muted))
      .child(h_flex().id("dash-pick").h(24).px(6).ml(-6).gap(4).flex_none().max_w(220).items_center().rounded(6).font_medium().text_size(13).cursor_pointer()
        .role("button").accessibility_label(`Dashboard: ${cur?.dash.title ?? "none"}. Choose another`)
        .hover((s) => s.bg(k.accent)).on_click((_e, cx) => { this.menu = !this.menu; if (this.menu) this.loadFiles(cx); cx.notify(); })
        .child(div().min_w(0).truncate().child(cur?.dash.title ?? "Dashboard"))
        .child(icon(this.menu ? "chevron-up" : "chevron-down").size(12).flex_none().text_color(k.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(failing && shown ? k.warningText : k.muted).child(said))
      .child(iconButton(k, "dash-refresh", "refresh-cw", (cx) => this.loadFiles(cx, true), { size: "sm", tip: "Read the dashboard files again and refresh every widget" }));
    const menu = v_flex().mx(10).my(4).p(4).w(260).flex_none().rounded(8).border(1).border_color(k.border).bg(k.popover).shadow_lg()
      .children(files.map((f) => h_flex().id(`dash-file-${f.name}`).min_h(28).px(8).py(4).gap(8).flex_none().items_center().rounded(6).text_size(13)
        .when(!!f.dash, (el) => el.cursor_pointer().role("button").accessibility_label(`Show ${f.dash.title}`).hover((s) => s.bg(k.accent)).on_click((_e, cx) => this.choose(cx, f.name)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(f.dash ? k.foreground : k.destructiveText).child(f.dash?.title ?? `${f.name}.json`))
          .child(div().text_size(11).line_height("15px").text_color(k.muted).child(f.dash ? `${f.name}.json · ${f.dash.widgets.length} widget${f.dash.widgets.length === 1 ? "" : "s"}` : f.error)))
        .when(f === cur, (el) => el.child(icon("check").size(14).flex_none().text_color(k.muted)))))
      .child(div().px(8).py(4).text_size(11).line_height("15px").text_color(k.muted).child(`Files in ${shortPath(dir())}`));
    const note = (title, body) => v_flex().flex_1().items_center().justify_center().gap(6).px(24)
      .child(div().font_medium().text_size(13).child(title)).child(div().max_w(360).text_center().line_height("18px").text_color(k.muted).child(body));
    return root.child(head)
      .when(this.menu, (el) => el.child(menu))
      .when(!this.files, (el) => el.child(note("Reading dashboards…", "")))
      .when(!!this.files && !cur, (el) => el.child(note(files.length ? "No dashboard could be read" : "No dashboards yet",
        files.length ? files.map((f) => f.error).join(" ") : `Put a JSON file in ${shortPath(dir())}. The examples are in t3-panels/dashboards/ and the format is in RECIPE.md.`)))
      .when(!!cur, (el) => el.child(div().id(`ht3-dash-body-${this.group}`).flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().flex_wrap().items_stretch().p(12).gap(8).children(widgets.map((w) => this.widget(k, w))))));
  }

  // One card. Its width is a share of the row that wraps when the panel is narrow.
  widget(k, w) {
    const st = this.of(w.id), has = st.data !== undefined;
    const empty = has && (st.data == null || (Array.isArray(st.data) && !st.data.length));
    const body = !w.type ? this.say(k, `No widget type "${w.typeName}". There are: stat, table, list, bars, line, status.`, k.destructiveText)
      : !has ? this.say(k, st.error ?? "Loading…", st.error ? k.destructiveText : k.muted)
        : empty ? this.say(k, w.empty ?? "No data", k.muted)
          : this.safely(k, () => this[`draw_${w.type}`](k, w, st));
    return v_flex().id(`dash-w-${w.id}`).flex_grow(w.w).flex_shrink(1).flex_basis(w.w * 168 + (w.w - 1) * 8).min_w(Math.min(w.w, 2) * 150).max_w_full()
      .p(12).gap(8).rounded(10).border(1).border_color(alpha(k.border, 0.7)).bg(k.card).overflow_hidden()
      .child(h_flex().flex_none().gap(6).items_center().text_size(12)
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(k.muted).child(w.title || w.typeName))
        .when(st.loading && !has, (el) => el.child(icon("refresh-cw").size(12).flex_none().text_color(k.dim).spin(1000)))
        .when(!!st.error && has, (el) => el.child(h_flex().id(`dash-err-${w.id}`).flex_none().gap(4).items_center().text_size(11).text_color(k.warningText).tooltip(st.error)
          .child(icon("circle-alert").size(12).flex_none()).child(st.at ? `stale ${age((Date.now() - st.at) / 1000)}` : "failed")))
        .when(!st.error && has && !!st.at, (el) => el.child(div().flex_none().text_size(11).text_color(k.dim).child(age((Date.now() - st.at) / 1000)))))
      .child(body);
  }
  say(k, text, color) { return div().py(8).text_size(12).line_height("17px").text_color(color).child(text); }
  // A field that doesn't fit its data must not take the panel down with it.
  safely(k, draw) { try { return draw(); } catch (e) { return this.say(k, String(e?.message ?? e).slice(0, 200), k.destructiveText); } }
  tone(k, l) { return l === "bad" ? k.destructiveText : l === "warn" ? k.warningText : l === "ok" ? k.successText : null; }
  fill(k, l) { return l === "bad" ? k.destructive : l === "warn" ? k.warning : l === "ok" ? k.success : k.primary; }
  dot(k, l) { return div().size(8).flex_none().rounded_full().bg(l ? this.fill(k, l) : alpha(k.muted, 0.5)); }
  rowsOf(data) { return Array.isArray(data) ? data : [data]; }

  // stat: one number. value (a path into the picked data, or its first row; default the data itself, or `.value`),
  // unit, format, decimals, scale, thresholds, sub (a template under it), spark: true (the values seen so far as bars;
  // with a range source, that range).
  statValue(w, data) {
    const row = Array.isArray(data) ? data[0] : data;
    if (w.value != null) return field(row, w.value);
    return row && typeof row === "object" ? row.value : row;
  }
  draw_stat(k, w, st) {
    const row = Array.isArray(st.data) ? st.data[0] : st.data;
    const v = this.statValue(w, st.data), l = level(v, w.thresholds, row);
    const text = show(v, { ...w, unit: null }), sub = field(row, w.sub);
    const past = Array.isArray(row?.points) ? row.points.map((p) => p[1]).filter((x) => x != null) : st.past;
    return v_flex().gap(6)
      .child(h_flex().gap(4).items_baseline()
        // A number is large; words (a host name, a state) are smaller and cut where the card ends.
        .child(div().min_w(0).truncate().text_size(text.length > 10 ? 16 : 24).line_height("28px").font_semibold().text_color(this.tone(k, l) ?? k.foreground).child(text))
        .when(!!w.unit && text !== "–", (el) => el.child(div().text_size(12).text_color(k.muted).child(w.unit))))
      .when(!!sub, (el) => el.child(div().text_size(11).line_height("15px").text_color(k.muted).child(String(sub))))
      .when(!!w.spark && past.length > 1, (el) => el.child(this.spark(k, past, l)));
  }
  spark(k, values, l, h = 28) {
    const vs = values.slice(-KEEP), top = Math.max(...vs, 1e-9), low = Math.min(...vs, 0);
    return h_flex().h(h).gap(1).items_end().children(vs.map((v, i) => div().flex_1().min_w(1).max_w(8).rounded_t(1)
      .h(Math.max(1, Math.round(h * ((v - low) / (top - low || 1))))).bg(i === vs.length - 1 ? this.fill(k, l) : alpha(this.fill(k, l), 0.45))));
  }

  // table: a row per item. columns: [{ title, value, format, unit, decimals, scale, thresholds, w (px), align, dot }].
  // The first column takes the room left. click: { run, args } runs a Herdr command for the row (args are templates).
  draw_table(k, w, st) {
    const rows = this.rowsOf(st.data), cols = Array.isArray(w.columns) && w.columns.length ? w.columns : [{ title: "Value", value: "." }];
    const cell = (c, i, child) => (i === 0 ? div().flex_1().min_w(60) : div().w(c.w ?? 72).flex_none()).truncate().when(i > 0 && c.align !== "left", (el) => el.text_right()).child(child);
    return v_flex()
      .child(h_flex().h(22).gap(8).items_center().text_size(11).text_color(k.muted).border_b(1).border_color(alpha(k.border, 0.6))
        .children(cols.map((c, i) => cell(c, i, c.title ?? ""))))
      .children(rows.map((r, ri) => {
        let el = h_flex().id(`dash-r-${w.id}-${ri}`).min_h(26).gap(8).items_center().when(ri < rows.length - 1, (e) => e.border_b(1).border_color(alpha(k.border, 0.35)));
        if (w.click?.run) el = el.cursor_pointer().role("button").hover((s) => s.bg(alpha(k.foreground, 0.05)))
          .on_click(() => { const args = {}; for (const [key, spec] of Object.entries(w.click.args ?? {})) args[key] = field(r, spec); run(String(w.click.run), args); });
        return el.children(cols.map((c, i) => {
          const v = field(r, c.value), l = c.dot ? level(v, c.thresholds, r) ?? stateLevel(v) : level(v, c.thresholds, r);
          const text = show(v, c), color = text === "–" ? k.dim : c.dot ? k.foreground : this.tone(k, l) ?? (i === 0 ? k.foreground : alpha(k.foreground, 0.85));
          return c.dot
            ? cell(c, i, h_flex().gap(6).items_center().when(i > 0 && c.align !== "left", (e) => e.justify_end()).child(this.dot(k, v == null ? null : l)).child(div().min_w(0).truncate().text_color(color).child(text)))
            : cell(c, i, div().truncate().text_color(color).when(i === 0, (e) => e.font_medium()).child(text));
        }));
      }));
  }

  // list: a line per item. text and sub (templates), state (a path: a dot coloured by it), thresholds for the state.
  draw_list(k, w, st) {
    return v_flex().gap(2).children(this.rowsOf(st.data).map((r) => {
      const s = w.state != null ? field(r, w.state) : undefined, l = w.state != null ? level(s, w.thresholds, r) ?? stateLevel(s) : null;
      const text = w.text != null ? field(r, w.text) : typeof r === "object" ? JSON.stringify(r) : r, sub = field(r, w.sub);
      return h_flex().min_h(22).gap(8).items_center()
        .when(w.state != null, (el) => el.child(this.dot(k, l)))
        .child(div().flex_1().min_w(0).truncate().child(String(text ?? "–")))
        .when(sub != null && sub !== "", (el) => el.child(div().flex_none().max_w(160).truncate().text_size(11).text_color(k.muted).child(String(sub))));
    }));
  }

  // bars: a horizontal bar per item. label (a template), value, max (a number or a path; default the largest value),
  // format, unit, decimals, thresholds (asked of `of`, a path, when the colour should follow another field).
  draw_bars(k, w, st) {
    const rows = this.rowsOf(st.data), vals = rows.map((r) => num(field(r, w.value ?? ".value")) ?? 0);
    const top = Math.max(...vals, 1e-9);
    return v_flex().gap(6).children(rows.map((r, i) => {
      const v = vals[i], max = num(field(r, w.max)) ?? top, share = Math.max(0, Math.min(1, max > 0 ? v / max : 0));
      const l = level(w.of != null ? field(r, w.of) : v, w.thresholds, r);
      return h_flex().h(18).gap(8).items_center()
        .child(div().w(w.labelWidth ?? 92).flex_none().truncate().child(String(field(r, w.label ?? ".name") ?? "–")))
        .child(h_flex().flex_1().min_w(24).h(6).rounded_full().overflow_hidden().bg(alpha(k.foreground, 0.1))
          .child(div().h(6).flex_grow(Math.round(share * 1000)).flex_basis(0).rounded_full().bg(this.fill(k, l)))
          .child(div().h(6).flex_grow(1000 - Math.round(share * 1000)).flex_basis(0)))
        .child(div().w(w.valueWidth ?? 84).flex_none().truncate().text_right().text_size(11).text_color(this.tone(k, l) ?? k.muted)
          .child(w.max != null && w.showMax !== false ? `${show(v, { ...w, unit: null })} / ${show(max, w)}` : show(v, w)));
    }));
  }

  // line: series over time, from a range source (each row has `points`: [[time, value], …]). legend (a template per
  // series), unit, format, decimals, min and max for the scale (default 0 and the largest value).
  draw_line(k, w, st) {
    const series = this.rowsOf(st.data).filter((r) => Array.isArray(r?.points) && r.points.length).slice(0, 6);
    if (!series.length) return this.say(k, 'A line needs a range source: a prometheus source with "range".', k.muted);
    const colors = [k.info, k.success, k.warning, "#9d6afb", k.destructive, k.muted];
    const t0 = Math.min(...series.map((s) => s.points[0][0])), t1 = Math.max(...series.map((s) => s.points.at(-1)[0]));
    const n = Math.min(COLS, Math.max(...series.map((s) => s.points.length)));
    // Each series in `n` columns: the last value that falls in the column.
    const cols = series.map((s) => { const out = new Array(n).fill(null); for (const [t, v] of s.points) if (v != null) out[Math.min(n - 1, Math.floor(((t - t0) / (t1 - t0 || 1)) * n))] = v; return out; });
    const all = cols.flat().filter((v) => v != null);
    const low = num(w.min) ?? Math.min(0, ...all), top = num(w.max) ?? Math.max(...all, low + 1e-9);
    const y = (v) => Math.round((CHART_H - 2) * (1 - Math.max(0, Math.min(1, (v - low) / (top - low || 1)))));
    return v_flex().gap(6)
      .child(h_flex().gap(6).items_stretch()
        .child(v_flex().flex_none().h(CHART_H).justify_between().text_size(10).text_right().text_color(k.dim).child(show(top, { ...w, unit: null })).child(show(low, { ...w, unit: null })))
        .child(h_flex().flex_1().min_w(0).h(CHART_H).border_l(1).border_b(1).border_color(alpha(k.border, 0.8))
          .children(Array.from({ length: n }, (_x, i) => div().relative().flex_1().h(CHART_H)
            .children(cols.map((c, si) => (c[i] == null ? null : div().absolute().left(0).right(0).top(y(c[i])).h(2).bg(colors[si]))).filter(Boolean))))))
      .child(h_flex().justify_between().text_size(10).text_color(k.dim).child(`${age(t1 - t0)} ago`).child("now"))
      .child(h_flex().flex_wrap().gap(10).children(series.map((s, si) => h_flex().gap(5).items_center().text_size(11)
        .child(div().w(8).h(2).flex_none().bg(colors[si]))
        .child(div().max_w(140).truncate().text_color(k.muted).child(String(field(s, w.legend ?? "{.host}{.instance}") || `series ${si + 1}`)))
        .child(div().font_medium().child(show(s.points.filter((p) => p[1] != null).at(-1)?.[1], w))))));
  }

  // status: a dot and a label per item. label and sub (templates), state (a path; default `.value`), thresholds.
  draw_status(k, w, st) {
    return h_flex().flex_wrap().gap(6).children(this.rowsOf(st.data).map((r) => {
      const s = field(r, w.state ?? ".value"), l = level(s, w.thresholds, r) ?? stateLevel(s), sub = field(r, w.sub);
      return h_flex().h(24).px(8).gap(6).flex_none().max_w_full().items_center().rounded(6).bg(alpha(k.foreground, 0.05))
        .child(this.dot(k, l))
        .child(div().min_w(0).truncate().child(String(field(r, w.label ?? ".name") ?? "–")))
        .when(sub != null && sub !== "", (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child(String(sub))));
    }));
  }
}
