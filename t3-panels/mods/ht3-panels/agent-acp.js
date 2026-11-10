// A chat's agent over the Agent Client Protocol: the mod starts the agent itself with
// Herdr's `spawn` and talks JSON-RPC on its stdio. The session code (session.js, acp.js,
// transcript.js) is the acp-chat mod's, unchanged; this file is that mod's runner with
// the drawing taken out. In a space on another machine the local program is ssh, and the
// agent runs there under that user's login shell.

import { exec, hc, spawn, processWrite, processNextLine, processExited, processKill, home, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { ChatSession } from "./session.js";

// Agents that speak ACP over stdio. `argv[0]` is looked up on PATH. `icon`: Herdr's own for that agent
// (~/.config/herdr-app/icons, as its program table has it), `tint` for a one-color glyph.
export const AGENTS = [
  { id: "omp", name: "Oh My Pi", argv: ["omp", "acp"] },
  { id: "pi", name: "Pi", argv: ["pi-acp"], hint: "npm i -g pi-acp", icon: "icons/pi.svg", tint: true },
  { id: "opencode", name: "OpenCode", argv: ["opencode", "acp"], icon: "icons/opencode.svg", tint: true },
  { id: "claude", name: "Claude Code", argv: ["claude-agent-acp"], hint: "npm i -g @agentclientprotocol/claude-agent-acp", icon: "icons/claude.svg", tint: false },
  { id: "codex", name: "Codex", argv: ["codex-acp"], hint: "github.com/zed-industries/codex-acp", icon: "icons/codex.svg", tint: false },
  { id: "gemini", name: "Gemini CLI", argv: ["gemini", "--experimental-acp"], icon: "icons/gemini.svg", tint: true },
];

// The AGENTS entry an argv starts (its program by name, wherever it is installed), or null.
export const agentOf = (argv) => AGENTS.find((a) => a.argv[0] === String(argv?.[0] ?? "").split("/").pop()) ?? null;

// Why an agent that ended before it had a session didn't start: its program is missing (the shell's
// 127, or its "not found"), or it gave up by itself.
export function startFailure(argv, exit, machine) {
  const name = String(argv?.[0] ?? "the agent").split("/").pop(), on = machine ? ` on ${machine}` : "";
  const err = String(exit?.stderr ?? "").trim().slice(-2000);
  if (exit?.code === 127 || /not found|no such file or directory/i.test(err.split("\n").pop() ?? ""))
    return `Couldn't start ${name}: not found${on}. Pick another agent with New chat, or see which are on in Settings.`;
  return `${name} ended before it started a session (${exit?.code == null ? "a signal" : `code ${exit.code}`}).` + (err ? `\n\n${err}` : "");
}

const SAVE_EVERY_MS = 1000;
const MAX_STATE_BYTES = 800 * 1024; // readTextFile reads at most 1 MiB

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

// Which agents are installed where the chat will run. -> { found: {program: path, HOME},
// target (ssh, for another machine), error }.
export async function detect(machine) {
  const out = { found: {}, target: null, error: null };
  const programs = [...new Set(AGENTS.map((a) => a.argv[0]))];
  const script = [...programs.map((p) => `printf '%s=%s\\n' ${p} "$(command -v ${p})"`), `printf 'HOME=%s\\n' "$HOME"`].join("; ");
  let r;
  if (machine) {
    try {
      out.target = await sshTarget(machine);
      const argv = sshArgv(out.target, script);
      r = await exec(argv[0], argv.slice(1), { timeout: 30000 });
    } catch (e) {
      out.error = String(e?.message ?? e);
      return out;
    }
  } else {
    r = await exec("/bin/sh", ["-lc", script]);
  }
  // An interactive shell may print more; only these lines count.
  for (const line of r.stdout.split("\n")) {
    const at = line.indexOf("=");
    const k = line.slice(0, at);
    const v = line.slice(at + 1).trim();
    if (at > 0 && v && (k === "HOME" || programs.includes(k))) out.found[k] = v;
  }
  if (machine && !out.found.HOME) out.error = `Couldn't reach ${machine}: ${r.stderr.trim().split("\n").pop() || `ssh exited with code ${r.code}`}`;
  return out;
}

// `agent` (an AGENTS id or an argv array) as the argv to start, or null when it isn't installed.
export function argvOf(agent, found) {
  if (Array.isArray(agent)) return agent;
  const a = AGENTS.find((x) => x.id === agent);
  return a && found[a.argv[0]] ? [found[a.argv[0]], ...a.argv.slice(1)] : null;
}

export class AcpSource {
  // dir: the chat's folder (state.json, kept only to resume). changed(cx, urgent): redraw.
  constructor({ dir, machine, changed }) {
    this.kind = "acp";
    this.dir = dir;
    this.machine = machine ?? null;
    this.onChanged = changed;
    this.state = null;
    this.session = null;
    this.proc = null;
    this.alive = false;
    this.target = null;
    this.remoteError = null;
    this.startError = null;
  }

  // The chat as it was saved. -> whether there was one.
  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    const text = await readTextFile(`${this.dir}/state.json`);
    if (!text) return false;
    try {
      this.state = JSON.parse(text);
    } catch {
      return false;
    }
    // A chat runs where it first ran.
    this.machine = this.state.machine ?? null;
    return true;
  }

  // It ran in an earlier copy of this pane (a reload, or the app quit): continue it.
  get resumable() {
    return this.state != null && !["exited", "stopped"].includes(this.state.status);
  }

  async reach() {
    if (!this.machine || this.target) return;
    const d = await detect(this.machine);
    this.target = d.target;
    this.remoteError = d.error;
  }

  // Starts the agent as this copy's program; it stops with the copy. `first`: a new chat's first message.
  // `set`: options a new chat starts with, e.g. { model: "provider/model" }, set before `first`.
  start(cx, argv, cwd, first = null, set = null) {
    if (this.machine && !this.target) {
      const why = this.remoteError ?? `Couldn't find how to reach ${this.machine}.`;
      if (this.state) Object.assign(this.state, { status: "exited", error: why });
      else this.startError = why;
      this.alive = false;
      return cx.notify();
    }
    // The agent runs under the person's login, interactive shell, as the agents Herdr starts in
    // terminals do: API keys and PATH entries exported in its profile reach it (Herdr's own
    // environment often lacks them). What the profile prints is not JSON, so acp.js skips it.
    // On another machine the local program is ssh, started in this computer's home.
    const line = `exec ${argv.map(shq).join(" ")}`;
    const cmd = this.machine ? sshArgv(this.target, `cd ${shq(cwd)} && ${line}`) : ["/bin/sh", "-c", `exec "\${SHELL:-/bin/sh}" -lic ${shq(line)}`];
    let proc;
    try {
      proc = spawn(cmd[0], cmd.slice(1), { cwd: this.machine ? home() : cwd });
    } catch (e) {
      this.startError = String(e?.message ?? e);
      if (this.state) Object.assign(this.state, { status: "exited", error: this.startError });
      return cx.notify();
    }
    if (this.session) processKill(this.proc);
    this.proc = proc;
    this.alive = true;
    this.startError = null;
    cx.spawn(async (cx) => {
      // Asked now, so killing it later can't lose the answer.
      const exited = processExited(proc);
      const session = new ChatSession({
        argv, cwd, machine: this.machine, old: this.state,
        write: (line) => processWrite(proc, line).catch(() => {}),
        kill: () => processKill(proc),
        changed: (urgent) => this.proc === proc && this.changed(cx, urgent),
      });
      this.session = session;
      this.state = session.state;
      cx.notify();
      const started = session.start();
      started.then(async (ok) => {
        if (!ok) return;
        for (const [id, value] of Object.entries(set ?? {})) await session.setConfig(id, value);
        if (first) session.handle({ type: "prompt", text: first });
      });
      for (let line; (line = await processNextLine(proc)) != null;) session.feed(line);
      const exit = await exited;
      if (this.proc !== proc || this.closing) return;
      this.alive = false;
      session.exited(exit.code == null ? "a signal" : `code ${exit.code}`, exit.stderr.slice(-2000));
      // It ended before it had a session: say why (session.js only knows "agent exited").
      if (!(await started.catch(() => false)) && session.state.status !== "stopped") session.failed(startFailure(argv, exit, this.machine));
    });
  }

  // Same agent and folder; the session resumes the agent's own when it can.
  restart(cx) {
    cx.spawn(async (cx) => {
      if (this.machine && !this.target) {
        this.remoteError = null;
        await this.reach();
      }
      this.start(cx, this.state.agentArgv, this.state.cwd);
    });
  }

  // Saves at most every SAVE_EVERY_MS, at once when urgent; the view throttles its own drawing.
  changed(cx, urgent) {
    if (["exited", "stopped"].includes(this.state.status)) this.alive = false;
    const save = () => fs.writeFile(`${this.dir}/state.json`, this.session.snapshot(MAX_STATE_BYTES)).catch(() => {});
    if (urgent) save();
    else if (!this.saveSoon) {
      this.saveSoon = true;
      cx.timer.after(SAVE_EVERY_MS, () => { this.saveSoon = false; save(); });
    }
    this.onChanged(cx, urgent);
  }

  // Keeps the status as it is, so the next copy of this pane resumes the chat.
  async close() {
    if (!this.session) return;
    this.closing = true;
    const text = this.session.snapshot(MAX_STATE_BYTES);
    processKill(this.proc);
    await fs.writeFile(`${this.dir}/state.json`, text);
  }

  // ---- what the chat view draws and does ----

  // view().status alone, for what runs on every change.
  word() {
    const s = this.state;
    if (!s) return this.startError ? "exited" : "starting";
    return this.alive ? s.status : s.status === "stopped" ? "stopped" : "exited";
  }

  view() {
    const s = this.state;
    if (!s) return { name: "Agent", status: this.startError ? "exited" : "starting", error: this.startError, items: [], dropped: 0, usage: null, options: [], permission: null, alive: false };
    return {
      name: s.agentInfo?.title ?? s.agentInfo?.name ?? s.agentArgv?.[0]?.split("/").pop() ?? "Agent",
      status: this.word(),
      error: s.error,
      cwd: s.cwd,
      machine: s.machine,
      items: s.transcript.items,
      dropped: s.transcript.dropped,
      usage: s.transcript.usage,
      commands: s.transcript.commands ?? [],
      options: (s.configOptions ?? []).filter((o) => o.type === "select").map((o) => ({
        id: o.id, name: o.name, category: o.category, current: o.currentValue,
        choices: o.options.map((c) => ({ value: c.value, name: c.name, description: c.description })),
      })),
      permission: s.permission,
      alive: this.alive,
    };
  }

  send(_cx, text, blocks = []) { this.session?.handle({ type: "prompt", text, blocks }); }
  stop() { this.session?.handle({ type: "cancel" }); }
  answer(_cx, optionId) { this.session?.handle({ type: "permission", optionId }); }
  setOption(id, value) { this.session?.handle({ type: "config", configId: id, value }); }
  // A tool's output arrives with the call; nothing to fetch.
  expand() {}
}
