// A chat pane for agents that speak the Agent Client Protocol (omp, OpenCode,
// the Claude Code and Codex ACP adapters, Gemini CLI). A mod can't keep a
// program running, so bridge.mjs holds the agent session in a herdr-core
// terminal; this mod reads the chat from <chat folder>/state.json and sends
// commands as files in <chat folder>/inbox/.
//
// Open it beside a terminal: pane.split {"direction": "right", "mod": "acp-chat"}.

import { View, div, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { exec, hc, appHome, home, focused, props, theme, settings, pickFolder, readTextFile, writeTextFile, watchFolder } from "herdr";
import * as fs from "fs/promises";

// Agents that speak ACP over stdio. `argv[0]` is looked up on PATH.
const AGENTS = [
  { id: "omp", name: "Oh My Pi", argv: ["omp", "acp"] },
  { id: "opencode", name: "OpenCode", argv: ["opencode", "acp"] },
  { id: "claude", name: "Claude Code", argv: ["claude-code-acp"], hint: "npm i -g @zed-industries/claude-code-acp" },
  { id: "codex", name: "Codex", argv: ["codex-acp"], hint: "github.com/zed-industries/codex-acp" },
  { id: "gemini", name: "Gemini CLI", argv: ["gemini", "--experimental-acp"] },
];

const LEASE_EVERY_MS = 60 * 1000;
const DETAIL_MAX = 4000;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function shortPath(p) {
  const h = home();
  return p && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "";
}

export default class AcpChat extends View {
  // props (all optional): chat (an id to reopen), agent (an AGENTS id, or an argv
  // array), cwd. With `agent`, a new chat starts at once instead of showing setup.
  init(_props, cx) {
    const p = props() ?? {};
    this.chatId = p.chat ?? localStorage.getItem("chat");
    if (!this.chatId || (p.agent && !p.chat)) {
      this.chatId = newId();
      localStorage.setItem("chat", this.chatId);
    }
    this.dir = `${appHome()}/data/acp-chat/chats/${this.chatId}`;
    this.name = `acp-chat-${this.chatId}`;
    this.bridge = `${appHome()}/mods/acp-chat/bridge.mjs`;

    this.state = null; // the bridge's state.json
    this.alive = false; // the bridge terminal is running
    this.phase = "loading"; // loading | setup | starting | chat
    this.found = {}; // program -> absolute path
    this.cwd = p.cwd ?? focused()?.cwd ?? home();
    this.choice = null; // agent id picked in setup
    this.expanded = {};
    this.follow = true;
    this.picker = null; // config option id whose choices are open
    this.cmdSeq = 0;

    this.input = TextareaState.new({ placeholder: "Message the agent…  (Enter sends, Shift+Enter for a new line)" });
    this.input.set_auto_grow(1, 8);
    // A textarea's Enter inserts a newline and then submits; Shift+Enter submits with `shift`.
    this.input.on("submit", (e, cx) => {
      if (!e?.shift) this.send(cx);
    });
    this.custom = InputState.new({ placeholder: "or a command, e.g. my-agent --acp" });
    this.filter = InputState.new({ placeholder: "Filter…" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.scroll = VirtualListScrollHandle.new();

    cx.spawn(async (cx) => {
      await fs.mkdir(`${this.dir}/inbox`, { recursive: true });
      await this.detect();
      await this.reload(cx);
      this.alive = await this.bridgeAlive();
      this.phase = this.alive || this.state ? "chat" : "setup";
      this.watch(cx);
      if (this.phase === "setup" && p.agent) {
        const agent = AGENTS.find((a) => a.id === p.agent);
        const argv = Array.isArray(p.agent) ? p.agent : agent && this.found[agent.argv[0]] ? [this.found[agent.argv[0]], ...agent.argv.slice(1)] : null;
        if (argv) return this.start(cx, argv);
      }
      cx.notify();
    });
    cx.timer.every(LEASE_EVERY_MS, () => this.touchLease());
  }

  async close(_cx) {
    if (this.alive) await exec("hc", ["kill", this.name]);
  }

  // Bridge and files

  async detect() {
    const programs = ["node", ...new Set(AGENTS.map((a) => a.argv[0]))];
    const script = programs.map((p) => `printf '%s=%s\\n' ${p} "$(command -v ${p})"`).join("; ");
    const r = await exec("/bin/sh", ["-lc", script]);
    for (const line of r.stdout.split("\n")) {
      const [k, v] = line.split("=");
      if (k && v) this.found[k] = v.trim();
    }
    this.choice = AGENTS.find((a) => this.found[a.argv[0]])?.id ?? null;
  }

  async bridgeAlive() {
    const r = await hc(["ls", "--json"]);
    try {
      const data = JSON.parse(r.stdout);
      const terms = Array.isArray(data) ? data : data.terminals ?? [];
      return terms.some((t) => t.name === this.name && t.state === "live");
    } catch {
      return false;
    }
  }

  async reload(cx) {
    const text = await readTextFile(`${this.dir}/state.json`);
    if (!text) return;
    let next;
    try {
      next = JSON.parse(text);
    } catch {
      return; // caught mid-rename; the next change brings a whole file
    }
    if (this.state && next.seq === this.state.seq) return;
    const grew = next.transcript.items.length !== (this.state?.transcript.items.length ?? 0) || next.seq !== this.state?.seq;
    this.state = next;
    if (["exited", "stopped"].includes(next.status)) this.alive = false;
    if (grew && this.follow) this.scroll.scroll_to_bottom();
    cx.notify();
  }

  // One loop per chat folder: a new chat ends the old folder's loop.
  watch(cx) {
    const dir = this.dir;
    cx.spawn(async (cx) => {
      while (dir === this.dir) {
        try {
          await watchFolder(dir);
        } catch {
          await new Promise((done) => cx.timer.after(1000, done));
        }
        if (dir === this.dir) await this.reload(cx);
      }
    });
  }

  touchLease() {
    if (this.alive) fs.writeFile(`${this.dir}/lease`, String(Date.now())).catch(() => {});
  }

  command(cmd) {
    const name = `${Date.now()}-${String(this.cmdSeq++).padStart(4, "0")}.json`;
    return writeTextFile(`${this.dir}/inbox/${name}`, JSON.stringify(cmd), null);
  }

  start(cx, argv, cwd = this.cwd) {
    if (!this.found.node) return;
    this.phase = "starting";
    this.alive = true;
    this.follow = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await fs.writeFile(`${this.dir}/lease`, String(Date.now()));
      const r = await hc([
        "run", "--bg", "--no-parent", "--no-notify", "--json",
        "--name", this.name, "--cwd", cwd, "--label", `herdr.acp-chat=${this.chatId}`,
        "--", this.found.node, this.bridge, "--dir", this.dir, "--", ...argv,
      ]);
      if (r.code !== 0) {
        this.alive = false;
        this.phase = "setup";
        this.startError = (r.stderr || r.stdout).trim();
      } else {
        this.phase = "chat";
      }
      cx.notify();
    });
  }

  startChoice(cx) {
    const typed = this.custom.value().trim();
    if (typed) return this.start(cx, typed.split(/\s+/));
    const agent = AGENTS.find((a) => a.id === this.choice);
    if (!agent) return;
    this.start(cx, [this.found[agent.argv[0]], ...agent.argv.slice(1)]);
  }

  // Same agent and folder; the bridge resumes the agent's session when it can.
  restart(cx) {
    this.start(cx, this.state.agentArgv, this.state.cwd);
  }

  newChat(cx) {
    if (this.alive) exec("hc", ["kill", this.name]);
    this.chatId = newId();
    localStorage.setItem("chat", this.chatId);
    this.dir = `${appHome()}/data/acp-chat/chats/${this.chatId}`;
    this.name = `acp-chat-${this.chatId}`;
    this.state = null;
    this.alive = false;
    this.phase = "setup";
    this.expanded = {};
    cx.spawn(async (cx) => {
      await fs.mkdir(`${this.dir}/inbox`, { recursive: true });
      this.watch(cx);
      cx.notify();
    });
    cx.notify();
  }

  send(cx) {
    const text = this.input.value().trim();
    if (!text || !this.alive || this.state?.status !== "ready") return;
    this.input.set_value("");
    this.follow = true;
    this.command({ type: "prompt", text });
    cx.notify();
  }

  // UI

  render(_cx) {
    const t = theme();
    const root = v_flex().id("acp-chat").size_full().bg(t.surface).text_color(t.foreground).text_size(13);
    if (this.phase === "loading") return root.child(this.centered(t, "Loading…"));
    if (this.phase === "setup") return root.child(this.setup(t));
    if (!this.state) return root.child(this.centered(t, "Starting the agent…"));
    return root
      .child(this.header(t))
      .when(this.picker != null, (el) => el.child(this.pickerPanel(t)))
      .child(this.messages(t))
      .when(this.state.permission != null, (el) => el.child(this.permission(t)))
      .child(this.composer(t));
  }

  centered(t, text) {
    return v_flex().flex_1().items_center().justify_center().text_color(t.muted).child(text);
  }

  button(t, id, label, onClick, { primary = false, disabled = false } = {}) {
    return div().id(id).px(10).py(4).rounded(5).border(1).text_size(12)
      .border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.surface)
      .text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(!disabled, (el) => el.hover((s) => s.bg(primary ? t.accent : t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  setup(t) {
    const node = this.found.node;
    return v_flex().flex_1().p(16).gap(12).overflow_y_scrollbar()
      .child(div().text_size(15).font_semibold().child("New agent chat"))
      .child(div().text_color(t.muted).child("Pick an agent that speaks ACP. It runs in this folder:"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().truncate().px(8).py(4).rounded(5).bg(t.background).child(shortPath(this.cwd)))
        .child(this.button(t, "pick-folder", "Change…", (cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Folder for the agent" });
          if (dir) this.cwd = dir;
          cx.notify();
        }))))
      .child(v_flex().gap(4).children(AGENTS.map((a) => {
        const path = this.found[a.argv[0]];
        const picked = this.choice === a.id;
        return h_flex().id(`agent-${a.id}`).gap(8).px(10).py(6).rounded(6).border(1).items_center()
          .border_color(picked ? t.accent : t.border)
          .bg(picked ? t.selected : t.surface)
          .when(!!path, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.choice = a.id; cx.notify(); }))
          .child(div().w(10).h(10).rounded(5).bg(path ? t.done : t.dim))
          .child(div().font_semibold().text_color(path ? t.foreground : t.dim).child(a.name))
          .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(path ? a.argv.join(" ") : `not installed${a.hint ? ` · ${a.hint}` : ""}`));
      })))
      .child(Input.new(this.custom))
      .when(!node, (el) => el.child(div().text_color(t.blocked).child("Node.js isn't on PATH; the chat bridge needs it.")))
      .when(!!this.startError, (el) => el.child(div().text_color(t.blocked).child(this.startError)))
      .child(h_flex().child(this.button(t, "start", "Start chat", (cx) => this.startChoice(cx), { primary: true, disabled: !node })));
  }

  header(t) {
    const s = this.state;
    const name = s.agentInfo?.title ?? s.agentInfo?.name ?? s.agentArgv?.[0]?.split("/").pop() ?? "Agent";
    const status = { starting: "starting", ready: "ready", working: "working", exited: "stopped", stopped: "stopped" }[s.status] ?? s.status;
    const color = { working: t.working, ready: t.done, starting: t.idle }[s.status] ?? t.dim;
    const usage = s.transcript.usage;
    return v_flex().px(12).py(8).gap(6).border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(8).items_center()
        .child(s.status === "working"
          ? div().text_color(color).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)
          : div().w(8).h(8).rounded(4).bg(color))
        .child(div().font_semibold().child(name))
        .child(div().text_color(t.dim).child(status))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(shortPath(s.cwd)))
        .when(usage?.size > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${Math.round((100 * usage.used) / usage.size)}% context`)))
        .child(this.button(t, "new-chat", "New", (cx) => this.newChat(cx))))
      .when(s.configOptions?.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(
        s.configOptions.filter((o) => o.type === "select").map((o) => {
          const current = o.options.find((c) => c.value === o.currentValue);
          const open = this.picker === o.id;
          return h_flex().id(`cfg-${o.id}`).gap(4).px(8).py(2).rounded(10).border(1).text_size(11)
            .border_color(open ? t.accent : t.border).bg(open ? t.selected : t.surface)
            .hover((st) => st.bg(t.hover))
            .on_click((_e, cx) => {
              this.picker = open ? null : o.id;
              this.filter.set_value("");
              if (!open) this.filter.focus();
              cx.notify();
            })
            .child(div().text_color(t.dim).child(o.name))
            .child(div().max_w(260).truncate().child(current?.name ?? o.currentValue ?? "—"));
        }))));
  }

  pickerPanel(t) {
    const opt = this.state.configOptions.find((o) => o.id === this.picker);
    if (!opt) return div();
    const f = this.filter.value().toLowerCase();
    const choices = opt.options.filter((c) => !f || c.name.toLowerCase().includes(f) || String(c.value).toLowerCase().includes(f));
    return v_flex().h(Math.min(320, 44 + choices.length * 26)).px(12).py(8).gap(6).border_b(1).border_color(t.border).bg(t.popover)
      .child(Input.new(this.filter))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(list(`pick-${opt.id}`, choices.length, (i) => String(choices[i].value), (i) => {
          const c = choices[i];
          const on = c.value === opt.currentValue;
          return h_flex().h(26).px(6).gap(8).items_center().rounded(4).bg(on ? t.selected : t.popover)
            .child(div().w(12).text_color(t.accent).child(on ? "✓" : ""))
            .child(div().truncate().child(c.name))
            .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(c.name === c.value ? "" : String(c.value)));
        }).on_item_click((value, cx) => {
          this.command({ type: "config", configId: opt.id, value });
          this.picker = null;
          cx.notify();
        }))
        .child(Scrollbar.vertical(`pick-${opt.id}`).absolute().inset_0()));
  }

  messages(t) {
    const tr = this.state.transcript;
    const items = tr.items;
    const mono = settings().font_family;
    return v_flex().relative().flex_1().min_h(0)
      .on_scroll_wheel((e, cx) => {
        if (e.delta.y > 0 && this.follow) { this.follow = false; cx.notify(); }
      })
      .child(list("acp-msgs", items.length, (i) => items[i].id, (i) => this.item(t, items[i], i === 0 ? tr.dropped : 0, mono))
        .track_scroll(this.scroll)
        .on_item_click((id, cx) => {
          this.expanded[id] = !this.expanded[id];
          cx.notify();
        }))
      .child(Scrollbar.vertical("acp-msgs").absolute().inset_0())
      .when(!this.follow, (el) => el.child(div().absolute().bottom(8).right(16)
        .child(this.button(t, "latest", "↓ Latest", (cx) => {
          this.follow = true;
          this.scroll.scroll_to_bottom();
          cx.notify();
        }))));
  }

  item(t, m, dropped, mono) {
    const row = v_flex().px(12).py(4).gap(4)
      .when(dropped > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${dropped} earlier messages not shown`)));
    switch (m.kind) {
      case "user":
        return row.child(div().px(10).py(6).rounded(8).bg(t.raised).child(m.text));
      case "agent":
        return row.child(TextView.markdown(`md-${m.id}`, m.text).selectable(true));
      case "thought": {
        const open = this.expanded[m.id];
        const text = open ? m.text : m.text.split("\n").slice(-2).join(" ").slice(-240);
        return row.child(div().text_size(12).text_color(t.dim).italic().child((open ? "▾ " : "▸ ") + "Thinking  " + text));
      }
      case "tool": {
        const icon = { completed: "✓", failed: "✗", in_progress: "◐", pending: "○" }[m.status] ?? "•";
        const color = { completed: t.done, failed: t.blocked, in_progress: t.working }[m.status] ?? t.dim;
        const open = this.expanded[m.id] && m.detail;
        return row.child(v_flex().px(8).py(4).rounded(6).border(1).border_color(t.border).bg(t.background)
          .child(h_flex().gap(6).items_center().text_size(12)
            .child(div().text_color(color).child(icon))
            .child(div().text_color(t.dim).child(m.toolKind ?? "tool"))
            .child(div().flex_1().truncate().child(m.title || "…"))
            .when(!!m.detail, (el) => el.child(div().text_color(t.dim).child(open ? "▾" : "▸"))))
          .when(!!open, (el) => el.child(div().text_size(11).font_family(mono).text_color(t.muted)
            .child(m.detail.length > DETAIL_MAX ? m.detail.slice(0, DETAIL_MAX) + "\n…" : m.detail))));
      }
      case "plan":
        return row.child(v_flex().px(8).py(4).gap(2).rounded(6).bg(t.background).text_size(12)
          .child(div().text_color(t.dim).child("Plan"))
          .children(m.entries.map((e) => h_flex().gap(6)
            .child(div().text_color(e.status === "completed" ? t.done : e.status === "in_progress" ? t.working : t.dim)
              .child(e.status === "completed" ? "☑" : e.status === "in_progress" ? "◐" : "☐"))
            .child(div().flex_1().text_color(e.status === "completed" ? t.dim : t.foreground).child(e.content)))));
      case "notice":
        return row.child(div().text_size(12).text_color(m.level === "error" ? t.blocked : m.level === "warn" ? t.working : t.dim).child(m.text));
    }
    return row;
  }

  permission(t) {
    const p = this.state.permission;
    return v_flex().mx(12).mb(6).p(10).gap(8).rounded(8).border(1).border_color(t.blocked).bg(t.raised)
      .child(div().font_semibold().child(p.title))
      .child(h_flex().gap(6).flex_wrap().children(p.options.map((o) =>
        this.button(t, `perm-${o.optionId}`, o.name, () => this.command({ type: "permission", optionId: o.optionId }), { primary: o.kind?.startsWith("allow") }))));
  }

  composer(t) {
    const s = this.state;
    if (!this.alive) {
      return v_flex().px(12).py(10).gap(8).border_t(1).border_color(t.border).bg(t.chrome)
        .when(!!s.error, (el) => el.child(div().text_size(12).text_color(t.blocked).child(s.error)))
        .child(h_flex().gap(6)
          .child(this.button(t, "restart", "Restart agent", (cx) => this.restart(cx), { primary: true }))
          .child(this.button(t, "new", "New chat", (cx) => this.newChat(cx))));
    }
    const working = s.status === "working";
    return h_flex().px(12).py(8).gap(8).items_end().border_t(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().child(Textarea.new(this.input)))
      .child(working
        ? this.button(t, "stop", "Stop", () => this.command({ type: "cancel" }))
        : this.button(t, "send", "Send", (cx) => this.send(cx), { primary: true, disabled: s.status !== "ready" }));
  }
}
