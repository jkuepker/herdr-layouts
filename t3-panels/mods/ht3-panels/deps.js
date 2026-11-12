// Dependencies (a dialog, `ht3-panels.deps`; the Project popover's Dependencies row; not in T3 Code): the outdated packages of
// the shown folder, grouped major / minor / patch, each with Update, and Update all patch+minor and Ask agent to update on top.
//
// - Ecosystem (deps-parse.js detectEcosystems, from the folder's files, read on its machine): npm, pnpm, yarn 1 or bun (package.json
//   and the lock file), uv (pyproject.toml and uv.lock), pip (requirements.txt, or pyproject.toml without uv.lock), Cargo
//   (cargo-outdated, which it says how to install when it is missing) and Go modules. A folder with several shows a button each.
// - The check runs as checks.js runs a command (`CheckRun`: spawn of `sh -c` in the folder with the login shell's PATH, Running…
//   with the time, Stop; on another machine through `exec`, no Stop), stopped after two minutes. Its output is read by deps-parse.js
//   parseOutdated into rows { name, current, wanted, latest, kind, dev }. The last result of a folder is kept in shared
//   "ht3-panels.deps-cache" (the 24 newest folders), so the dialog opens on it, and the Project popover's row counts it.
// - Update runs the ecosystem's command for that package in a new side terminal (scripts.js runScript, the way the Project
//   popover's scripts run), and the dialog closes so the terminal can be watched; the row says "sent" when the dialog is opened
//   again, until a new check. Update all patch+minor asks first (Yes / Cancel) and then runs the one command for every patch and
//   minor row. Ask agent to update puts a prompt into the message box of the shown tab's chat (not sent, shared
//   "ht3-panels.quote", as Checks' Send to chat does) about the ticked packages, else the major ones, else all, and closes.
// For scripts: `ht3-panels.deps` opens it (again while it is open closes it). While it is open: `deps-refresh`, `deps-stop`,
// `deps-update:<package>`, `deps-filter:<text>`, `deps-select:<package>` (ticks or unticks), `deps-all` (asks), `deps-yes`, `deps-no`,
// `deps-ask`, `deps-eco:<id>`, `ui:close`. What the last check found is in shared "ht3-panels.deps-result".

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, closeOverlay, openOverlay, shared, setShared, focused } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, badge, shortPath } from "./look.js";
import { placeOf, activeSpace } from "./side.js";
import { projectOf, runScript } from "./scripts.js";
import { parseBundle } from "./detect.js";
import { CheckRun, clock } from "./checks.js";
import { DEPS_READ, TIMEOUT_MS, detectEcosystems, parseOutdated, failureText, updateCommand, filterRows, groupRows, counts, safeRows, askRows, askPrompt, ago } from "./deps-parse.js";

export const DEPS_SIZE = { width: 640, height: 560 };
const OPEN = `${MOD}.deps-open`, CACHE = `${MOD}.deps-cache`, RESULT = `${MOD}.deps-result`;
const KEEP = 24; // folders whose last result is kept
const SHOW_MAX = 300; // rows drawn
export const depsOpen = () => Date.now() - (shared(OPEN) ?? 0) < 2500;
export const openDeps = () => { openOverlay({ mod: MOD, kind: "dialog", ...DEPS_SIZE, props: { menu: "deps" } }); };

// ---- what the last check found, kept in memory (shared state) per folder and ecosystem ----
const folderKey = (place) => `${place?.on ?? ""}|${place?.cwd ?? ""}|`;
export const cached = (place, id) => (shared(CACHE) ?? {})[`${folderKey(place)}${id}`] ?? null;
function keep(place, id, entry) {
  const all = { ...(shared(CACHE) ?? {}), [`${folderKey(place)}${id}`]: entry };
  const old = Object.keys(all).sort((a, b) => (all[b].at ?? 0) - (all[a].at ?? 0)).slice(KEEP);
  for (const k of old) delete all[k];
  setShared(CACHE, all);
}
// How many packages the last checks of a folder found outdated (all its ecosystems), or null before any check: the popover's row.
export function outdatedCount(place) {
  const prefix = folderKey(place), all = shared(CACHE) ?? {};
  const mine = Object.keys(all).filter((k) => k.startsWith(prefix));
  return mine.length ? mine.reduce((n, k) => n + (all[k].rows?.length ?? 0), 0) : null;
}

