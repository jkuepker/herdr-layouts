// What a group of the side panel shows with nothing open: T3 Code's "Open a surface" launcher
// (RightPanelTabs.tsx), a row per surface with its letter. For the bottom panel (props.bottom),
// a button that starts the space's terminal.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { tokens, alpha, icon, button, kbd } from "./look.js";
import { SURFACES, send, surfaceOff, surfacesHere } from "./side.js";

export class Empty {
  init(p) {
    this.group = p.group ?? "a";
    this.bottom = p.bottom === true;
  }
  close() {}
  command() {}

  // A terminal that doesn't start says so in a toast (side.js).
  render(cx) {
    const k = tokens();
    // What doesn't apply in the folder the space works in now is greyed, with why (side.js).
    const where = this.bottom ? null : surfacesHere(cx);
    const root = v_flex().id(`ht3-empty-${this.bottom ? "bottom" : this.group}`).size_full().items_center().justify_center().bg(k.background).text_color(k.foreground).text_size(14);
    if (this.bottom) {
      return root.gap(12)
        .child(div().text_color(k.muted).child("No terminal for this space yet."))
        .child(button(k, "bottom-open", "Open terminal", () => send("add:terminal:bottom"), { variant: "default", size: "sm", glyph: "square-terminal" }));
    }
    // RightPanelTabs.tsx's launcher: 24 in, a list at most 320 wide, rows 32 high.
    return root.px(24)
      .child(v_flex().w_full().max_w(320).py(24).gap(2)
        .child(div().mb(12).text_center().font_medium().child("Open a surface"))
        .children(SURFACES.map((s) => {
          const off = surfaceOff(s, where);
          const el = h_flex().id(`empty-${s.kind}`).h(32).px(10).gap(10).items_center().rounded(8).text_size(14)
            .child(icon(s.glyph).size(16).flex_none().text_color(k.muted))
            .child(div().flex_1().min_w(0).truncate().text_color(off ? k.dim : k.foreground).child(s.label))
            .child(kbd(k, s.key.toUpperCase()));
          if (off) return el.opacity(0.5).tooltip(off);
          return el.role("button").accessibility_label(s.label).cursor_pointer().hover((st) => st.bg(alpha(k.accent, 0.6)))
            .on_click(() => send(`add:${s.kind}:${this.group}`));
        })));
  }
}
