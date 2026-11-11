// Checks (a surface of the side panel, `ht3-panels.checks`; not in T3 Code): the project's check commands (test,
// typecheck, lint, build) listed, run in the project's folder with their output streamed, and what fails shown as
// Problems rows that open the file at that line.
//
// - The commands: what the folder says it has (detect.js: package.json scripts, Makefile targets, justfile recipes,
//   Cargo.toml, pyproject.toml), and the ones added with `+` (kept per project, scripts.js `customChecksOf`).
// - A run is `spawn` (herdr.d.ts) of `sh -c` in the shown space's folder (a chat's worktree is its own folder), with the
//   login shell's PATH as setup.js has it, and the lines read with `processNextLine`. It shows running, passed
//   or failed with the time taken and a Stop button (`processKill`: the command and what it started). `spawn` runs on
//   this computer only: in a space on another machine the command runs through `exec` there, whole (no streaming, ten
//   minutes at most, no Stop).
// - Problems (problems-parse.js): file, line, column, message and severity of what tsc, eslint, vitest, jest, pytest,
//   cargo/rustc and anything printing `path:line:col: message` said. A row opens the file at the line in Files
//   (main.js `goto:`, the way a Search hit does). "Send to chat" puts a summary into the message box of the shown
//   tab's chat, not sent (shared "ht3-panels.quote", as Diff's Add to chat does).
// - The raw output stays under "Output", closed until opened: the last 2000 lines are shown; the last 20000 are kept
//   to read problems from.
// For scripts: `ht3-panels.checks` shows the surface; with it shown, `checks-run:<n>` runs the nth command (from 0, the
// order of the list), `checks-stop`, `checks-send`, `checks-output` (opens or closes the output), `checks-row:<n>` clicks the
// nth Problems row, `checks-refresh`.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, spawn, processNextLine, processExited, processKill, run, shared, setShared, focused } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, badge, shortPath } from "./look.js";
import { activeSpace, placeOf, showing, spaceState, openSurface, GROUPS } from "./side.js";
import { projectOf, detectProject, customChecksOf, setCustomChecks } from "./scripts.js";
import { parseProblems, resolveFile, shortFile, summarize, clean } from "./problems-parse.js";

export const KEEP = 2000; // output lines shown
export const PARSE_KEEP = 20000; // output lines kept to read problems from
const LINE_MAX = 4000; // characters of a line kept
const SHOW_MAX = 500; // problems rows drawn
const WRAP_MS = 400; // a run tells its panel at most this often

// $1 folder, $2 the command, $3 the PATH to use (empty: ask the login shell). Herdr started from the Dock has a bare PATH:
// the command gets the login shell's, as setup.js gives a setup script. stderr goes where stdout goes (spawn reads stdout).
const WRAP = 'cd "$1" || exit 127\n'
  + 'P="$3"; [ -n "$P" ] || P=$("${SHELL:-/bin/sh}" -lic \'printf %s "$PATH"\' 2>/dev/null </dev/null | tail -n 1)\n'
  + '[ -n "$P" ] && export PATH="$P:$PATH"\n'
  + 'export NO_COLOR=1 FORCE_COLOR=0\n'
  + 'exec 2>&1\n'
  + 'exec sh -c "$2" </dev/null';

let pathCache = null;
// This computer's login-shell PATH, asked once.
export async function loginPath() {
  if (pathCache != null) return pathCache;
  const r = await exec("sh", ["-c", '"${SHELL:-/bin/sh}" -lic \'printf %s "$PATH"\' 2>/dev/null </dev/null | tail -n 1'], { timeout: 20000 }).catch(() => null);
  return (pathCache = r?.code === 0 ? r.stdout.trim() : "");
}

// The Checks surface's command (main.js): shows it in the group that has it, else the first, or the one asked for.
export function openChecks(group) {
  const st = spaceState(activeSpace()?.id);
  return openSurface(group ?? GROUPS.find((g) => st[g].tabs.some((t) => t.kind === "checks")) ?? "a", "checks");
}

export const clock = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
};