// The command of a check without the guard that says the tool is missing.
const shownCommand = (eco) => eco.check.split("; ").pop();
const TONE = { major: "destructiveText", minor: "warningText", patch: "successText" };
const LABEL = { major: "Major", minor: "Minor", patch: "Patch" };

// The dialog. Fields are named so none hides a method (command, init, render, close).
export class DepsDialog {
  init(p, cx) {
    this.overlay = p.overlay;
    const space = activeSpace(), at = placeOf(space);
    this.place = { cwd: at?.cwd ?? null, on: at?.on ?? null };
    this.project = null;
    this.ecoList = null; // null while the folder is being read
    this.ecoId = null;
    this.runs = new Map(); // ecosystem id -> CheckRun
    this.results = new Map(); // ecosystem id -> the last result of this dialog (errors too; the cache keeps the good ones)
    this.picked = new Set();
    this.confirm = false;
    this.said = null; // { text, bad }
    this.filterBox = InputState.new({ placeholder: "Filter: name, major, minor, patch or dev" });
    this.filterBox.on("change", (_e, cx) => cx.notify());
    setShared(OPEN, Date.now());
    // The clock of a running check, its time limit, and the stamp that says the dialog is open.
    cx.timer.every(500, (cx) => {
      let live = false;
      for (const r of this.runs.values()) if (r.running()) { live = true; if (r.canStop() && r.elapsed() > TIMEOUT_MS && !r.timedOut) { r.timedOut = true; r.stop(); } }
      if (live) cx.notify();
    });
    cx.timer.every(1000, () => setShared(OPEN, Date.now()));
    if (!this.place.cwd) { this.ecoList = []; return; }
    cx.spawn(async (cx) => {
      const [project, files] = await Promise.all([
        projectOf(space).catch(() => null),
        exec("sh", ["-c", DEPS_READ, "sh", this.place.cwd], { cwd: this.place.cwd, on: this.place.on ?? undefined, timeout: 10000 }).catch(() => null),
      ]);
      this.project = project;
      this.ecoList = detectEcosystems(parseBundle(files?.stdout ?? ""));
      this.ecoId = this.ecoList[0]?.id ?? null;
      cx.notify();
      const eco = this.eco();
      if (eco && !cached(this.place, eco.id)) this.start(cx);
    });
  }
  close() { for (const r of this.runs.values()) r.stop(); }

  eco() { return this.ecoList?.find((e) => e.id === this.ecoId) ?? null; }
  run() { const e = this.eco(); return e ? this.runs.get(e.id) ?? null : null; }
  // The result shown: this dialog's own, else the kept one of the folder.
  result() { const e = this.eco(); return e ? this.results.get(e.id) ?? cached(this.place, e.id) : null; }
  rows() { return this.result()?.rows ?? []; }

  // Commands for scripts: see the header.
  command(c, cx) {
    if (c === "ui:close" || c === "deps") return void closeOverlay(this.overlay);
    if (c === "deps-refresh") this.start(cx);
    else if (c === "deps-stop") this.run()?.stop();
    else if (c.startsWith("deps-update:")) { const r = this.rows().find((x) => x.name === c.slice(12)); if (r) this.update([r], cx, `Update ${r.name}`); else console.log(`${MOD}.${c}: no outdated package of that name here`); }
    else if (c.startsWith("deps-filter:")) this.filterBox.set_value(c.slice(12));
    else if (c.startsWith("deps-select:")) this.toggle(c.slice(12));
    else if (c === "deps-all") this.confirm = safeRows(this.rows()).length > 0;
    else if (c === "deps-yes") this.updateAll(cx);
    else if (c === "deps-no") this.confirm = false;
    else if (c === "deps-ask") this.ask();
    else if (c.startsWith("deps-eco:")) { if (this.ecoList?.some((e) => e.id === c.slice(9))) this.pickEco(c.slice(9), cx); }
    cx.notify();
  }

  pickEco(id, cx) {
    this.ecoId = id;
    this.picked = new Set();
    this.confirm = false;
    this.said = null;
    if (!cached(this.place, id) && !this.results.has(id) && !this.runs.get(id)?.running()) this.start(cx);
  }

  toggle(name) { if (this.picked.has(name)) this.picked.delete(name); else this.picked.add(name); }

  // ---- the check ----

