// The Dashboard's Plan map widget (type "plan-map"; "xo-map" is its old name and still loads): xo's planned work as
// the xo-map mod draws it, read-only, inside a card.
// - view "fleet" (default): a region per project with a mini card per component, coloured by status.
//   view "project" with `project`: that project's components in columns by `needs` depth, with the edges.
// - layout "compact" (default): fleet as is, capped in height; a project's cards are their heads only.
//   layout "full": a project's cards list their tasks and live workers, as in xo-map.
// - Data: shared("xo.data") while xo-status keeps it fresh (it runs in the xo layouts); otherwise this widget runs
//   `xo plan --rows` and `xo bearings --rows` itself, which only read. The card's foot says which it was.
// - No `xo act` buttons. A click on a region, a card or "Open full map" opens the real xo-map as a tab (on that
//   project): the mod must be installed (~/.config/herdr-app/mods/xo-map).
// The layout is planmap-graph.js and the data steps planmap-data.js, both copied from xo-map (see their headers); the
// drawing follows xo-map/main.js fleetView and projectView, in this surface's colours.

import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, run, shared, spaces, focused } from "herdr";
import { alpha, icon } from "./look.js";
import { fleetLayout, projectLayout, CARD_HEAD, TASK_ROW, MAX_TASKS, CHIP_ROW, REGION_W, REGION_GAP } from "./planmap-graph.js";
import { normalize, joinLive, counts, taskMark, edgeLook } from "./planmap-data.js";

const FRESH_MS = 60000; // xo.data older than this is nobody's live read
const PAD = 40; // planmap-graph.js lays out with this margin; a card has its own
const VIOLET = "#8f7fd1";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function xo(args) {
  let last = null;
  for (const bin of ["xo", `${home()}/.local/bin/xo`]) {
    let r;
    try { r = await exec(bin, args, { timeout: 15000 }); } catch (e) { last = e; continue; }
    if (r.code === 127) { last = new Error("xo isn't installed"); continue; }
    if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").filter(Boolean).pop()?.replace(/^xo: (error: )?/, "").slice(0, 200) || `xo ${args[0]} exited ${r.code}`);
    return JSON.parse(r.stdout);
  }
  throw new Error(`Needs xo, which isn't installed here (looked on PATH and in ~/.local/bin)${last?.message && !/installed/.test(last.message) ? `: ${String(last.message).slice(0, 80)}` : ""}`);
}

