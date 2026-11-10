// A chat pane for agents that speak the Agent Client Protocol (omp, OpenCode,
// the Claude Code and Codex ACP adapters, Gemini CLI). session.js holds the
// agent session; where it runs depends on the Herdr build:
// - with `spawn` (herdrdev/herdr-app#723), in this mod: the agent's stdio comes
//   straight here, and <chat folder>/state.json is kept only to resume;
// - without it, a mod's `exec` can't keep a program running, so bridge.mjs
//   holds the session in a herdr-core terminal; this mod reads the chat from
//   state.json and sends commands as files in <chat folder>/inbox/.
//
// Two faces:
// - the launcher, as a dialog (`mod.open {"name": "acp-chat"}`): pick an agent
//   and a folder, then it splits a chat pane beside the focused one;
// - a chat pane, `pane.split {"mod": "acp-chat", "props": {chat, agent, cwd, machine, prompt}}`.
//   The `chat` id keeps each pane's chat (and its localStorage, which Herdr
//   keys by props) apart from every other pane's.
//
// In a space on another machine (with spawn only), the agent runs there over
// `ssh <machine's target>`, under the remote user's login, interactive shell,
// and finding agents goes the same way, so a green dot means it starts. Its
// stdio is still this mod's: closing the pane ends ssh, the agent sees its
// stdin close and exits.

