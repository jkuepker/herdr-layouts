// T3 Code's Browser surface, as far as Herdr goes. Herdr has no web view (its mods can't draw
// one), so this tab is an address field that opens the page in the system browser, a list of
// the pages opened lately, and the servers listening on this computer, one click from a tab.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, shared, setShared } from "herdr";
import { tokens, alpha, icon, button, iconButton } from "./look.js";
import { showing } from "./side.js";

const RECENT = "ht3-browser.recent";

// "localhost:3000" is http, "example.com/docs" https; anything with a scheme stays as typed.
export function normalizeUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /\s/.test(t)) return null;
  return (/^(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+)(:|\/|$)/i.test(t) ? "http://" : "https://") + t;
}
export function openUrl(url) {
  const recent = [url, ...(shared(RECENT) ?? []).filter((u) => u !== url)].slice(0, 12);
  setShared(RECENT, recent);
  return exec("open", [url]);
}

export class BrowserPanel {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.input = InputState.new({ placeholder: "Enter a URL, or localhost:3000" });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.servers = null;
    this.error = null;
    this.scan(cx);
    // Looks for servers only while the tab shows.
    cx.timer.every(15000, (cx) => { if (showing(this.group, "browser")) this.scan(cx); });
  }
  close() {}
  command() {}

  go(cx, text = null) {
    const url = normalizeUrl(text ?? this.input.value());
    if (!url) { this.error = "That isn't a web address."; return cx.notify(); }
    if (text == null) this.input.set_value("");
    cx.spawn(async (cx) => {
      try {
        const r = await openUrl(url);
        this.error = r.code === 0 ? null : (r.stderr.trim() || "The system browser didn't open.");
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  // Programs listening on a TCP port of this computer, from lsof.
  scan(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"], { timeout: 8000 }).catch(() => null);
      if (!r) { this.servers = []; return cx.notify(); }
      const found = new Map();
      let cmd = "";
      for (const line of r.stdout.split("\n")) {
        if (line[0] === "c") cmd = line.slice(1);
        else if (line[0] === "n") {
          const m = line.match(/^n(?:\*|127\.0\.0\.1|\[::1?\]|localhost|\[::\]):(\d+)$/);
          if (m && Number(m[1]) >= 1024 && !found.has(m[1])) found.set(m[1], cmd);
        }
      }
      this.servers = [...found.entries()].map(([port, name]) => ({ port: Number(port), name })).sort((a, b) => a.port - b.port).slice(0, 14);
      cx.notify();
    });
  }

  render(_cx) {
    const k = tokens();
    const row = (id, glyph, label, detail, onClick) => h_flex().id(id).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13)
      .role("button").accessibility_label(label).cursor_pointer().hover((s) => s.bg(alpha(k.foreground, 0.07))).on_click((_e, cx) => onClick(cx))
      .child(icon(glyph).size(14).flex_none().text_color(k.muted))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(!!detail, (el) => el.child(div().flex_none().max_w(140).truncate().text_size(12).text_color(k.muted).child(detail)));
    const label = (t) => div().px(8).pt(12).pb(4).text_size(11).font_medium().text_color(k.muted).child(t);
    const recent = shared(RECENT) ?? [];
    return v_flex().id("ht3-browser").size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(13)
      .child(h_flex().h(40).flex_none().px(8).gap(6).items_center()
        .child(h_flex().flex_1().min_w(0).h(28).px(8).gap(6).items_center().rounded(8).border(1).border_color(k.input).text_size(13)
          .child(icon("globe").size(14).flex_none().text_color(k.muted))
          .child(div().flex_1().min_w(0).child(Input.new(this.input))))
        .child(button(k, "browser-go", "Open", (cx) => this.go(cx), { variant: "default", size: "sm", glyph: "external-link" })))
      .child(v_flex().id("ht3-browser-body").flex_1().min_h(0).px(8).pb(12).overflow_y_scrollbar()
        .when(!!this.error, (el) => el.child(div().px(8).py(4).text_size(12).text_color(k.destructiveText).child(this.error)))
        .child(div().px(8).py(4).text_size(12).line_height("16px").text_color(k.muted).child("Herdr can't show a web page inside a panel, so a page opens in your system browser."))
        .child(h_flex().items_center().child(div().flex_1().child(label("Servers on this computer")))
          .child(iconButton(k, "browser-scan", "refresh-cw", (cx) => this.scan(cx), { size: "micro", tip: "Look again" })))
        .when(this.servers && !this.servers.length, (el) => el.child(div().px(8).py(4).text_size(12).text_color(k.muted).child("Nothing is listening on a port.")))
        .children((this.servers ?? []).map((s) => row(`srv-${s.port}`, "globe", `localhost:${s.port}`, s.name, (cx) => this.go(cx, `localhost:${s.port}`))))
        .when(recent.length > 0, (el) => el.child(label("Recent")).children(recent.map((u) => row(`rec-${u}`, "clock", u.replace(/^https?:\/\//, ""), null, (cx) => this.go(cx, u))))));
  }
}
