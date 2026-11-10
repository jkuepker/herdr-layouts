// T3 Code's look in gpui-kit: its tokens read from the theme, and its button, chip and
// work-log primitives. Sizes are T3's (apps/web/src, 1rem = 16px): buttons from
// ui/button.tsx, the work log from chat/WorkLog.tsx, the composer controls from
// ui/kbd.tsx: a key in a chip, 20 high, 12px medium.
export const kbd = (k, text) => h_flex().flex_none().h(20).min_w(20).px(4).items_center().justify_center().rounded(4)
  .bg(alpha(k.foreground, 0.07)).text_size(12).font_medium().text_color(k.muted).child(text);

// chat/ComposerControl.tsx.

import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, settings, home } from "herdr";

export const MOD = "ht3-panels";
export const icon = (name) => svg(`mods/${MOD}/icons/${name}.svg`);

// An agent's own icon (agent-acp.js AGENTS: Herdr's for it), or null when it has none: a one-color
// glyph in `color`, else the picture.
export const agentMark = (a, size, color) => (!a?.icon ? null : a.tint ? svg(a.icon).size(size).flex_none().text_color(color) : image(a.icon).w(size).h(size).flex_none());

// T3's tokens by their own names. With the t3code themes these are T3's exact colors;
// with any other theme they follow it.
export function tokens() {
  const t = theme();
  const dark = settings()?.dark !== false;
  return {
    t,
    dark,
    background: t.background,
    foreground: t.foreground,
    card: t.surface,
    popover: t.popover,
    message: t.raised, // --message-surface, the user bubble
    accent: t.selected, // hover and pressed fills
    hover: t.hover,
    border: t.border,
    input: t.input,
    muted: t.muted, // --muted-foreground
    dim: t.dim,
    primary: t.accent,
    primaryText: t.accent_foreground ?? "#ffffff",
    // T3's semantic colors (index.css :root and dark), which Herdr themes have no names for.
    destructive: dark ? "#fb414a" : "#fb2c36",
    destructiveText: dark ? "#ff6467" : "#c10007",
    warning: "#fe9a00",
    warningText: dark ? "#ffba00" : "#bb4d00",
    success: "#00bc7d",
    successText: dark ? "#00d492" : "#007a55",
    info: dark ? "#51a2ff" : "#1447e6",
    mono: settings()?.font_family,
  };
}

// A color with an alpha byte, e.g. alpha("#ffffff", 0.08).
export function alpha(hex, a) {
  return String(hex).slice(0, 7) + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
}

export function shortPath(p) {
  const h = home();
  return p && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p ?? "";
}

// A press on a control inside a window_drag block must not drag the window.
const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

// ui/button.tsx. size: "default" 32, "sm" 28, "xs" 24. variant: "default" (primary),
// "outline", "ghost", "ghost-muted", "destructive".
export function button(k, id, label, onClick, { variant = "outline", size = "xs", disabled = false, glyph = null, tip = null } = {}) {
  const h = { default: 32, sm: 28, xs: 24 }[size];
  const px = { default: 11, sm: 9, xs: 7 }[size];
  const fill = { default: k.primary, destructive: k.destructive, outline: k.popover }[variant] ?? "#00000000";
  const line = { default: k.primary, destructive: k.destructive, outline: k.input }[variant] ?? "#00000000";
  const text = { default: k.primaryText, destructive: "#ffffff", "ghost-muted": k.muted }[variant] ?? k.foreground;
  const over = { default: alpha(k.primary, 0.9), destructive: alpha(k.destructive, 0.9) }[variant] ?? k.accent;
  let el = h_flex().id(id).h(h).px(px).gap(size === "xs" ? 4 : 6).flex_none().items_center().justify_center()
    .rounded(8).border(1).border_color(line).bg(fill).text_color(text)
    .text_size(size === "xs" ? 12 : 14).font_medium().whitespace_nowrap();
  if (glyph) el = el.child(icon(glyph).size(size === "xs" ? 14 : 16).flex_none());
  if (label) el = el.child(label);
  if (tip) el = el.tooltip(tip);
  if (disabled) return el.opacity(0.64);
  return stop(el).role("button").accessibility_label(label || tip || id).cursor_pointer()
    .hover((s) => s.bg(over).text_color(variant === "ghost-muted" ? k.foreground : text))
    .on_click((_e, cx) => onClick(cx));
}

