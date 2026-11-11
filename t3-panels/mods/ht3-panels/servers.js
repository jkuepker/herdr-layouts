// Servers a chat started (T3 Code's ThreadServersPanel.tsx and portDiscoveryState.ts): the programs that listen on a
// TCP port and belong to a folder, with Open, Copy URL and Stop. Hidden while there are none.
// A listener belongs to the folder when its own working folder is inside it, or that of a process it descends from
// (an agent that works in the chat's folder and starts `cd /tmp && python3 -m http.server` is still its parent), or
// when it descends from one of `roots` (process ids a caller knows, e.g. an agent's). Herdr gives a mod no process id
// of an agent it started, so the folder of the ancestors stands in for it.
// Found with two programs runs on the folder's machine (`exec` with `on`): `lsof -nP -iTCP -sTCP:LISTEN` (`ss -ltnp`
// where lsof is missing) with `ps` for the parents, then the working folders of the listeners and their ancestors
// (`lsof -a -d cwd -p …`, /proc/<pid>/cwd on Linux). Nothing is cached and nothing runs while no list shows.
// Three faces: the dialog (`ht3-panels.servers`), a strip for the chat (`serversStrip`), a row in the Project popover.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, closeOverlay, openOverlay, notify, shared, setShared } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, shortPath } from "./look.js";
import { openUrl } from "./browser.js";
import { placeOf, activeSpace } from "./side.js";

export const SERVERS_SIZE = { width: 560, height: 440 };
const POLL = 5000;
// A strip nobody has drawn for this long is hidden: its watch stops asking.
const SEEN = 12000;

const PATHS = 'PATH="$PATH:/usr/sbin:/sbin:/usr/bin:/bin"; ';
// The listeners, then every process with its parent. `+c 0`: the whole command name.
const LIST = PATHS + 'if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP -sTCP:LISTEN -Fpcn +c 0 2>/dev/null; else echo "#ss"; ss -ltnpH 2>/dev/null; fi; '
  + 'echo "#ps"; ps -axo pid=,ppid=,comm= 2>/dev/null; true';
// $1: the folder (printed as it really is, symlinks followed); the rest: process ids, whose working folders and
// command lines are printed. A process of another user has no folder to read and so never belongs.
const FOLDERS = PATHS + 'r=$(cd "$1" 2>/dev/null && pwd -P); echo "#root $r"; shift; [ $# -gt 0 ] || exit 0; l=$(IFS=,; echo "$*"); '
  + 'if [ -d /proc/self/fd ] && [ -e /proc/self/cwd ]; then for p in "$@"; do d=$(readlink "/proc/$p/cwd" 2>/dev/null) && printf "p%s\\nn%s\\n" "$p" "$d"; done; '
  + 'else lsof -a -d cwd -Fpn -p "$l" 2>/dev/null; fi; echo "#args"; ps -o pid=,args= -p "$l" 2>/dev/null; true';
// SIGTERM (or $2), then up to three seconds for it to go.
const SIGNAL = 'kill -s "$2" "$1" || exit 1; i=0; while [ $i -lt 15 ]; do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.2; i=$((i+1)); done; true';

const LOOPBACK = /^(127\.|\[?::1\]?$|localhost$)/;
const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

// LIST's output: { listeners: [{ pid, name, port, open }], procs: Map pid -> { ppid, name } }. `open`: it listens on
// every address of the machine, not on loopback alone.
export function parseList(stdout) {
  const listeners = [], procs = new Map(), seen = new Set();
  const add = (pid, name, addr) => {
    const m = String(addr).match(/^(.*):(\d+)$/);
    if (!m || !pid) return;
    const port = Number(m[2]), key = `${pid}:${port}`, open = !LOOPBACK.test(m[1]);
    const had = seen.has(key) ? listeners.find((l) => l.pid === pid && l.port === port) : null;
    if (had) { had.open ||= open; return; }
    seen.add(key);
    listeners.push({ pid, name, port, open });
  };
  let mode = "lsof", pid = 0, name = "";
  for (const line of String(stdout ?? "").split("\n")) {
    if (line === "#ss") { mode = "ss"; continue; }
    if (line === "#ps") { mode = "ps"; continue; }
    if (mode === "lsof") {
      if (line[0] === "p") { pid = Number(line.slice(1)); name = ""; }
      else if (line[0] === "c") name = line.slice(1);
      else if (line[0] === "n") add(pid, name, line.slice(1));
    } else if (mode === "ss") {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      for (const u of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) add(Number(u[2]), u[1], cols[3]);
    } else {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), name: base(m[3].trim()) || m[3].trim() });
    }
  }
  return { listeners, procs };
}

