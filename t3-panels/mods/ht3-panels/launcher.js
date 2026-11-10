// The New chat dialog (T3's dialog sizes: 512 wide, 24 in, a 20px title, the buttons in a
// footer under a line). It offers the agents already running in this tab's terminals, whose
// conversation the chat shows, and the ACP agents installed where the space is, which the
// chat starts itself. Open chat splits a chat pane to the right of the pane under the dialog.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, closeOverlay, focused, spaces, panes, home, pickFolder } from "herdr";
import { MOD, tokens, alpha, icon, agentMark, button, iconButton, shortPath } from "./look.js";
import { AGENTS, detect } from "./agent-acp.js";
import { enabledAgents, agentOn, firstAgent } from "./settings.js";
import { KINDS } from "./core/chat-reader.js";

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export class Launcher {
  init(p, cx) {
    this.overlay = p.overlay;
    const f = focused();
    this.pane = f?.pane ?? null;
    this.machine = (f && spaces().find((s) => s.id === f.space)?.machine) ?? null;
    this.cwd = f?.cwd ?? spaces().find((s) => s.id === f?.space)?.folder ?? (this.machine ? null : home());
    // Claude Code and Codex terminals in the shown tab: their logs can be read as a chat.
    this.running = panes().filter((x) => x.tab === f?.tab && x.terminal && (KINDS[x.app] ?? KINDS[x.program?.key]))
      .map((x) => ({ id: `term:${x.terminal}`, terminal: x.terminal, name: x.program?.name ?? x.app, title: x.title, status: x.status, focused: x.pane === f?.pane }));
    this.found = null;
    this.error = null;
    this.choice = (this.running.find((x) => x.focused) ?? this.running[0])?.id ?? null;
    this.custom = InputState.new({ placeholder: "or a command that speaks ACP, e.g. my-agent --acp" });
    this.custom.on("change", (_e, cx) => cx.notify());
    cx.spawn(async (cx) => {
      const d = await detect(this.machine);
      this.found = d.found;
      this.error = d.error;
      if (this.machine && !this.cwd) this.cwd = d.found.HOME ?? null;
      this.choice ??= firstAgent(d.found);
      cx.notify();
    });
  }

  close() {}
  command() {}

  open() {
    // A chat is a tab of its own, the whole work area, not a split beside the terminal.
    const space = focused()?.space;
    const base = { mod: MOD, ...(space ? { space } : {}) };
    const typed = this.custom.value().trim();
    const term = this.running.find((x) => x.id === this.choice);
    const agent = AGENTS.find((a) => a.id === this.choice);
    if (typed) run("tab.new", { ...base, name: typed.split(/\s+/)[0], props: { panel: "chat", chat: newId(), agent: typed.split(/\s+/), cwd: this.cwd, machine: this.machine } });
    else if (term) run("tab.new", { ...base, name: term.name ?? "Chat", props: { panel: "chat", terminal: term.terminal } });
    else if (agent && agentOn(agent.id) && this.found?.[agent.argv[0]]) run("tab.new", { ...base, name: agent.name ?? agent.id, props: { panel: "chat", chat: newId(), agent: [this.found[agent.argv[0]], ...agent.argv.slice(1)], cwd: this.cwd, machine: this.machine } });
    else return;
    closeOverlay(this.overlay);
  }

  render(_cx) {
    const k = tokens();
    const remote = this.machine != null;
    const where = remote ? `${this.machine}:${this.cwd ?? "~"}` : shortPath(this.cwd);
    const label = (text) => div().px(10).pt(8).pb(4).text_size(12).font_medium().text_color(k.muted).child(text);
    const row = (id, glyph, name, detail, { enabled = true, dot = null, agent = null } = {}) => {
      const on = this.choice === id;
      return h_flex().id(`pick-${id}`).h(32).px(10).gap(10).flex_none().items_center().rounded(8).text_size(14)
        .bg(on ? k.accent : "#00000000")
        .when(enabled, (el) => el.role("button").accessibility_label(name).cursor_pointer().hover((s) => s.bg(on ? k.accent : alpha(k.accent, 0.6))).on_click((_e, cx) => { this.choice = id; cx.notify(); }))
        .child(h_flex().size(16).flex_none().items_center().justify_center().opacity(enabled ? 1 : 0.5)
          .child(agentMark(agent, 16, k.foreground) ?? icon(glyph).size(16).flex_none().text_color(enabled ? k.muted : k.dim)))
        .child(div().flex_none().font_medium().text_color(enabled ? k.foreground : k.dim).child(name))
        .when(!!dot, (el) => el.child(div().size(6).flex_none().rounded_full().bg(dot)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(detail ?? ""))
        .when(on, (el) => el.child(icon("check").size(14).flex_none().text_color(k.muted)));
    };
    const ready = !!this.custom.value().trim() || this.running.some((x) => x.id === this.choice)
      || !!(enabledAgents().find((a) => a.id === this.choice) && this.found?.[AGENTS.find((a) => a.id === this.choice).argv[0]]);
    return v_flex().id("ht3-launcher").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(v_flex().px(24).pt(24).pb(8).gap(8).flex_none()
        .child(h_flex().items_center()
          .child(div().flex_1().text_size(20).font_semibold().child("New chat"))
          // The agents listed here, and their models, are chosen in Settings.
          .child(iconButton(k, "launcher-settings", "settings-2", () => { closeOverlay(this.overlay); run(`${MOD}.settings`); }, { tip: "Settings: agents and models" })))
        .child(div().text_size(14).text_color(k.muted).child("Show an agent that is already running here, or start one.")))
      .child(v_flex().id("ht3-launcher-list").flex_1().min_h(0).px(14).overflow_y_scrollbar()
        .when(this.running.length > 0, (el) => el
          .child(label("Running in this tab"))
          .children(this.running.map((x) => row(x.id, "square-terminal", x.name, `${x.terminal} · reads its conversation, types into its terminal`,
            { dot: x.status === "working" ? k.primary : x.status === "blocked" ? k.warning : null }))))
        .child(label("Start an agent"))
        .child(h_flex().px(10).pb(6).gap(8).items_center()
          .child(icon("folder").size(14).flex_none().text_color(k.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(where || "No folder"))
          .when(!remote, (el) => el.child(button(k, "pick-folder", "Change…", (cx) => cx.spawn(async (cx) => {
            const dir = await pickFolder({ prompt: "Folder for the agent" });
            if (dir) this.cwd = dir;
            cx.notify();
          })))))
        .when(!this.found, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.muted).child("Looking for installed agents…")))
        .when(!!this.error, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.destructiveText).child(this.error)))
        .when(!!this.found && !enabledAgents().length, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.muted).child("No agent is enabled in Settings.")))
        .when(!!this.found, (el) => el.children(enabledAgents().map((a) => {
          const path = this.found[a.argv[0]];
          return row(a.id, "bot", a.name, path ? a.argv.join(" ") : `not installed${a.hint ? ` · ${a.hint}` : ""}`, { enabled: !!path, agent: a });
        })))
        .child(div().mx(10).mt(8).h(30).px(11).rounded(8).border(1).border_color(k.input).text_size(14).child(Input.new(this.custom))))
      .child(h_flex().px(24).py(16).gap(8).flex_none().justify_end().border_t(1).border_color(k.border)
        .child(button(k, "cancel", "Cancel", () => closeOverlay(this.overlay), { variant: "outline", size: "default" }))
        .child(button(k, "open", "Open chat", () => this.open(), { variant: "default", size: "default", disabled: !ready })));
  }
}