// An icon-only button: 28 ("sm"), 24 ("xs") or 20 ("micro") square.
export function iconButton(k, id, glyph, onClick, { size = "xs", tip = null, on = false, color = null, ring = false } = {}) {
  const box = { sm: 28, xs: 24, micro: 20 }[size];
  let el = h_flex().id(id).size(box).flex_none().items_center().justify_center()
    .rounded(size === "micro" ? 4 : 8).bg(on ? k.accent : "#00000000").text_color(color ?? (on ? k.foreground : k.muted))
    .when(ring && on, (e) => e.border(1).border_color(k.primary))
    .child(icon(glyph).size(size === "micro" ? 12 : 14).flex_none());
  if (tip) el = el.tooltip(tip);
  return stop(el).role("button").accessibility_label(tip || id).cursor_pointer()
    .hover((s) => s.bg(k.accent).text_color(color ?? k.foreground)).on_click((_e, cx) => onClick(cx));
}

// chat/ComposerControl.tsx, size sm: 28 high, 8 in, a 16px icon, 14px medium text at 80%.
export function control(k, id, { glyph = null, mark = null, label, suffix = null, open = false, onClick = null }) {
  let el = h_flex().id(id).h(28).px(8).gap(6).flex_none().items_center().rounded(8)
    .bg(open ? k.accent : "#00000000").text_size(14).font_medium().text_color(alpha(k.foreground, 0.8));
  if (mark) el = el.child(mark);
  else if (glyph) el = el.child(icon(glyph).size(16).flex_none().text_color(k.muted));
  el = el.child(div().max_w(224).truncate().child(label));
  if (suffix) el = el.child(div().max_w(96).truncate().font_weight(400).text_color(k.muted).child(suffix));
  if (!onClick) return el;
  return el.role("button").accessibility_label(String(label)).cursor_pointer()
    .hover((s) => s.bg(k.accent).text_color(k.foreground)).on_click((_e, cx) => onClick(cx));
}

// ui/badge.tsx, default size: 18 high, 3 in, 12px medium, radius 4.
export function badge(k, label, tone = "secondary") {
  const c = { info: k.info, success: k.successText, warning: k.warningText, error: k.destructiveText }[tone];
  return h_flex().h(18).px(4).flex_none().items_center().rounded(4).text_size(12).font_medium()
    .bg(c ? alpha(c, k.dark ? 0.16 : 0.08) : k.accent).text_color(c ?? k.foreground).child(label);
}

// chat/WorkLog.tsx WorkLogLine: 24 high, a 16px icon in a 24px slot, a muted 14px label,
// then whatever trails (a failure mark, the chevron).
export function workLine(k, glyph, label, { color = null, bold = false, trail = [], spin = false } = {}) {
  const g = icon(glyph).size(16).flex_none();
  return h_flex().min_h(24).gap(6).px(2).items_center().rounded(6).text_size(14)
    .child(h_flex().size(24).flex_none().items_center().justify_center().text_color(color ?? k.muted).child(spin ? g.spin(1000) : g))
    .child(div().flex_1().min_w(0).truncate().text_color(color ?? k.muted).when(bold, (el) => el.font_medium()).child(label))
    .children(trail);
}

// chat/TimelineSystemDivider.tsx: 11px muted words between two hairlines.
export function divider(k, text, color = null) {
  const rule = () => div().flex_1().h(1).bg(alpha(k.border, 0.7));
  return h_flex().py(8).gap(8).items_center().text_size(11).text_color(color ?? k.muted)
    .child(rule()).child(div().flex_none().max_w("80%").child(text)).child(rule());
}