export const planmap = {
  async "load_plan-map"() {
    const s = shared("xo.data");
    if (s?.plan && Date.now() - (Number(s.updated) || 0) < FRESH_MS) return { via: "xo-status", data: joinLive(normalize(s.plan), { rows: s.rows ?? [], bearings: s.bearings ?? [] }) };
    const plan = await xo(["plan", "--rows"]);
    let bearings = null, liveProblem = null;
    try { bearings = await xo(["bearings", "--rows"]); } catch (e) { liveProblem = String(e?.message ?? e); }
    return { via: "xo", data: joinLive(normalize(plan), bearings), liveProblem };
  },
  // The projects xo knows, for the settings form's picker.
  pickOptions(from) {
    if (from !== "xo-projects") return [];
    for (const st of this.state.values()) if (st.data?.data?.projects) return st.data.data.projects.map((p) => p.project);
    return [];
  },
  // arg: a project's name (a click on its region or on one of its cards), or "" for the fleet.
  "press_plan-map"(w, _cx, arg) {
    const project = arg || (w.view === "project" ? w.project : null) || null, name = project ? `Plan map · ${project}` : "Plan map";
    const here = spaces().find((s) => s.id === focused()?.space), had = here?.tabs.find((t) => t.name === name);
    if (had) return run("tab.select", { id: had.id });
    run("tab.new", { name, mod: "xo-map", ...(project ? { props: { project } } : {}) });
  },

  "draw_plan-map"(k, w, st) {
    if (st.data === undefined) return this.say(k, st.error ? (st.missing ? st.error : `xo plan --rows failed: ${st.error}`) : "Reading xo plan…", st.error && !st.missing ? k.destructiveText : k.muted);
    const d = st.data.data, compact = w.layout !== "full";
    const C = { done: k.success, working: VIOLET, planned: alpha(k.muted, 0.55), stuck: k.destructive };
    const sizes = (this.xoSizes ??= new Map()), width = Math.max(280, Math.floor(sizes.get(w.id) ?? 640));
    const p = w.view === "project" ? d.projects.find((x) => x.project === w.project) : null;
    const open = (id, label, project) => h_flex().id(id).h(22).px(8).gap(4).flex_none().items_center().rounded(6).border(1).border_color(k.input).text_size(11).text_color(k.muted).cursor_pointer()
      .role("button").accessibility_label(label).hover((s) => s.bg(k.accent).text_color(k.foreground))
      .on_click((_e, cx) => { if (!this.editing) this["press_plan-map"](w, cx, project); }).child(icon("arrow-up-right").size(12)).child("Open full map");
    const live = d.projects.reduce((a, x) => a + x.live, 0), need = d.projects.reduce((a, x) => a + x.needsYou, 0);
    let head, canvas;
    if (w.view === "project" && !p) {
      head = `No project "${w.project ?? ""}"`;
      canvas = this.say(k, d.projects.length ? `xo knows: ${d.projects.map((x) => x.project).join(", ")}. Pick one in this widget's settings.` : "xo knows no projects.", k.muted);
    } else if (p) {
      const n = counts(p);
      head = `${p.project} · ${plural(p.components.length, "component")} · ${n.done} done · ${n.working} working · ${n.stuck} stuck${p.live ? ` · ${p.live} live` : ""}${p.needsYou ? ` · ${p.needsYou} need you` : ""}`;
      canvas = !p.has_plan || !p.components.length ? this.say(k, p.has_plan ? "PLAN.md has no components" : "no PLAN.md", k.muted) : this.xoProject(k, w, p, d, width, compact, C);
    } else {
      const stuck = d.projects.reduce((a, x) => a + counts(x).stuck, 0);
      head = `Fleet · ${plural(d.projects.length, "project")}${stuck ? ` · ${stuck} stuck` : ""}${live ? ` · ${live} live` : ""}${need ? ` · ${need} need you` : ""}`;
      canvas = d.projects.length ? this.xoFleet(k, w, d, width, compact, C) : this.say(k, "xo knows no projects.", k.muted);
    }
    return v_flex().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(need ? k.warningText : k.foreground).child(head))
        .child(open(`xo-open-${w.id}`, "Open the full map (the xo-map mod)", p?.project ?? "")))
      .child(div().id(`xo-size-${w.id}`).w_full().on_size_change((size, cx) => { if (Math.abs((sizes.get(w.id) ?? 0) - size.width) >= 1) { sizes.set(w.id, size.width); cx.notify(); } }).child(canvas))
      .child(h_flex().gap(10).flex_wrap().items_center().text_size(10).text_color(k.dim)
        .children(["done", "working", "planned", "stuck"].map((s) => h_flex().gap(4).items_center().child(div().size(7).rounded_full().bg(C[s])).child(s)))
        .child(div().flex_1())
        .child(st.data.via === "xo-status" ? "from xo-status" : `from xo plan --rows${st.data.liveProblem ? " · no live work: xo bearings failed" : ""}`));
  },

  xoFleet(k, w, d, width, compact, C) {
    // Two regions side by side where the card is nearly wide enough: drawn a little smaller instead of one per row.
    const two = 2 * REGION_W + REGION_GAP, z = d.projects.length > 1 && width < two ? Math.max(0.78, Math.min(1, width / two)) : 1;
    const L = fleetLayout(d.projects, width / z + 2 * PAD), byProject = Object.fromEntries(d.projects.map((p) => [p.project, p]));
    const H = (L.height - 2 * PAD) * z, cap = compact ? 250 : 640;
    const inner = div().relative().w_full().h(H).children(L.regions.map((r) => {
      const p = byProject[r.project], n = counts(p);
      return div().id(`xo-region-${w.id}-${r.project}`).absolute().left((r.x - PAD) * z).top((r.y - PAD) * z).w(Math.min(r.w * z, width)).h(r.h * z).rounded(10 * z).bg(alpha(k.foreground, 0.03))
        .border(1).border_color(p.needsYou ? k.warning : alpha(k.border, 0.9)).overflow_hidden().cursor_pointer().role("button").accessibility_label(`Open ${r.project} in the full map`)
        .hover((s) => s.bg(alpha(k.foreground, 0.06))).on_click((_e, cx) => { if (!this.editing) this["press_plan-map"](w, cx, r.project); })
        .child(h_flex().absolute().left(14 * z).top(11 * z).right(14 * z).h(22 * z).gap(8 * z).items_center()
          .child(div().min_w(0).truncate().font_semibold().text_size(13 * z).child(r.project))
          .child(div().flex_1())
          .when(p.needsYou > 0, (el) => el.child(div().flex_none().px(6).rounded(8).bg(alpha(k.warning, 0.15)).text_color(k.warningText).text_size(11 * z).child(`${p.needsYou} need you`)))
          .when(p.live > 0, (el) => el.child(div().flex_none().font_family(k.mono).text_size(11 * z).text_color(VIOLET).child(`${p.live} live`)))
          .when(!r.empty, (el) => el.child(div().flex_none().font_family(k.mono).text_size(11 * z).text_color(k.muted).child(`${n.done}/${p.components.length}`))))
        .when(r.empty, (el) => el.child(div().absolute().left(14 * z).top(50 * z).text_size(12 * z).text_color(k.muted).child(p.has_plan ? "PLAN.md has no components" : "no PLAN.md")))
        .children(r.minis.map((m, j) => {
          const c = p.components[j];
          return div().absolute().left((m.x - r.x) * z).top((m.y - r.y) * z).w(m.w * z).h(m.h * z).rounded(6 * z).bg(alpha(k.foreground, 0.07)).overflow_hidden()
            .child(div().absolute().left(0).top(0).w(3).h(m.h * z).bg(C[c.status] ?? C.planned))
            .when(c.workers?.length > 0, (el) => el.child(div().absolute().right(6 * z).top((m.h / 2 - 3.5) * z).size(7 * z).rounded_full().bg(c.needsYou ? k.warning : VIOLET)))
            .child(h_flex().absolute().left(10 * z).top(0).right(18 * z).h(m.h * z).items_center().child(div().min_w(0).truncate().text_size(11 * z).text_color(alpha(k.foreground, 0.85)).child(c.title)));
        }));
    }));
    return div().id(`xo-fleet-${w.id}`).w_full().h(Math.min(H, cap)).overflow_y_scrollbar().child(inner);
  },

  xoProject(k, w, p, d, width, compact, C) {
    // Compact: the cards are their heads (no tasks, chips or trail), so the layout is as short as the plan allows.
    const shown = compact ? { ...p, components: p.components.map((c) => ({ ...c, tasks: [], done: [], workers: [], had: c.workers?.length ?? 0 })) } : p;
    const cache = (this.xoLayouts ??= new Map()), key = `${w.id}|${compact}|${JSON.stringify(shown.components.map((c) => [c.id, c.needs, c.links, c.tasks.length, c.workers?.length ?? 0, c.done.length]))}`;
    if (cache.get(w.id)?.key !== key) cache.set(w.id, { key, L: projectLayout(shown, d.edges), paths: null });
    const hit = cache.get(w.id), L = hit.L;
    const W0 = L.width - 2 * PAD + 16, H0 = L.height - 2 * PAD + 16, off = PAD - 8;
    const z = Math.max(compact ? 0.5 : 0.62, Math.min(1, width / W0));
    const X = (v) => (v - off) * z, Y = (v) => (v - off) * z;
    const byId = Object.fromEntries(p.components.map((c) => [c.id, c]));
    if (hit.z !== z || !hit.paths || hit.dark !== k.dark) {
      const paths = [], heads = [];
      for (const e of L.edges) {
        const { x1, y1, ax, ay, bx, by, x2, y2 } = e.curve;
        const look = e.stub ? "plain" : edgeLook(e, byId);
        const color = look === "red" ? k.destructive : look === "live" ? VIOLET : e.kind === "links" ? alpha(k.muted, 0.6) : k.muted;
        let path = PathBuilder.stroke(look === "plain" ? (e.kind === "links" ? 1.25 : 1.5) : 2);
        if (look === "live") path = path.dash_array([6, 4]); else if (e.kind === "links") path = path.dash_array([2, 6]);
        paths.push({ path: path.move_to(X(x1), Y(y1)).cubic_bezier_to(X(x2), Y(y2), X(ax), Y(ay), X(bx), Y(by)).build(), color });
        if (e.arrow) { const s = 8 * z; heads.push({ path: PathBuilder.fill().add_polygon([[X(x2) - s, Y(y2) - s / 2], [X(x2), Y(y2)], [X(x2) - s, Y(y2) + s / 2]], true).build(), color }); }
      }
      hit.paths = [...paths, ...heads]; hit.z = z; hit.dark = k.dark;
    }
    const cards = shown.components.map((c) => {
      const q = L.pos[c.id], col = C[c.status] ?? C.planned, real = byId[c.id], tasks = c.tasks.slice(0, MAX_TASKS);
      const chipTop = CARD_HEAD + (tasks.length + (c.tasks.length > MAX_TASKS ? 1 : 0)) * TASK_ROW;
      return div().id(`xo-card-${w.id}-${c.id}`).absolute().left(X(q.x)).top(Y(q.y)).w(q.w * z).h(q.h * z).rounded(9 * z).bg(k.card)
        .border(1).border_color(real.needsYou ? k.warning : c.status === "stuck" ? k.destructive : k.border).overflow_hidden().cursor_pointer()
        .role("button").accessibility_label(`${c.title}: ${c.status}. Open ${p.project} in the full map`).hover((s) => s.bg(k.accent))
        .on_click((_e, cx) => { if (!this.editing) this["press_plan-map"](w, cx, p.project); })
        .child(div().absolute().left(0).top(0).w(q.w * z).h(3 * z).bg(col))
        .child(h_flex().absolute().left(10 * z).top(9 * z).right(8 * z).h((CARD_HEAD - 12) * z).gap(6 * z).items_center().min_w(0)
          .child(div().flex_none().size(8 * z).rounded_full().bg(col))
          .child(div().min_w(0).flex_1().truncate().font_semibold().text_size(12.5 * z).child(c.title))
          .when(c.had > 0, (el) => el.child(div().flex_none().size(7 * z).rounded_full().bg(real.needsYou ? k.warning : VIOLET)))
          .child(div().flex_none().font_family(k.mono).text_size(9.5 * z).text_color(k.dim).child(c.status)))
        .children(tasks.map((t, i) => {
          const m = taskMark(t);
          return h_flex().absolute().left(10 * z).right(8 * z).top((CARD_HEAD + i * TASK_ROW) * z).h(TASK_ROW * z).gap(6 * z).items_center().min_w(0)
            .child(div().flex_none().font_family(k.mono).text_size(10.5 * z).text_color(C[m.state] ?? k.dim).child(`[${m.mark}]`))
            .child(div().min_w(0).flex_1().truncate().text_size(11 * z).text_color(m.state === "done" ? k.muted : alpha(k.foreground, 0.85)).child(t.title));
        }))
        .when(c.tasks.length > MAX_TASKS, (el) => el.child(div().absolute().left(10 * z).top((CARD_HEAD + MAX_TASKS * TASK_ROW) * z).font_family(k.mono).text_size(10 * z).text_color(k.dim).child(`+${c.tasks.length - MAX_TASKS} more`)))
        .children((c.workers ?? []).map((x, i) => h_flex().absolute().left(8 * z).right(8 * z).top((chipTop + i * CHIP_ROW) * z).h((CHIP_ROW - 4) * z).px(6 * z).gap(5 * z).items_center().min_w(0).rounded(5 * z)
          .bg(alpha(k.foreground, 0.06)).border(1).border_color(x.needsYou ? k.warning : VIOLET)
          .child(div().flex_none().size(7 * z).rounded_full().bg(x.agent === "blocked" ? k.warning : x.agent === "working" ? VIOLET : k.muted))
          .child(div().min_w(0).flex_1().truncate().font_family(k.mono).text_size(10 * z).child(x.slug))
          .child(div().flex_none().font_family(k.mono).text_size(9 * z).text_color(k.muted).child(x.harness + (x.host ? `@${x.host}` : "")))));
    });
    const stubs = L.stubs.map((s) => h_flex().absolute().left(X(s.x)).top(Y(s.y)).w(s.w * z).h(s.h * z).px(4 * z).items_center().justify_center().rounded(9 * z)
      .border(1).border_dashed().border_color(k.muted).font_family(k.mono).text_size(10 * z).text_color(k.muted).child(div().truncate().child(s.label)));
    const W = W0 * z, H = H0 * z, cap = compact ? 260 : 640;
    return div().id(`xo-proj-${w.id}`).w_full().h(Math.min(H, cap)).overflow_scroll()
      .child(div().relative().w(W).h(H)
        .children(hit.paths.map((e) => window.paint_path(e.path, e.color).absolute().left(0).top(0).w(W).h(H)))
        .children(cards).children(stubs));
  },
};
