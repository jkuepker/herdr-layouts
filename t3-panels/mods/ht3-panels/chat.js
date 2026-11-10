// The chat panel: T3 Code's thread view (apps/web/src/components/chat) in gpui-kit. A
// centered 736px lane; your messages as right-aligned bubbles, the agent's as plain
// markdown, its work as flat one-line rows that open, a "Working for 12s" line, and the
// composer card with its controls and the round Send / Stop button.
//
// The agent comes from one of two sources that give the same rows:
// - agent-term.js: an agent already running in a Herdr terminal (props.terminal);
// - agent-acp.js: an agent this pane starts over ACP (props.agent, cwd, machine, prompt).

import { div, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { run, openOverlay, appHome, home } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, control, badge, workLine, divider, shortPath } from "./look.js";
import { AcpSource, detect, argvOf } from "./agent-acp.js";
import { TermSource } from "./agent-term.js";

const LANE = 736; // --chat-content-max-width: 46rem
const DRAW_EVERY_MS = 80;
const DETAIL_MAX = 4000;
const TOOL_GLYPH = { read: "eye", edit: "square-pen", delete: "trash-2", move: "file", search: "search", execute: "terminal", think: "brain", fetch: "globe", switch_mode: "list-todo", other: "wrench" };
const OPTION_GLYPH = { model: "sparkles", mode: "lock", thought_level: "brain" };

export function openLauncher() {
  openOverlay({ mod: MOD, kind: "dialog", width: 512, height: 520 });
}

