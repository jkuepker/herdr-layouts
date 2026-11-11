// The New chat dialog (T3's dialog sizes: 512 wide, 24 in, a 20px title, the buttons in a
// footer under a line). It offers the agents already running in this tab's terminals, whose
// conversation the chat shows, and the ACP agents installed where the space is, which the
// chat starts itself. Open chat opens the chat as a tab of its own. Under them, the earlier chats,
// to search and reopen; opened with props.find, the dialog is that list alone.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, closeOverlay, focused, spaces, panes, home, pickFolder, appHome, shared, setShared, readTextFile } from "herdr";
import { agentName } from "./report.js";
import { MOD, tokens, alpha, icon, agentMark, button, iconButton, badge, shortPath } from "./look.js";
import { AGENTS, detect } from "./agent-acp.js";
import { enabledAgents, agentOn, firstAgent } from "./settings.js";
import { KINDS } from "./core/chat-reader.js";
import { scriptsOf, setScripts, setupOf, setSetup, toggleSetup, setupTemplate } from "./scripts.js";
import { runSetup, setupCard, setupButtons, SetupDialog } from "./setup.js";

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// "New worktree" (T3's worktree per thread): the repository a folder belongs to, its main checkout even when the
// folder is itself a worktree, and the worktree made for a chat, <repo>/.worktrees/<branch> on a new branch.
// `.worktrees/` must be ignored first: if it isn't, it goes into the repository's own info/exclude, never .gitignore.
const REPO = 'c=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 1; case "$c" in */.git) printf %s "${c%/.git}";; *) git rev-parse --show-toplevel | tr -d "\\n";; esac';
const ADD = 'r="$1"; b="$2"; cd "$r" || exit 1; git check-ref-format --branch "$b" >/dev/null 2>&1 || { echo "Not a branch name: $b" >&2; exit 2; }\n'
  + 'git check-ignore -q .worktrees/x || { f=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$f")" && printf "\\n.worktrees/\\n" >> "$f" || exit 3; }\n'
  + 'git worktree add "$r/.worktrees/$b" -b "$b" ${3:+"$3"}';
