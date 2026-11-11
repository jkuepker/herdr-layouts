// The Outline step of the Files editor, and what Quick open's `@` mode shares with it (the parsing is outline-parse.js, which
// has no Herdr imports and is what tests run on).
//
// Files' Outline button (`ht3-panels.outline`) replaces the file's view with the file's symbols (functions, classes, headings,
// keys: whatever outline-parse.js knows for its language) under a filter box, drawn like History (blame.js historyView). A
// click on a row, or Enter on the marked one, closes the outline and picks that line in the Lines view (editor.js pickLine), as
// the conflict banner's Next does. Up and Down move the mark while the box has the focus, Esc closes.
//
// Quick open's `@` mode lists the same symbols of the open file. Quick open is a dialog and the file is Files', so Quick asks
// the shown Files copy to publish them: `ht3-panels.outline-share` makes Files answer in shared("ht3-panels.outline") =
// { path, symbols, at } (`symbols` empty and `path` null: no file is open); quick.js reads it.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { shared, setShared } from "herdr";
import { MOD, alpha, button, icon } from "./look.js";
import { outlineOf, rankSymbols, badgeOf } from "./outline-parse.js";
import { pieces } from "./fuzzy.js";

export const SHARE = `${MOD}.outline`;
export const ROW = 24;

// Files' answer to `outline-share`: the open file's symbols, from its text as it is now (unsaved edits too).
export function shareOutline(tab) {
  const symbols = tab?.state ? outlineOf(tab.path, tab.state.value()) : [];
  setShared(SHARE, { path: tab?.state ? tab.path : null, symbols, at: Date.now() });
}
// What Files last published, when it did so at or after `since`; else null.
export function sharedOutline(since = 0) {
  const s = shared(SHARE);
  return s && typeof s.at === "number" && s.at >= since && Array.isArray(s.symbols) ? s : null;
}

// Starts the step on `tab`: tab.outline = { box, symbols, at, q, rows, scroll, range, empty }. `change(cx)` runs when the
// filter changes (the panel redraws).
export function openOutline(cx, tab, change) {
  const box = InputState.new({ placeholder: "Filter symbols…" });
  const o = tab.outline = { box, symbols: outlineOf(tab.path, tab.state.value()), at: 0, q: null, rows: [], scroll: VirtualListScrollHandle.new(), range: null };
  box.on("change", (_e, cx) => { o.at = 0; change(cx); });
  cx.timer.after(0, () => box.focus());
  return o;
}

// The rows for what the box says now: [{ sym, at }], kept until it changes.
export function rowsOf(o) {
  const q = o.box.value();
  if (o.q !== q) { o.q = q; o.rows = rankSymbols(q, o.symbols); o.filtered = !!q.trim(); }
  return o.rows;
}

// Up, Down, Enter and Escape in the step: moves the mark, picks, or closes. `pick(cx, line)` and `close(cx)` are the panel's.
export function outlineKey(o, key, cx, { pick, close }) {
  const rows = rowsOf(o), n = rows.length;
  if (key === "escape") return close(cx);
  if (key === "enter") return n ? pick(cx, rows[Math.min(o.at, n - 1)].sym.line) : undefined;
  if ((key !== "up" && key !== "down") || !n) return;
  o.at = (o.at + (key === "down" ? 1 : -1) + n) % n;
  const r = o.range;
  cx.notify();
}

// The symbol's name with the letters the filter matched in bold.
export const nameEls = (k, name, at) => pieces(name, at, 0).map((p) => (p.on
  ? div().flex_none().font_bold().text_color(k.foreground).child(p.text)
  : div().flex_none().child(p.text)));

// A symbol row's badge: its kind in small muted caps.
export const kindBadge = (k, kind) => h_flex().flex_none().min_w(34).h(16).px(4).rounded(4).items_center().justify_center().text_size(10)
  .bg(alpha(k.foreground, 0.07)).text_color(k.muted).child(badgeOf(kind));

// The Outline step, in the file's place. tab.outline is openOutline's.
export function outlineView(k, tab, { close, pick }) {
  const o = tab.outline, rows = rowsOf(o), n = rows.length;
  const total = o.symbols.length;
  const note = !total ? "No symbols found in this file." : !n ? `No symbol matches "${o.box.value().trim()}".` : null;
  const row = (i) => {
    const { sym, at } = rows[i], on = i === o.at;
    const indent = o.filtered ? 0 : Math.min(sym.depth, 8) * 14;
    return h_flex().id(`ol-${i}`).h(ROW).flex_none().mx(8).pl(8 + indent).pr(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(13)
      .bg(on ? alpha(k.foreground, 0.12) : "#00000000").hover((s) => s.bg(alpha(k.foreground, on ? 0.12 : 0.07)))
      .role("button").accessibility_label(`${sym.kind} ${sym.name}, line ${sym.line}`)
      .on_click((_e, cx) => { o.at = i; pick(cx, sym.line); })
      .child(kindBadge(k, sym.kind))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_color(alpha(k.foreground, 0.9)).children(nameEls(k, sym.name, at)))
      .child(div().flex_none().text_size(11).text_color(k.muted).child(String(sym.line)));
  };
  return v_flex().id("ht3-file-outline").flex_1().min_h(0)
    .on_key_down((e, cx) => {
      if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
      const key = String(e.key ?? "").toLowerCase();
      if (["up", "down", "enter", "escape"].includes(key)) { outlineKey(o, key, cx, { pick, close }); cx.stop_propagation?.(); }
    })
    .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6)).text_size(12).text_color(k.muted)
      .child(icon("list-tree").size(14).flex_none())
      .child(div().flex_1().min_w(0).text_size(13).text_color(k.foreground).child(Input.new(o.box)))
      .child(div().flex_none().text_size(11).child(o.filtered ? `${n} of ${total}` : `${total} symbol${total === 1 ? "" : "s"}`))
      .child(button(k, "outline-close", "Close", (cx) => close(cx), { variant: "ghost-muted" })))
    .when(!!note, (el) => el.child(div().px(12).py(8).text_size(12).text_color(k.muted).child(note)))
    // A plain list (as History): a virtual list gets no height in the editor's column. 500 rows at most are drawn.
    .when(!note, (el) => el.child(v_flex().id("ht3-outline-list").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .children(Array.from({ length: Math.min(n, 500) }, (_, i) => row(i)))
      .when(n > 500, (e) => e.child(div().px(16).py(6).text_size(11).text_color(k.muted).child(`${n - 500} more: type to narrow.`)))));
}