// One run of one command. state: "running" → "passed" | "failed" | "stopped" | "error" (it didn't start: `message`).
// `io` is herdr's spawn and friends (a test gives its own).
export class CheckRun {
  constructor({ key, name, command, cwd, on = null, io = { spawn, processNextLine, processExited, processKill, exec, loginPath }, onChange = () => {} }) {
    Object.assign(this, { key, name, command, cwd, on, io, onChange });
    this.state = "idle";
    this.lines = [];
    this.dropped = 0; // lines past PARSE_KEEP that were let go
    this.started = null;
    this.ended = null;
    this.code = null;
    this.message = null;
    this.problems = [];
    this.tools = [];
    this.pid = null;
    this.stopping = false;
    this.parsedAt = 0;
    this.parsedN = -1;
    this.told = 0;
  }
  running() { return this.state === "running"; }
  elapsed() { return this.started == null ? 0 : (this.ended ?? Date.now()) - this.started; }
  canStop() { return this.running() && !this.on; }

  push(line) {
    this.lines.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line);
    if (this.lines.length > PARSE_KEEP + 5000) { this.dropped += 5000; this.lines.splice(0, 5000); }
    const now = Date.now();
    if (now - this.told > WRAP_MS) { this.told = now; this.onChange(this); }
  }

  // Problems from the lines so far; not again while nothing came in, nor more than every 1.5 s while it runs.
  reparse(force = false) {
    if (this.parsedN === this.lines.length + this.dropped) return;
    if (!force && Date.now() - this.parsedAt < 1500) return;
    this.parsedN = this.lines.length + this.dropped;
    this.parsedAt = Date.now();
    const r = parseProblems(this.lines.join("\n"));
    this.problems = r.problems;
    this.tools = r.tools;
  }

  async start() {
    this.state = "running";
    this.started = Date.now();
    this.onChange(this);
    try {
      if (this.on) {
        const r = await this.io.exec("sh", ["-c", WRAP, "sh", this.cwd, this.command, ""], { cwd: this.cwd, on: this.on, timeout: 600000 });
        for (const l of `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.split("\n")) this.push(clean(l));
        this.code = r.code;
      } else {
        const path = await this.io.loginPath();
        if (this.stopping) { this.code = null; return this.finish(); }
        this.pid = this.io.spawn("sh", ["-c", WRAP, "sh", this.cwd, this.command, path], { cwd: this.cwd });
        for (let l; (l = await this.io.processNextLine(this.pid)) != null;) this.push(clean(l));
        const ex = await this.io.processExited(this.pid);
        this.code = ex.code;
        if (ex.code == null && !this.stopping && ex.stderr) this.push(String(ex.stderr).trim().split("\n").pop());
      }
    } catch (e) {
      // After processKill Herdr refuses the process's id, so the reads above end here: that is a stop, not a failure.
      if (this.stopping) { this.code = null; return this.finish(); }
      this.message = String(e?.message ?? e);
      this.ended = Date.now();
      this.state = "error";
      this.reparse(true);
      this.onChange(this);
      return;
    }
    this.finish();
  }

  finish() {
    this.ended = Date.now();
    this.state = this.stopping ? "stopped" : this.code === 0 ? "passed" : "failed";
    this.reparse(true);
    this.onChange(this);
  }

  // Stop: the command and everything it started end. The loop in start() then sees its output close.
  stop() {
    if (!this.running() || this.on) return;
    this.stopping = true;
    if (this.pid != null) { try { this.io.processKill(this.pid); } catch { /* it had ended */ } }
  }

  // The message for the chat's box.
  summary(max) {
    return summarize({ command: this.command, code: this.state === "stopped" ? null : this.code, problems: this.problems, cwd: this.cwd, tail: this.lines.filter((l) => l.trim()).slice(-20), max });
  }
}

const TONE = { passed: "successText", failed: "destructiveText", error: "destructiveText", stopped: "warningText", running: "muted" };
const GLYPH = { passed: "circle-check", failed: "circle-x", error: "circle-alert", stopped: "circle-dashed", running: "loader-circle", idle: "circle-dashed" };
const SEV = { error: ["circle-x", "destructiveText"], warning: ["triangle-alert", "warningText"], info: ["info", "muted"] };

export class ChecksPanel {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.runs = new Map(); // "<machine>|<folder>|<command>" -> CheckRun; kept while the panel lives, so a folder shown again has its results
    this.sel = null; // the key whose result shows
    this.seen = null;
    this.where = null; // { on, cwd }
    this.project = null;
    this.detected = null; // detect.js's answer for the folder
    this.adding = false;
    this.output = false; // the raw output is open
    this.said = null; // { text, bad }
    this.name = InputState.new({ placeholder: "Name, e.g. Lint" });
    this.command = InputState.new({ placeholder: "Command, e.g. npm run lint" });
    for (const f of [this.name, this.command]) { f.on("change", (_e, cx) => cx.notify()); f.on("submit", (_e, cx) => { this.addCustom(cx); }); }
    this.pscroll = VirtualListScrollHandle.new();
    this.oscroll = VirtualListScrollHandle.new();
    this.follow(cx);
    // While a command runs: the clock and the problems so far.
    cx.timer.every(500, (cx) => {
      let live = false;
      for (const r of this.runs.values()) if (r.running()) { live = true; r.reparse(); }
      if (live) cx.notify();
    });
  }
  close() { for (const r of this.runs.values()) r.stop(); }

  // For scripts: see the header.
  command_(c, cx) {
    const list = this.list(), cur = this.current();
    if (c.startsWith("checks-run:")) { const item = list[Number(c.slice(11))]; if (item) this.runCommand(item, cx); }
    else if (c === "checks-stop") cur?.stop();
    else if (c === "checks-send") this.send(cx);
    else if (c === "checks-output") this.output = !this.output;
    else if (c === "checks-refresh") this.detect(cx);
    else if (c.startsWith("checks-row:")) this.openRow(cur?.problems[Number(c.slice(11))]);
    cx.notify();
  }
  command(c, cx) { if (showing(this.group, "checks")) this.command_(c, cx); }

  // The folder shown, and what it has: a new folder asks again.
  follow(cx) {
    const sp = activeSpace(), where = placeOf(sp);
    const key = `${where.on ?? ""}|${where.cwd ?? ""}`;
    if (key === this.seen) return;
    this.seen = key;
    this.where = where.cwd ? { on: where.on ?? null, cwd: where.cwd } : null;
    this.sel = null;
    this.detected = null;
    this.project = null;
    this.said = null;
    if (!this.where) return;
    this.detect(cx);
    const seen = this.seen;
    cx.spawn(async (cx) => { const pr = await projectOf(sp).catch(() => null); if (this.seen === seen) { this.project = pr; cx.notify(); } });
  }

  detect(cx) {
    const seen = this.seen, where = this.where;
    if (!where) return;
    cx.spawn(async (cx) => {
      const found = await detectProject(where.cwd, where.on).catch(() => null);
      if (this.seen === seen) { this.detected = found ?? { checks: [], dev: null, scripts: [] }; cx.notify(); }
    });
  }

  // The commands to list: found ones, then the ones added here.
  list() {
    const found = (this.detected?.checks ?? []).map((c) => ({ id: c.id, name: c.name, command: c.command, kind: c.kind, source: c.source, custom: false }));
    const mine = customChecksOf(this.project?.key).map((c) => ({ id: `c:${c.name}`, name: c.name, command: c.command, kind: null, source: "added", custom: true }));
    const have = new Set(found.map((c) => c.command));
    return [...found, ...mine.filter((c) => !have.has(c.command))];
  }
  keyOf(item) { return `${this.where?.on ?? ""}|${this.where?.cwd ?? ""}|${item.command}`; }
  runOf(item) { return this.runs.get(this.keyOf(item)) ?? null; }
  current() { return this.sel ? this.runs.get(this.sel) ?? null : null; }

  runCommand(item, cx) {
    if (!this.where) return;
    const key = this.keyOf(item), was = this.runs.get(key);
    if (was?.running()) { this.sel = key; return; }
    // The click's cx goes stale at the first await, so the run reports through the spawn's own context.
    const r = new CheckRun({ key, name: item.name, command: item.command, cwd: this.where.cwd, on: this.where.on });
    this.runs.set(key, r);
    this.sel = key;
    this.said = null;
    cx.notify();
    cx.spawn(async (acx) => { r.onChange = () => acx.notify(); await r.start(); acx.notify(); });
  }

  addCustom(cx) {
    const name = this.name.value().trim(), command = this.command.value().trim();
    if (!this.project || !name || !command) return;
    setCustomChecks(this.project.key, [...customChecksOf(this.project.key).filter((c) => c.name !== name), { name, command }]);
    this.name.set_value("");
    this.command.set_value("");
    this.adding = false;
    cx.notify();
  }
  dropCustom(item, cx) {
    if (this.project) setCustomChecks(this.project.key, customChecksOf(this.project.key).filter((c) => c.name !== item.name));
    cx.notify();
  }

  // A row: Files shows the file with the line picked (main.js `goto:`, the keeper's, as a Search hit does).
  openRow(p) {
    if (!p || !this.where) return;
    const file = resolveFile(p.file, this.where.cwd);
    run(`${MOD}.goto:${p.line}:${file}`);
  }

  // Send to chat: the summary goes into the message box of the shown tab's chat (chat.js takes shared "ht3-panels.quote").
  send(cx) {
    const r = this.current();
    if (!r) return;
    const tab = focused()?.tab, places = shared("ht3-panels.places") ?? {};
    if (!Object.values(places).some((p) => p.tab === tab)) { this.said = { text: "The shown tab isn't a chat: show the chat this is for, then send it.", bad: true }; return cx.notify(); }
    setShared("ht3-panels.quote", { tab, text: r.summary(), at: Date.now() });
    this.said = { text: `Put into the chat's message box: ${Math.min(r.problems.length, 40)} of ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}, not sent.`, bad: false };
    cx.notify();
  }

  head(k) {
    const w = this.where;
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
      .child(icon("list-checks").size(14).flex_none().text_color(k.muted))
      .child(div().flex_none().font_medium().text_size(13).child("Checks"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(w ? `${w.on ? `${w.on}: ` : ""}${shortPath(this.project?.root ?? w.cwd)}` : ""))
      .child(iconButton(k, "checks-add", "plus", (cx) => { this.adding = !this.adding; if (this.adding) this.name.focus(); cx.notify(); }, { tip: "Add a command", on: this.adding }))
      .child(iconButton(k, "checks-refresh", "refresh-cw", (cx) => this.detect(cx), { tip: "Look for commands again" }));
  }

  commandRow(k, item, i) {
    const r = this.runOf(item), key = this.keyOf(item), on = this.sel === key;
    const glyph = icon(GLYPH[r?.state ?? "idle"]).size(14).flex_none().text_color(r ? k[TONE[r.state]] ?? k.muted : alpha(k.muted, 0.6));
    return h_flex().id(`check-${i}`).h(32).px(8).gap(8).flex_none().items_center().rounded(8).cursor_pointer()
      .bg(on ? alpha(k.foreground, 0.07) : "#00000000").hover((s) => s.bg(alpha(k.foreground, 0.08)))
      .role("button").accessibility_label(`${item.name}: show its result`)
      .on_click((_e, cx) => { if (r) this.sel = key; cx.notify(); })
      .child(r?.running() ? glyph.spin(1000) : glyph)
      .child(div().flex_none().max_w(110).truncate().font_medium().child(item.name))
      .child(div().flex_1().min_w(0).truncate().font_family(k.mono).text_size(11).text_color(k.muted).tooltip(`${item.command}\n${item.source}`).child(item.command))
      .when(!!r && r.state !== "idle", (el) => el.child(div().flex_none().text_size(11).text_color(r.running() ? k.muted : k[TONE[r.state]]).child(clock(r.elapsed()))))
      .when(item.custom, (el) => el.child(iconButton(k, `check-drop-${i}`, "trash-2", (cx) => this.dropCustom(item, cx), { size: "micro", tip: `Remove ${item.name}` })))
      .child(r?.running()
        ? (r.canStop() ? button(k, `check-stop-${i}`, "Stop", () => r.stop(), { variant: "destructive", size: "xs", glyph: "stop" }) : button(k, `check-stop-${i}`, "Running", () => {}, { disabled: true, tip: "Runs on another machine: it can't be stopped from here" }))
        : button(k, `check-run-${i}`, r ? "Again" : "Run", (cx) => this.runCommand(item, cx), { variant: "outline", size: "xs", glyph: "play" }));
  }

  addForm(k) {
    const ok = !!this.name.value().trim() && !!this.command.value().trim();
    return h_flex().flex_none().px(12).py(6).gap(6).items_center().border_b(1).border_color(alpha(k.border, 0.6))
      .child(div().w(96).flex_none().h(28).px(8).rounded(8).border(1).border_color(k.input).text_size(13).child(Input.new(this.name)))
      .child(div().flex_1().min_w(0).h(28).px(8).rounded(8).border(1).border_color(k.input).text_size(13).font_family(k.mono).child(Input.new(this.command)))
      .child(button(k, "check-new", "Add", (cx) => this.addCustom(cx), { variant: "default", disabled: !ok || !this.project, tip: "Kept for this project" }));
  }

  problemRow(k, p, i) {
    const [glyph, tone] = SEV[p.severity] ?? SEV.error, where = this.where?.cwd;
    return h_flex().h(40).mx(4).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(alpha(k.foreground, 0.07)))
      .child(icon(glyph).size(14).flex_none().text_color(k[tone]))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().min_w(0).truncate().font_family(k.mono).text_size(12).font_medium().child(`${shortFile(p.file, where)}${p.line ? `:${p.line}${p.col ? `:${p.col}` : ""}` : ""}`))
          .when(!!p.code, (e) => e.child(div().flex_none().text_size(11).text_color(k.muted).child(p.code))))
        .child(div().min_w(0).truncate().text_size(12).text_color(alpha(k.foreground, 0.8)).child(p.message)));
  }

  // The result of the selected run: how it ended, then the Problems, then the output (closed until opened).
  result(k, r) {
    const shown = r.problems.slice(0, SHOW_MAX), tone = k[TONE[r.state]] ?? k.muted;
    const errors = r.problems.filter((p) => p.severity === "error").length, warns = r.problems.filter((p) => p.severity === "warning").length;
    const ended = r.state === "passed" ? "Passed" : r.state === "failed" ? `Failed${r.code != null ? ` (exit ${r.code})` : ""}` : r.state === "stopped" ? "Stopped" : r.state === "error" ? "Didn't run" : "Running…";
    const outLines = r.lines.slice(-KEEP);
    const nl = r.lines.length;
    const none = r.state === "error" ? r.message
      : r.running() ? "Problems appear here as the output shows them."
      : r.problems.length ? null
      : r.state === "passed" ? "No problems."
      : r.state === "stopped" ? "Stopped before it said anything."
      : "No problem lines were found in the output. Open Output to read it.";
    return v_flex().flex_1().min_h(0).border_t(1).border_color(alpha(k.border, 0.6))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center()
        .child(div().flex_none().font_medium().text_color(tone).child(ended))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child([r.name, clock(r.elapsed()), r.problems.length ? `${errors} error${errors === 1 ? "" : "s"}${warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}` : null].filter(Boolean).join(" · ")))
        .when(r.problems.length > 0 || (!r.running() && r.state === "failed"), (el) => el.child(button(k, "check-send", "Send to chat", (cx) => this.send(cx), { size: "xs", glyph: "message-square", tip: "Puts the failures into the chat's message box, not sent" }))))
      .when(!!this.said, (el) => el.child(div().flex_none().px(12).pb(6).text_size(12).line_height("16px").text_color(this.said.bad ? k.destructiveText : k.muted).child(this.said.text)))
      .child(none
        ? v_flex().flex_1().min_h(0).px(24).items_center().justify_center().text_size(12).line_height("18px").text_center().text_color(r.state === "error" ? k.destructiveText : k.muted).child(none)
        : v_flex().relative().flex_1().min_h(0)
          .child(v_virtual_list("ht3-checks-problems", shown.length, 40, (i) => `p:${i}`, (range) => shown.slice(range.start, range.end).map((p, j) => this.problemRow(k, p, range.start + j)))
            .track_scroll(this.pscroll).size_full().on_item_click((key, cx) => { if (key.startsWith("p:")) { this.openRow(shown[Number(key.slice(2))]); cx.notify(); } }))
          .child(Scrollbar.vertical("ht3-checks-problems").absolute().inset_0()))
      .when(r.problems.length > SHOW_MAX, (el) => el.child(div().flex_none().px(12).py(4).text_size(11).text_color(k.muted).child(`The first ${SHOW_MAX} of ${r.problems.length} are listed; Send to chat sends 40.`)))
      .child(h_flex().id("check-output-head").h(28).flex_none().px(12).gap(6).items_center().cursor_pointer().border_t(1).border_color(alpha(k.border, 0.6)).text_size(12).text_color(k.muted)
        .hover((s) => s.bg(alpha(k.foreground, 0.05)).text_color(k.foreground)).role("button").accessibility_label(this.output ? "Close the output" : "Open the output")
        .on_click((_e, cx) => { this.output = !this.output; cx.notify(); })
        .child(icon(this.output ? "chevron-down" : "chevron-right").size(14).flex_none())
        .child(div().flex_1().child(`Output · ${nl + r.dropped} line${nl + r.dropped === 1 ? "" : "s"}${r.dropped || nl > KEEP ? `, the last ${Math.min(nl, KEEP)} shown` : ""}`)))
      .when(this.output, (el) => {
        if (r.running()) this.oscroll.scroll_to_bottom();
        return el.child(v_flex().relative().flex_1().min_h(0).bg(alpha(k.card, 0.5))
          .child(v_virtual_list("ht3-checks-output", outLines.length, 16, (i) => `o:${i}`, (range) => outLines.slice(range.start, range.end).map((l) => div().h(16).px(12).flex_none().overflow_hidden().whitespace_nowrap().font_family(k.mono).text_size(11).text_color(alpha(k.foreground, 0.85)).child(l.replace(/ /g, "\u00a0").replace(/\t/g, "\u00a0\u00a0"))))
            .track_scroll(this.oscroll).size_full())
          .child(Scrollbar.vertical("ht3-checks-output").absolute().inset_0()));
      });
  }

  render(cx) {
    this.follow(cx);
    const k = tokens();
    const root = v_flex().id("ht3-checks").size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(13);
    if (!this.where) return root.child(this.head(k)).child(v_flex().flex_1().items_center().justify_center().px(24).text_size(12).text_color(k.muted).child("No folder: focus a terminal or a chat in a project."));
    const list = this.list(), r = this.current();
    return root.child(this.head(k))
      .when(this.adding, (el) => el.child(this.addForm(k)))
      .child(v_flex().id("ht3-checks-list").flex_none().max_h(r ? 196 : 400).px(8).py(6).gap(2).overflow_y_scrollbar()
        .when(this.detected == null, (el) => el.child(div().px(4).py(6).text_size(12).text_color(k.muted).child("Looking for commands…")))
        .when(this.detected != null && !list.length, (el) => el.child(div().px(4).py(6).text_size(12).line_height("18px").text_color(k.muted).child("No test, typecheck, lint or build command found in package.json, a Makefile, a justfile, Cargo.toml or pyproject.toml. Add one with +.")))
        .children(list.map((item, i) => this.commandRow(k, item, i))))
      .when(!!r, (el) => el.child(this.result(k, r)))
      .when(!r && list.length > 0, (el) => el.child(v_flex().flex_1().items_center().justify_center().px(24).text_size(12).line_height("18px").text_center().text_color(k.muted).child("Run a command: what fails shows here as problems you can open, or send to the chat.")));
  }
}