// A process and the ones it descends from, nearest first, without init.
export function lineage(pid, procs) {
  const out = [];
  for (let p = pid, n = 0; p > 1 && n < 64 && !out.includes(p); n++) { out.push(p); p = procs.get(p)?.ppid ?? 0; }
  return out;
}

// FOLDERS' output: { root, cwds: Map pid -> folder, args: Map pid -> command line }.
export function parseFolders(stdout) {
  const cwds = new Map(), args = new Map();
  let root = "", pid = 0, tail = false;
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("#root ")) root = line.slice(6).trim();
    else if (line === "#args") tail = true;
    else if (tail) { const m = line.match(/^\s*(\d+)\s+(.*)$/); if (m) args.set(Number(m[1]), m[2].trim()); }
    else if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid && !cwds.has(pid)) cwds.set(pid, line.slice(1));
  }
  return { root, cwds, args };
}

export const inside = (path, folder) => !!path && !!folder && folder !== "/" && (path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`));

// The servers of `where` ({ cwd, on?, roots? }): [{ port, pid, name, cwd, command, open, via }], by port. `via`:
// null when the server's own folder is inside, else the name of the process above it that made it belong.
// `run` is `exec` (tests pass their own). Throws when the machine can't be asked.
export async function discover(where, run = exec) {
  const folder = String(where?.cwd ?? "").replace(/(.)\/+$/, "$1"), on = where?.on ?? undefined;
  if (!folder || folder === "/") return [];
  const a = await run("sh", ["-c", LIST], { on, timeout: 12000 });
  const { listeners, procs } = parseList(a.stdout);
  if (!listeners.length) return [];
  const chains = new Map(listeners.map((l) => [l.pid, lineage(l.pid, procs)]));
  const pids = [...new Set([...chains.values()].flat())];
  const b = await run("sh", ["-c", FOLDERS, "sh", folder, ...pids.map(String)], { on, timeout: 12000 });
  const { root, cwds, args } = parseFolders(b.stdout);
  const roots = new Set((where?.roots ?? []).map(Number).filter((n) => n > 1));
  const within = (p) => inside(cwds.get(p), root || folder) || inside(cwds.get(p), folder);
  const out = [];
  for (const l of listeners) {
    const chain = chains.get(l.pid), by = chain.find((p) => within(p) || roots.has(p));
    if (by == null) continue;
    out.push({ port: l.port, pid: l.pid, name: procs.get(l.pid)?.name || l.name || "process", cwd: cwds.get(l.pid) ?? null, command: args.get(l.pid) ?? null,
      open: l.open, via: by === l.pid ? null : (procs.get(by)?.name ?? null) });
  }
  return out.sort((x, y) => x.port - y.port || x.pid - y.pid);
}

// Stops one: SIGTERM, or SIGKILL with `force`. Only a process that still listens on that port gets the signal (a
// process id can be another program's by now). Resolves { stopped }: false when it still listens three seconds on.
export async function stopServer(server, where, { force = false, run = exec } = {}) {
  const on = where?.on ?? undefined;
  const listening = async () => parseList((await run("sh", ["-c", LIST], { on, timeout: 12000 })).stdout).listeners.some((l) => l.pid === server.pid && l.port === server.port);
  if (!(await listening())) return { stopped: true };
  const r = await run("sh", ["-c", SIGNAL, "sh", String(server.pid), force ? "KILL" : "TERM"], { on, timeout: 10000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `Couldn't signal process ${server.pid}.`);
  return { stopped: !(await listening()) };
}

const keyOf = (s) => `${s.pid}:${s.port}`;
export const localUrl = (s) => `http://localhost:${s.port}`;
// The ssh name of a machine (`hc machine ls`: its target), else the machine's own name.
const hosts = new Map();
async function hostOf(on) {
  if (!on) return null;
  if (hosts.has(on)) return hosts.get(on);
  let found = { ssh: on, host: on };
  try {
    const r = await hc(["machine", "ls", "--json"]);
    const m = (JSON.parse(r.stdout).machines ?? []).find((x) => x.name === on);
    if (m) found = { ssh: m.via ? null : (m.target || m.name), host: m.host || m.target || m.name };
  } catch { /* the machine's name it is */ }
  hosts.set(on, found);
  return found;
}
export const forwardCommand = (s, ssh) => `ssh -N -L ${s.port}:localhost:${s.port} ${ssh}`;

