// Slate: a quiet, dense dark frame. One mod draws every part; the layout says which with props().part:
// "top" (brand, text tabs with an underline, the command hint), "side" (the shown space as a pinned card, spaces
// as coloured chips, agents in flight, the concluded ones folded away), "panel" (the shown space's task graph:
// each tab and the agents in it) and "bottom" (the status bar). Right-clicks open Herdr's own menu mod.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, machines, run, props, setAgentOrder, window, openOverlay, home } from "herdr";

const C = {
  top: "#101012", side: "#0f0f11", main: "#121214", panel: "#0e0e10", card: "#242328", hover: "#1a1a1d",
  line: "#1e1e20", text: "#e4e4e7", muted: "#8a898e", dim: "#56555b", accent: "#b4a0db", accentDim: "#625187",
  yellow: "#ffb406", green: "#53cf91", purple: "#8f7fd1", red: "#e0707f",
};
// chips: [text, background], picked by a hash of the name so a space keeps its colour
const CHIPS = [
  ["#e0707f", "#3b1d24"], ["#3ec9b4", "#11302d"], ["#f0a050", "#3a2410"], ["#a690e8", "#2a2245"],
  ["#e6c35c", "#352c10"], ["#6fb3f2", "#152a40"], ["#e88cc8", "#3a1a30"], ["#8fd18a", "#1c321c"],
];
const STATUS = { blocked: C.yellow, working: C.purple, done: C.green, idle: C.dim };
const WORD = { blocked: "waits on you", working: "working", done: "done", idle: "idle" };
const ORDER = { blocked: 0, working: 1, done: 2, idle: 3 };
const MONO = "JetBrains Mono";
const SANS = "Geist";
const SIDE = 300; // the sidebar's width, which the top bar's brand cell matches

const two = (n) => String(n).padStart(2, "0");
const spaced = (s) => String(s ?? "").toUpperCase().split("").join(" "); // letter-spaced capitals
function chip(name) {
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHIPS[h % CHIPS.length];
}
function ago(ms, now) {
  if (!ms) return "";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
// what the program titled its terminal, when that says more than its address
const said = (a) => (a.title && a.title !== a.address ? a.title : "");
const tilde = (p) => (p && home() && p.startsWith(home()) ? "~" + p.slice(home().length) : p ?? "");

// Herdr's menu mod at the pointer: tab is "space", "tab", "pane" or "global"
const menu = (tab, target) => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab, target } });
// Herdr's new menu: a terminal, each installed agent, a new space, worktrees
const newMenu = () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
// a right-click handler that opens one menu; stopping the press keeps the bar behind from opening its own
const onRight = (open) => (_e, cx) => { cx.stop_propagation(); open(); };
const globalMenu = () => menu("global", {});
// a control inside a window_drag bar: its press must not start a window drag
const noDrag = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

const mono = (size, color, text) => div().font_family(MONO).text_size(size).text_color(color).child(text);
const icon = (name, size, color) => svg(`mods/slate/${name}.svg`).size(size).flex_none().text_color(color);
function tag(name) {
  const [fg, bg] = chip(name);
  return div().flex_none().px(5).py(1).rounded(3).bg(bg).text_color(fg).font_family(SANS).text_size(11).truncate().child(name);
}
// the status mark in front of a row: a spinner while working, a check when done, a dot otherwise
function mark(status, size = 12) {
  if (status === "working") return icon("spinner", size, C.purple).spin(900);
  if (status === "done") return icon("circle-check", size, C.green);
  return div().w(size).h(size).flex_none().flex().items_center().justify_center()
    .child(div().w(6).h(6).rounded(3).bg(STATUS[status] ?? C.dim)
      .when(status === "blocked", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 900 })));
}

export default class Slate extends View {
  init(_props, cx) {
    this.now = Date.now();
    // relative times and the clock; Herdr's own data redraws without this
    cx.timer.every(30000, (cx) => { this.now = Date.now(); cx.notify(); });
    this.open = { spaces: true, flight: true, concluded: false };
  }

  render() {
    const part = props()?.part;
    if (part === "top") return this.top();
    if (part === "side") return this.side();
    if (part === "panel") return this.panel();
    if (part === "bottom") return this.bottom();
    return div().child(`slate: unknown part ${part}`);
  }

