// What a group of the side panel shows with nothing open: T3 Code's "Open a surface" launcher
// (RightPanelTabs.tsx), a row per surface with its letter. For the bottom panel (props.bottom),
// a button that starts the space's terminal.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { tokens, alpha, icon, button } from "./look.js";
import { SURFACES, openSurface, openBottom } from "./side.js";

export class Empty {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.bottom = p.bottom === true;
    this.error = null;
    this.focus = cx.focus_handle();
  }
  close() {}
  command() {}

  open(cx, s) {
    if (s.off) return;
    cx.spawn(async (cx) => {
      try { await openSurface(cx, this.group, s.kind); } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  render(_cx) {
    const k = tokens();
    const root = v_flex().id(`ht3-empty-${this.bottom ? "bottom" : this.group}`).size_full().items_center().justify_center().bg(k.background).text_color(k.foreground).text_size(14);
    if (this.bottom) {
      return root.gap(12)
        .child(div().text_color(k.muted).child("No terminal for this space yet."))
        .child(button(k, "bottom-open", "Open terminal", (cx) => {
          cx.spawn(async (cx) => { try { await openBottom(cx); } catch (e) { this.error = String(e?.message ?? e); } cx.notify(); });
        }, { variant: "default", size: "sm", glyph: "square-terminal" }))
        .when(!!this.error, (el) => el.child(div().max_w(320).text_size(12).text_color(k.destructiveText).child(this.error)));
    }
    return root
      .child(v_flex().w_full().max_w(320).py(24).px(16).gap(2)
        .child(div().mb(8).text_center().font_medium().child("Open a surface"))
        .children(SURFACES.map((s) => {
          const el = h_flex().id(`empty-${s.kind}`).h(32).px(10).gap(10).items_center().rounded(8).text_size(14)
            .child(icon(s.glyph).size(16).flex_none().text_color(k.muted))
            .child(div().flex_1().min_w(0).truncate().text_color(s.off ? k.dim : k.foreground).child(s.label))
            .child(div().flex_none().h(18).min_w(18).px(4).flex().items_center().justify_center().rounded(4).bg(alpha(k.foreground, 0.07)).text_size(11).font_medium().text_color(k.muted).child(s.key.toUpperCase()));
          if (s.off) return el.opacity(0.5).tooltip(s.off);
          return el.role("button").accessibility_label(s.label).cursor_pointer().hover((st) => st.bg(k.accent)).on_click((_e, cx) => this.open(cx, s));
        }))
        .when(!!this.error, (el) => el.child(div().pt(8).text_size(12).text_color(k.destructiveText).child(this.error))));
  }
}
