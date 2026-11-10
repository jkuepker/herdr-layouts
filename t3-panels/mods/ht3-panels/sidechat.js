// T3 Code's Side chat surface: a chat in the side panel, with an agent of its own (chat.js over
// ACP) while the main work goes on. A group has at most one; it is started from a short list of
// the ACP agents installed where the space lives, in the folder the space works in. Its tab in
// the panel's state keeps { chat, agent, cwd, machine }; closing the tab stops the agent.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome } from "herdr";
import { MOD, tokens, alpha, icon, button } from "./look.js";
import { ChatPanel } from "./chat.js";
import { AGENTS, detect, argvOf } from "./agent-acp.js";
import { GROUPS, read, change, activeSpace, placeOf } from "./side.js";

const newId = () => "side-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// Gives the group's side chat tab its agent: `agentId` from AGENTS, found on `found` (detect()'s paths).
export function beginChat(group, agentId, found) {
  const a = AGENTS.find((x) => x.id === agentId);
  if (!a || !found?.[a.argv[0]]) return false;
  const sp = activeSpace();
  const { on, cwd } = placeOf(sp);
  change(sp?.id, (st) => {
    const t = st[group].tabs.find((x) => x.kind === "chat");
    if (t) t.chat = { id: newId(), agent: [found[a.argv[0]], ...a.argv.slice(1)], name: a.name, cwd: cwd ?? found.HOME ?? null, machine: on };
  });
  return true;
}

export class SideChat {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.panels = new Map(); // chat id -> ChatPanel
    this.starting = new Set();
    this.found = null;
    this.error = null;
    this.choice = null;
    this.where = null;
    cx.timer.every(2000, (cx) => this.sweep(cx));
    cx.spawn(async (cx) => {
      const sp = activeSpace();
      this.where = placeOf(sp);
      const d = await detect(this.where.on);
      this.found = d.found;
      this.error = d.error;
      this.choice = AGENTS.find((a) => d.found[a.argv[0]])?.id ?? null;
      cx.notify();
    });
  }

  // Stops the chats whose tab is gone (this copy is not drawn while another tab shows).
  sweep(cx) {
    const live = new Set(GROUPS.flatMap((g) => Object.values(read().spaces).flatMap((s) => s[g].tabs.map((t) => t.chat?.id).filter(Boolean))));
    for (const [id, panel] of this.panels) {
      if (live.has(id)) continue;
      this.panels.delete(id);
      // Closing a side chat ends it: its saved conversation goes too.
      panel.close(cx).then(() => exec("rm", ["-rf", `${appHome()}/data/${MOD}/chats/${id}`])).catch(() => {});
    }
  }

  async close(cx) {
    for (const panel of this.panels.values()) await panel.close(cx);
  }

  command(c, cx) {
    for (const panel of this.panels.values()) panel.command?.(c, cx);
  }

  start(cx, tab) {
    beginChat(this.group, this.choice, this.found);
    cx.notify();
  }

  render(cx) {
    const k = tokens();
    const sp = activeSpace();
    const st = read().spaces[sp?.id ?? ""];
    const tab = st?.[this.group]?.tabs.find((t) => t.kind === "chat");
    const root = v_flex().id(`ht3-sidechat-${this.group}`).size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(14);
    if (!tab) return root.child(div().m_auto().text_color(k.muted).child("Open a side chat from the + menu."));
    if (tab.chat) {
      const panel = this.panels.get(tab.chat.id);
      if (!panel) {
        // A chat's inputs can't be made while drawing: the next tick makes it.
        if (!this.starting.has(tab.chat.id)) {
          this.starting.add(tab.chat.id);
          const c = tab.chat;
          cx.timer.after(0, (cx) => {
            const made = new ChatPanel();
            made.init({ panel: "chat", chat: c.id, agent: c.agent, cwd: c.cwd, machine: c.machine }, cx);
            this.panels.set(c.id, made);
            this.starting.delete(c.id);
            cx.notify();
          });
        }
        return root.child(div().m_auto().text_color(k.muted).child("Starting the chat…"));
      }
      return root.child(panel.render(cx));
    }
    const row = (a) => {
      const ok = !!this.found?.[a.argv[0]], on = this.choice === a.id;
      return h_flex().id(`sc-${a.id}`).h(32).px(10).gap(10).flex_none().items_center().rounded(8).text_size(14).bg(on ? k.accent : "#00000000")
        .when(ok, (el) => el.role("button").accessibility_label(a.name).cursor_pointer().hover((s) => s.bg(on ? k.accent : alpha(k.accent, 0.6))).on_click((_e, cx) => { this.choice = a.id; cx.notify(); }))
        .child(icon("bot").size(16).flex_none().text_color(ok ? k.muted : k.dim))
        .child(div().flex_none().font_medium().text_color(ok ? k.foreground : k.dim).child(a.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(ok ? a.argv.join(" ") : `not installed${a.hint ? ` · ${a.hint}` : ""}`))
        .when(on, (el) => el.child(icon("check").size(14).flex_none().text_color(k.muted)));
    };
    return root.px(16).pt(20).gap(8)
      .child(div().text_size(16).font_semibold().child("Side chat"))
      .child(div().text_size(13).text_color(k.muted).child("Ask a side question while your work goes on. Pick the agent to start here."))
      .child(div().text_size(12).text_color(k.muted).child(this.where?.on ? `${this.where.on}:${this.where.cwd ?? "~"}` : this.where?.cwd ?? ""))
      .when(!this.found, (el) => el.child(div().text_size(12).text_color(k.muted).child("Looking for installed agents…")))
      .when(!!this.error, (el) => el.child(div().text_size(12).text_color(k.destructiveText).child(this.error)))
      .child(v_flex().gap(2).children(AGENTS.map(row)))
      .child(h_flex().pt(8).child(button(k, "sc-start", "Start chat", (cx) => this.start(cx, tab), { variant: "default", size: "default", disabled: !this.choice })));
  }
}