  // when the agent's tab last changed, or started working
  tabOf(a) {
    for (const s of spaces()) for (const t of s.tabs) if (t.id === a.tab) return t;
    return null;
  }
  when(a) {
    const t = this.tabOf(a);
    return t?.working_since ?? t?.changed_at ?? null;
  }

  top() {
    const space = spaces().find((s) => s.active);
    const mac = window()?.platform === "macos";
    const tab = (t) => h_flex().id(`tab-${t.id}`).h_full().flex_none().px(10).items_center().relative()
      .font_family(MONO).text_size(13).text_color(t.active ? C.text : C.muted).cursor_pointer()
      .hover((st) => st.text_color(C.text))
      .on_click(() => run("tab.select", { id: t.id }))
      .on_mouse_down("right", onRight(() => menu("tab", { id: t.id, space: space.id })))
      .child(h_flex().gap(6).items_center()
        .when(!!t.status && t.status !== "idle", (el) => el.child(mark(t.status, 10)))
        .child(t.name))
      .child(div().absolute().bottom(0).left(8).right(8).h(2).rounded(1).bg(t.active ? C.accent : "#00000000"));
    const brand = h_flex().w(SIDE).h_full().flex_none().pl(mac ? 84 : 16).items_center().gap(8)
      .child(div().font_family(MONO).text_size(12).font_weight(700).text_color(C.accent).child(spaced("herdr")));
    return h_flex().id("top").size_full().bg(C.top).border_b(1).border_color(C.line)
      .on_mouse_down("right", onRight(globalMenu))
      .child(brand)
      .child(h_flex().id("tabs").flex_1().min_w(0).h_full().pl(14).overflow_x_scrollbar()
        .children((space?.tabs ?? []).filter((t) => !t.settled).map((t) => noDrag(tab(t))))
        .child(noDrag(h_flex().id("tab-new").h_full().flex_none().px(8).items_center().cursor_pointer()
          .hover((st) => st.opacity(0.6)).on_click(() => newMenu()).child(icon("plus", 14, C.muted)))))
      .child(h_flex().h_full().flex_none().pr(12).gap(10).items_center()
        .child(noDrag(h_flex().id("palette").gap(6).items_center().cursor_pointer().hover((st) => st.opacity(0.7))
          .on_click(() => run("app.palette"))
          .child(mono(12, C.muted, "commands"))
          .children((mac ? ["⌘", "⇧", "P"] : ["Ctrl", "Shift", "P"]).map((k) =>
            div().px(5).rounded(3).bg(C.card).font_family(MONO).text_size(11).text_color(C.muted).child(k)))))
        .child(noDrag(div().id("panel-toggle").cursor_pointer().hover((st) => st.opacity(0.6))
          .on_click(() => run("layout.toggle", { id: "panel" })).child(icon("panel-right", 15, C.muted)))));
  }

  side() {
    const list = spaces();
    const crew = agents().slice().sort((a, b) => (ORDER[a.status] ?? 4) - (ORDER[b.status] ?? 4));
    setAgentOrder(crew.map((a) => a.address));
    const space = list.find((s) => s.active);
    const flight = crew.filter((a) => a.status === "working" || a.status === "blocked");
    const concluded = crew.filter((a) => a.status !== "working" && a.status !== "blocked");
    // the pinned card counts only the shown space; the lists below cover every space
    const here = crew.filter((a) => a.space === space?.id);
    const waiting = here.filter((a) => a.status === "blocked").length;
    const busy = here.filter((a) => a.status === "working").length;

    const header = h_flex().w_full().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(C.line)
      .child(icon("folder", 14, C.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(C.text).child(tilde(space?.folder) || "no folder"))
      .when(!!space?.branch, (el) => el.child(mono(11, C.dim, space.branch)));

    const name = space?.name ?? "herdr";
    const card = div().px(8).pt(8).pb(6).flex_none().child(
      h_flex().id("pinned").w_full().gap(10).px(10).py(8).rounded(6).bg(C.card).items_center()
        .on_mouse_down("right", onRight(() => space && menu("space", { id: space.id })))
        .child(div().w(24).h(24).flex_none().rounded(5).border(1).border_color(C.accentDim).bg("#2c2838")
          .flex().items_center().justify_center().font_family(MONO).text_size(12).font_weight(700).text_color(C.accent)
          .child(name.slice(0, 1).toUpperCase()))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(8).items_center()
            .child(div().font_family(MONO).text_size(13).font_weight(700).text_color(C.accent).truncate().child(name.toUpperCase()))
            .child(mono(11, C.dim, space?.machine ? `@${space.machine}` : "@local")))
          .child(h_flex().gap(6).items_center()
            .child(div().w(7).h(7).rounded(4).bg(waiting ? C.yellow : C.green))
            .child(mono(11, C.muted, waiting ? `${waiting} waiting on you` : `${busy} working`))
            .child(div().flex_1())
            .child(mono(10, C.dim, ago(space?.tabs?.reduce((m, t) => Math.max(m, t.changed_at ?? 0), 0), this.now))))));

