// LCARS: the frame of the lcars layout. One mod draws every part; the layout says which with props().part:
// "top" (the upper elbow, arm and title), "side" (spaces and crew as LCARS buttons), "tabs" (the tab pills)
// and "bottom" (the lower elbow and the status arm).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, machines, run, props, setAgentOrder, window } from "herdr";

const C = {
  black: "#000000", orange: "#ff9900", peach: "#ff9966", gold: "#ffcc66", tan: "#ffcc99", lilac: "#cc99cc",
  violet: "#9999ff", blue: "#99ccff", sky: "#5599ff", red: "#ff5544", gray: "#666688",
};
const SPACE_COLORS = [C.tan, C.lilac, C.peach, C.blue, C.violet];
const STATUS = { working: C.blue, blocked: C.red, done: C.gold, idle: C.violet };
const WORD = { working: "WORKING", blocked: "NEEDS YOU", done: "DONE", idle: "STANDING BY" };
const SIDE = 210; // the sidebar's width, which the elbows match
const ARM = 20; // the thickness of the horizontal arms
const GAP = 4; // black between LCARS blocks

const up = (s) => String(s ?? "").toUpperCase();
const two = (n) => String(n).padStart(2, "0");

function stardate(now) {
  // a made-up but steady stardate: year, then the day's fraction of the year
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear() - 1920}${(((now - start) / 864e5) * 2.7397).toFixed(1).padStart(6, "0")}`;
}

// a block of LCARS colour with a black label set in its bottom-right corner
function slab(id, color, label, h, extra) {
  let el = div().id(id).w_full().h(h).flex_none().bg(color).flex().items_end().justify_end().px(10).pb(2)
    .text_color(C.black).text_size(15).font_weight(700).child(up(label));
  return extra ? extra(el) : el;
}

export default class Lcars extends View {
  init(_props, cx) {
    this.now = Date.now();
    cx.timer.every(15000, (cx) => { this.now = Date.now(); cx.notify(); });
  }

  render() {
    const part = props()?.part;
    if (part === "top") return this.top();
    if (part === "side") return this.side();
    if (part === "tabs") return this.tabs();
    if (part === "bottom") return this.bottom();
    return div().child(`lcars: unknown part ${part}`);
  }

  top() {
    const space = spaces().find((s) => s.active);
    const elbow = div().w(SIDE).h_full().flex_none().bg(C.orange).rounded_tl(44)
      .flex().items_end().justify_end().px(10).pb(4).text_color(C.black).text_size(13).font_weight(700)
      .child(up(space?.machine ?? "this computer"));
    const arm = h_flex().w_full().h(ARM).flex_none().gap(GAP)
      .child(div().w(160).h_full().bg(C.orange))
      .child(div().w(70).h_full().bg(C.lilac))
      .child(div().flex_1().h_full().bg(C.tan))
      .child(div().w(46).h_full().bg(C.blue).rounded_tr(10).rounded_br(10));
    // the concave inner corner: black with a rounded top-left corner, over the elbow's orange
    const title = div().w_full().flex_1().bg(C.orange).child(
      h_flex().size_full().bg(C.black).rounded_tl(26).items_center().justify_end().gap(14).pr(4)
        .child(div().text_color(C.gold).text_size(13).font_weight(700).child(`STARDATE ${stardate(this.now)}`))
        .child(div().text_color(C.orange).text_size(30).font_weight(700).child(up(space?.name ?? "HERDR"))));
    return h_flex().size_full().bg(C.black)
      .child(elbow)
      .child(v_flex().flex_1().h_full().child(arm).child(title));
  }

  side() {
    const list = spaces();
    const crew = agents();
    setAgentOrder(crew.map((a) => a.address));
    const space = (s, i) => {
      const color = s.active ? C.orange : s.status === "blocked" ? C.red : SPACE_COLORS[i % SPACE_COLORS.length];
      return h_flex().id(`space-${s.id}`).w_full().h(40).flex_none().bg(color).items_end().justify_between().px(10).pb(2)
        .text_color(C.black).font_weight(700).cursor_pointer()
        .hover((st) => st.opacity(0.85))
        .when(s.status === "blocked" && !s.active, (el) => el.loop("opacity", { from: 0.55, to: 1, period: 900 }))
        .on_click(() => run("space.select", { id: s.id }))
        .child(div().text_size(12).child(`${two(s.index)}${s.machine ? "-" + up(s.machine) : ""}`))
        .child(div().text_size(15).truncate().child(up(s.name)));
    };
    const member = (a) => h_flex().id(`agent-${a.address}`).w_full().h(40).flex_none().gap(6).items_center()
      .cursor_pointer().hover((st) => st.opacity(0.85))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(div().w(14).h_full().bg(STATUS[a.status] ?? C.gray).rounded_l(15)
        .when(a.status === "blocked", (el) => el.loop("opacity", { from: 0.4, to: 1, period: 700 })))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_weight(700).text_color(a.focused ? C.orange : C.tan).truncate()
          .child(up(`${a.program?.name ?? a.app ?? "agent"} · ${a.tab_name}`)))
        .child(div().text_size(11).text_color(STATUS[a.status] ?? C.gray).truncate()
          .child(`${WORD[a.status] ?? up(a.status)} · ${up(a.space_name)}`)));
    return v_flex().size_full().bg(C.black).gap(GAP)
      .child(div().w_full().h(18).flex_none().bg(C.orange)) // carries the top elbow down
      .child(slab("spaces-label", C.peach, `spaces ${two(list.length)}`, 26))
      .children(list.map(space))
      .child(slab("crew-label", C.lilac, `crew ${two(crew.length)}`, 26))
      .child(v_flex().id("crew").w_full().flex_none().gap(2).pr(4).children(crew.map(member)))
      .child(div().w_full().flex_1().min_h(10).bg(C.gray)); // runs into the bottom elbow
  }

  tabs() {
    const space = spaces().find((s) => s.active);
    const pill = (t) => {
      const color = t.active ? C.orange : STATUS[t.status] ?? C.tan;
      return h_flex().id(`tab-${t.id}`).h_full().flex_none().px(16).rounded(15).bg(color).items_center()
        .text_color(C.black).text_size(14).font_weight(700).cursor_pointer()
        .hover((st) => st.opacity(0.85))
        .when(t.status === "blocked" && !t.active, (el) => el.loop("opacity", { from: 0.5, to: 1, period: 800 }))
        .on_click(() => run("tab.select", { id: t.id }))
        .child(`${two(t.index)} ${up(t.name)}`);
    };
    return h_flex().size_full().gap(GAP + 2).items_center().overflow_x_scrollbar()
      .children((space?.tabs ?? []).filter((t) => !t.settled).map(pill))
      .child(h_flex().id("tab-new").h_full().flex_none().px(14).rounded(15).bg(C.gray).items_center()
        .text_color(C.black).text_size(16).font_weight(700).cursor_pointer().hover((st) => st.bg(C.violet))
        .on_click(() => run("tab.new", {})).child("+"));
  }

  bottom() {
    const crew = agents();
    const count = (s) => crew.filter((a) => a.status === s).length;
    const away = machines().filter((m) => m.name).length;
    const clock = new Date(this.now).toTimeString().slice(0, 5);
    const elbow = div().w(SIDE).h_full().flex_none().bg(C.gray).rounded_bl(40);
    const status = div().w_full().flex_1().bg(C.gray).child(
      h_flex().size_full().bg(C.black).rounded_bl(22).items_center().gap(18).pl(18).text_size(12).font_weight(700)
        .child(div().text_color(C.blue).child(`${two(count("working"))} WORKING`))
        .child(div().text_color(count("blocked") ? C.red : C.gray).child(`${two(count("blocked"))} NEED YOU`))
        .child(div().text_color(C.gold).child(`${two(count("done"))} DONE`))
        .child(div().text_color(C.lilac).child(`${two(away + 1)} MACHINES`))
        .child(div().flex_1())
        .child(div().id("palette").text_color(C.tan).cursor_pointer().on_click(() => run("app.palette"))
          .child(`${window()?.platform === "macos" ? "⌘" : "CTRL"} SHIFT P · ${clock}`)));
    const arm = h_flex().w_full().h(16).flex_none().gap(GAP)
      .child(div().w(120).h_full().bg(C.gray))
      .child(div().flex_1().h_full().bg(C.sky))
      .child(div().w(90).h_full().bg(C.peach))
      .child(div().w(46).h_full().bg(C.orange).rounded_tr(8).rounded_br(8));
    return h_flex().size_full().bg(C.black)
      .child(elbow)
      .child(v_flex().flex_1().h_full().child(status).child(arm));
  }
}