export async function repoOf(cwd, on) {
  if (!cwd) return null;
  const r = await exec("sh", ["-c", REPO], { cwd, on: on ?? undefined, timeout: 10000 }).catch(() => null);
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
// Resolves to the new worktree's folder; rejects with git's last line.
// Every New-worktree launch comes through here, so the project's setup script (scripts.js `setupOf`, setup.js) runs
// here too: after the worktree is made and before this resolves, which is before the caller starts its chat. It
// resolves once the setup succeeded or was skipped, and rejects when it was cancelled (the error has `setup` and
// `worktree`, the folder that was made and is kept). `opts.card(run)`: the caller draws the progress card itself
// (with `sleep` and `onChange` from its `cx`); without it the card opens as a dialog of its own. `opts.setup: false`
// makes the worktree alone. `opts.from`: the branch (or commit) the new one starts from; without it, the main checkout's HEAD
// (the Tasks surface starts its worktrees from the branch the person is on).
export async function addWorktree(repo, branch, on, opts = {}) {
  const r = await exec("sh", ["-c", ADD, "sh", repo, branch, ...(opts.from ? [String(opts.from)] : [])], { cwd: repo, on: on ?? undefined, timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop().replace(/^fatal: /, "") || "git worktree add failed");
  const path = `${repo}/.worktrees/${branch}`;
  await setupWorktree(repo, path, on, opts);
  return path;
}
// The same for a worktree made some other way (an existing branch, a pull request's): runs the setup script of the
// repository's project in `path`. Resolves to "none" (no setup script), "ok" or "skipped"; rejects when cancelled.
export async function setupWorktree(repo, path, on, opts = {}) {
  const script = opts.setup === false ? null : setupOf(`${on ?? ""}:${repo}`);
  if (!script) return "none";
  return runSetup({ cwd: path, root: repo, on: on ?? null, script, card: opts.card ?? null, sleep: opts.sleep ?? null, onChange: opts.onChange ?? null,
    ...(opts.timeout ? { timeout: opts.timeout } : {}), ...(opts.every ? { every: opts.every } : {}) });
}

const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

// The chats saved under data/ht3-panels/chats (each a state.json), newest first, at most 60:
// { id, title, agent, argv, cwd, machine, at, text (what was said, to search) }. Chats that never got a message are left out.
async function savedChats() {
  const dir = `${appHome()}/data/${MOD}/chats`, named = shared(`${MOD}.named`) ?? {};
  // (A mod's fs has no readdir or stat: the shell lists them.)
  const r = await exec("/bin/sh", ["-c", "cd \"$1\" 2>/dev/null && stat -f '%m %N' */state.json 2>/dev/null", "sh", dir]).catch(() => null);
  const stats = String(r?.stdout ?? "").split("\n").filter(Boolean).map((l) => ({ at: Number(l.slice(0, l.indexOf(" "))) * 1000, id: l.slice(l.indexOf(" ") + 1).split("/")[0] }))
    .filter((x) => x.at && x.id).sort((a, b) => b.at - a.at).slice(0, 60);
  const out = [];
  for (const { id, at } of stats) {
    try {
      const s = JSON.parse(await readTextFile(`${dir}/${id}/state.json`));
      const items = s.transcript?.items ?? [], first = items.find((m) => m.kind === "user")?.text?.trim().split("\n")[0];
      if (!first || !Array.isArray(s.agentArgv)) continue;
      out.push({ id, at, title: named[id] || (first.length > 80 ? first.slice(0, 80) + "…" : first), agent: agentName(s.agentArgv, s.agentInfo?.title ?? s.agentInfo?.name),
        argv: s.agentArgv, cwd: s.cwd ?? null, machine: s.machine ?? null,
        text: items.filter((m) => m.kind === "user" || m.kind === "agent").map((m) => m.text ?? "").join("\n").slice(0, 200000) });
    } catch {}
  }
  return out;
}

export class Launcher {
  init(p, cx) {
    this.overlay = p.overlay;
    // Opened by setup.js for a caller with no card of its own: the setup card alone.
    if (p.setup) { this.face = new SetupDialog(); return this.face.init(p, cx); }
    // Opened to find an earlier chat (`ht3-panels.earlier`): that list alone.
    this.find = p.find === true;
    const f = focused();
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
    // New worktree: off, and offered only where the folder is in a Git repository.
    this.repo = null;
    this.wt = false;
    this.busy = false;
    this.branch = InputState.new({ placeholder: "new branch, e.g. fix-login" });
    this.branch.on("change", (_e, cx) => cx.notify());
    // The setup script New worktree runs first: its picker (the project's scripts, and a new one from a template),
    // and the run whose card is shown while it runs or after it failed.
    this.pickSetup = false;
    this.template = null; // true while the new script's command is being typed
    this.setupCommand = InputState.new({ placeholder: "command, e.g. npm ci" });
    this.setupCommand.on("change", (_e, cx) => cx.notify());
    this.setupRun = null;
    // Earlier chats (T3's thread search and its archived threads): the chats saved on this computer,
    // newest first, with a field that looks through their names and what was said in them.
    this.recent = null;
    this.armed = null; // the chat whose bin was pressed once
    this.query = InputState.new({ placeholder: "Search chats" });
    this.query.on("change", (_e, cx) => cx.notify());
    if (this.find) { this.query.focus(); cx.timer.after(300, () => this.query.focus()); }
    cx.spawn(async (cx) => { this.recent = await savedChats().catch(() => []); cx.notify(); });
    cx.spawn(async (cx) => {
      const d = await detect(this.machine);
      this.found = d.found;
      this.error = d.error;
      if (this.machine && !this.cwd) this.cwd = d.found.HOME ?? null;
      this.choice ??= firstAgent(d.found);
      cx.notify();
      this.repo = await repoOf(this.cwd, this.machine);
      cx.notify();
    });
  }

  // Closed (Esc) while the setup script runs: the script is stopped; the worktree stays.
  async close(cx) { if (this.face) return this.face.close(cx); await this.setupRun?.cancel(); }
  // The project the scripts are kept for: the repository's main checkout on the space's machine (scripts.js `projectOf`).
  projectKey() { return this.repo ? `${this.machine ?? ""}:${this.repo}` : null; }
  // New from template: the field gets a command to start from (scripts.js `setupTemplate`); Save adds it as the
  // script "setup" (replacing one of that name) and marks it.
  newSetup(cx) {
    this.pickSetup = true;
    this.template = true;
    this.setupCommand.focus();
    cx.spawn(async (cx) => { const t = await setupTemplate(this.repo, this.machine); if (this.template && !this.setupCommand.value().trim()) this.setupCommand.set_value(t); cx.notify(); });
  }
  saveSetup() {
    const key = this.projectKey(), command = this.setupCommand.value().trim();
    if (!key || !command) return;
    setScripts(key, [...scriptsOf(key).filter((s) => s.name !== "setup"), { name: "setup", command }]);
    setSetup(key, "setup");
    this.template = null;
    this.pickSetup = false;
    this.setupCommand.set_value("");
  }
  // For scripts: worktree:<branch> (New worktree on, with that branch; worktree: turns it off), custom:<command> (types it into
  // the command field), open (the Open chat button),
  // recent:<text> (types into Search chats), reopen:<n> and forget:<n> (the nth row shown, from 0; forget twice deletes).
  // setup:pick (opens or closes the setup picker), setup:<script name> (marks it; setup: alone unmarks), setup:template (a new
  // one, from the template), setup:command:<text> (types its command), setup:save; while the card shows, setup:retry,
  // setup:skip, setup:cancel.
  command(c, cx) {
    if (this.face) return this.face.command(c, cx);
    if (c.startsWith("setup:")) {
      const a = c.slice(6), run = this.setupRun;
      if (run && (a === "retry" || a === "skip" || a === "cancel")) run[a]();
      else if (a === "pick") this.pickSetup = !this.pickSetup;
      else if (a === "template") this.newSetup(cx);
      else if (a.startsWith("command:")) { this.pickSetup = this.template = true; this.setupCommand.set_value(a.slice(8)); }
      else if (a === "save") this.saveSetup();
      else setSetup(this.projectKey(), a || null);
      return cx.notify();
    }
    if (c.startsWith("worktree:")) { this.wt = !!c.slice(9) && !!this.repo; this.branch.set_value(c.slice(9)); }
    if (c.startsWith("custom:")) this.custom.set_value(c.slice(7));
    if (c === "open") this.open(cx);
    if (c.startsWith("recent:")) this.query.set_value(c.slice(7));
    if (c.startsWith("reopen:")) this.reopen(this.shown()[Number(c.slice(7))]);
    if (c.startsWith("forget:")) this.forget(cx, this.shown()[Number(c.slice(7))]);
    cx.notify();
  }

  // The saved chats that match the search, each with the line that matched when it isn't its name.
  shown() {
    const q = this.query.value().trim().toLowerCase(), open = shared(`${MOD}.places`) ?? {};
    const out = [];
    for (const c of this.recent ?? []) {
      const at = q ? c.text.toLowerCase().indexOf(q) : -1;
      if (q && !c.title.toLowerCase().includes(q) && at < 0) continue;
      const from = Math.max(0, at - 30);
      out.push({ ...c, open: open[c.id] ?? null, match: at >= 0 && !c.title.toLowerCase().includes(q) ? (from ? "…" : "") + c.text.slice(from, at + q.length + 50).replace(/\s+/g, " ") : null });
    }
    return out.slice(0, 30);
  }

  // A chat still open is shown; a closed one opens as a tab again, on its agent and folder, with what was said.
  reopen(c) {
    if (!c) return;
    if (c.open) run("pane.focus", { pane: c.open.pane });
    else {
      const space = focused()?.space;
      run("tab.new", { mod: MOD, ...(space ? { space } : {}), name: c.agent, props: { panel: "chat", chat: c.id, agent: c.argv, cwd: c.cwd, machine: c.machine } });
    }
    closeOverlay(this.overlay);
  }

  // The bin: once to ask, again to delete the chat's folder for good. Not a chat that is open.
  forget(cx, c) {
    if (!c || c.open) return;
    if (this.armed !== c.id) { this.armed = c.id; return cx.notify(); }
    this.armed = null;
    this.recent = this.recent.filter((x) => x.id !== c.id);
    const named = { ...(shared(`${MOD}.named`) ?? {}) };
    if (named[c.id]) { delete named[c.id]; setShared(`${MOD}.named`, named); }
    const kept = { ...(shared(`${MOD}.kept`) ?? {}) };
    if (kept[c.id]) { delete kept[c.id]; setShared(`${MOD}.kept`, kept); }
    if (/^[\w-]+$/.test(c.id)) exec("rm", ["-rf", `${appHome()}/data/${MOD}/chats/${c.id}`]).catch(() => {});
    cx.notify();
  }

  // With New worktree on, the worktree is made first and the chat starts in it; if git says no, the dialog stays and says why.
  open(cx) {
    const term = this.running.find((x) => x.id === this.choice && !this.custom.value().trim());
    if (!this.wt || !this.repo || term) return this.start(this.cwd);
    const branch = this.branch.value().trim();
    if (!branch || this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const sleep = (ms) => new Promise((r) => cx.timer.after(ms, () => r()));
      try {
        // The setup script, if the project has one, runs inside addWorktree: its card takes the dialog's place until
        // it succeeded or was skipped.
        const cwd = await addWorktree(this.repo, branch, this.machine, { card: (run) => { this.setupRun = run; cx.notify(); }, sleep, onChange: () => cx.notify() });
        if (this.setupRun?.state === "ok") await sleep(700); // the finished card, for a moment
        this.start(cwd);
      } catch (e) { this.error = e?.setup ? String(e.message) : `Couldn't make the worktree: ${String(e?.message ?? e)}`; }
      this.setupRun = null;
      this.busy = false;
      cx.notify();
    });
  }

  start(cwd) {
    // A chat is a tab of its own, the whole work area, not a split beside the terminal.
    const space = focused()?.space;
    const base = { mod: MOD, ...(space ? { space } : {}) };
    const typed = this.custom.value().trim();
    const term = this.running.find((x) => x.id === this.choice);
    const agent = AGENTS.find((a) => a.id === this.choice);
    if (typed) run("tab.new", { ...base, name: typed.split(/\s+/)[0], props: { panel: "chat", chat: newId(), agent: typed.split(/\s+/), cwd, machine: this.machine } });
    else if (term) run("tab.new", { ...base, name: term.name ?? "Chat", props: { panel: "chat", terminal: term.terminal } });
    else if (agent && agentOn(agent.id) && this.found?.[agent.argv[0]]) run("tab.new", { ...base, name: agent.name ?? agent.id, props: { panel: "chat", chat: newId(), agent: [this.found[agent.argv[0]], ...agent.argv.slice(1)], cwd, machine: this.machine } });
    else return;
    closeOverlay(this.overlay);
  }

  // Under New worktree: the project's setup script (or that it has none) with Change, and under it the picker: the
  // project's scripts, the marked one with a "setup" badge (a click marks or unmarks), and a new one from a template.
  setupRows(k, el) {
    const key = this.projectKey(), list = scriptsOf(key), setup = list.find((s) => s.setup) ?? null;
    const line = h_flex().px(10).pb(6).gap(8).h(30).items_center()
      .child(icon("wrench").size(14).flex_none().text_color(k.muted))
      .child(div().flex_none().text_size(12).text_color(setup ? k.foreground : k.muted).child(setup ? `Runs ${setup.name} first` : "No setup script"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).font_family(k.mono).text_color(k.muted).child(setup ? setup.command : ""))
      .child(button(k, "setup-pick", this.pickSetup ? "Done" : setup ? "Change…" : "Set…", (cx) => { this.pickSetup = !this.pickSetup; this.template = null; cx.notify(); },
        { tip: "The script that runs in a new worktree before its chat starts" }));
    if (!this.pickSetup) return el.child(line);
    const rows = list.map((s, i) => h_flex().id(`setup-script-${i}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
      .role("button").accessibility_label(s.setup ? `${s.name}: the setup script. Click to unmark` : `Run ${s.name} as the setup script`)
      .hover((st) => st.bg(alpha(k.accent, 0.6))).on_click((_e, cx) => { toggleSetup(key, s.name); cx.notify(); })
      .child(icon(s.setup ? "check" : "square-terminal").size(14).flex_none().text_color(k.muted))
      .child(div().flex_none().max_w(150).truncate().child(s.name))
      .when(!!s.setup, (e) => e.child(badge(k, "setup", "info")))
      .child(div().flex_1().min_w(0).truncate().text_size(11).font_family(k.mono).text_color(k.muted).child(s.command)));
    return el.child(line).child(v_flex().id("ht3-setup-pick").mx(10).mb(6).p(4).gap(2).rounded(8).border(1).border_color(k.border)
      .children(rows)
      .when(!this.template, (e) => e.child(h_flex().id("setup-new").h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer().role("button").accessibility_label("New setup script from a template")
        .hover((st) => st.bg(alpha(k.accent, 0.6))).on_click((_e, cx) => this.newSetup(cx))
        .child(icon("plus").size(14).flex_none().text_color(k.muted))
        .child(div().flex_none().child("New from a template…"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.muted).child("copy .env files, install from the lockfile"))))
      .when(!!this.template, (e) => e
        .child(h_flex().px(4).py(2).gap(6).items_center()
          .child(div().flex_1().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(12).font_family(k.mono).child(Input.new(this.setupCommand)))
          .child(button(k, "setup-template-cancel", "Cancel", (cx) => { this.template = null; this.setupCommand.set_value(""); cx.notify(); }))
          .child(button(k, "setup-save", "Save", (cx) => { this.saveSetup(); cx.notify(); }, { variant: "default", disabled: !this.setupCommand.value().trim() })))
        .child(div().px(8).pb(2).text_size(11).text_color(k.muted).child("Saved as the project script \"setup\". It runs with sh in the new worktree; $HT3_PROJECT_ROOT is the main checkout.")))
      .when(!list.length && !this.template, (e) => e.child(div().px(8).py(2).text_size(11).text_color(k.muted).child("The project has no scripts yet. Settings → Project scripts adds more."))));
  }

  render(cx) {
    if (this.face) return this.face.render(cx);
    const k = tokens();
    // A setup script runs (or failed and waits): its card, and its buttons in the footer.
    if (this.setupRun) return v_flex().id("ht3-launcher").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(v_flex().px(24).pt(24).pb(8).gap(8).flex_none()
        .child(div().text_size(20).font_semibold().child("New chat"))
        .child(div().text_size(14).text_color(k.muted).child(`The worktree is made. The chat starts once ${this.setupRun.script.name} has run.`)))
      .child(v_flex().id("ht3-launcher-list").flex_1().min_h(0).px(24).py(8).overflow_y_scrollbar().child(setupCard(k, this.setupRun)))
      .child(h_flex().px(24).py(16).gap(8).flex_none().justify_end().border_t(1).border_color(k.border).children(setupButtons(k, this.setupRun)));
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
    const earlier = (el) => {
          const rows = this.shown();
          return (this.find ? el : el.child(label("Earlier chats")))
            .child(h_flex().mx(10).mb(4).h(30).px(8).gap(6).items_center().rounded(8).border(1).border_color(k.input).text_size(14)
              .child(icon("search").size(14).flex_none().text_color(k.muted)).child(div().flex_1().child(Input.new(this.query))))
            .when(!rows.length, (e) => e.child(div().px(10).py(6).text_size(12).text_color(k.muted).child("No chats match.")))
            .children(rows.map((c) => h_flex().id(`chat-${c.id}`).min_h(40).px(10).py(4).gap(10).flex_none().items_center().rounded(8).cursor_pointer().role("button").accessibility_label(c.title)
              .hover((s) => s.bg(alpha(k.accent, 0.6))).on_click(() => this.reopen(c))
              .child(icon(c.open ? "message-square" : "clock").size(16).flex_none().text_color(k.muted))
              .child(v_flex().flex_1().min_w(0)
                .child(div().truncate().text_size(14).child(c.title))
                .child(div().truncate().text_size(12).text_color(k.muted).child(c.match ?? `${c.agent} · ${shortPath(c.cwd) ?? ""} · ${ago(c.at)}${c.open ? " · open" : ""}`)))
              .when(!c.open, (e) => e.child(this.armed === c.id
                ? button(k, `forget-${c.id}`, "Delete?", (cx) => this.forget(cx, c), { variant: "outline" })
                : iconButton(k, `forget-${c.id}`, "trash-2", (cx) => this.forget(cx, c), { tip: "Delete this chat" })))));
        };
    if (this.find) return v_flex().id("ht3-launcher").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(v_flex().px(24).pt(24).pb(12).gap(8).flex_none()
        .child(div().text_size(20).font_semibold().child("Earlier chats"))
        .child(div().text_size(14).text_color(k.muted).child("Chats saved on this computer. A click shows one that is open, or opens it again as a tab.")))
      .child(v_flex().id("ht3-launcher-list").flex_1().min_h(0).px(14).pb(14).overflow_y_scrollbar()
        .when(this.recent == null, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.muted).child("Looking…")))
        .when(this.recent != null && !this.recent.length, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.muted).child("No chats yet.")))
        .when((this.recent?.length ?? 0) > 0, earlier));
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
            if (dir) { this.cwd = dir; this.repo = await repoOf(dir, null); if (!this.repo) this.wt = false; }
            cx.notify();
          })))))
        // New worktree: the chat gets a folder and a branch of its own, <repo>/.worktrees/<branch>.
        .when(!!this.repo, (el) => el.child(h_flex().px(10).pb(6).gap(8).h(34).items_center()
          .child(h_flex().id("wt-toggle").gap(8).flex_none().items_center().cursor_pointer().role("check_box").accessibility_label("New worktree")
            .on_click((_e, cx) => { this.wt = !this.wt; if (this.wt) this.branch.focus(); cx.notify(); })
            .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border(1).border_color(this.wt ? k.primary : k.input).bg(this.wt ? k.primary : "#00000000")
              .text_color(k.primaryText).when(this.wt, (e) => e.child(icon("check").size(12))))
            .child(div().text_size(13).text_color(this.wt ? k.foreground : k.muted).child("New worktree")))
          .when(this.wt, (e) => e.child(div().flex_1().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(13).child(Input.new(this.branch))))
          .when(!this.wt, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.dim).child("the chat gets a branch and a folder of its own: .worktrees/<branch>")))))
        .when(this.wt && !!this.branch.value().trim(), (el) => el.child(div().px(10).pb(6).text_size(12).text_color(k.muted).truncate()
          .child(`git worktree add .worktrees/${this.branch.value().trim()} -b ${this.branch.value().trim()}   in ${shortPath(this.repo)}`)))
        .when(this.wt, (el) => this.setupRows(k, el))
        .when(!this.found, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.muted).child("Looking for installed agents…")))
        .when(!!this.error, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.destructiveText).child(this.error)))
        .when(!!this.found && !enabledAgents().length, (el) => el.child(div().px(10).py(6).text_size(12).text_color(k.muted).child("No agent is enabled in Settings.")))
        .when(!!this.found, (el) => el.children(enabledAgents().map((a) => {
          const path = this.found[a.argv[0]];
          return row(a.id, "bot", a.name, path ? a.argv.join(" ") : `not installed${a.hint ? ` · ${a.hint}` : ""}`, { enabled: !!path, agent: a });
        })))
        .child(div().mx(10).mt(8).h(30).px(11).rounded(8).border(1).border_color(k.input).text_size(14).child(Input.new(this.custom)))
        .when((this.recent?.length ?? 0) > 0, earlier))
      .child(h_flex().px(24).py(16).gap(8).flex_none().justify_end().border_t(1).border_color(k.border)
        .child(button(k, "cancel", "Cancel", () => closeOverlay(this.overlay), { variant: "outline", size: "default" }))
        .child(button(k, "open", this.busy ? "Making the worktree…" : "Open chat", (cx) => this.open(cx), { variant: "default", size: "default", disabled: !ready || this.busy || (this.wt && !this.branch.value().trim()) })));
  }
}
