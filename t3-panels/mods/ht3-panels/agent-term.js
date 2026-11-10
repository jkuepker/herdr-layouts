// A chat's agent that already runs in a Herdr terminal (Claude Code or Codex): the chat is
// read from the agent's own session log, and what you write is typed into its terminal.
// The agent keeps running there; closing the chat leaves it alone. The reading and the
// sending are Shepherdr's (core/chat-reader.js, chat-log.js, send.js, MIT, unchanged);
// this file drives them the way Shepherdr's chat mod does and hands the chat view the
// same rows the ACP source gives it.

import { exec, hc, agents, terminals, watchFolder, run } from "herdr";
import { ChatReader, kindOf } from "./core/chat-reader.js";
import { sendBody } from "./core/send.js";

const NAMES = { claude: "Claude Code", codex: "Codex" };
const GLYPH = { read: "read", edit: "edit", run: "execute", search: "search", web: "fetch", agent: "think", plan: "think", tool: "other" };

export class TermSource {
  // addr: the terminal's address ("t7", or "machine/t7"). changed(cx, urgent): redraw.
  constructor({ addr, changed }) {
    this.kind = "term";
    this.addr = addr;
    this.machine = addr.includes("/") ? addr.split("/")[0] : null;
    this.onChanged = changed;
    // io.sh's args[0] is the script's $0, as Shepherdr's own callers pass it.
    this.reader = new ChatReader({ sh: (script, args, machine) => exec("sh", ["-c", script, ...args], { on: machine }) }, addr);
    this.record = null; // hc get's record of the terminal
    this.gone = false;
    this.error = null;
    this.pending = []; // sent, not in the log yet: [{ id, text, at, failed }]
    this.details = new Map(); // tool row id -> what it printed
    this.loading = new Set();
    this.seq = 0;
    this.closed = false;
  }

  // Follows the log until the pane closes: the agent's process again every few seconds (a
  // /clear, a resume or a new agent in the same terminal writes another file), then what
  // the log gained.
  start(cx) {
    cx.spawn(async (cx) => {
      let last = 0;
      while (!this.closed) {
        try {
          let moved = false;
          if (!this.reader.path || Date.now() - last > 4000) {
            last = Date.now();
            moved = await this.locate();
          }
          const grew = await this.reader.pull();
          if (grew) this.settle();
          if (this.error) { this.error = null; moved = true; }
          if (moved || grew) this.onChanged(cx, true);
        } catch (e) {
          this.error = String(e?.message ?? e);
          this.onChanged(cx, true);
        }
        const path = this.reader.path;
        if (!this.machine && path) {
          // Here: wake when the log's folder changes, and look again now and then anyway.
          const dir = path.slice(0, path.lastIndexOf("/"));
          if (this.watching?.dir !== dir) this.watching = { dir, next: watchFolder(dir).catch(() => null).finally(() => { this.watching = null; }) };
          await Promise.race([this.watching.next, cx.sleep(4000)]);
        } else {
          await cx.sleep(this.status() === "working" || this.pending.length ? 1500 : 4000);
        }
      }
    });
  }

  async locate() {
    const r = await hc(["get", this.addr, "--json"]);
    let t = null;
    try { t = JSON.parse(r.stdout || "null"); } catch {}
    const gone = /not_found|no terminal/.test(`${r.stdout}\n${r.stderr}`) || (t && !t.error && t.state !== "live");
    if (gone !== this.gone) { this.gone = gone; this.record = t; return true; }
    if (gone || !t || t.error) return false;
    this.record = t;
    return this.reader.locate(t);
  }

  // A sent message that the log now shows is no longer pending.
  settle() {
    const users = (this.reader.conv?.items ?? []).filter((x) => x.kind === "user");
    this.pending = this.pending.filter((p) => p.failed || !users.some((u) => (u.at ?? 0) >= p.at - 60000 && String(u.text ?? "").includes(p.text.slice(0, 80))));
  }

  status() {
    if (this.gone) return "exited";
    const a = agents().find((x) => x.address === this.addr);
    if (a?.status === "working") return "working";
    if (a?.status === "blocked") return "blocked";
    if (this.reader.state === "finding") return "starting";
    if (this.reader.state === "none" || this.reader.state === "missing") return "none";
    return "ready";
  }

  close() {
    this.closed = true;
  }

  // ---- what the chat view draws and does ----