import { View, div, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { exec, hc, run, openOverlay, closeOverlay, appHome, home, focused, spaces, props, theme, settings, pickFolder, readTextFile, writeTextFile, watchFolder } from "herdr";
import * as herdr from "herdr";
import * as fs from "fs/promises";
import { ChatSession } from "./session.js";

// Older Herdr builds have no `spawn`; a named import of it would fail to load.
const DIRECT = typeof herdr.spawn === "function";

// Agents that speak ACP over stdio. `argv[0]` is looked up on PATH.
const AGENTS = [
  { id: "omp", name: "Oh My Pi", argv: ["omp", "acp"] },
  { id: "pi", name: "Pi", argv: ["pi-acp"], hint: "npm i -g pi-acp" },
  { id: "opencode", name: "OpenCode", argv: ["opencode", "acp"] },
  { id: "claude", name: "Claude Code", argv: ["claude-agent-acp"], hint: "npm i -g @agentclientprotocol/claude-agent-acp" },
  { id: "codex", name: "Codex", argv: ["codex-acp"], hint: "github.com/zed-industries/codex-acp" },
  { id: "gemini", name: "Gemini CLI", argv: ["gemini", "--experimental-acp"] },
];

const LEASE_EVERY_MS = 60 * 1000;
const DRAW_EVERY_MS = 80;
// Why an agent that ended before it had a session didn't start: its program is missing (a shell's
// 127, or "not found"), or it gave up by itself. `threw`: spawn itself failed, with `exit.stderr` its reason.
function startFailure(argv, exit, machine, threw = false) {
  const name = String(argv?.[0] ?? "the agent").split("/").pop(), on = machine ? ` on ${machine}` : "";
  const err = String(exit?.stderr ?? "").trim().slice(-2000);
  if (exit?.code === 127 || /not found|no such file or directory|ENOENT/i.test(err.split("\n").pop() ?? ""))
    return `Couldn't start ${name}: not found${on}. Pick another agent${threw ? "" : " with New chat"}.`; // thrown: the picker is still shown
  if (threw) return `Couldn't start ${name}${on}: ${err}`;
  return `${name} ended before it started a session (${exit?.code == null ? "a signal" : `code ${exit.code}`}).` + (err ? `\n\n${err}` : "");
}

// A reply's text cut at its fenced code blocks, so each block can carry its own Copy row:
// [{ code, lang, text }]. A fence left open (still streaming) is a block to its end.
function segments(text) {
  const out = [];
  let buf = [], code = null;
  const flush = () => { if (buf.join("\n").trim()) out.push({ code: false, text: buf.join("\n") }); buf = []; };
  for (const line of String(text ?? "").split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
    if (!code && f) { flush(); code = { fence: f[1], lang: f[2], lines: [] }; }
    else if (code && f && f[1][0] === code.fence[0] && f[1].length >= code.fence.length && !f[2]) { out.push({ code: true, lang: code.lang, text: code.lines.join("\n") }); code = null; }
    else if (code) code.lines.push(line);
    else buf.push(line);
  }
  if (code) out.push({ code: true, lang: code.lang, text: code.lines.join("\n") });
  flush();
  return out;
}

const SAVE_EVERY_MS = 1000;
const MAX_STATE_BYTES = 800 * 1024; // readTextFile reads at most 1 MiB
const DETAIL_MAX = 4000;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function shortPath(p) {
  const h = home();
  return p && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "";
}

// Where a chat runs, as the dialog and header show it.
function where(machine, cwd) {
  return machine ? `${machine}:${cwd ?? "~"}` : shortPath(cwd);
}

function focusedMachine() {
  const f = focused();
  return (f && spaces().find((s) => s.id === f.space)?.machine) ?? null;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// `script` on the machine over ssh, under its user's login, interactive shell:
// the PATH their terminals get (nvm and ~/.local/bin often load only there).
function sshArgv(target, script) {
  return [
    "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    target, `exec "\${SHELL:-/bin/sh}" -lic ${shq(script)}`,
  ];
}

// The ssh target Herdr reaches the machine by (`hc machine ls`).
async function sshTarget(machine) {
  const r = await hc(["machine", "ls", "--json"]);
  let m;
  try {
    m = JSON.parse(r.stdout).machines?.find((x) => x.name === machine);
  } catch {}
  if (!m) throw new Error(`Herdr doesn't list a machine named ${machine}.`);
  if (m.via) throw new Error(`Herdr reaches ${machine} through a command (${m.via}); chats there need it added over ssh.`);
  return m.target;
}

function openLauncher() {
  openOverlay({ mod: "acp-chat", kind: "dialog", width: 560, height: 470 });
}

export default class AcpChat extends View {
  // Pane props (all optional): chat (its id), agent (an AGENTS id or an argv
  // array), cwd, machine (a Herdr machine name, null for this computer), prompt.
  // With `agent`, a chat that has never run starts at once, and sends `prompt`
  // as its first message. A pane without `chat` keeps one chat in its localStorage.
  init(_props, cx) {
    const p = props() ?? {};
    this.overlay = p.overlay ?? null; // set when this copy is the launcher dialog
    this.chatId = p.chat ?? localStorage.getItem("chat");
    if (!this.chatId) {
      this.chatId = newId();
      if (!this.overlay) localStorage.setItem("chat", this.chatId);
    }
    this.dir = `${appHome()}/data/acp-chat/chats/${this.chatId}`;
    this.name = `acp-chat-${this.chatId}`;
    this.bridge = `${appHome()}/mods/acp-chat/bridge.mjs`;

    this.state = null; // the session's state (from state.json without spawn)
    this.alive = false; // the agent (or its bridge) is running
    this.session = null; // with spawn: the ChatSession in this mod
    this.phase = "loading"; // loading | setup | starting | chat
    this.found = {}; // program -> absolute path
    this.machine = p.machine !== undefined ? p.machine : focusedMachine();
    this.target = null; // its ssh target, once found
    this.remoteError = null; // why the machine couldn't be asked
    this.cwd = p.cwd ?? focused()?.cwd ?? (this.machine ? null : home());
    this.choice = null; // agent id picked in setup
    this.firstPrompt = null; // a new chat's `prompt` prop, until it's sent
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
    // For scripts (`herdr-app do acp-chat.<command>`), what the Copy rows and Cmd+V do: copy:last (the
    // last reply), copy:code (its last code block), paste (the clipboard's text into the message box).
    if (typeof herdr.nextCommand === "function") cx.spawn(async (cx) => {
      for (;;) {
        const c = await herdr.nextCommand();
        const last = [...(this.state?.transcript?.items ?? [])].reverse().find((m) => m.kind === "agent");
        if (c === "copy:last" && last) this.copy(cx, `${last.id}:cp`, last.text);
        if (c === "copy:code" && last) { const g = segments(last.text).filter((x) => x.code).pop(); if (g) this.copy(cx, `${last.id}:cp`, g.text); }
        if (c === "paste") { const text = cx.read_from_clipboard(); if (text) this.input.replace(text); }
        cx.notify();
      }
    });
    this.custom = InputState.new({ placeholder: "or a command, e.g. my-agent --acp" });
    this.filter = InputState.new({ placeholder: "Filter…" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.scroll = VirtualListScrollHandle.new();

    if (this.overlay) {
      this.phase = "loading";
      cx.spawn(async (cx) => {
        await this.detect();
        this.phase = "setup";
        cx.notify();
      });
      return;
    }
    cx.spawn(async (cx) => {
      await fs.mkdir(DIRECT ? this.dir : `${this.dir}/inbox`, { recursive: true });
      await this.reload(cx);
      // A chat runs where it first ran; chats saved before remote ones existed ran here.
      if (this.state) this.machine = this.state.machine ?? null;
      await this.detect();
      if (DIRECT) {
        // It ran in an earlier copy of this pane (a reload, or the app quit): continue it.
        if (this.state && !["exited", "stopped"].includes(this.state.status)) return this.restart(cx);
        this.phase = this.state ? "chat" : "setup";
      } else {
        this.alive = await this.bridgeAlive();
        this.phase = this.alive || this.state ? "chat" : "setup";
        this.watch(cx);
      }
      if (this.phase === "setup" && p.agent) {
        const agent = AGENTS.find((a) => a.id === p.agent);
        const argv = Array.isArray(p.agent) ? p.agent : agent && this.found[agent.argv[0]] ? [this.found[agent.argv[0]], ...agent.argv.slice(1)] : null;
        if (argv) {
          this.firstPrompt = p.prompt ?? null;
          return this.start(cx, argv);
        }
      }
      cx.notify();
    });
    if (!DIRECT) cx.timer.every(LEASE_EVERY_MS, () => this.touchLease());
  }

  async close(_cx) {
    if (this.overlay) return;
    if (!DIRECT) {
      if (this.alive) await exec("hc", ["kill", this.name]);
      return;
    }
    if (!this.session) return;
    // Keep the status as it is, so the next copy of this pane resumes the chat.
    this.closing = true;
    const text = this.session.snapshot(MAX_STATE_BYTES);
    herdr.processKill(this.proc);
    await fs.writeFile(`${this.dir}/state.json`, text);
  }

  // Bridge and files

  async detect() {
    const programs = ["node", ...new Set(AGENTS.map((a) => a.argv[0]))];
    const script = [...programs.map((p) => `printf '%s=%s\\n' ${p} "$(command -v ${p})"`), `printf 'HOME=%s\\n' "$HOME"`].join("; ");
    let r;
    if (this.machine) {
      try {
        this.target = await sshTarget(this.machine);
        const argv = sshArgv(this.target, script);
        r = await exec(argv[0], argv.slice(1), { timeout: 30000 });
      } catch (e) {
        this.remoteError = String(e?.message ?? e);
        return;
      }
    } else {
      r = await exec("/bin/sh", ["-lc", script]);
    }
    // An interactive shell may print more; only these lines count.
    for (const line of r.stdout.split("\n")) {
      const at = line.indexOf("=");
      const k = line.slice(0, at);
      const v = line.slice(at + 1).trim();
      if (at > 0 && v && (k === "HOME" || programs.includes(k))) this.found[k] = v;
    }
    if (this.machine && !this.found.HOME) {
      this.remoteError = `Couldn't reach ${this.machine}: ${(r.stderr.trim().split("\n").pop() || `ssh exited with code ${r.code}`)}`;
      return;
    }
    if (this.machine && !this.cwd) this.cwd = this.found.HOME;
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
    if (DIRECT) return this.session?.handle(cmd);
    const name = `${Date.now()}-${String(this.cmdSeq++).padStart(4, "0")}.json`;
    return writeTextFile(`${this.dir}/inbox/${name}`, JSON.stringify(cmd), null);
  }

  start(cx, argv, cwd = this.cwd) {
    if (this.machine && !(DIRECT && this.target)) {
      const why = this.remoteError ?? (DIRECT ? `Couldn't find how to reach ${this.machine}.` : "Chats on another machine need a Herdr with spawn.");
      // A chat that ran keeps its messages, with the reason and Restart agent.
      if (this.state) Object.assign(this.state, { status: "exited", error: why });
      else this.startError = why;
      this.alive = false;
      this.phase = this.state ? "chat" : "setup";
      return cx.notify();
    }
    if (DIRECT) return this.startHere(cx, argv, cwd);
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
        // The bridge takes commands once the session is ready.
        if (this.firstPrompt) this.command({ type: "prompt", text: this.firstPrompt });
      }
      this.firstPrompt = null;
      cx.notify();
    });
  }

  // With spawn: the agent runs as this copy's program, and stops with it.
  startHere(cx, argv, cwd) {
    // On another machine the local program is ssh, started in this computer's home.
    const cmd = this.machine ? sshArgv(this.target, `cd ${shq(cwd)} && exec ${argv.map(shq).join(" ")}`) : argv;
    let proc;
    try {
      proc = herdr.spawn(cmd[0], cmd.slice(1), { cwd: this.machine ? home() : cwd });
    } catch (e) {
      this.phase = "setup";
      this.startError = startFailure(argv, { code: null, stderr: String(e?.message ?? e) }, this.machine, true);
      cx.notify();
      return;
    }
    if (this.session) herdr.processKill(this.proc);
    this.proc = proc;
    this.alive = true;
    this.follow = true;
    this.phase = "chat";
    this.startError = null;
    cx.spawn(async (cx) => {
      // Asked now, so killing it later can't lose the answer.
      const exited = herdr.processExited(proc);
      const session = new ChatSession({
        argv, cwd, machine: this.machine, old: this.state,
        write: (line) => herdr.processWrite(proc, line).catch(() => {}),
        kill: () => herdr.processKill(proc),
        changed: (urgent) => this.proc === proc && this.changed(cx, urgent),
      });
      this.session = session;
      this.state = session.state;
      cx.notify();
      const started = session.start();
      started.then((ok) => {
        if (ok && this.firstPrompt) session.handle({ type: "prompt", text: this.firstPrompt });
        this.firstPrompt = null;
      });
      for (let line; (line = await herdr.processNextLine(proc)) != null;) session.feed(line);
      const exit = await exited;
      if (this.proc !== proc || this.closing) return;
      this.alive = false;
      session.exited(exit.code == null ? "a signal" : `code ${exit.code}`, exit.stderr.slice(-2000));
      // It ended before it had a session: say why (session.js only knows "agent exited").
      if (!(await started.catch(() => false)) && session.state.status !== "stopped") session.failed(startFailure(argv, exit, this.machine));
    });
  }

  // Draws at most every DRAW_EVERY_MS and saves at most every SAVE_EVERY_MS, both at once when urgent.
  changed(cx, urgent) {
    if (["exited", "stopped"].includes(this.state.status)) this.alive = false;
    const save = () => fs.writeFile(`${this.dir}/state.json`, this.session.snapshot(MAX_STATE_BYTES)).catch(() => {});
    const draw = () => {
      if (this.follow) this.scroll.scroll_to_bottom();
      cx.notify();
    };
    if (urgent) {
      save();
      return draw();
    }
    if (!this.drawSoon) {
      this.drawSoon = true;
      cx.timer.after(DRAW_EVERY_MS, () => { this.drawSoon = false; draw(); });
    }
    if (!this.saveSoon) {
      this.saveSoon = true;
      cx.timer.after(SAVE_EVERY_MS, () => { this.saveSoon = false; save(); });
    }
  }

  startChoice(cx) {
    const typed = this.custom.value().trim();
    const agent = AGENTS.find((a) => a.id === this.choice);
    const argv = typed ? typed.split(/\s+/) : agent ? [this.found[agent.argv[0]], ...agent.argv.slice(1)] : null;
    if (!argv) return;
    if (!this.overlay) return this.start(cx, argv);
    // The launcher: a new pane with its own chat id, beside the pane under the dialog.
    run("pane.split", { direction: "right", mod: "acp-chat", props: { chat: newId(), agent: argv, cwd: this.cwd, machine: this.machine } });
    closeOverlay(this.overlay);
  }

  // Same agent and folder; the session resumes the agent's own when it can.
  // `retry`: from the Restart agent button, which asks a machine that couldn't be reached again.
  restart(cx, retry = false) {
    if (!this.machine || this.target || !retry) return this.start(cx, this.state.agentArgv, this.state.cwd);
    this.remoteError = null;
    cx.spawn(async (cx) => {
      await this.detect();
      this.start(cx, this.state.agentArgv, this.state.cwd);
    });
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
    const node = DIRECT || this.found.node;
    const remote = this.machine != null;
    const ready = remote ? DIRECT && !this.remoteError : node;
    return v_flex().flex_1().p(16).gap(12).overflow_y_scrollbar()
      .child(div().text_size(15).font_semibold().child("New agent chat"))
      .child(div().text_color(t.muted).child("Pick an agent that speaks ACP. It runs in this folder:"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().truncate().px(8).py(4).rounded(5).bg(t.background).child(where(this.machine, this.cwd)))
        .when(!remote, (el) => el.child(this.button(t, "pick-folder", "Change…", (cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Folder for the agent" });
          if (dir) this.cwd = dir;
          cx.notify();
        })))))
      .when(remote && !!this.remoteError, (el) => el.child(div().text_color(t.blocked).child(this.remoteError)))
      .when(remote && !DIRECT, (el) => el.child(div().text_color(t.blocked).child("Chats on another machine need a Herdr with spawn.")))
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
      .when(!remote && !node, (el) => el.child(div().text_color(t.blocked).child("Node.js isn't on PATH; the chat bridge needs it.")))
      .when(!!this.startError, (el) => el.child(div().text_color(t.blocked).child(this.startError)))
      .child(h_flex().gap(6)
        .child(this.button(t, "start", this.overlay ? "Open chat" : "Start chat", (cx) => this.startChoice(cx), { primary: true, disabled: !ready }))
        .when(!!this.overlay, (el) => el.child(this.button(t, "cancel", "Cancel", () => closeOverlay(this.overlay)))));
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
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(where(s.machine, s.cwd)))
        .when(usage?.size > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${Math.round((100 * usage.used) / usage.size)}% context`)))
        .child(this.button(t, "new-chat", "New", () => openLauncher())))
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

  // Copies, and the row that did says so for a moment.
  copy(cx, id, text) {
    cx.write_to_clipboard(String(text ?? ""));
    this.copied = id;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === id) { this.copied = null; cx.notify(); } });
  }

  messages(t) {
    const tr = this.state.transcript;
    const mono = settings().font_family;
    // A handler can't sit inside a list row, so Copy is a row of its own: one under each message
    // (all of it), and one over each code block of a reply (that block). A right-click on a
    // message copies all of it.
    const items = [], busy = ["working", "blocked"].includes(this.state.status), lastItem = tr.items[tr.items.length - 1];
    for (const m of tr.items) {
      if (m.kind === "agent") {
        segments(m.text).forEach((g, i) => {
          if (g.code) items.push({ id: `${m.id}:h${i}`, kind: "copy", text: g.text, label: "Copy code", right: true });
          items.push({ id: `${m.id}:s${i}`, kind: "seg", code: g.code, lang: g.lang, text: g.text, whole: m.text });
        });
        if (m.text && !(busy && m === lastItem)) items.push({ id: `${m.id}:cp`, kind: "copy", text: m.text, label: "Copy" });
      } else if (m.kind === "user") {
        items.push(m);
        if (!m.pending) items.push({ id: `${m.id}:cp`, kind: "copy", text: m.text, label: "Copy" });
      } else items.push(m);
    }
    return v_flex().relative().flex_1().min_h(0)
      .on_scroll_wheel((e, cx) => {
        if (e.delta.y > 0 && this.follow) { this.follow = false; cx.notify(); }
      })
      .child(list("acp-msgs", items.length, (i) => items[i].id, (i) => this.item(t, items[i], i === 0 ? tr.dropped : 0, mono))
        .track_scroll(this.scroll)
        .on_item_click((id, cx) => {
          const m = items.find((x) => x.id === id);
          if (m?.kind === "copy") return this.copy(cx, id, m.text);
          this.expanded[id] = !this.expanded[id];
          cx.notify();
        })
        .on_item_secondary_click((id, _e, cx) => {
          const m = items.find((x) => x.id === id);
          const text = !m ? null : m.kind === "seg" ? m.whole : m.kind === "tool" ? m.detail : ["user", "thought", "copy"].includes(m.kind) ? m.text : null;
          if (text) this.copy(cx, m.kind === "copy" ? id : `${String(id).split(":")[0]}:cp`, text);
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
      case "seg":
        return row.child(TextView.markdown(`md-${m.id}`, m.code ? "```" + m.lang + "\n" + m.text + "\n```" : m.text).selectable(true));
      case "copy": {
        const done = this.copied === m.id;
        return v_flex().px(12).child(h_flex().when(!!m.right, (el) => el.justify_end())
          .child(div().px(6).rounded(4).cursor_pointer().text_size(11).text_color(done ? t.done : t.dim).hover((s) => s.bg(t.raised)).child(done ? "✓ Copied" : `⧉ ${m.label}`)));
      }
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
          .child(this.button(t, "restart", "Restart agent", (cx) => this.restart(cx, true), { primary: true }))
          .child(this.button(t, "new", "New chat", () => openLauncher())));
    }
    const working = s.status === "working";
    return h_flex().px(12).py(8).gap(8).items_end().border_t(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().child(Textarea.new(this.input)))
      .child(working
        ? this.button(t, "stop", "Stop", () => this.command({ type: "cancel" }))
        : this.button(t, "send", "Send", (cx) => this.send(cx), { primary: true, disabled: s.status !== "ready" }));
  }
}
