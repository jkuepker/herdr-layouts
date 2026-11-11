// The Dashboard's widget types beyond the six data ones (dashboard.js mixes these in; dash-types.js is what the
// editor knows of them): gauge, text, log, heatmap, link, terminal, chat.
// A type draws with draw_<type>(k, w, st). One that gets its data itself has load_<type>(w) (asked at the widget's
// refresh, as a source would be), and one that does something on a click has press_<type>(w, cx, arg), which
// `ht3-panels.dashboard-press:<widget>[:<arg>]` also reaches.

import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, hc, run, shared, setShared, spaces, readTextFile, appHome } from "herdr";
import { MOD, alpha, icon, agentMark } from "./look.js";
import { openScript, activate, ensureShown } from "./side.js";
import { field, num, show, level } from "./dash-data.js";

const TERMS = `${MOD}.dashterms`; // { "<command>|<cwd>|<on>": terminal address }: the terminals this surface's buttons opened
const termKey = (w) => `${w.command ?? ""}|${w.cwd ?? ""}|${w.on ?? ""}`;
// A shell waiting is not the command's last line: a bare prompt sign, user@host…, or a prompt drawn with icon-font glyphs.
const PROMPT = /^\S{0,40}\s?[%$#❯>]\s*$|^[^\s]*@[^\s]*.*[%$#❯]\s*$|[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u;
const STATUS = { working: "info", blocked: "warning", done: "success", idle: "muted" };

export const widgets = {
  // ---- gauge: a 270° ring from `min` (0) to `max` (100), filled to the value, coloured by thresholds ----
  draw_gauge(k, w, st) {
    const row = Array.isArray(st.data) ? st.data[0] : st.data;
    const v = num(this.statValue(w, st.data)), lo = num(w.min) ?? 0, hi = num(field(row, w.max)) ?? 100;
    const share = v == null ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
    const l = level(v, w.thresholds, row), color = this.fill(k, l), sub = field(row, w.sub);
    const S = 104, R = 42, C = S / 2, T = 9;
    const at = (deg) => [C + R * Math.cos((deg * Math.PI) / 180), C + R * Math.sin((deg * Math.PI) / 180)];
    const arc = (to) => { const [x0, y0] = at(135), [x1, y1] = at(135 + to); return PathBuilder.stroke(T).move_to(x0, y0).arc_to(R, R, 0, to > 180, true, x1, y1).build(); };
    const text = show(v, { ...w, unit: null });
    return v_flex().items_center().gap(4)
      .child(div().relative().size(S).flex_none()
        .child(window.paint_path(arc(270), alpha(k.foreground, 0.1)).absolute().left(0).top(0).w(S).h(S))
        .when(share > 0.004, (el) => el.child(window.paint_path(arc(270 * share), color).absolute().left(0).top(0).w(S).h(S)))
        .child(v_flex().absolute().left(0).top(0).size(S).items_center().justify_center()
          .child(div().text_size(text.length > 5 ? 15 : 20).line_height("24px").font_semibold().text_color(this.tone(k, l) ?? k.foreground).child(text))
          .when(!!w.unit && text !== "–", (el) => el.child(div().text_size(11).line_height("13px").text_color(k.muted).child(w.unit)))))
      .child(div().text_size(11).line_height("15px").text_color(k.muted).child(sub != null && sub !== "" ? String(sub) : `of ${show(hi, w)}`));
  },

  // ---- text: Markdown (or plain) written in the file (`text`), or what a source answers (`value` picks a field) ----
  draw_text(k, w, st) {
    let text;
    if (w.source) {
      if (st.data === undefined) return this.say(k, st.error ?? "Loading…", st.error ? k.destructiveText : k.muted);
      const v = w.value != null ? field(st.data, w.value) : st.data;
      text = v == null ? "" : typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join("\n") : JSON.stringify(v, null, 2);
    } else text = String(w.text ?? "");
    if (!text.trim()) return this.say(k, w.empty ?? "Nothing to show", k.muted);
    text = text.slice(0, 20000);
    if (w.plain) return v_flex().text_size(12).line_height("18px").children(text.split("\n").slice(0, 400).map((l) => div().min_h(18).child(l || " ")));
    return div().text_size(13).line_height("20px").child(TextView.markdown(`dash-md-${w.id}`, text).selectable(true));
  },

  // ---- log: the last `lines` (12) lines of what the source answers, monospace, the newest at the bottom ----
  draw_log(k, w, st) {
    const all = (Array.isArray(st.data) ? st.data.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : String(st.data).split("\n")).map((l) => l.replace(/\s+$/, ""));
    while (all.length && !all.at(-1)) all.pop();
    const n = Math.max(1, Math.min(200, Number(w.lines) || 12)), lines = all.slice(-n);
    if (!lines.length) return this.say(k, w.empty ?? "No lines", k.muted);
    return v_flex().px(8).py(6).rounded(6).bg(alpha(k.foreground, 0.04)).font_family(k.mono).text_size(11).line_height("16px").overflow_hidden()
      .children(lines.map((l, i) => { const el = div().min_h(16).text_color(i === lines.length - 1 ? k.foreground : alpha(k.foreground, 0.7)); return (w.wrap ? el : el.truncate()).child(l.slice(0, 2000) || " "); }));
  },

  // ---- heatmap: a row per series or name, a cell per time step or column, coloured by the value ----
  // With a range source (rows with `points`) the columns are `steps` (24) equal time steps and a cell is the mean of
  // its step. Without, each data row is one cell: `row`, `col`, `value` name its place and value.
  draw_heatmap(k, w, st) {
    const data = this.rowsOf(st.data), timed = data.some((r) => Array.isArray(r?.points));
    let names = [], cols = [], cell = new Map(), foot = null;
    if (timed) {
      const series = data.filter((r) => Array.isArray(r?.points) && r.points.length).slice(0, 24);
      if (!series.length) return this.say(k, "No points", k.muted);
      const t0 = Math.min(...series.map((s) => s.points[0][0])), t1 = Math.max(...series.map((s) => s.points.at(-1)[0]));
      const n = Math.max(1, Math.min(96, Number(w.steps) || 24));
      cols = Array.from({ length: n }, (_x, i) => i);
      series.forEach((s, si) => {
        const name = String(field(s, w.label ?? "{.host}{.instance}") || `series ${si + 1}`), sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
        for (const [t, v] of s.points) if (v != null) { const i = Math.min(n - 1, Math.floor(((t - t0) / (t1 - t0 || 1)) * n)); sum[i] += v; cnt[i]++; }
        names.push(name);
        cols.forEach((i) => { if (cnt[i]) cell.set(`${name}|${i}`, sum[i] / cnt[i]); });
      });
      const span = t1 - t0;
      foot = [`${span >= 5400 ? `${Math.round(span / 3600)}h` : `${Math.round(span / 60)}m`} ago`, "now"];
    } else {
      for (const r of data) {
        const name = String(field(r, w.row ?? ".row") ?? ""), col = String(field(r, w.col ?? ".col") ?? ""), v = num(field(r, w.value ?? ".value"));
        if (!names.includes(name)) names.push(name);
        if (!cols.includes(col)) cols.push(col);
        if (v != null) cell.set(`${name}|${col}`, v);
      }
      names = names.slice(0, 24); cols = cols.slice(0, 48);
    }
    const all = [...cell.values()], lo = num(w.min) ?? Math.min(0, ...all), most = Math.max(...all, lo), hi = num(w.max) ?? (most > lo ? most : lo + 1);
    const LW = w.labelWidth ?? 84;
    const paint = (v) => {
      if (v == null) return alpha(k.foreground, 0.05);
      const l = level(v, w.thresholds, null);
      return l ? alpha(this.fill(k, l), l === "ok" ? 0.55 : 0.9) : alpha(k.info, 0.1 + 0.9 * Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))));
    };
    return v_flex().gap(2)
      .children(names.map((name, ri) => h_flex().h(16).gap(6).items_center()
        .child(div().w(LW).flex_none().truncate().text_size(11).text_color(k.muted).child(name))
        .child(h_flex().flex_1().min_w(0).h(14).gap(1).children(cols.map((c, ci) => {
          const v = cell.get(`${name}|${c}`);
          return div().id(`hm-${w.id}-${ri}-${ci}`).flex_1().min_w(2).h(14).rounded(2).bg(paint(v)).tooltip(`${name}${timed ? "" : ` · ${c}`}: ${show(v, w)}`);
        })))))
      .child(h_flex().gap(6).pt(2).text_size(10).text_color(k.dim)
        .child(div().w(LW).flex_none())
        .child(timed ? h_flex().flex_1().justify_between().child(foot[0]).child(foot[1])
          : h_flex().flex_1().min_w(0).gap(1).children(cols.map((c) => div().flex_1().min_w(2).truncate().text_center().child(cols.length > 16 ? "" : c)))))
      .when(!w.thresholds, (el) => el.child(h_flex().gap(6).items_center().text_size(10).text_color(k.dim)
        .child(div().w(LW).flex_none())
        .child(show(lo, w)).child(h_flex().w(72).h(6).gap(1).children([0.1, 0.3, 0.55, 0.8, 1].map((a) => div().flex_1().h(6).rounded(1).bg(alpha(k.info, a))))).child(show(hi, w))));
  },

  // ---- link: a button. `url` (the system browser), `space` (a space by name or id), or `run` with `args` (a Herdr command) ----
  draw_link(k, w) {
    const what = w.url ? "external-link" : w.space ? "arrow-up-right" : "play";
    const sub = w.sub ?? (w.url ? String(w.url) : w.space ? `Space ${w.space}` : w.run ? String(w.run) : "Nothing to do: set a command, an address or a space");
    return this.pressable(k, w, h_flex().gap(10).items_center()
      .child(h_flex().size(28).flex_none().items_center().justify_center().rounded(8).bg(alpha(k.primary, 0.14)).text_color(k.foreground).child(icon(what).size(14)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).font_medium().child(String(w.label ?? w.title ?? "Open")))
        .child(div().truncate().text_size(11).line_height("15px").text_color(k.muted).child(sub))), String(w.label ?? w.title ?? "Open"));
  },
  press_link(w) {
    if (w.url) { if (/^https?:\/\//i.test(String(w.url))) exec("open", [String(w.url)]).catch(() => {}); return; }
    if (w.space) { const s = spaces().find((x) => x.id === w.space || x.name === w.space || x.name.replace(/​/g, "") === w.space); if (s) run("space.select", { id: s.id }); return; }
    if (w.run) run(String(w.run), w.args && typeof w.args === "object" ? w.args : {});
  },

  // ---- terminal: a button that opens a terminal tab in the side panel and types `command` there; shows its last line ----
  // The terminal is remembered by its command (shared "ht3-panels.dashterms"), so a second click goes to it, and
  // "Run again" types the command once more. Its last line is what `hc read` prints last that isn't a shell prompt.
  async load_terminal(w) {
    const addr = (shared(TERMS) ?? {})[termKey(w)];
    if (!addr) return { addr: null };
    const r = await hc(["read", addr]).catch(() => null);
    if (!r || r.code !== 0) { const all = { ...(shared(TERMS) ?? {}) }; delete all[termKey(w)]; setShared(TERMS, all); return { addr: null }; }
    const lines = r.stdout.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l && !PROMPT.test(l) && !l.endsWith(String(w.command ?? "\u0000")));
    return { addr, last: lines.at(-1) ?? "" };
  },
  draw_terminal(k, w, st) {
    const d = st.data ?? {}, open = !!d.addr;
    return v_flex().gap(6)
      .child(this.pressable(k, w, h_flex().gap(10).items_center()
        .child(h_flex().size(28).flex_none().items_center().justify_center().rounded(8).bg(alpha(k.primary, 0.14)).text_color(k.foreground).child(icon("square-terminal").size(14)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).font_medium().child(String(w.label ?? w.title ?? "Run")))
          .child(div().truncate().font_family(k.mono).text_size(11).line_height("15px").text_color(k.muted).child(String(w.command ?? "No command set"))))
        .child(div().flex_none().text_size(11).text_color(open ? k.successText : k.dim).child(open ? `Open · ${d.addr}` : "Click to run")), String(w.label ?? "Run")))
      .when(open, (el) => el.child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).px(8).py(4).rounded(6).bg(alpha(k.foreground, 0.04)).truncate().font_family(k.mono).text_size(11).line_height("16px").text_color(d.last ? k.foreground : k.dim).child(d.last || "no output yet"))
        .child(h_flex().id(`dash-rerun-${w.id}`).h(22).px(8).flex_none().items_center().rounded(6).border(1).border_color(k.input).text_size(11).text_color(k.muted).cursor_pointer()
          .role("button").accessibility_label("Run the command again in that terminal").hover((s) => s.bg(k.accent).text_color(k.foreground))
          .on_click((_e, cx) => { if (!this.editing) this.press_terminal(w, cx, "again"); }).child("Run again"))));
  },
  press_terminal(w, cx, arg) {
    if (!w.command) return;
    const key = termKey(w), addr = (shared(TERMS) ?? {})[key];
    const soon = () => { for (const ms of [1500, 4000]) cx.timer.after(ms, (cx) => { this.state.get(w.id) && (this.state.get(w.id).tried = 0); this.poll(cx); }); };
    if (addr && arg === "again") { hc(["send", addr, String(w.command)]).catch(() => {}); return soon(); }
    if (addr) { ensureShown(); activate("a", addr); run("pane.focus", { terminal: addr }); return; }
    openScript({ command: String(w.command), cwd: w.cwd || undefined, on: w.on || null }).then((a) => { if (a) setShared(TERMS, { ...(shared(TERMS) ?? {}), [key]: a }); }, () => {});
    soon();
  },

  // ---- chat: the open chats (or the one named by `chat`): agent mark, name, status, space, last message ----
  // Which chats are open, their status and names come from what chat tabs report (report.js: shared
  // "ht3-panels.places", ".status", ".titles", ".programs", ".named"); the last message from the chat's own file.
  async load_chat(w) {
    const places = shared(`${MOD}.places`) ?? {}, out = {};
    for (const id of Object.keys(places).slice(0, 30)) {
      if (w.chat && w.chat !== id) continue;
      try {
        const text = await readTextFile(`${appHome()}/data/${MOD}/chats/${id}/state.json`);
        const s = text ? JSON.parse(text) : null, said = (s?.transcript?.items ?? []).filter((m) => (m.kind === "agent" || m.kind === "user") && m.text);
        const last = said.at(-1);
        out[id] = { last: last ? String(last.text).replace(/\s+/g, " ").trim().slice(0, 240) : "", who: last?.kind ?? null, agent: s?.agentInfo?.title ?? s?.agentInfo?.name ?? null };
      } catch { out[id] = { last: "", who: null, agent: null }; }
    }
    return out;
  },
  chatRows(w) {
    const places = shared(`${MOD}.places`) ?? {}, status = shared(`${MOD}.status`) ?? {}, titles = shared(`${MOD}.titles`) ?? {}, programs = shared(`${MOD}.programs`) ?? {}, named = shared(`${MOD}.named`) ?? {};
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, s])));
    const rows = Object.entries(places).filter(([id, p]) => tabs.has(p.tab) && (!w.chat || w.chat === id))
      .map(([id, p]) => ({ id, tab: p.tab, pane: p.pane, space: tabs.get(p.tab), status: status[p.tab] ?? "idle", name: named[id] ?? titles[p.tab] ?? "Chat", program: programs[p.tab] ?? null }));
    const rank = { blocked: 0, working: 1, done: 2, idle: 3 };
    return rows.sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4)).slice(0, Math.max(1, Number(w.limit) || 12));
  },
  draw_chat(k, w, st) {
    const rows = this.chatRows(w), more = st.data ?? {};
    if (!rows.length) return this.say(k, w.empty ?? (w.chat ? "That chat isn't open" : "No chat is open"), k.muted);
    return v_flex().gap(4).children(rows.map((r, i) => {
      const tone = STATUS[r.status] ?? "muted", color = tone === "muted" ? alpha(k.muted, 0.6) : k[tone], m = more[r.id] ?? {};
      return this.pressable(k, w, v_flex().gap(2)
        .child(h_flex().gap(8).items_center()
          .child(agentMark(r.program, 14, k.foreground) ?? icon("message-square").size(14).flex_none().text_color(k.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().child(String(r.name)))
          .child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(tone === "muted" ? k.muted : k[`${tone}Text`] ?? color)
            .child(div().size(7).rounded_full().bg(color)).child(r.status)))
        .child(h_flex().gap(8).text_size(11).line_height("15px").text_color(k.muted)
          .child(div().flex_none().max_w(160).truncate().child(`${r.program?.name ?? m.agent ?? "Agent"} · ${r.space.name.replace(/​/g, "")}`))
          .child(div().flex_1().min_w(0).truncate().text_color(alpha(k.foreground, 0.7)).child(m.last ? `${m.who === "user" ? "You: " : ""}${m.last}` : ""))), `Go to the chat ${r.name}`, String(i), r.id);
    }));
  },
  press_chat(w, _cx, arg) {
    const r = this.chatRows(w)[Number(arg) || 0];
    if (!r) return;
    run("tab.select", { id: r.tab });
    if (r.pane) run("pane.focus", { pane: r.pane });
  },

  // A widget body that is a button: press_<type>(w, cx, arg) on a click. Not while editing (a click there is for the tools).
  pressable(k, w, child, label, arg = "", key = "") {
    return div().id(`dash-press-${w.id}-${key || arg}`).p(8).mx(-4).rounded(8).cursor_pointer().role("button").accessibility_label(label)
      .hover((s) => s.bg(alpha(k.foreground, 0.06)))
      .on_click((_e, cx) => { if (!this.editing) { this[`press_${w.type}`]?.(w, cx, arg); cx.notify(); } })
      .child(child);
  },
};
// Types drawn even with no data: they have no source, or draw their own "nothing yet".
export const DIRECT = new Set(["text", "link", "terminal", "chat", "plan-map"]);