  view() {
    const conv = this.reader.conv;
    const kind = this.reader.kind ?? kindOf(this.record);
    const status = this.status();
    const live = terminals().find((x) => x.address === this.addr);
    const items = [];
    for (const x of conv?.items ?? []) {
      if (x.kind === "user") items.push({ id: x.id, kind: "user", text: x.from ? `From ${x.from}:\n${x.text}` : x.text });
      else if (x.kind === "agent") items.push({ id: x.id, kind: "agent", text: x.text });
      else if (x.kind === "tools") {
        for (const s of x.steps) {
          items.push({
            id: `${x.id}:${s.id}`, kind: "tool", step: s, title: s.count > 1 ? `${s.line} ×${s.count}` : s.line, toolKind: GLYPH[s.kind] ?? "other",
            status: s.out !== undefined ? "completed" : "in_progress",
            detail: this.details.get(s.id) ?? null, lazy: s.out !== undefined, loading: this.loading.has(s.id),
          });
        }
      } else if (x.kind === "ask") items.push({ id: x.id, kind: "notice", level: x.closed ? "info" : "warn", text: x.closed ? `Asked: ${x.text}` : `Asks: ${x.text}` });
      else if (x.kind === "error") items.push({ id: x.id, kind: "notice", level: "error", text: x.text });
      else if (x.kind === "sent") items.push({ id: x.id, kind: "notice", level: "info", text: `Sent to ${x.to}: ${x.text}` });
    }
    for (const p of this.pending) {
      items.push({ id: p.id, kind: "user", text: p.text, pending: !p.failed });
      if (p.failed) items.push({ id: `${p.id}:e`, kind: "notice", level: "error", text: `Not sent: ${p.failed}` });
    }
    const meta = conv?.meta ?? {};
    const model = meta.model ? [{ id: "model", name: "Model", current: meta.model, choices: [], readonly: true, suffix: meta.effort ?? null }] : [];
    return {
      name: NAMES[kind] ?? live?.program?.name ?? "Terminal",
      status,
      doing: conv?.doing ?? null,
      error: status === "none" && this.reader.state !== "pending"
        ? (this.reader.state === "missing" ? "The agent's session log is gone." : "This terminal isn't running Claude Code or Codex, so there is no conversation to show. Start one there, or open a new chat with another agent.")
        : this.error,
      cwd: this.record?.foreground?.cwd ?? this.record?.cwd ?? null,
      machine: this.machine,
      items,
      dropped: 0,
      earlier: this.reader.start > 0,
      usage: meta.used && meta.window ? { used: meta.used, size: meta.window } : null,
      options: model,
      // The agent's own dialog is open in its terminal; this chat can't answer it, only take you there.
      permission: status === "blocked" ? {
        title: `${NAMES[kind] ?? "The agent"} is waiting for you in its terminal`,
        note: "A question or a permission prompt is open there.",
        options: [{ optionId: "focus", name: "Go to terminal", kind: "allow_once" }, { optionId: "esc", name: "Dismiss (Esc)", kind: "reject_once" }],
      } : null,
      alive: !this.gone && status !== "none",
      terminal: this.addr,
    };
  }

  send(cx, text) {
    const p = { id: `p${Date.now()}-${this.seq++}`, text, at: Date.now(), failed: null };
    this.pending.push(p);
    cx.spawn(async (cx) => {
      const io = { hc: (args) => hc(args), sleep: (ms) => cx.sleep(ms), status: () => this.status() };
      try {
        const r = await sendBody(io, this.addr, this.reader.kind, text);
        if (r.code !== 0) p.failed = String(r.stderr || r.stdout || "it didn't go through").trim().slice(0, 300);
      } catch (e) {
        p.failed = String(e?.message ?? e);
      }
      this.onChanged(cx, true);
    });
  }

  // Esc interrupts both CLIs' turns.
  stop() {
    hc(["keys", this.addr, "esc"]).catch(() => {});
  }

  answer(_cx, optionId) {
    if (optionId === "focus") run("pane.focus", { terminal: this.addr });
    else hc(["keys", this.addr, "esc"]).catch(() => {});
  }

  setOption() {}

  // A tool row opened: its output is read from the log only now.
  expand(cx, item) {
    const s = item.step;
    if (!s || s.out === undefined || this.details.has(s.id) || this.loading.has(s.id)) return;
    this.loading.add(s.id);
    cx.spawn(async (cx) => {
      try {
        const got = await this.reader.results([s]);
        this.details.set(s.id, got.get(s.id) || "(no output)");
      } catch (e) {
        this.details.set(s.id, String(e?.message ?? e));
      }
      this.loading.delete(s.id);
      this.onChanged(cx, true);
    });
  }

  // The page of the log before what is shown.
  earlier(cx) {
    cx.spawn(async (cx) => {
      if (await this.reader.earlier()) this.onChanged(cx, true);
    });
  }

  restart() {}
}