  start(cx) {
    const eco = this.eco();
    if (!eco || !this.place.cwd || this.run()?.running()) return;
    const r = new CheckRun({ key: `${folderKey(this.place)}${eco.id}`, name: `${eco.label} outdated`, command: eco.check, cwd: this.place.cwd, on: this.place.on });
    r.timedOut = false;
    this.runs.set(eco.id, r);
    this.said = null;
    this.confirm = false;
    cx.notify();
    // The click's cx goes stale at the first await, so the run reports through the spawn's own context.
    cx.spawn(async (acx) => { r.onChange = () => acx.notify(); await r.start(); this.finish(eco, r); acx.notify(); });
  }

  // The run ended: read its output. A stop by the person keeps what was shown; a stop by the time limit says so.
  finish(eco, r) {
    if (r.state === "stopped" && !r.timedOut) return;
    const text = r.lines.join("\n");
    let res;
    if (r.timedOut) res = { rows: [], notes: [], error: `The check took more than ${Math.round(TIMEOUT_MS / 1000)} seconds and was stopped.`, missing: null };
    else {
      res = parseOutdated(eco.id, text, eco);
      // An exit other than 0 with nothing to show: the tool's own words. (npm and the others exit 1 when something is outdated.)
      if (!res.rows.length && !res.notes.length && !res.missing && !res.error && (r.state === "error" || (r.code != null && r.code !== 0))) res.error = r.message || failureText(text) || `The command ended with exit ${r.code}.`;
    }
    res = { ...res, at: Date.now(), command: shownCommand(eco) };
    this.results.set(eco.id, res);
    this.picked = new Set([...this.picked].filter((n) => res.rows.some((x) => x.name === n)));
    if (!res.error && !res.missing) keep(this.place, eco.id, { rows: res.rows, notes: res.notes, at: res.at, command: res.command });
    setShared(RESULT, { cwd: this.place.cwd, on: this.place.on, eco: eco.id, at: res.at, error: res.error, missing: res.missing?.tool ?? null, counts: counts(res.rows), rows: res.rows.map((x) => ({ name: x.name, kind: x.kind })) });
  }

  // ---- updating ----

  // Runs the update of these rows in a side terminal and closes the dialog, so the terminal can be watched.
  update(rows, cx, label) {
    const eco = this.eco();
    if (!eco || !rows.length) return;
    if (!this.project) { this.said = { text: "No folder to run it in.", bad: true }; return cx.notify(); }
    runScript(this.project, { name: label, command: updateCommand(eco, rows) });
    const res = this.result();
    if (res && !res.error) keep(this.place, eco.id, { rows: res.rows, notes: res.notes, at: res.at, command: res.command, sent: { ...(cached(this.place, eco.id)?.sent ?? {}), ...Object.fromEntries(rows.map((r) => [r.name, Date.now()])) } });
    this.results.delete(eco.id);
    closeOverlay(this.overlay);
  }
  updateAll(cx) {
    if (!this.confirm) return;
    this.confirm = false;
    const rows = safeRows(this.rows());
    this.update(rows, cx, `Update ${rows.length} dependenc${rows.length === 1 ? "y" : "ies"}`);
  }

  // Ask agent: the prompt goes into the message box of the shown tab's chat (chat.js takes shared "ht3-panels.quote").
  ask() {
    const eco = this.eco(), rows = askRows(this.rows(), [...this.picked]);
    if (!eco || !rows.length) { this.said = { text: "Nothing is outdated to ask about.", bad: true }; return; }
    const tab = focused()?.tab, places = shared(`${MOD}.places`) ?? {};
    if (!Object.values(places).some((p) => p.tab === tab)) { this.said = { text: "The shown tab isn't a chat: show the chat this is for, then ask.", bad: true }; return; }
    setShared(`${MOD}.quote`, { tab, text: askPrompt(eco, rows, { root: shortPath(this.project?.root ?? this.place.cwd) }), at: Date.now() });
    closeOverlay(this.overlay);
  }

  // ---- drawing ----

  checkbox(k, id, on, label, onClick) {
    return h_flex().id(id).size(16).flex_none().items_center().justify_center().rounded(4).border(1).cursor_pointer()
      .border_color(on ? k.primary : k.input).bg(on ? k.primary : "#00000000").text_color(k.primaryText)
      .role("check_box").accessibility_label(label).on_click((_e, cx) => onClick(cx))
      .when(on, (e) => e.child(icon("check").size(12)));
  }

