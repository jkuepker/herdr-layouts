// A worktree's setup script (T3 Code's "run on worktree creation", chat/WorktreeSetupCard.tsx): the project script
// marked as setup (scripts.js `setupOf`) runs in a new worktree before its chat's agent starts, with a card that
// shows the command, its last output lines, the time it has taken and how it ended. A failed run waits for
// Retry, Skip (start the chat anyway) or Cancel.
//
// The script runs where the worktree is (`exec` with `on:`), detached under nohup, so nothing waits on one long
// `exec` (capped at 10 minutes, and silent until it ends): its output goes to `ht3-setup.log` in the worktree's
// own Git folder (<repo>/.git/worktrees/<name>, never the working tree), its exit code to `ht3-setup.code`, and a
// short `exec` once a second reads both. It gets HT3_PROJECT_ROOT (the main checkout) and HT3_WORKTREE_PATH, and
// T3 Code's names for the same (T3CODE_PROJECT_ROOT, T3CODE_WORKTREE_PATH). After SETUP_TIMEOUT it is stopped.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { MOD, tokens, alpha, icon, button, badge, shortPath } from "./look.js";

export const SETUP_TIMEOUT = 15 * 60000;
const RUNS = `${MOD}.setup-run`; // { "<run id>": { state, beat, message? } }: a card in a dialog of its own tells its caller

// Herdr started from the Dock has a bare PATH: the script gets the login shell's, as chats do to find their agents.
const START = 'w="$1"; cd "$w" || exit 1\n'
  + 'P=$("${SHELL:-/bin/sh}" -lic \'printf %s "$PATH"\' 2>/dev/null </dev/null | tail -n 1); [ -n "$P" ] && export PATH="$P:$PATH"\n'
  + 'd=$(git rev-parse --absolute-git-dir 2>/dev/null) || d=$(mktemp -d) || exit 1\n'
  + 'rm -f "$d/ht3-setup.code"\n'
  + 'HT3_PROJECT_ROOT="$3" HT3_WORKTREE_PATH="$w" T3CODE_PROJECT_ROOT="$3" T3CODE_WORKTREE_PATH="$w" '
  + 'nohup sh -c \'sh -c "$1"; echo $? > "$2/ht3-setup.code.tmp"; mv "$2/ht3-setup.code.tmp" "$2/ht3-setup.code"\' sh "$2" "$d" > "$d/ht3-setup.log" 2>&1 < /dev/null &\n'
  + 'echo $! > "$d/ht3-setup.pid"; printf %s "$d"';
const POLL = 'd="$1"; p=$(cat "$d/ht3-setup.pid" 2>/dev/null)\n'
  + 'if [ -f "$d/ht3-setup.code" ]; then echo "done $(cat "$d/ht3-setup.code")"; elif [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo running;\n'
  + 'elif [ -f "$d/ht3-setup.code" ]; then echo "done $(cat "$d/ht3-setup.code")"; else echo gone; fi\n'
  + 'tail -n 40 "$d/ht3-setup.log" 2>/dev/null | cut -c1-2000';
// The script and everything under it: each process's children are listed before it is ended.
const KILL = 'k() { set -- "$1" $(pgrep -P "$1" 2>/dev/null); kill "$1" 2>/dev/null; shift; for c; do k "$c"; done; }\n'
  + 'p=$(cat "$1/ht3-setup.pid" 2>/dev/null) && [ -n "$p" ] && k "$p"; true';

// Mods have no setTimeout: a caller with a `cx` passes its own wait (cx.timer.after); without one, `sleep` waits.
const nap = (ms) => exec("sleep", [String(Math.max(0.05, ms / 1000))], { timeout: ms + 5000 }).catch(() => null);

// What a terminal would have left on each line: the text after the last carriage return, without colors.
export const tidy = (text, keep = 12) => String(text ?? "").split("\n")
  .map((l) => l.replace(/\r+$/, "").split("\r").pop().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+$/, "")).filter(Boolean).slice(-keep);

