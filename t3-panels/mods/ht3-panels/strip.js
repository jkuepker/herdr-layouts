// The tab strip of one group of the side panel: T3 Code's RightPanelTabs (a row of 24px tabs
// with an icon each, the active one filled, and a `+` that opens the menu of surfaces), plus a
// button for the project popover and one that splits the panel in two.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { openOverlay } from "herdr";
import { MOD, tokens, alpha, icon, iconButton } from "./look.js";
import { spaceState, activeSpace, surface, activate, closeTab, toggleSplit } from "./side.js";

const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export class Strip {
  init(p) {
    this.group = p.group ?? "a";
    this.press = null; // where the last press on a menu button was
  }
  close() {}
  command() {}

  title(tab, st) {
    if (tab.kind === "terminal") return `Terminal ${tab.n ?? ""}`.trim();
    return { chat: "Side chat", pr: "Pull request", prs: "Linked PRs" }[tab.kind] ?? surface(tab.kind)?.label ?? tab.kind;
  }

  // RightPanelTabs.tsx: 24px tabs, max 144, 6 round, an icon of 12px, the active one filled.
  tab(k, tab, on, st) {
    const g = this.group, title = this.title(tab, st), glyph = surface(tab.kind)?.glyph ?? "file";
    return h_flex().id(`tab-${g}-${tab.id}`).h(24).max_w(144).min_w(40).pl(6).pr(4).gap(4).flex_shrink(1).items_center().overflow_hidden().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? k.accent : "#00000000").text_color(on ? k.foreground : k.muted)
      .hover((s) => s.bg(on ? k.accent : alpha(k.accent, 0.6)).text_color(k.foreground))
      .role("button").accessibility_label(`${title} tab`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { activate(g, tab.id); cx.notify(); })
      .child(h_flex().size(16).flex_none().items_center().justify_center().child(icon(glyph).size(12)))
      .child(div().min_w(0).truncate().child(title))
      .child(h_flex().id(`tab-${g}-${tab.id}-x`).size(16).flex_none().items_center().justify_center().rounded(4)
        .role("button").accessibility_label(`Close ${title}`)
        .hover((s) => s.bg(k.input))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => { await closeTab(cx, g, tab.id); cx.notify(); }); })
        .child(icon("x").size(12)));
  }

  openMenu(kind, props, size) {
    const press = this.press;
    openOverlay({ mod: MOD, kind: "popup", at: press ? { x: Math.max(8, press.x - 12), y: press.y + 18 } : undefined, width: size.w, height: size.h, props: { menu: kind, ...props } });
  }

  render(_cx) {
    const k = tokens();
    const g = this.group, space = activeSpace(), st = spaceState(space?.id);
    const tabs = st[g].tabs;
    const withPress = (el) => el.on_mouse_down("left", (e, cx) => { this.press = e.position; cx.stop_propagation(); });
    return h_flex().id(`ht3-strip-${g}`).size_full().pl(8).pr(8).gap(4).items_center().overflow_hidden().bg(k.background)
      .child(h_flex().min_w(0).flex_shrink(1).gap(4).items_center().overflow_hidden().children(tabs.map((t) => this.tab(k, t, t.id === st[g].active, st))))
      .child(withPress(iconButton(k, `add-${g}`, "plus", () => this.openMenu("add", { group: g }, { w: 296, h: 296 }), { tip: "Add panel surface" })))
      .child(div().flex_1())
      .when(g === "a", (el) => el.child(withPress(h_flex().id("project").h(24).max_w(150).px(6).gap(4).flex_none().items_center().rounded(6).text_size(12).text_color(k.muted).cursor_pointer()
        .hover((s) => s.bg(k.accent).text_color(k.foreground)).role("button").accessibility_label("Project").tooltip("Machine, editor and branch")
        .on_click(() => this.openMenu("project", {}, { w: 344, h: 460 }))
        .child(icon("git-branch").size(14).flex_none())
        .child(div().min_w(0).truncate().child(space?.branch ?? "Project"))
        .child(icon("chevron-down").size(12).flex_none()))))
      .child(stop(iconButton(k, `split-${g}`, "rows-2", (cx) => { cx.spawn(async (cx) => { await toggleSplit(cx); cx.notify(); }); },
        { on: st.split, tip: st.split ? "Merge the panel back into one" : "Split the panel" })));
  }
}