  depRow(k, r, n, sent) {
    const pick = this.picked.has(r.name);
    return h_flex().id(`dep-${n}`).h(30).px(12).gap(8).flex_none().items_center().hover((s) => s.bg(alpha(k.foreground, 0.05)))
      .child(this.checkbox(k, `dep-pick-${n}`, pick, `${r.name}: ${pick ? "selected" : "not selected"} for Ask agent`, (cx) => { this.toggle(r.name); cx.notify(); }))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().tooltip(`${r.name}\ncurrent ${r.current}${r.wanted && r.wanted !== r.current ? `\nwanted ${r.wanted}` : ""}\nlatest ${r.latest}${r.deprecated ? "\ndeprecated" : ""}`).child(r.name))
      .when(r.dev, (el) => el.child(badge(k, "dev")))
      .when(!!r.deprecated, (el) => el.child(badge(k, "deprecated", "warning")))
      .child(h_flex().flex_none().max_w(220).font_family(k.mono).text_size(11).text_color(k.muted).child(div().truncate().child(`${r.current} → `)).child(div().truncate().text_color(k[TONE[r.kind]]).child(r.latest)))
      .child(sent ? badge(k, "sent", "success") : button(k, `dep-up-${n}`, "Update", (cx) => this.update([r], cx, `Update ${r.name}`), { size: "xs", glyph: "arrow-up", tip: `Updates ${r.name} to ${r.latest} in a side terminal` }));
  }

  render(_cx) {
    const k = tokens(), eco = this.eco(), run = this.run(), res = this.result(), all = this.rows();
    const where = this.place.cwd ? `${this.place.on ? `${this.place.on}:` : ""}${shortPath(this.place.cwd)}` : null;
    const shown = filterRows(all, this.filterBox.value()), groups = groupRows(shown), safe = safeRows(all);
    const sentOf = cached(this.place, eco?.id ?? "")?.sent ?? {};
    const sent = (name) => Date.now() - (sentOf[name] ?? 0) < 3600000 && res?.at != null && (sentOf[name] ?? 0) > res.at;
    const quiet = (text, bad = false) => div().px(12).py(8).text_size(12).line_height("18px").text_color(bad ? k.destructiveText : k.muted).child(text);
    const c = counts(all);
    let n = 0, drawn = 0;
    return v_flex().id("ht3-deps").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(h_flex().px(20).pt(16).pb(12).gap(8).flex_none().items_center().border_b(1).border_color(k.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(18).font_semibold().child(res && all.length ? `Dependencies (${all.length} outdated)` : "Dependencies"))
          .child(div().truncate().text_size(12).text_color(k.muted).child(where ? `${eco ? `${eco.label} · ` : ""}${where}${res?.at ? ` · checked ${ago(Date.now() - res.at)}` : ""}` : "No folder here")))
        .child(run?.running() && run.canStop() ? button(k, "deps-stop", "Stop", () => run.stop(), { variant: "destructive", glyph: "stop" }) : iconButton(k, "deps-refresh", "refresh-cw", (cx) => this.start(cx), { tip: "Check again" }))
        .child(iconButton(k, "deps-close", "x", () => closeOverlay(this.overlay), { tip: "Close" })))
      .when((this.ecoList?.length ?? 0) > 1, (el) => el.child(h_flex().px(20).py(8).gap(6).flex_none().items_center().border_b(1).border_color(alpha(k.border, 0.6))
        .children(this.ecoList.map((e) => button(k, `deps-eco-${e.id}`, e.label, (cx) => { this.pickEco(e.id, cx); cx.notify(); }, { variant: e.id === this.ecoId ? "default" : "outline", size: "xs" })))))
      .when(!!eco && all.length > 0, (el) => el.child(h_flex().px(12).py(8).gap(6).flex_none().items_center().border_b(1).border_color(alpha(k.border, 0.6))
        .child(div().flex_1().min_w(0).h(28).px(8).rounded(8).border(1).border_color(k.input).text_size(13).child(Input.new(this.filterBox)))
        .child(button(k, "deps-all", `Update all patch+minor (${safe.length})`, (cx) => { this.confirm = true; cx.notify(); }, { variant: "outline", disabled: !safe.length || !!run?.running(), glyph: "arrow-up", tip: safe.length ? "Every patch and minor step, in one command in a side terminal; asks first" : "No patch or minor update" }))
        .child(button(k, "deps-ask", "Ask agent to update", (cx) => { this.ask(); cx.notify(); }, { variant: "outline", glyph: "message-square", tip: this.picked.size ? `Puts a prompt about the ${this.picked.size} ticked package${this.picked.size === 1 ? "" : "s"} into the chat's message box, not sent` : "Puts a prompt about the major updates (else all) into the chat's message box, not sent" }))))
      .when(this.confirm && !!eco, (el) => el.child(h_flex().px(12).py(8).gap(8).flex_none().items_center().border_b(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.warningText, 0.08))
        .child(div().flex_1().min_w(0).text_size(12).line_height("16px").child(`Update ${safe.length} package${safe.length === 1 ? "" : "s"} (${c.minor} minor, ${c.patch} patch) in a side terminal? Major ones are left alone.`))
        .child(button(k, "deps-no", "Cancel", (cx) => { this.confirm = false; cx.notify(); }, { variant: "outline" }))
        .child(button(k, "deps-yes", "Yes", (cx) => { this.updateAll(cx); cx.notify(); }, { variant: "default" }))))
      .when(!!run?.running(), (el) => el.child(h_flex().px(20).py(8).gap(8).flex_none().items_center().border_b(1).border_color(alpha(k.border, 0.6))
        .child(icon("loader-circle").size(14).flex_none().text_color(k.muted).spin(1000))
        .child(div().flex_none().text_size(12).font_medium().child(`Running… ${clock(run.elapsed())}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_family(k.mono).text_color(k.muted).child(res?.command ?? (eco ? shownCommand(eco) : "")))))
      .child(v_flex().id("ht3-deps-body").flex_1().min_h(0).py(6).overflow_y_scrollbar()
        .when(!this.place.cwd, (el) => el.child(quiet("The shown space has no folder, so there is nothing to look at.")))
        .when(!!this.place.cwd && this.ecoList == null, (el) => el.child(quiet("Looking at the folder…")))
        .when(this.ecoList != null && !!this.place.cwd && !eco, (el) => el.child(quiet("No dependencies found: this folder has no package.json with dependencies, pyproject.toml with uv.lock, requirements.txt, Cargo.toml or go.mod.")))
        .when(!!res?.missing, (el) => el.child(quiet(res.missing.hint, true)))
        .when(!!res?.error, (el) => el.child(quiet(res.error, true)))
        .when(!!eco && !!res && !res.error && !res.missing && !all.length, (el) => el.child(quiet("Everything is up to date.")))
        .when(!!eco && !res && !run, (el) => el.child(quiet("Not checked yet.")))
        .when(all.length > 0 && !shown.length, (el) => el.child(quiet("Nothing matches the filter.")))
        .children(groups.flatMap((g) => {
          const names = g.rows.map((r) => r.name), allOn = names.every((x) => this.picked.has(x));
          const head = h_flex().id(`dep-group-${g.kind}`).h(28).px(12).gap(8).flex_none().items_center().mt(n ? 6 : 0)
            .child(div().flex_none().text_size(12).font_semibold().text_color(k[TONE[g.kind]]).child(`${LABEL[g.kind]} (${g.count})`))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.muted).child(g.kind === "major" ? "may break: read the changelog" : g.kind === "minor" ? "new features, compatible" : "bug fixes"))
            .child(button(k, `dep-group-pick-${g.kind}`, allOn ? "Unselect" : "Select", (cx) => { for (const x of names) { if (allOn) this.picked.delete(x); else this.picked.add(x); } cx.notify(); }, { variant: "ghost-muted", size: "xs", tip: "Tick these for Ask agent" }));
          n++;
          const rows = [];
          for (const r of g.rows) { if (drawn++ >= SHOW_MAX) break; rows.push(this.depRow(k, r, drawn, sent(r.name))); }
          return [head, ...rows];
        }))
        .when(shown.length > SHOW_MAX, (el) => el.child(quiet(`The first ${SHOW_MAX} of ${shown.length} are listed: filter for the rest.`))))
      .child(div().px(20).py(10).flex_none().border_t(1).border_color(k.border).text_size(12).line_height("16px").text_color(this.said?.bad ? k.destructiveText : k.muted)
        .child(this.said?.text ?? (res?.notes?.length ? res.notes.join(" ") : "Update runs in a side terminal (Refresh when it is done). Tick packages to ask an agent about them.")));
  }
}