// The servers of one place, looked at every five seconds while something draws them.
export class ServerWatch {
  constructor({ toast = false } = {}) {
    this.where = null;
    this.servers = null; // null: not looked yet
    this.error = null;
    this.note = null;
    this.state = {}; // "<pid>:<port>" -> "stopping" | "ask" (SIGTERM didn't end it) | "killing"
    this.toast = toast;
    this.seen = 0;
    this.scanning = false;
  }

  // Call once from init. `always`: a dialog, which shows as long as it lives.
  start(cx, { always = false } = {}) {
    this.always = always;
    this.cx = cx;
    cx.timer.every(POLL, (cx) => { if (this.always || Date.now() - this.seen < SEEN) this.scan(cx); });
    return this;
  }

  // Where to look ({ cwd, on }); a new place is looked at at once. Returns the watch.
  at(where) {
    const next = where?.cwd ? { cwd: where.cwd, on: where.on ?? null, roots: where.roots ?? [] } : null;
    const same = (this.where?.cwd ?? null) === (next?.cwd ?? null) && (this.where?.on ?? null) === (next?.on ?? null);
    this.where = next;
    if (!same) { this.servers = null; this.state = {}; this.error = null; this.note = null; this.fresh = true; }
    return this;
  }

  scan(cx) {
    if (this.scanning || !this.where) return;
    const where = this.where;
    this.scanning = true;
    this.fresh = false;
    cx.spawn(async (cx) => {
      let list = null, error = null;
      try { list = await discover(where); } catch (e) { error = String(e?.message ?? e); }
      this.scanning = false;
      if (this.where !== where) return cx.notify();
      const was = JSON.stringify(this.servers);
      this.servers = list ?? this.servers ?? [];
      this.error = error;
      const live = new Set(this.servers.map(keyOf));
      for (const k of Object.keys(this.state)) if (!live.has(k)) delete this.state[k];
      // For scripts and the other mods: what the last look found, written only when it changed.
      if (list && JSON.stringify(list) !== was) setShared(`${MOD}.servers`, { cwd: where.cwd, on: where.on, at: Date.now(), list: list.map((s) => ({ port: s.port, pid: s.pid, name: s.name, cwd: s.cwd })) });
      cx.notify();
    });
  }

  say(cx, text, level = "info") {
    this.note = { text, level };
    if (this.toast) notify({ title: text, level, timeout: 5000 });
    cx.notify();
  }

  // Open: this computer's server in the system browser (Herdr has no web view and no port forwarding for a mod). On
  // another machine: a server that listens on every address opens at the machine's name; one on loopback alone can't
  // be reached, so the ssh forward for it is copied instead.
  open(s, cx) {
    cx.spawn(async (cx) => {
      try {
        const on = this.where?.on ?? null;
        if (on && !s.open) return this.forward(s, cx);
        const h = on ? await hostOf(on) : null;
        const url = h ? `http://${h.host}:${s.port}` : localUrl(s);
        const r = await openUrl(url);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "The system browser didn't open.");
        this.say(cx, `Opened ${url} in your browser.`);
      } catch (e) { this.say(cx, String(e?.message ?? e), "error"); }
    });
  }

  forward(s, cx) {
    cx.spawn(async (cx) => {
      const h = await hostOf(this.where?.on ?? null);
      if (!h?.ssh) return this.say(cx, `${this.where?.on} isn't reached over ssh, so there is no forward to copy.`, "warning");
      cx.write_to_clipboard(forwardCommand(s, h.ssh));
      this.say(cx, `Copied "${forwardCommand(s, h.ssh)}". Run it in a terminal on this computer, then open ${localUrl(s)}.`);
    });
  }

  copy(s, cx) {
    cx.spawn(async (cx) => {
      const on = this.where?.on ?? null, h = on && s.open ? await hostOf(on) : null;
      const url = h ? `http://${h.host}:${s.port}` : localUrl(s);
      cx.write_to_clipboard(url);
      this.say(cx, on && !s.open ? `Copied ${url}. It answers on ${on} only: forward the port to open it here.` : `Copied ${url}.`);
    });
  }

  // Stop: SIGTERM. A server that still listens three seconds later asks before SIGKILL (`kill`).
  stop(s, cx, force = false) {
    const key = keyOf(s), where = this.where;
    if (this.state[key] === "stopping" || this.state[key] === "killing") return;
    this.state[key] = force ? "killing" : "stopping";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await stopServer(s, where, { force });
        if (r.stopped) {
          delete this.state[key];
          if (this.servers) this.servers = this.servers.filter((x) => keyOf(x) !== key);
          this.say(cx, `Stopped localhost:${s.port} (${s.name}).`, "success");
        } else {
          this.state[key] = "ask";
          this.say(cx, force ? `localhost:${s.port} is still running after SIGKILL.` : `localhost:${s.port} didn't stop when asked to.`, "warning");
        }
      } catch (e) { delete this.state[key]; this.say(cx, String(e?.message ?? e), "error"); }
      this.scan(cx);
    });
  }
  kill(s, cx) { this.stop(s, cx, true); }
  leave(s, cx) { delete this.state[keyOf(s)]; cx.notify(); }
  byPort(port) { return (this.servers ?? []).find((s) => String(s.port) === String(port)) ?? null; }
}