export const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// One setup run and what it waits for. state: "idle" → "running" → "ok" | "failed"; from "failed", retry() runs it
// again, skip() ends as "skipped", cancel() as "cancelled"; cancel() while it runs stops the script.
// run() resolves to "ok", "skipped" or "cancelled", and not before one of them: a failed run waits for the person.
export class SetupRun {
  constructor({ cwd, root, on = null, script, timeout = SETUP_TIMEOUT, every = 1000, sleep = nap, onChange = null }) {
    Object.assign(this, { cwd, root: root ?? cwd, on, script, timeout, every, sleep, onChange });
    this.state = "idle";
    this.lines = [];      // the last output lines
    this.started = null;  // ms
    this.ended = null;
    this.code = null;     // the exit code, once it has one
    this.message = null;  // why it failed, when the exit code doesn't say
    this.tries = 0;
    this.stopping = false;
    this.asked = null;    // resolves the wait after a failure
    this.dir = null;      // where the running script's log, pid and exit code are
    this.result = null;
  }

  elapsed() { return this.started == null ? 0 : (this.ended ?? Date.now()) - this.started; }
  settled() { return this.state === "ok" || this.state === "skipped" || this.state === "cancelled"; }
  changed() { try { this.onChange?.(this); } catch {} }

  retry() { if (this.state === "failed") this.asked?.("retry"); }
  skip() { if (this.state === "failed") this.asked?.("skip"); }
  // Resolves once the script was told to stop (a closing dialog waits for that).
  cancel() {
    if (this.state === "failed") this.asked?.("cancel");
    else if (this.state === "running" || this.state === "idle") { this.stopping = true; this.changed(); return this.kill(); }
    return Promise.resolve(null);
  }
  kill() { return this.dir ? exec("sh", ["-c", KILL, "sh", this.dir], { on: this.on ?? undefined, timeout: 15000 }).catch(() => null) : Promise.resolve(null); }

  run() { return (this.result ??= this.loop()); }

  async loop() {
    for (;;) {
      await this.attempt();
      if (this.stopping) { this.state = "cancelled"; this.changed(); return "cancelled"; }
      if (this.state === "ok") return "ok";
      const answer = await new Promise((r) => { this.asked = r; this.changed(); });
      this.asked = null;
      if (answer === "retry") continue;
      this.state = answer === "skip" ? "skipped" : "cancelled";
      this.changed();
      return this.state;
    }
  }

  fail(message, code = null) { this.state = "failed"; this.code = code; this.message = message; this.ended = Date.now(); }