const seconds = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export class ChatPanel {
  init(p, cx) {
    this.chatId = p.chat ?? null;
    this.source = null;
    this.phase = "loading"; // loading | empty | chat
    this.expanded = {};
    this.follow = true;
    this.picker = null; // option id whose choices are open
    this.since = null; // when the running turn was first seen
    this.hasText = false;

    this.input = TextareaState.new({ placeholder: "Ask anything" });
    this.input.set_auto_grow(2, 8);
    // A textarea's Enter inserts a newline and then submits; Shift+Enter submits with `shift`.
    this.input.on("submit", (e, cx) => {
      if (!e?.shift) this.send(cx);
    });
    this.input.on("change", (_e, cx) => {
      const has = this.input.value().trim().length > 0;
      if (has !== this.hasText) { this.hasText = has; cx.notify(); }
    });
    this.filter = InputState.new({ placeholder: "Search" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.scroll = VirtualListScrollHandle.new();

    const changed = (cx, urgent) => this.changed(cx, urgent);
    if (p.terminal) {
      this.source = new TermSource({ addr: p.terminal, changed });
      this.source.start(cx);
      this.phase = "chat";
    } else if (this.chatId) {
      const src = new AcpSource({ dir: `${appHome()}/data/${MOD}/chats/${this.chatId}`, machine: p.machine, changed });
      this.source = src;
      cx.spawn(async (cx) => {
        const had = await src.load();
        if (had) {
          this.phase = "chat";
          if (src.resumable) src.restart(cx);
          return cx.notify();
        }
        const d = await detect(src.machine);
        src.target = d.target;
        src.remoteError = d.error;
        const argv = argvOf(p.agent, d.found);
        this.phase = "chat";
        if (argv) src.start(cx, argv, p.cwd ?? d.found.HOME ?? home(), p.prompt ?? null, p.set ?? null);
        else src.startError = d.error ?? `${Array.isArray(p.agent) ? p.agent[0] : p.agent ?? "The agent"} isn't installed.`;
        cx.notify();
      });
    } else {
      this.phase = "empty";
    }
    // The "Working for …" line counts seconds; nothing else here redraws on a timer.
    cx.timer.every(1000, (cx) => {
      if (this.since != null) cx.notify();
    });
  }

  async close(_cx) {
    await this.source?.close();
  }

  command(c, cx) {
    if (c === "focus") this.input.focus();
    cx.notify();
  }

  // Draws at most every DRAW_EVERY_MS, at once when urgent.
  changed(cx, urgent) {
    const draw = (cx) => {
      if (this.follow) this.scroll.scroll_to_bottom();
      cx.notify();
    };
    if (urgent) return draw(cx);
    if (this.drawSoon) return;
    this.drawSoon = true;
    cx.timer.after(DRAW_EVERY_MS, (cx) => { this.drawSoon = false; draw(cx); });
  }

  send(cx) {
    const v = this.view;
    const text = this.input.value().trim();
    if (!text || !v?.alive) return;
    // An ACP agent takes one message per turn; a terminal agent takes one mid-turn too.
    if (this.source.kind === "acp" && v.status !== "ready") return;
    this.input.set_value("");
    this.hasText = false;
    this.follow = true;
    this.source.send(cx, text);
    this.scroll.scroll_to_bottom();
    cx.notify();
  }

  // ---- drawing ----

  render(_cx) {
    const k = tokens();
    const root = v_flex().id("ht3-chat").size_full().bg(k.background).text_color(k.foreground).text_size(14);
    if (this.phase === "loading") return root.child(this.centered(k, "Loading…"));
    if (this.phase === "empty") return root.child(this.empty(k));
    const v = (this.view = this.source.view());
    if (v.status === "working") this.since ??= Date.now();
    else this.since = null;
    return root
      .child(this.header(k, v))
      .child(this.timeline(k, v))
      .when(this.picker != null, (el) => el.child(this.pickerPanel(k, v)))
      .child(this.composer(k, v));
  }

  centered(k, text) {
    return v_flex().flex_1().items_center().justify_center().text_size(14).text_color(k.muted).child(text);
  }

  empty(k) {
    return v_flex().flex_1().items_center().justify_center().gap(12)
      .child(div().text_size(14).font_medium().child("No chat here yet"))
      .child(div().text_size(12).text_color(k.muted).child("Show a terminal agent's conversation, or start an agent."))
      .child(button(k, "empty-new", "New chat", () => openLauncher(), { variant: "default", size: "sm", glyph: "square-pen" }));
  }

  // T3's breadcrumb header, at the height of this layout's bars: folder / agent, then what
  // applies to the chat.
  header(k, v) {
    const folder = v.cwd ? shortPath(v.cwd).split("/").filter(Boolean).pop() ?? "~" : null;
    const where = v.cwd ? (v.machine ? `${v.machine}:${v.cwd}` : shortPath(v.cwd)) : "";
    const word = { starting: "Starting", working: "Working", blocked: "Waiting for you", exited: "Stopped", stopped: "Stopped" }[v.status];
    const tone = { blocked: "warning", exited: "error", stopped: "error", working: "info" }[v.status];
    return h_flex().h(40).flex_none().px(16).gap(8).items_center().text_size(14).font_medium()
      .when(!!folder, (el) => el
        .child(div().max_w(160).truncate().text_color(k.muted).tooltip(where).child(folder))
        .child(div().text_color(alpha(k.muted, 0.6)).child("/")))
      .child(div().min_w(0).truncate().child(v.name))
      .when(!!word, (el) => el.child(badge(k, word, tone)))
      .child(div().flex_1())
      .when(v.usage?.size > 0, (el) => el.child(div().text_size(12).font_weight(400).text_color(k.muted)
        .child(`${Math.round((100 * v.usage.used) / v.usage.size)}% context`)))
      .when(!!v.terminal, (el) => el.child(iconButton(k, "to-term", "square-terminal", () => run("pane.focus", { terminal: v.terminal }), { tip: `Go to its terminal (${v.terminal})` })))
      .child(iconButton(k, "new-chat", "square-pen", () => openLauncher(), { tip: "New chat" }));
  }

  rows(v) {
    const rows = [];
    if (v.earlier) rows.push({ id: "__earlier", kind: "earlier" });
    else if (v.dropped > 0) rows.push({ id: "__dropped", kind: "notice", level: "info", text: `${v.dropped} earlier messages not shown` });
    for (const m of v.items) rows.push(m);
    if (v.status === "working") rows.push({ id: "__working", kind: "working", doing: v.doing });
    return rows;
  }

  timeline(k, v) {
    const rows = this.rows(v);
    if (!rows.length) {
      const text = v.status === "starting" ? "Starting the agent…" : v.error ? "" : "Send a message to start the conversation.";
      return this.centered(k, text);
    }
    return v_flex().relative().flex_1().min_h(0)
      .on_scroll_wheel((e, cx) => {
        if (e.delta.y > 0 && this.follow) { this.follow = false; cx.notify(); }
      })
      .child(list("ht3-chat-rows", rows.length, (i) => rows[i].id, (i) => this.row(k, rows[i], i === 0, i === rows.length - 1))
        .track_scroll(this.scroll)
        .on_item_click((id, cx) => {
          const m = rows.find((r) => r.id === id);
          if (!m) return;
          if (m.kind === "earlier") return this.source.earlier?.(cx);
          if (m.kind !== "tool" && m.kind !== "thought") return;
          this.expanded[id] = !this.expanded[id];
          if (this.expanded[id]) this.source.expand(cx, m);
          cx.notify();
        }))
      .child(Scrollbar.vertical("ht3-chat-rows").absolute().inset_0())
      // chat/TimelineOverlays.tsx: the glass pill over the end of the lane.
      .when(!this.follow, (el) => el.child(h_flex().absolute().bottom(6).left(0).right(0).justify_center()
        .child(h_flex().id("to-end").h(24).px(8).gap(4).items_center().rounded_full().border(1).border_color(alpha(k.border, 0.6))
          .bg(k.card).shadow_sm().text_size(12).font_medium().cursor_pointer().role("button").accessibility_label("Scroll to end").hover((s) => s.border_color(k.border))
          .on_click((_e, cx) => { this.follow = true; this.scroll.scroll_to_bottom(); cx.notify(); })
          .child(icon("chevron-down").size(14)).child("Scroll to end"))));
  }

  // One timeline row in the lane. Rows carry their own space below, as T3's do (16 after a
  // message, 8 after work, 6 after the working line).
  row(k, m, first, last) {
    const lane = (body, pb) => h_flex().w_full().justify_center().px(16).pt(first ? 12 : 0).pb(pb + (last ? 12 : 0))
      .child(v_flex().w_full().max_w(LANE).min_w(0).child(body));
    const chevron = (open) => h_flex().size(16).flex_none().items_center().justify_center().text_color(alpha(k.muted, 0.7))
      .child(icon(open ? "chevron-down" : "chevron-right").size(12));
    switch (m.kind) {
      case "user":
        return lane(h_flex().w_full().justify_end()
          .child(div().max_w("80%").min_w(0).p(12).rounded(16).bg(k.message).text_size(14).line_height("23px")
            .when(m.pending, (el) => el.opacity(0.6)).child(m.text)), 16);
      case "agent":
        return lane(div().px(4).py(2).text_size(14).line_height("23px").child(TextView.markdown(`md-${m.id}`, m.text || "(empty response)").selectable(true)), 16);
      case "thought": {
        const open = this.expanded[m.id];
        return lane(v_flex()
          .child(workLine(k, "brain", m.open ? "Thinking" : "Thought", { trail: [chevron(open)] }))
          .when(open, (el) => el.child(div().ml(30).py(4).text_size(14).line_height("23px").text_color(alpha(k.foreground, 0.8)).child(m.text))), 8);
      }
      case "tool": {
        const failed = m.status === "failed";
        const running = m.status === "in_progress" || m.status === "pending";
        const open = this.expanded[m.id] && (m.detail || m.lazy);
        const can = !!(m.detail || m.lazy);
        const trail = [];
        if (failed) trail.push(icon("x").size(12).flex_none().text_color(k.destructive));
        if (can) trail.push(chevron(open));
        const detail = m.detail ?? (m.loading ? "Loading…" : "");
        return lane(v_flex()
          .child(workLine(k, TOOL_GLYPH[m.toolKind] ?? "wrench", m.title || "Working…", {
            color: failed ? k.destructive : running ? alpha(k.foreground, 0.8) : null, bold: failed, trail }))
          .when(open, (el) => el.child(div().ml(30).mt(2).mb(6).pb(8).text_size(12).line_height("18px").font_family(k.mono).text_color(k.muted)
            .child(detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) + "\n…" : detail))), 4);
      }
      case "plan":
        // chat/ProposedPlanCard.tsx
        return lane(v_flex().p(16).gap(12).rounded(16).border(1).border_color(alpha(k.border, 0.8)).bg(alpha(k.card, 0.7))
          .child(h_flex().gap(8).items_center().child(badge(k, "Plan")).child(div().text_size(14).font_medium().child("Plan")))
          .child(v_flex().gap(4).children(m.entries.map((e) => h_flex().gap(8).items_start().text_size(14).line_height("23px")
            .child(h_flex().size(16).mt(3).flex_none().items_center().justify_center().rounded(4).border(1)
              .border_color(e.status === "completed" ? k.primary : k.input).bg(e.status === "completed" ? k.primary : "#00000000")
              .text_color(k.primaryText).when(e.status === "completed", (el) => el.child(icon("check").size(12))))
            .child(div().flex_1().min_w(0).text_color(e.status === "completed" ? k.muted : e.status === "in_progress" ? k.foreground : alpha(k.foreground, 0.8))
              .when(e.status === "in_progress", (el) => el.font_medium()).child(e.content))))), 16);
      case "notice":
        if (m.level === "info") return lane(divider(k, m.text), 0);
        return lane(v_flex()
          .child(workLine(k, "circle-alert", m.text.split("\n")[0], { color: m.level === "error" ? k.destructive : k.warning, bold: true }))
          .when(m.text.includes("\n"), (el) => el.child(div().ml(30).py(4).text_size(14).line_height("23px").text_color(alpha(k.foreground, 0.8))
            .child(m.text.split("\n").slice(1).join("\n").trim()))), 8);
      case "earlier":
        return lane(divider(k, "Show earlier messages"), 0);
      case "working":
        // chat/TimelineWorkGroupRows.tsx: words and a timer, no spinner.
        return lane(h_flex().pt(4).pb(8).border_b(1).border_color(alpha(k.border, 0.6))
          .child(div().h(24).px(4).text_size(14).line_height("23px").text_color(k.muted)
            .child(`Working for ${seconds(Date.now() - (this.since ?? Date.now()))}${m.doing ? ` · ${m.doing}` : ""}`)), 6);
    }
    return lane(div(), 0);
  }

  // The choices of one composer control, as T3's menus look: 4 in, radius 8, 28px rows.
  pickerPanel(k, v) {
    const opt = v.options.find((o) => o.id === this.picker);
    if (!opt) return div();
    const f = this.filter.value().toLowerCase();
    const choices = opt.choices.filter((c) => !f || c.name.toLowerCase().includes(f) || String(c.value).toLowerCase().includes(f));
    const search = opt.choices.length > 8;
    return h_flex().w_full().flex_none().justify_center().px(16).pb(6)
      .child(h_flex().w_full().max_w(LANE).justify_end()
        .child(v_flex().w(320).h(Math.min(300, (search ? 44 : 8) + Math.max(1, choices.length) * 28)).p(4).rounded(8).border(1).border_color(k.border).bg(k.popover).shadow_lg()
          .when(search, (el) => el.child(div().h(32).px(8).mb(4).border_b(1).border_color(k.border).text_size(14).child(Input.new(this.filter))))
          .child(v_flex().relative().flex_1().min_h(0)
            .child(list(`pick-${opt.id}`, choices.length, (i) => String(choices[i].value), (i) => {
              const c = choices[i];
              const on = c.value === opt.current;
              return h_flex().h(28).px(8).gap(8).items_center().rounded(4).text_size(14).bg(on ? k.accent : "#00000000")
                .child(div().flex_1().min_w(0).truncate().child(c.name))
                .when(on, (el) => el.child(icon("check").size(14).flex_none().text_color(k.muted)));
            }).on_item_click((value, cx) => {
              this.source.setOption(opt.id, value);
              this.picker = null;
              cx.notify();
            }))
            .child(Scrollbar.vertical(`pick-${opt.id}`).absolute().inset_0())
            .when(!choices.length, (el) => el.child(div().px(8).py(4).text_size(12).text_color(k.muted).child("No matches."))))));
  }

  // chat/ComposerSurface.tsx and ComposerPrimaryActions.tsx.
  composer(k, v) {
    const lane = (body) => h_flex().w_full().flex_none().justify_center().px(16).pb(12).child(v_flex().w_full().max_w(LANE).child(body));
    const line = alpha(k.foreground, k.dark ? 0.1 : 0.08);

    // The drawer tucked on top of the card: an approval, or why the agent isn't there.
    let drawer = null;
    if (v.permission) {
      const p = v.permission;
      drawer = v_flex().mx(22).px(16).pt(8).pb(10).gap(8).rounded_t(16).border(1).border_color(line).bg(k.card)
        .child(h_flex().gap(6).items_center().text_size(12).text_color(k.muted)
          .child(icon("shield").size(12).text_color(k.warning)).child("Waiting for approval"))
        .child(div().text_size(14).line_height("23px").child(p.title))
        .when(!!p.note, (el) => el.child(div().text_size(12).text_color(k.muted).child(p.note)))
        .child(h_flex().gap(6).flex_wrap().justify_end().children(p.options.map((o) =>
          button(k, `perm-${o.optionId}`, o.name, (cx) => this.source.answer(cx, o.optionId), { variant: o.kind?.startsWith("allow") ? "default" : "outline" }))));
    } else if (!v.alive && v.status !== "starting") {
      drawer = v_flex().mx(22).px(16).pt(8).pb(10).gap(8).rounded_t(16).border(1).border_color(alpha(k.destructive, 0.32)).bg(k.card)
        .when(!!v.error, (el) => el.child(div().text_size(12).line_height("18px").text_color(k.destructiveText).child(String(v.error).slice(0, 1200))))
        .child(h_flex().gap(6).justify_end()
          .when(this.source.kind === "acp" && !!this.source.state, (el) => el.child(button(k, "restart", "Restart agent", (cx) => this.source.restart(cx), { variant: "default", glyph: "rotate-ccw" })))
          .child(button(k, "drawer-new", "New chat", () => openLauncher(), { variant: "outline" })));
    }

    const working = v.status === "working";
    const stop = working && (!this.hasText || this.source.kind === "acp");
    const can = v.alive && this.hasText && (this.source.kind === "term" || v.status === "ready");
    const action = stop
      ? h_flex().id("stop").size(32).flex_none().items_center().justify_center().rounded_full().bg(alpha(k.destructive, 0.9)).text_color("#ffffff")
        .shadow_xs().cursor_pointer().tooltip("Interrupt").role("button").accessibility_label("Stop generation").hover((s) => s.bg(k.destructive))
        .on_click(() => this.source.stop()).child(icon("stop").size(12))
      : h_flex().id("send").size(32).flex_none().items_center().justify_center().rounded_full()
        .bg(can ? k.primary : alpha(k.foreground, 0.12)).text_color(can ? k.primaryText : k.muted)
        .role("button").accessibility_label("Submit message")
        .when(can, (el) => el.shadow_xs().cursor_pointer().hover((s) => s.bg(alpha(k.primary, 0.9))).on_click((_e, cx) => this.send(cx)))
        .child(icon("arrow-up").size(14));

    const controls = v.options.map((o) => {
      const cur = o.choices.find((c) => c.value === o.current);
      return control(k, `opt-${o.id}`, {
        glyph: OPTION_GLYPH[o.category ?? o.id] ?? (o.id === "model" ? "sparkles" : "lock"),
        label: cur?.name ?? o.current ?? o.name, suffix: o.suffix ?? null, open: this.picker === o.id,
        onClick: o.readonly ? null : (cx) => {
          this.picker = this.picker === o.id ? null : o.id;
          this.filter.set_value("");
          if (this.picker && o.choices.length > 8) this.filter.focus();
          cx.notify();
        },
      });
    });

    const card = v_flex().rounded(16).border(1).border_color(line).bg(k.card).shadow_xs()
      .child(div().px(16).pt(14).pb(8).text_size(14).line_height("23px").child(Textarea.new(this.input)))
      .child(h_flex().px(8).pb(8).gap(2).items_center()
        .child(div().flex_1())
        .children(controls)
        .child(div().w(6).flex_none())
        .child(action));
    return lane(drawer ? v_flex().child(drawer).child(card) : card);
  }
}