// One server's row: the port, the process and its folder, then Open, Copy URL (the ssh forward too on another
// machine) and Stop; after a SIGTERM that didn't end it, the question for SIGKILL in their place.
function serverRow(k, w, s, id, { compact = false } = {}) {
  const key = keyOf(s), st = w.state[key] ?? null, remote = !!w.where?.on;
  const about = [s.name, s.via ? `from ${s.via}` : null, s.cwd ? shortPath(s.cwd) : null].filter(Boolean).join(" · ");
  const words = h_flex().flex_1().min_w(0).gap(8).items_center()
    .child(icon("globe").size(compact ? 14 : 16).flex_none().text_color(k.muted))
    .child(compact
      ? h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_none().text_size(13).font_medium().child(`localhost:${s.port}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(about))
      : v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(14).font_medium().child(`localhost:${s.port}${remote ? ` on ${w.where.on}` : ""}`))
        .child(div().truncate().text_size(12).text_color(k.muted).child(about)));
  let el = h_flex().id(id).h(compact ? 28 : 44).px(compact ? 8 : 12).gap(6).flex_none().items_center();
  if (s.command) el = el.tooltip(`${s.command}\nprocess ${s.pid}`);
  el = el.child(words);
  if (st === "ask") return el
    .child(div().flex_none().text_size(12).text_color(k.warningText).child("Still running."))
    .child(button(k, `${id}-kill`, "Force stop", (cx) => w.kill(s, cx), { variant: "destructive", tip: "SIGKILL: it ends at once and can't tidy up" }))
    .child(button(k, `${id}-leave`, "Leave it", (cx) => w.leave(s, cx), { variant: "outline" }));
  if (st) return el.child(div().flex_none().text_size(12).text_color(k.muted).child(st === "killing" ? "Ending…" : "Stopping…"));
  return el
    .child(iconButton(k, `${id}-open`, "external-link", (cx) => w.open(s, cx), { tip: remote ? (s.open ? `Open ${w.where.on}:${s.port} in your browser` : "It listens on that machine only: copy the ssh forward") : "Open in your browser" }))
    .when(remote, (e) => e.child(iconButton(k, `${id}-fwd`, "square-terminal", (cx) => w.forward(s, cx), { tip: "Copy the ssh forward for this port" })))
    .child(iconButton(k, `${id}-copy`, "copy", (cx) => w.copy(s, cx), { tip: "Copy URL" }))
    .child(iconButton(k, `${id}-stop`, "stop", (cx) => w.stop(s, cx), { tip: "Stop server", color: k.destructiveText }));
}

export const openServers = (folder = "") => { openOverlay({ mod: MOD, kind: "dialog", ...SERVERS_SIZE, props: { menu: "servers", folder: folder || null } }); };

// The strip for a chat, over its message box: a row per server (three at most, then "N more" opens the dialog), or
// null while the folder has none. Draw it with the chat's place: `serversStrip(k, this.servers.at({ cwd, on }))`,
// where init made `this.servers = new ServerWatch({ toast: true }).start(cx)`. Drawing it is what keeps it looking.
export function serversStrip(k, watch, { max = 3 } = {}) {
  watch.seen = Date.now();
  // A place just given, or a strip back from hiding: look now rather than at the next tick.
  if (watch.fresh && watch.cx) { watch.fresh = false; const cx = watch.cx; cx.timer.after(0, (cx) => watch.scan(cx)); }
  const list = watch.servers ?? [];
  if (!list.length) return null;
  const more = list.length - max;
  return v_flex().id("ht3-servers-strip").w_full().mb(6).py(2).flex_none().rounded(8).border(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.card, 0.4)).text_color(k.foreground)
    .children(list.slice(0, max).map((s) => serverRow(k, watch, s, `srv-strip-${s.pid}-${s.port}`, { compact: true })))
    .when(more > 0, (el) => el.child(h_flex().id("srv-strip-more").h(24).px(8).items_center().text_size(12).text_color(k.muted).cursor_pointer()
      .role("button").accessibility_label("Show all servers").hover((s) => s.text_color(k.foreground)).on_click(() => openServers(watch.where?.cwd))
      .child(`${more} more server${more === 1 ? "" : "s"}…`)));
}

// Whether the dialog is open: it says so every second while it is (as the search dialog does).
const OPEN = `${MOD}.servers-open`;
export const serversOpen = () => Date.now() - (shared(OPEN) ?? 0) < 2500;

// The dialog (`ht3-panels.servers`, or `servers:<folder>`): the servers of the shown space's folder (side.js `placeOf`:
// the pinned folder, else the chat's, else the terminal's), or of the folder given. While it is open:
// `server:refresh`, `server:open:<port>`, `server:copy:<port>`, `server:forward:<port>`, `server:stop:<port>`,
// `server:kill:<port>` (after a stop that didn't end it), `server:leave:<port>`, `ui:close`.
export class ServersDialog {
  init(p, cx) {
    this.overlay = p.overlay;
    const space = activeSpace(), at = placeOf(space);
    this.place = p.folder ? { cwd: String(p.folder), on: space?.machine ?? null } : { cwd: at?.cwd ?? null, on: at?.on ?? null };
    this.watch = new ServerWatch().at(this.place).start(cx, { always: true });
    this.watch.scan(cx);
    setShared(OPEN, Date.now());
    cx.timer.every(1000, () => setShared(OPEN, Date.now()));
  }
  close() {}
  command(c, cx) {
    if (c === "ui:close" || c === "servers") return void closeOverlay(this.overlay);
    if (!c.startsWith("server:")) return;
    const [, verb, port] = c.split(":"), w = this.watch, s = w.byPort(port);
    if (verb === "refresh") w.scan(cx);
    else if (!s) console.log(`${MOD}.${c}: no server on port ${port} here`);
    else if (verb === "open" || verb === "copy" || verb === "forward" || verb === "leave") w[verb](s, cx);
    else if (verb === "stop") w.stop(s, cx);
    else if (verb === "kill" && w.state[keyOf(s)] === "ask") w.kill(s, cx);
    cx.notify();
  }

  render(_cx) {
    const k = tokens(), w = this.watch, list = w.servers ?? [];
    const where = this.place.cwd ? `${this.place.on ? `${this.place.on}:` : ""}${shortPath(this.place.cwd)}` : null;
    const tone = { error: k.destructiveText, warning: k.warningText, success: k.successText }[w.note?.level] ?? k.muted;
    const quiet = (text) => div().px(12).py(8).text_size(12).line_height("16px").text_color(k.muted).child(text);
    return v_flex().id("ht3-servers").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(h_flex().px(20).pt(16).pb(12).gap(8).flex_none().items_center().border_b(1).border_color(k.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(18).font_semibold().child(list.length ? `Servers (${list.length})` : "Servers"))
          .child(div().truncate().text_size(12).text_color(k.muted).child(where ? `Listening on a port, started from ${where}` : "No folder here")))
        .child(iconButton(k, "servers-refresh", "refresh-cw", (cx) => w.scan(cx), { tip: "Look again" }))
        .child(iconButton(k, "servers-close", "x", () => closeOverlay(this.overlay), { tip: "Close" })))
      .child(v_flex().id("ht3-servers-body").flex_1().min_h(0).px(8).py(8).overflow_y_scrollbar()
        .when(!this.place.cwd, (el) => el.child(quiet("The shown space has no folder, so there is nothing to look for.")))
        .when(!!this.place.cwd && w.servers == null && !w.error, (el) => el.child(quiet("Looking…")))
        .when(!!w.error, (el) => el.child(div().px(12).py(8).text_size(12).line_height("16px").text_color(k.destructiveText).child(w.error)))
        .when(w.servers != null && !list.length && !w.error, (el) => el.child(quiet("Nothing started from this folder listens on a port. A server shows here within five seconds of starting.")))
        .children(list.map((s, i) => v_flex().flex_none().when(i > 0, (e) => e.border_t(1).border_color(alpha(k.border, 0.5))).child(serverRow(k, w, s, `srv-${s.pid}-${s.port}`)))))
      .child(div().px(20).py(10).flex_none().border_t(1).border_color(k.border).text_size(12).line_height("16px").text_color(tone)
        .child(w.note?.text ?? "A server belongs here when it, or a process that started it, runs in this folder. Stop asks it to end (SIGTERM) and asks you before forcing it."));
  }
}