    const section = (key, label, n, extra) => h_flex().id(`sec-${key}`).w_full().h(26).flex_none().px(12).gap(6).items_center()
      .cursor_pointer().on_click((_e, cx) => { this.open[key] = !this.open[key]; cx.notify(); })
      .child(icon(this.open[key] ? "chevron-down" : "chevron-right", 12, C.dim))
      .child(mono(11, C.dim, label.toUpperCase()))
      .child(div().px(5).rounded(8).bg(C.card).font_family(MONO).text_size(10).text_color(C.muted).child(String(n)))
      .child(div().flex_1())
      .children(extra ? [extra] : []);

    const spaceRow = (s) => h_flex().id(`space-${s.id}`).w_full().h(26).flex_none().px(12).gap(8).items_center()
      .bg(s.active ? C.hover : "#00000000").cursor_pointer().hover((st) => st.bg(C.hover))
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", onRight(() => menu("space", { id: s.id })))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(tag(s.name))
        .when(s.status === "blocked", (el) => el.child(mark("blocked", 10))))
      .child(mono(11, C.dim, `${s.tabs.length} ${s.tabs.length === 1 ? "tab" : "tabs"}`))
      .child(div().w(28).flex_none().flex().justify_end()
        .child(mono(11, C.dim, ago(s.tabs.reduce((m, t) => Math.max(m, t.changed_at ?? 0), 0), this.now))));

    const agentRow = (a) => v_flex().id(`agent-${a.address}`).w_full().flex_none().px(12).py(5).gap(3)
      .bg(a.focused ? C.hover : "#00000000").cursor_pointer().hover((st) => st.bg(C.hover))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .on_mouse_down("right", onRight(() => menu("pane", { pane: a.pane, terminal: a.address })))
      .child(h_flex().gap(8).items_center()
        .child(mark(a.status))
        .child(div().flex_1().min_w(0).truncate().font_family(SANS).text_size(13)
          .text_color(a.focused ? C.text : "#c8c8cc").child(a.tab_name)))
      .child(h_flex().pl(20).gap(8).items_center()
        .child(tag(a.space_name))
        .child(mono(11, STATUS[a.status] ?? C.dim, WORD[a.status] ?? a.status ?? ""))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).text_color(C.dim)
          .child(a.program?.name ?? a.app ?? ""))
        .child(mono(11, C.dim, ago(this.when(a), this.now))));

    const addSpace = noDrag(div().id("space-new").cursor_pointer().hover((st) => st.opacity(0.6))
      .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", {}); }).child(icon("plus", 12, C.dim)));

    return v_flex().id("side").size_full().bg(C.side).on_mouse_down("right", onRight(globalMenu))
      .child(header)
      .child(card)
      .child(v_flex().id("side-lists").w_full().flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .child(section("spaces", "spaces", list.length, addSpace))
        .when(this.open.spaces, (el) => el.children(list.map(spaceRow)))
        .child(div().h(8).flex_none())
        .child(section("flight", "in flight", flight.length))
        .when(this.open.flight, (el) => el.children(flight.map(agentRow))
          .when(!flight.length, (el) => el.child(div().px(32).py(4).font_family(MONO).text_size(11).text_color(C.dim).child("nothing running"))))
        .child(div().h(8).flex_none())
        .when(this.open.concluded, (el) => el.child(section("concluded", "concluded", concluded.length)).children(concluded.map(agentRow))))
      // folded, CONCLUDED waits at the foot of the sidebar like the target's
      .when(!this.open.concluded, (el) => el.child(div().border_t(1).border_color(C.line)
        .child(section("concluded", "concluded", concluded.length))));
  }

  // the shown space's task graph: each tab, then the agents working in it on tree lines
  panel() {
    const space = spaces().find((s) => s.active);
    const crew = agents().filter((a) => a.space === space?.id);
    const running = crew.filter((a) => a.status === "working").length;
    const tabs = (space?.tabs ?? []).filter((t) => !t.settled || t.status === "blocked");
    const node = (t) => {
      const inTab = crew.filter((a) => a.tab === t.id);
      return v_flex().id(`node-${t.id}`).w_full().flex_none().gap(2)
        .child(h_flex().id(`node-head-${t.id}`).w_full().px(12).py(4).gap(8).items_center().rounded(4)
          .bg(t.active ? C.hover : "#00000000").cursor_pointer().hover((st) => st.bg(C.hover))
          .on_click(() => run("tab.select", { id: t.id }))
          .on_mouse_down("right", onRight(() => menu("tab", { id: t.id, space: space.id })))
          .child(mark(t.status))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().font_family(SANS).text_size(13).text_color(C.text).child(t.name))
            .child(h_flex().gap(6).items_center()
              .child(tag(space.name))
              .child(mono(11, C.dim, `#${two(t.index)}`))
              .when(t.panes > 1, (el) => el.child(mono(11, C.dim, `${t.panes} panes`)))))
          .child(mono(11, C.dim, ago(t.working_since ?? t.changed_at, this.now))))
        .children(inTab.map((a, i) => h_flex().id(`leaf-${a.address}`).w_full().pl(24).pr(12).gap(6).items_center()
          .cursor_pointer().hover((st) => st.bg(C.hover))
          .on_click(() => run("agent.focus", { terminal: a.address }))
          .child(mono(12, C.line, i === inTab.length - 1 ? "└" : "├"))
          .child(mark(a.status, 11))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().font_family(SANS).text_size(12).text_color("#c8c8cc").child(a.program?.name ?? a.app ?? "agent"))
            .child(div().truncate().font_family(MONO).text_size(11).text_color(STATUS[a.status] ?? C.dim)
              .child(`${WORD[a.status] ?? ""}${said(a) ? " · " + said(a) : ""}`)))));
    };
    const group = (label, list) => !list.length ? [] : [
      h_flex().w_full().px(12).pt(10).pb(4).gap(6).items_center()
        .child(mono(11, C.dim, label.toUpperCase())).child(mono(11, C.dim, String(list.length))),
      ...list.map(node),
    ];
    const by = (st) => tabs.filter((t) => (t.status ?? "idle") === st);
    return v_flex().id("panel").size_full().bg(C.panel).on_mouse_down("right", onRight(globalMenu))
      .child(h_flex().w_full().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(C.line)
        .child(mono(11, C.muted, "TASK GRAPH"))
        .child(div().flex_1())
        .child(mono(11, C.dim, `${tabs.length} live · ${running} running`)))
      .child(v_flex().id("graph").w_full().flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .children(group("waiting on you", by("blocked")))
        .children(group("running", by("working")))
        .children(group("landed", by("done")))
        .children(group("idle", by("idle"))));
  }

  bottom() {
    const crew = agents();
    const count = (s) => crew.filter((a) => a.status === s).length;
    const away = machines().filter((m) => m.name).length;
    const clock = new Date(this.now).toTimeString().slice(0, 5);
    const item = (text, color, dot) => h_flex().gap(5).items_center()
      .when(!!dot, (el) => el.child(div().w(6).h(6).rounded(3).bg(dot)))
      .child(mono(11, color, text));
    return h_flex().id("bottom").size_full().px(12).gap(16).items_center().bg(C.panel).border_t(1).border_color(C.line)
      .on_mouse_down("right", onRight(globalMenu))
      .child(item(`${crew.length} agents`, C.muted))
      .child(item(`${count("working")} working`, C.muted, C.purple))
      .child(item(`${count("blocked")} waiting`, count("blocked") ? C.yellow : C.muted, C.yellow))
      .child(item(`${count("done")} done`, C.muted, C.green))
      .child(div().flex_1())
      .child(item(`${spaces().length} spaces`, C.dim))
      .child(item(`${away + 1} ${away ? "machines" : "machine"}`, C.dim, C.green))
      .child(div().id("settings").cursor_pointer().hover((st) => st.opacity(0.6))
        .on_click(() => run("app.settings")).child(icon("settings", 12, C.dim)))
      .child(item(clock, C.muted));
  }
}