  async attempt() {
    Object.assign(this, { state: "running", started: Date.now(), ended: null, code: null, message: null, lines: [] });
    this.tries += 1;
    this.changed();
    const at = { on: this.on ?? undefined };
    let dir = this.dir = null;
    try {
      const r = await exec("sh", ["-c", START, "sh", this.cwd, this.script.command, this.root], { cwd: this.cwd, ...at, timeout: 30000 });
      if (r.code !== 0 || !r.stdout.trim()) return this.fail(`Couldn't start it: ${(r.stderr || r.stdout).trim().split("\n").pop() || `sh exited with ${r.code}`}`);
      dir = this.dir = r.stdout.trim();
    } catch (e) { return this.fail(`Couldn't start it: ${String(e?.message ?? e)}`); }
    const stop = () => this.kill();
    for (let missed = 0; ;) {
      await this.sleep(this.every);
      if (this.stopping) { await stop(); this.ended = Date.now(); return; }
      const r = await exec("sh", ["-c", POLL, "sh", dir], { ...at, timeout: 15000 }).catch(() => null);
      const out = r?.code === 0 ? r.stdout : null, nl = out?.indexOf("\n") ?? -1, head = out == null ? null : (nl < 0 ? out : out.slice(0, nl)).trim();
      if (head == null) {
        // The machine didn't answer: the script may well still run there. Five in a row and it is given up.
        if (++missed >= 5) return this.fail(`${this.on ?? "This computer"} stopped answering; the script may still be running there.`);
      } else {
        missed = 0;
        this.lines = tidy(nl < 0 ? "" : out.slice(nl + 1));
        if (head.startsWith("done")) {
          const code = Number(head.slice(5));
          this.ended = Date.now();
          if (code === 0) { this.state = "ok"; this.code = 0; this.changed(); return; }
          return this.fail(null, Number.isFinite(code) ? code : null);
        }
        if (head === "gone") return this.fail("The script ended without an exit code (it was stopped from outside).");
      }
      if (Date.now() - this.started > this.timeout) {
        await stop();
        const m = this.timeout / 60000;
        return this.fail(`Stopped: not finished after ${m >= 1 ? `${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"}` : `${Math.round(this.timeout / 1000)} seconds`}. Retry runs it again from the start.`);
      }
      this.changed();
    }
  }
}

// The line a run's end is told in, for a caller that shows no card.
export function setupError(run, path) {
  const why = run.state === "cancelled" ? "Setup was cancelled" : `Setup script "${run.script.name}" failed${run.code != null ? ` (exit ${run.code})` : ""}: ${run.message ?? run.lines.at(-1) ?? "no output"}`;
  const e = new Error(`${why}. The worktree is kept: ${path}`);
  e.setup = run.state;
  e.worktree = path;
  return e;
}

// Runs a new worktree's setup and resolves once the chat may start ("ok", "skipped"); rejects (setupError) when it was
// cancelled. `card(run)`: the caller draws the card itself (the New chat dialog) and gives `sleep` and `onChange`
// from its `cx`. Without `card`, the card opens as a dialog of its own, which runs the script and says how it went in
// shared `ht3-panels.setup-run`; should that dialog not come up within 8 seconds, the script runs here with no card
// and a failure rejects.
export async function runSetup({ cwd, root, on = null, script, card = null, sleep = null, onChange = null, timeout = SETUP_TIMEOUT, every = 1000 }) {
  if (card) {
    const run = new SetupRun({ cwd, root, on, script, timeout, every, sleep: sleep ?? nap, onChange });
    card(run);
    const how = await run.run();
    if (how === "cancelled") throw setupError(run, cwd);
    return how;
  }
  const wait = sleep ?? nap, id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6), opened = Date.now();
  let overlay = null;
  try { overlay = openOverlay({ mod: MOD, kind: "dialog", width: 512, height: 400, props: { setup: { id, cwd, root, on, script: { name: script.name, command: script.command } } } }); } catch {}
  const forget = () => { const all = { ...(shared(RUNS) ?? {}) }; delete all[id]; setShared(RUNS, all); };
  for (;;) {
    await wait(500);
    const s = (shared(RUNS) ?? {})[id];
    if (!s) {
      if (overlay != null && Date.now() - opened < 8000) continue;
      break; // no card came up: run it here
    }
    if (s.state === "ok" || s.state === "skipped") { forget(); return s.state; }
    // Cancelled, or the dialog went without a word (its beat is every poll, a second apart).
    if (s.state === "cancelled" || Date.now() - s.beat > 20000) {
      forget();
      const e = new Error(`Setup was cancelled. The worktree is kept: ${cwd}`);
      e.setup = "cancelled"; e.worktree = cwd;
      throw e;
    }
  }
  if (overlay != null) try { closeOverlay(overlay); } catch {}
  let failure = null;
  const run = new SetupRun({ cwd, root, on, script, timeout, every, sleep: wait, onChange: (r) => { if (r.state === "failed") { failure = setupError(r, cwd); failure.setup = "failed"; r.cancel(); } } });
  const how = await run.run();
  if (how !== "ok") throw failure ?? setupError(run, cwd);
  return how;
}

// The card (WorktreeSetupCard.tsx): how it stands and the time, the script and where it runs, its last lines in a
// mono box, and why it failed. The buttons are setupButtons, for the caller's footer.
export function setupCard(k, run) {
  const s = run.state, failed = s === "failed", done = s === "ok" || s === "skipped";
  const title = s === "ok" ? "Setup finished" : s === "skipped" ? "Setup skipped" : s === "cancelled" ? "Setup cancelled"
    : failed ? (run.code != null ? `Setup failed (exit ${run.code})` : "Setup failed") : run.stopping ? "Stopping…" : "Setting up the worktree";
  const tone = failed ? k.destructiveText : s === "ok" ? k.successText : k.muted;
  const glyph = failed ? "circle-alert" : s === "ok" ? "circle-check" : done || s === "cancelled" ? "circle-x" : "circle-dashed";
  const mark = icon(glyph).size(16).flex_none();
  return v_flex().id("ht3-setup-card").gap(8).p(12).rounded(10).border(1).border_color(failed ? alpha(k.destructiveText, 0.4) : k.border).bg(alpha(k.accent, 0.3))
    .child(h_flex().gap(8).items_center()
      .child(h_flex().size(16).flex_none().items_center().justify_center().text_color(tone).child(s === "running" ? mark.spin(1000) : mark))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(failed ? k.destructiveText : k.foreground).child(title))
      .when(run.tries > 1, (el) => el.child(div().flex_none().text_size(12).text_color(k.muted).child(`try ${run.tries}`)))
      .child(div().id("ht3-setup-time").flex_none().text_size(12).font_family(k.mono).text_color(k.muted).child(clock(run.elapsed()))))
    .child(h_flex().gap(8).items_center()
      .child(icon("square-terminal").size(14).flex_none().text_color(k.muted))
      .child(badge(k, run.script.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(k.mono).text_color(k.muted).child(run.script.command)))
    .child(div().flex_none().text_size(12).text_color(k.dim).truncate().child(`in ${run.on ? `${run.on}:` : ""}${shortPath(run.cwd)}`))
    .child(v_flex().id("ht3-setup-output").min_h(64).max_h(190).px(8).py(6).rounded(6).bg(k.background ?? k.popover).border(1).border_color(alpha(k.border, 0.7)).overflow_y_scrollbar()
      .text_size(12).font_family(k.mono).text_color(k.muted)
      .when(!run.lines.length, (el) => el.child(div().text_color(k.dim).child(s === "running" ? "No output yet." : "No output.")))
      .children(run.lines.slice(-10).map((l, i) => div().id(`ht3-setup-line-${i}`).truncate().child(l.length > 300 ? `${l.slice(0, 300)}…` : l))))
    .when(failed && !!run.message, (el) => el.child(div().text_size(12).text_color(k.destructiveText).child(run.message)))
    .when(failed, (el) => el.child(div().text_size(12).text_color(k.muted).child("Retry runs the script again. Skip starts the chat without it. Cancel keeps the worktree and starts nothing.")));
}

// Cancel while it runs; Cancel, Skip and Retry once it failed.
export function setupButtons(k, run) {
  const press = (what) => (cx) => { run[what](); cx.notify(); };
  if (run.state === "failed") return [
    button(k, "setup-cancel", "Cancel", press("cancel"), { variant: "outline", size: "default" }),
    button(k, "setup-skip", "Skip", press("skip"), { variant: "outline", size: "default", tip: "Start the chat without the setup" }),
    button(k, "setup-retry", "Retry", press("retry"), { variant: "default", size: "default", glyph: "rotate-ccw" })];
  if (run.state === "running" || run.state === "idle") return [button(k, "setup-cancel", run.stopping ? "Stopping…" : "Cancel", press("cancel"), { variant: "outline", size: "default", disabled: run.stopping })];
  return [];
}

// The card as a dialog of its own (opened by runSetup for a caller with no card; props.setup). It runs the script
// and tells the caller through shared `ht3-panels.setup-run`. Closing it (Esc) cancels.
export class SetupDialog {
  init(p, cx) {
    this.overlay = p.overlay;
    const s = p.setup;
    this.id = s.id;
    const tell = () => { if (!this.told) setShared(RUNS, { ...(shared(RUNS) ?? {}), [this.id]: { state: this.run.state, beat: Date.now() } }); };
    this.run = new SetupRun({ cwd: s.cwd, root: s.root, on: s.on, script: s.script, sleep: (ms) => new Promise((r) => cx.timer.after(ms, () => r())), onChange: () => { tell(); cx.notify(); } });
    tell();
    // The beat, also while a failed run waits for an answer.
    cx.timer.every(2000, () => { if (!this.run.settled()) tell(); });
    cx.spawn(async (cx) => {
      const how = await this.run.run();
      tell();
      this.told = true;
      if (how === "ok") await this.run.sleep(700); // the finished card, for a moment
      cx.notify();
      closeOverlay(this.overlay);
    });
  }

  // Esc, or anything else that takes the dialog away, before the run settled: the script is stopped and the caller told.
  async close() {
    if (this.told) return;
    this.told = true;
    setShared(RUNS, { ...(shared(RUNS) ?? {}), [this.id]: { state: "cancelled", beat: Date.now() } });
    await this.run.cancel();
  }

  // setup:retry, setup:skip, setup:cancel: the buttons, for scripts.
  command(c, cx) {
    if (c === "setup:retry") this.run.retry();
    if (c === "setup:skip") this.run.skip();
    if (c === "setup:cancel") this.run.cancel();
    cx.notify();
  }

  render() {
    const k = tokens();
    return v_flex().id("ht3-setup").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(v_flex().px(24).pt(24).pb(8).gap(8).flex_none()
        .child(div().text_size(20).font_semibold().child("Worktree setup"))
        .child(div().text_size(14).text_color(k.muted).child("The project's setup script runs in the new worktree before the chat starts.")))
      .child(v_flex().flex_1().min_h(0).px(24).py(8).overflow_y_scrollbar().child(setupCard(k, this.run)))
      .child(h_flex().px(24).py(16).gap(8).flex_none().justify_end().border_t(1).border_color(k.border).children(setupButtons(k, this.run)));
  }
}
