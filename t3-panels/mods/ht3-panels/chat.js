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
import { run, openOverlay, appHome, home, exec, layout, settings } from "herdr";
import { MOD, tokens, alpha, icon, agentMark, button, iconButton, control, badge, workLine, divider, shortPath } from "./look.js";
import { AcpSource, detect, argvOf } from "./agent-acp.js";
import { TermSource } from "./agent-term.js";
import { Reporter } from "./report.js";
import { addNotice } from "./transcript.js";
import { limitModels, rememberModels } from "./settings.js";
import { agentOf } from "./agent-acp.js";

const LANE = 736; // --chat-content-max-width: 46rem
const DRAW_EVERY_MS = 80;
const DETAIL_MAX = 4000;
const TOOL_GLYPH = { read: "eye", edit: "square-pen", delete: "trash-2", move: "file", search: "search", execute: "terminal", think: "brain", fetch: "globe", switch_mode: "list-todo", other: "wrench" };
const OPTION_GLYPH = { model: "sparkles", mode: "lock", thought_level: "brain" };

export function openLauncher() {
  openOverlay({ mod: MOD, kind: "dialog", width: 512, height: 520 });
}

// The composer's placeholder, T3's words, and the one for a lane too narrow to show them whole.
const HINT = "Ask anything. @ files, $ skills, / commands", HINT_SHORT = "Ask anything", HINT_ROOM = 360;
const seconds = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
// A finished turn's time, as T3 says it: "1.6s" under ten seconds.
const took = (ms) => (ms < 10000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : seconds(ms));
const isWork = (m) => m.kind === "thought" || m.kind === "tool";
// A project's badge, as T3's sidebar and header: two letters of its name ("fleetq" FL, "herdr-layouts" HL).
const initials = (name) => {
  const words = String(name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ((words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2)) || "?").toUpperCase();
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
    // A chat tab's agent has no terminal: it tells the layout's lists how it is itself (report.js).
    // A side chat is no tab, and a terminal agent's chat has its terminal to speak for it.
    this.reporter = this.chatId && !p.terminal && !p.side ? new Reporter(this.chatId) : null;

    this.turnAt = null; // when the running turn of an ACP agent began
    this.hint = HINT;
    this.makeInput();
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
          this.report();
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
      if (this.since != null || this.fitHint()) cx.notify();
      // A finished turn nobody saw is "done" until its tab is looked at.
      if (this.reporter?.tab) this.reporter.seen();
      else this.report();
    });
  }

  async close(_cx) {
    this.reporter?.close();
    await this.source?.close();
  }

  // How long each turn of an ACP agent took, kept on its message so the chat can say "Worked for 1.6s".
  clock() {
    const s = this.source?.kind === "acp" ? this.source.state : null;
    if (!s) return;
    const working = this.source.word() === "working";
    if (working) this.turnAt ??= Date.now();
    else if (this.turnAt != null) {
      const items = s.transcript.items;
      for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user") { items[i].took = Date.now() - this.turnAt; break; }
      // A turn that ends with nothing said (Pi does this when its model can't be reached) would read as if
      // the message was never sent.
      if (items.at(-1)?.kind === "user" && this.source.alive) addNotice(s.transcript, "The agent ended the turn without a reply. Check its model or its sign-in.", "warn");
      this.turnAt = null;
      this.whereabouts();
    }
    if (this.whereAsked == null) this.whereabouts();
  }

  // The branch its folder is on, for its card in the lists: asked at the start and after each turn.
  whereabouts() {
    const s = this.source?.kind === "acp" ? this.source.state : null;
    if (!this.reporter || !s?.cwd || this.whereAsking) return;
    this.whereAsking = true;
    this.whereAsked = Date.now();
    exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: s.cwd, on: s.machine ?? null, timeout: 10000 })
      .then((r) => (r.code === 0 ? r.stdout.trim() : null), () => null)
      .then((branch) => {
        this.whereAsking = false;
        this.reporter.where = { branch: branch || null, machine: s.machine ?? null };
        this.report();
      });
  }

  // The composer's field. Its placeholder can't be changed once made and never wraps, so a lane too narrow
  // for the long one gets a field with the short one, swapped only while nothing is typed.
  makeInput() {
    this.input = TextareaState.new({ placeholder: this.hint });
    this.input.set_auto_grow(2, 8);
    // A textarea's Enter inserts a newline and then submits; Shift+Enter submits with `shift`.
    this.input.on("submit", (e, cx) => {
      if (!e?.shift) this.send(cx);
    });
    this.input.on("change", (_e, cx) => {
      const has = this.input.value().trim().length > 0;
      if (has !== this.hasText) { this.hasText = has; cx.notify(); }
    });
  }

  // Not while drawing: a field can't be made then. From the field's size changing and the one-second timer.
  fitHint() {
    const hint = this.fieldW != null && this.fieldW < HINT_ROOM ? HINT_SHORT : HINT;
    if (hint === this.hint || this.input.value() !== "") return false;
    this.hint = hint;
    this.makeInput();
    return true;
  }

  // What the agent offers as models, for Settings to list: remembered when it changes.
  models() {
    const s = this.source?.kind === "acp" ? this.source.state : null, o = s?.configOptions?.find((x) => x.type === "select" && (x.category ?? x.id) === "model");
    if (!o || o.options === this.modelsSeen) return;
    this.modelsSeen = o.options;
    rememberModels(agentOf(s.agentArgv)?.id, [{ id: o.id, category: o.category, choices: o.options.map((c) => ({ value: c.value, name: c.name })) }]);
  }

  // Waiting for a permission is "blocked": the session itself still says working.
  report() {
    const s = this.source?.state;
    if (this.reporter && s) this.reporter.update(s.permission && this.source.alive ? "blocked" : this.source.word(), s.agentArgv, s.agentInfo?.title ?? s.agentInfo?.name,
      s.transcript.items.find((m) => m.kind === "user")?.text,
      { cwd: s.cwd, machine: s.machine ?? null, crumb: this.crumb({ cwd: s.cwd, machine: s.machine, items: s.transcript.items, status: this.source.word(), permission: s.permission, usage: s.transcript.usage, name: "Agent" }) });
  }

  // "focus" from pane.go. For scripts, as the `+` menu's key:<key>: `ht3-panels.say:<text>` sends a
  // message in the shown chat, `pick:<option id>` (pick:model) opens or closes that control's choices,
  // `choose:<option id>=<value>` picks one, `answer:<answer id>` answers an approval, `stop` is the stop
  // button, and `fold:<row id>` opens or closes a row (a work row's id, `__startup`, `__worked-<message id>`).
  command(c, cx) {
    if (c === "focus") this.input.focus();
    if (c.startsWith("say:")) { this.input.set_value(c.slice(4)); this.hasText = true; this.send(cx); }
    if (c.startsWith("pick:")) { this.picker = this.picker === c.slice(5) ? null : c.slice(5); this.filter.set_value(""); }
    if (c.startsWith("answer:")) this.source?.answer(cx, c.slice(7));
    if (c === "stop") this.source?.stop();
    if (c.startsWith("choose:")) { const at = c.indexOf("=", 7); if (at > 0) { this.source?.setOption(c.slice(7, at), c.slice(at + 1)); this.picker = null; } }
    if (c.startsWith("fold:")) this.expanded[c.slice(5)] = !this.expanded[c.slice(5)];
    cx.notify();
  }

  // Draws at most every DRAW_EVERY_MS, at once when urgent.
  changed(cx, urgent) {
    this.report();
    this.models();
    this.clock();
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

  render(cx) {
    const k = tokens();
    // A chat learns which pane is its own by being drawn in it (report.js).
    if (this.reporter && !this.reporter.tab && !this.placing) {
      this.placing = true;
      this.reporter.drawn();
      cx.timer.after(0, () => { this.placing = false; this.reporter.drawn(); this.report(); });
    }
    const root = v_flex().id("ht3-chat").size_full().bg(k.background).text_color(k.foreground).text_size(14);
    if (this.phase === "loading") return root.child(this.centered(k, "Loading…"));
    if (this.phase === "empty") return root.child(this.empty(k));
    const v = (this.view = this.source.view());
    // Settings may cut an agent's models to a list of the person's (settings.js).
    if (this.source.kind === "acp") v.options = limitModels(agentOf(this.source.state?.agentArgv)?.id, v.options);
    if (v.status === "working") this.since ??= this.turnAt ?? Date.now();
    else this.since = null;
    return root
      // In a tab of the Herdr T3 layout the pane's header draws it (report.js `crumb`): one header, as T3's.
      .when(!this.headed(), (el) => el.child(this.header(k, v)))
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
  // Whether the pane's own header says all this: the layout's pane header is ht3-pane and this chat reports to it.
  headed() {
    if (!this.reporter?.tab) return false;
    const has = (x) => x?.content?.pane?.header?.content?.mod === "ht3-pane" || (x?.children ?? []).some(has);
    return has(layout());
  }

  // What the header says, for this one and for the pane header's.
  crumb(v) {
    const folder = v.cwd ? shortPath(v.cwd).split("/").filter(Boolean).pop() ?? "~" : null;
    // T3's header: the project's badge and name, then the thread's title, its first message.
    const said = v.items.find((m) => m.kind === "user")?.text?.trim().split("\n")[0] ?? "";
    const title = said ? (said.length > 80 ? said.slice(0, 80) + "…" : said) : (this.source.kind === "acp" && agentOf(this.source.state?.agentArgv)?.name) || v.name;
    const where = v.cwd ? (v.machine ? `${v.machine}:${v.cwd}` : shortPath(v.cwd)) : "";
    // An ACP agent waiting for an approval still says working; the badge says what it waits for.
    const state = v.permission && v.status === "working" ? "blocked" : v.status;
    // Working says so in the timeline ("Working for 3s"), as T3's header says nothing of it.
    const word = { starting: "Starting", blocked: "Waiting for you", exited: "Stopped", stopped: "Stopped" }[state] ?? null;
    const tone = { blocked: "warning", exited: "error", stopped: "error", working: "info" }[state] ?? null;
    return { badge: folder ? initials(folder) : null, folder, where, title, word, tone, usage: v.usage?.size > 0 ? Math.round((100 * v.usage.used) / v.usage.size) : null };
  }

  header(k, v) {
    const { folder, where, title, word, tone } = this.crumb(v);
    return h_flex().h(40).flex_none().px(16).gap(8).items_center().text_size(14).font_medium()
      .when(!!folder, (el) => el
        .child(h_flex().h(16).min_w(16).px(2).flex_none().items_center().justify_center().rounded(4).bg(alpha(k.info, 0.16)).text_size(9).font_bold().text_color(k.info).child(initials(folder)))
        .child(div().max_w(160).truncate().text_color(k.muted).tooltip(where).child(folder))
        .child(div().text_color(alpha(k.muted, 0.6)).child("/")))
      .child(div().min_w(0).truncate().tooltip(v.name).child(title))
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
    // T3's turns: your message, then "Working for 3s" over the work while it runs; once done, the work
    // folds under "Worked for 1.6s" and the answer stays. What an agent says before any message (a
    // startup banner: its version, skills, extensions) folds the same way.
    const items = v.items, busy = v.status === "working" || v.status === "blocked";
    const fold = (id, label, inside, rest) => {
      // With nothing under it, it is only the turn's time: no chevron, and nothing to open.
      rows.push({ id, kind: "fold", label, open: inside.length > 0 && !!this.expanded[id], bare: !inside.length });
      if (inside.length && this.expanded[id]) for (const m of inside) rows.push(m);
      for (const m of rest) rows.push(m);
    };
    let at = items.findIndex((m) => m.kind === "user");
    const before = items.slice(0, at < 0 ? items.length : at);
    const quiet = before.filter((m) => m.kind !== "notice");
    if (quiet.length && !(busy && at < 0)) fold("__startup", "Startup notes", quiet, before.filter((m) => m.kind === "notice"));
    else for (const m of before) rows.push(m);
    while (at >= 0 && at < items.length) {
      let end = at + 1;
      while (end < items.length && items[end].kind !== "user") end++;
      const user = items[at], rest = items.slice(at + 1, end);
      rows.push(user);
      if (end === items.length && busy) {
        rows.push({ id: "__working", kind: "working", doing: v.doing });
        for (const m of rest) rows.push(m);
      } else {
        const work = rest.filter(isWork);
        if (work.length || user.took != null) fold(`__worked-${user.id}`, user.took != null ? `Worked for ${took(user.took)}` : "Worked", work, rest.filter((m) => !isWork(m)));
        else for (const m of rest) rows.push(m);
      }
      at = end;
    }
    // The same note several times running (a session begun anew at each restart) is said once.
    return rows.filter((m, i) => !(m.kind === "notice" && rows[i - 1]?.kind === "notice" && rows[i - 1].text === m.text));
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
          if (m.kind === "fold") { this.expanded[id] = !this.expanded[id]; return cx.notify(); }
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
        // T3: the thought itself on one muted line; it opens to the whole of it.
        const line = (m.text ?? "").trim().split("\n")[0];
        return lane(v_flex()
          .child(workLine(k, "brain", line || (m.open ? "Thinking" : "Thought"), { trail: [chevron(open)] }))
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
      case "fold":
        // chat/TimelineWorkGroupRows.tsx: the words, a chevron, and a hairline under them.
        return lane(h_flex().pt(4).pb(8).border_b(1).border_color(alpha(k.border, 0.6))
          .child(h_flex().h(24).px(4).gap(6).items_center().rounded(6).text_size(14).line_height("23px").text_color(k.muted).when(!m.bare, (el) => el.cursor_pointer())
            .child(m.label).when(!m.bare, (el) => el.child(icon(m.open ? "chevron-down" : "chevron-right").size(12).flex_none()))), m.open ? 6 : 12);
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
      // A model named by its path ("provider/Model") shows as the model alone, as T3's "Qwen3.8 (tatooine-r9700)":
      // the start of the path says least and would push the name out of the control. The menu lists the whole names.
      const whole = String(cur?.name ?? o.current ?? o.name), cut = (o.category ?? o.id) === "model" ? whole.lastIndexOf("/") : -1;
      const named = cut > 0 && cut < whole.length - 1 ? { label: whole.slice(cut + 1) } : { label: whole };
      return control(k, `opt-${o.id}`, {
        glyph: OPTION_GLYPH[o.category ?? o.id] ?? (o.id === "model" ? "sparkles" : "lock"),
        // T3's model control leads with the harness's own icon.
        mark: (o.category ?? o.id) === "model" && this.source.kind === "acp" ? agentMark(agentOf(this.source.state?.agentArgv), 16, alpha(k.foreground, 0.8)) : null,
        label: named.label, suffix: o.suffix ?? null, open: this.picker === o.id,
        onClick: o.readonly ? null : (cx) => {
          this.picker = this.picker === o.id ? null : o.id;
          this.filter.set_value("");
          if (this.picker && o.choices.length > 8) this.filter.focus();
          cx.notify();
        },
      });
    });

    const card = v_flex().rounded(16).border(1).border_color(line).bg(k.card).shadow_xs()
      .child(div().px(16).pt(14).pb(8).text_size(14).line_height("23px")
        .on_size_change((size, cx) => {
          const w = size.width / (Number(settings()?.zoom) || 1);
          if (Math.abs(w - (this.fieldW ?? 0)) < 1) return;
          this.fieldW = w;
          if (this.fitHint()) cx.notify();
        })
        .child(Textarea.new(this.input)))
      .child(h_flex().px(8).pb(8).gap(2).items_center()
        .child(div().flex_1())
        .children(controls)
        .child(div().w(6).flex_none())
        .child(action));
    return lane(drawer ? v_flex().child(drawer).child(card) : card);
  }
}
