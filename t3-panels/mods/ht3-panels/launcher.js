// The New chat dialog (T3's dialog sizes: 512 wide, 24 in, a 20px title, the buttons in a
// footer under a line). It offers the agents already running in this tab's terminals, whose
// conversation the chat shows, and the ACP agents installed where the space is, which the
// chat starts itself. Open chat opens the chat as a tab of its own. Under them, the earlier chats,
// to search and reopen; opened with props.find, the dialog is that list alone.
// "Several models" (fanout.js): one prompt to two to four of the agent's models, each in a background chat and a
// worktree of its own; `fanOut` below starts them, for the dialog and for `ht3-panels.fanout:<json>` alike.
// "From" (basebranch.js): the branch a new worktree starts from, for New worktree and for Several models, with "Fetch first".

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, run, closeOverlay, focused, spaces, panes, home, pickFolder, appHome, shared, setShared, readTextFile, notify } from "herdr";
import { agentName } from "./report.js";
import { MOD, tokens, alpha, icon, agentMark, button, iconButton, badge, shortPath } from "./look.js";
import { AGENTS, detect } from "./agent-acp.js";
import { enabledAgents, agentOn, firstAgent, knownModels, modelsOf } from "./settings.js";
import { KINDS } from "./core/chat-reader.js";
import { scriptsOf, setScripts, setupOf, setSetup, toggleSetup, setupTemplate } from "./scripts.js";
import { runSetup, setupCard, setupButtons, SetupDialog } from "./setup.js";
import { FANOUT_MIN, FANOUT_MAX, cleanModels, typedModels, toggleModel, fanoutProblem, fanoutSpecs, fanoutNotice } from "./fanout.js";
import { parseRefs, REF_ARGS } from "./branches.js";
import { validChatId } from "./chatlinks.js";
import { baseRefs, defaultBase, filterRefs, cleanFrom, onOrigin, fetchArgs, baseLabel } from "./basebranch.js";

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// "New worktree" (T3's worktree per thread): the repository a folder belongs to, its main checkout even when the
// folder is itself a worktree, and the worktree made for a chat, <repo>/.worktrees/<branch> on a new branch.
// `.worktrees/` must be ignored first: if it isn't, it goes into the repository's own info/exclude, never .gitignore.
// A start point ($3) is only where the branch begins: --no-track, so one started from origin/main doesn't push there.
const REPO = 'c=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 1; case "$c" in */.git) printf %s "${c%/.git}";; *) git rev-parse --show-toplevel | tr -d "\\n";; esac';
const ADD = 'r="$1"; b="$2"; cd "$r" || exit 1; git check-ref-format --branch "$b" >/dev/null 2>&1 || { echo "Not a branch name: $b" >&2; exit 2; }\n'
  + 'git check-ignore -q .worktrees/x || { f=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$f")" && printf "\\n.worktrees/\\n" >> "$f" || exit 3; }\n'
  + 'git worktree add "$r/.worktrees/$b" -b "$b" ${3:+--no-track "$3"}';
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
// (the Tasks surface starts its worktrees from the branch the person is on). `opts.fetch`: "Fetch first", for a start
// point on origin (`fetchBase`).
export async function addWorktree(repo, branch, on, opts = {}) {
  if (opts.from && opts.fetch) await fetchBase(repo, opts.from, on);
  const r = await exec("sh", ["-c", ADD, "sh", repo, branch, ...(opts.from ? [String(opts.from)] : [])], { cwd: repo, on: on ?? undefined, timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop().replace(/^fatal: /, "") || "git worktree add failed");
  const path = `${repo}/.worktrees/${branch}`;
  await setupWorktree(repo, path, on, opts);
  return path;
}
// "Fetch first": `git fetch origin <branch>` for a start point named origin/<branch>, so the worktree starts from what
// origin has now. Any other start point is left as it is. Rejects with git's last line when the fetch fails.
export async function fetchBase(repo, from, on) {
  const args = fetchArgs(from);
  if (!args) return;
  const r = await exec("git", args, { cwd: repo, on: on ?? undefined, timeout: 60000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (r.code !== 0) throw new Error(`git fetch origin ${args[2]} failed: ${(r.stderr || r.stdout).trim().split("\n").pop().replace(/^fatal: /, "") || "no reason given"}`);
}
// The same for a worktree made some other way (an existing branch, a pull request's): runs the setup script of the
// repository's project in `path`. Resolves to "none" (no setup script), "ok" or "skipped"; rejects when cancelled.
export async function setupWorktree(repo, path, on, opts = {}) {
  const script = opts.setup === false ? null : setupOf(`${on ?? ""}:${repo}`);
  if (!script) return "none";
  return runSetup({ cwd: path, root: repo, on: on ?? null, script, card: opts.card ?? null, sleep: opts.sleep ?? null, onChange: opts.onChange ?? null,
    ...(opts.timeout ? { timeout: opts.timeout } : {}), ...(opts.every ? { every: opts.every } : {}) });
}

// ---- one prompt to several models ----

const nap = (ms) => exec("sleep", [String(ms / 1000)], { timeout: ms + 5000 }).catch(() => null);
// What a fan-out that failed was asked for ({ prompt, branch, models, from, fetch, at }): the dialog comes up with it again.
const FAN_LAST = `${MOD}.fanout-last`;
// The models an agent's chats may be set to, as its picker lists them: what it has offered (settings.js knownModels),
// cut to the person's list when there is one (ids added there by hand too). Empty until the agent has listed them.
export function modelsFor(id) {
  const known = knownModels(id), only = modelsOf(id);
  if (!only) return known;
  return only.map((v) => known.find((m) => m.value === v) ?? { value: v, name: v });
}
let fanBusy = false;
// Starts one background chat per model (fanout.js fanoutSpecs), each in a new worktree on <branch>-<model> from the
// commit `o.folder` is on (or `o.from` is at, fetched first with `o.fetch` when it is on origin), with the same prompt as its first message and its model set before it. The chats are tabs
// of the shown space; the tab shown now is shown again after each one began (chat.js stepBack), so focus stays where
// it was. One model that can't start doesn't stop the others. A notice lists them at the end; with exactly two, its
// click opens Compare on them (compare.js reads their saved state, which is there by the time it is clicked).
// `o`: { folder, prompt, models, branch?, agent?, from?, fetch? } (fanout.js parseFanout). -> { started, failed }.
export async function fanOut(o) {
  const f = focused(), space = f?.space ?? null, here = f?.tab ?? null;
  const on = (space && spaces().find((s) => s.id === space)?.machine) || null;
  const started = [], failed = [];
  if (fanBusy) { notify({ title: "Several models", body: "The last ones are still being started.", level: "warning" }); return { started, failed }; }
  fanBusy = true;
  try {
    const why = fanoutProblem(o);
    if (why) throw new Error(why);
    const folder = !on && String(o.folder).startsWith("~") ? home() + String(o.folder).slice(1) : String(o.folder);
    const repo = await repoOf(folder, on);
    if (!repo) throw new Error(`${shortPath(folder)} isn't in a Git repository.`);
    const d = await detect(on), agent = AGENTS.find((a) => a.id === (o.agent ?? firstAgent(d.found)));
    if (!agent || !agentOn(agent.id) || !d.found[agent.argv[0]]) throw new Error(o.agent ? `The agent ${o.agent} isn't installed and turned on (Settings).` : d.error ?? "No chat agent is installed and turned on (Settings).");
    const git = async (args) => { const r = await exec("git", args, { cwd: folder, on: on ?? undefined, timeout: 10000 }).catch(() => null); return r?.code === 0 ? r.stdout.trim() : ""; };
    // One start point for all of them: the commit the folder is on now (or the picked branch is at, after its fetch),
    // not whatever it is when each is made.
    const base = cleanFrom(o.from);
    if (o.from != null && !base) throw new Error(`Not a branch or commit to start from: ${String(o.from).slice(0, 80)}`);
    if (base && o.fetch) await fetchBase(repo, base, on);
    const from = await git(["rev-parse", "--verify", "-q", `${base ?? "HEAD"}^{commit}`]);
    if (!from) throw new Error(base ? `${base} isn't a branch or commit in ${shortPath(folder)}.` : `${shortPath(folder)} has no commit to start from.`);
    const taken = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean);
    // A model given by its id alone is called what the agent calls it.
    const known = knownModels(agent.id);
    const models = cleanModels(o.models).map((m) => (m.name !== m.value ? m : { value: m.value, name: known.find((x) => x.value === m.value)?.name ?? m.value }));
    const specs = fanoutSpecs({ prompt: o.prompt, models, branch: o.branch ?? null, suffix: Date.now().toString(36).slice(-4), taken });
    for (const s of specs) {
      try {
        const cwd = await addWorktree(repo, s.branch, on, { from });
        const chat = newId(), before = new Set(spaces().flatMap((sp) => sp.tabs.map((t) => t.id)));
        // Its name, "<title> · <model>", as a renamed thread's (chat.js named), and its tab's.
        setShared(`${MOD}.named`, { ...(shared(`${MOD}.named`) ?? {}), [chat]: s.title.slice(0, 120) });
        run("tab.new", { mod: MOD, ...(space ? { space } : {}), name: s.title,
          props: { panel: "chat", chat, agent: [d.found[agent.argv[0]], ...agent.argv.slice(1)], cwd, machine: on, prompt: s.prompt, set: s.set,
            ...(here ? { back: { tab: here, at: Date.now() } } : {}) } });
        started.push({ chat, title: s.title, branch: s.branch, path: cwd, model: s.model });
        // A copy starts when its tab first shows: wait until this one took its place and stepped back, at most three
        // seconds, before the next tab is made. One that didn't step back by itself is put behind here.
        for (let i = 0; i < 60; i++) { await nap(50); if ((shared(`${MOD}.places`) ?? {})[chat] && (!here || focused()?.tab === here)) break; }
        const now = focused()?.tab;
        if (here && now && now !== here && !before.has(now)) run("tab.select", { id: here });
      } catch (e) { failed.push({ name: s.name, model: s.model, why: String(e?.message ?? e).slice(0, 200) }); }
    }
    const n = fanoutNotice(started, failed);
    notify({ title: n.title, body: n.body, level: n.level, timeout: n.compare ? 20000 : 8000, ...(n.compare ? { action: { name: `${MOD}.compare:${n.compare[0]}:${n.compare[1]}` } } : {}) });
    // The ones that didn't start stay picked, with the prompt, for the dialog's next time (T3 keeps them selected too).
    if (failed.length) setShared(FAN_LAST, { prompt: o.prompt, branch: o.branch ?? null, models: failed.map((x) => x.model), from: base, fetch: o.fetch === true, at: Date.now() });
  } catch (e) {
    notify({ title: "Several models: nothing started", body: String(e?.message ?? e).slice(0, 300), level: "error" });
    setShared(FAN_LAST, { prompt: String(o?.prompt ?? ""), branch: o?.branch ?? null, models: cleanModels(o?.models).map((m) => m.value), from: cleanFrom(o?.from), fetch: o?.fetch === true, at: Date.now() });
  } finally { fanBusy = false; }
  return { started, failed };
}

const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

// The chats saved under data/ht3-panels/chats (each a state.json), newest first, at most 60:
// { id, title, agent, argv, cwd, machine, at, text (what was said, to search) }. Chats that never got a message are left out.
export async function savedChats() {
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

// Goes to a chat by its id (a chat link's click, `ht3-panels.openchat:<id>`): a chat open in a tab is shown ("focused"),
// a closed one opens as a tab again as Earlier chats does it (reopen below; "opened"). null when nothing of that chat
// is saved here.
export async function openChat(id) {
  if (!validChatId(id)) return null;
  const at = (shared(`${MOD}.places`) ?? {})[id];
  if (at?.pane && spaces().some((s) => s.tabs.some((t) => t.id === at.tab))) { run("pane.focus", { pane: at.pane }); return "focused"; }
  let s = null;
  try { s = JSON.parse(await readTextFile(`${appHome()}/data/${MOD}/chats/${id}/state.json`)); } catch {}
  if (!s || !Array.isArray(s.agentArgv)) return null;
  const space = focused()?.space;
  run("tab.new", { mod: MOD, ...(space ? { space } : {}), name: agentName(s.agentArgv, s.agentInfo?.title ?? s.agentInfo?.name),
    props: { panel: "chat", chat: id, agent: s.agentArgv, cwd: s.cwd ?? null, machine: s.machine ?? null } });
  return "opened";
}
// The same, with a short notice when there is no such chat.
export async function openChatOrSay(id) {
  const how = await openChat(String(id ?? "").trim()).catch(() => null);
  if (!how) notify({ title: "Chat not found", body: String(id ?? "").trim().slice(0, 80), level: "info", timeout: 3000 });
  return how;
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
    // Several models: off. The ticked models (`picked`), the prompt they all get, and, for an agent that hasn't
    // listed its models yet, their names typed. What a fan-out that failed left (fanOut) comes back once.
    this.several = false;
    this.picked = [];
    this.prompt = TextareaState.new({ placeholder: "The prompt every model gets", rows: 3 });
    this.prompt.on("change", (_e, cx) => cx.notify());
    this.modelNames = InputState.new({ placeholder: "model names, comma separated, e.g. opus, sonnet" });
    this.modelNames.on("change", (_e, cx) => cx.notify());
    // From: the branch the new worktree (or each model's) starts from (basebranch.js). `refs`: the folder's branches, null
    // until read; `base`: the one picked, null for the default (the checked-out one); `fetchFirst`: fetch a picked origin/
    // branch before the worktree is made.
    this.refs = null;
    this.base = null;
    this.pickBase = false;
    this.fetchFirst = false;
    this.baseQuery = InputState.new({ placeholder: "Filter branches" });
    this.baseQuery.on("change", (_e, cx) => cx.notify());
    const left = shared(FAN_LAST);
    if (left && Date.now() - Number(left.at) < 600000) {
      this.several = true;
      this.picked = cleanModels(left.models).map((m) => m.value).slice(0, FANOUT_MAX);
      this.prompt.set_value(String(left.prompt ?? ""));
      this.modelNames.set_value(this.picked.join(", "));
      if (left.branch) this.branch.set_value(String(left.branch));
      this.base = cleanFrom(left.from);
      this.fetchFirst = left.fetch === true;
    }
    if (left) setShared(FAN_LAST, null);
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
      await this.readRefs();
      cx.notify();
    });
  }

  // Closed (Esc) while the setup script runs: the script is stopped; the worktree stays.
  async close(cx) { if (this.face) return this.face.close(cx); await this.setupRun?.cancel(); }
  // The folder's branches, for the From picker: local ones and origin's (branches.js REF_ARGS, basebranch.js baseRefs).
  async readRefs() {
    const cwd = this.cwd;
    const r = this.repo && cwd ? await exec("git", REF_ARGS, { cwd, on: this.machine ?? undefined, timeout: 10000 }).catch(() => null) : null;
    if (cwd === this.cwd) this.refs = r?.code === 0 ? baseRefs(parseRefs(r.stdout)) : [];
  }
  // The start point: the picked one, else the branch checked out in the folder; null where there is neither (HEAD).
  baseRef() { return this.base ?? defaultBase(this.refs); }
  // What addWorktree and fanOut get for it: { from, fetch } ("Fetch first" only counts for a branch on origin), or {}.
  baseOpts() {
    const from = this.baseRef();
    return from ? { from, ...(this.fetchFirst && onOrigin(from, this.refs) ? { fetch: true } : {}) } : {};
  }
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
  // several:on and several:off (Several models), several:model:<model id> (ticks or unticks it), several:models:<names>
  // (types them, comma separated, where the agent has listed none), several:prompt:<text>; open then starts them.
  // from:<ref> (the start point of the new worktree, or of each model's: a branch, origin/<branch> or a commit; from: alone
  // is the default again), from:pick (opens or closes the From picker), from:filter:<text> (types into its filter),
  // from:fetch:on and from:fetch:off (Fetch first).
  command(c, cx) {
    if (this.face) return this.face.command(c, cx);
    if (c.startsWith("from:")) {
      const a = c.slice(5);
      if (a === "pick") this.pickBase = !this.pickBase;
      else if (a.startsWith("filter:")) { this.pickBase = true; this.baseQuery.set_value(a.slice(7)); }
      else if (a === "fetch:on" || a === "fetch:off") this.fetchFirst = a === "fetch:on";
      else { this.base = cleanFrom(a); this.pickBase = false; }
      return cx.notify();
    }
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
    if (c.startsWith("several:")) {
      const a = c.slice(8);
      if (a === "on" || a === "off") this.several = a === "on" && !!this.repo;
      else if (a.startsWith("model:")) this.picked = toggleModel(this.picked, a.slice(6));
      else if (a.startsWith("models:")) this.modelNames.set_value(a.slice(7));
      else if (a.startsWith("prompt:")) this.prompt.set_value(a.slice(7));
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
    if (this.fanReady() !== null) return this.fan(cx);
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
        const cwd = await addWorktree(this.repo, branch, this.machine, { ...this.baseOpts(), card: (run) => { this.setupRun = run; cx.notify(); }, sleep, onChange: () => cx.notify() });
        if (this.setupRun?.state === "ok") await sleep(700); // the finished card, for a moment
        this.start(cwd);
      } catch (e) { this.error = e?.setup ? String(e.message) : `Couldn't make the worktree: ${String(e?.message ?? e)}`; }
      this.setupRun = null;
      this.busy = false;
      cx.notify();
    });
  }

  // ---- several models ----

  // The agent the models are of: the picked one, when it is an installed ACP agent and no command was typed. Else null.
  fanAgent() {
    const a = this.custom.value().trim() ? null : enabledAgents().find((x) => x.id === this.choice);
    return a && this.found?.[a.argv[0]] ? a : null;
  }
  // The models to send to: the ticked ones the agent lists, or, when it has listed none, the names typed.
  fanModels() {
    const a = this.fanAgent(), offered = a ? modelsFor(a.id) : [];
    return offered.length ? this.picked.filter((v) => offered.some((m) => m.value === v)) : typedModels(this.modelNames.value());
  }
  // null when Several models is off (or can't be on: no repository), else why it can't start yet, or "" when it can.
  fanReady() {
    if (!this.several || !this.repo) return null;
    if (!this.fanAgent()) return "Pick an installed agent above.";
    return fanoutProblem({ prompt: this.prompt.value(), models: this.fanModels(), branch: this.branch.value() }) ?? "";
  }
  // Start: the keeper makes the worktrees and the chats (main.js `fanout:<json>`, fanOut above) and says how it went in
  // a notice; the dialog closes at once, so the tab it was opened over is the one that stays shown.
  fan(cx) {
    const why = this.fanReady(), branch = this.branch.value().trim();
    if (why) { this.error = why; return cx.notify(); }
    run(`${MOD}.fanout:${JSON.stringify({ folder: this.cwd, prompt: this.prompt.value().trim(), models: this.fanModels(), agent: this.fanAgent().id, ...(branch ? { branch } : {}), ...this.baseOpts() })}`);
    closeOverlay(this.overlay);
  }
  // Under the Several models tick: the prompt, the branch the models' branches are named after, and the agent's models
  // to tick (a field for their names when it has listed none).
  fanRows(k, el) {
    const a = this.fanAgent(), offered = a ? modelsFor(a.id) : [], n = this.fanModels().length, branch = this.branch.value().trim();
    const tick = (m, i) => {
      const on = this.picked.includes(m.value), full = !on && this.picked.length >= FANOUT_MAX;
      return h_flex().id(`fan-model-${i}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).opacity(full ? 0.5 : 1)
        .role("check_box").accessibility_label(`${m.name}${on ? ": ticked" : ""}`)
        .when(!full, (e) => e.cursor_pointer().hover((st) => st.bg(alpha(k.accent, 0.6))).on_click((_e, cx) => { this.picked = toggleModel(this.picked, m.value); cx.notify(); }))
        .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border(1).border_color(on ? k.primary : k.input).bg(on ? k.primary : "#00000000")
          .text_color(k.primaryText).when(on, (e) => e.child(icon("check").size(12))))
        .child(div().flex_none().max_w(220).truncate().child(m.name))
        .when(m.name !== m.value, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).font_family(k.mono).text_color(k.muted).child(m.value)));
    };
    return el
      .child(div().mx(10).mb(6).min_h(60).px(8).py(4).rounded(8).border(1).border_color(k.input).text_size(13).line_height("20px").child(Textarea.new(this.prompt)))
      .child(h_flex().px(10).pb(6).gap(8).h(34).items_center()
        .child(icon("git-branch").size(14).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(13).child(Input.new(this.branch)))
        .child(div().flex_none().max_w(230).truncate().text_size(12).text_color(k.dim).child(`each model: .worktrees/${branch || "<prompt>"}-<model>`)))
      .when(!a, (e) => e.child(div().px(10).pb(6).text_size(12).text_color(k.muted).child("Pick an installed agent below: its models are listed here.")))
      .when(!!a && !offered.length, (e) => e
        .child(div().mx(10).mb(4).h(30).px(11).rounded(8).border(1).border_color(k.input).text_size(13).child(Input.new(this.modelNames)))
        .child(div().px(10).pb(6).text_size(12).text_color(k.muted).child(`${a.name} hasn't listed its models yet (it does in its first chat): type ${FANOUT_MIN} to ${FANOUT_MAX} of their names.`)))
      .when(!!a && offered.length > 0, (e) => e.child(v_flex().id("ht3-fan-models").mx(10).mb(6).p(4).gap(2).max_h(150).overflow_y_scrollbar().rounded(8).border(1).border_color(k.border)
        .children(offered.map(tick))))
      .when(!!a, (e) => e.child(div().px(10).pb(6).text_size(12).text_color(k.muted).child(`${n} of ${FANOUT_MIN} to ${FANOUT_MAX} models of ${a.name}. Each gets a background chat in a worktree of its own; this tab stays shown.`)));
  }

  // ---- from ----

  // Under New worktree and under Several models: "From <branch>" with Fetch first and Change, and under it the picker: a
  // filter and the folder's branches (basebranch.js baseRefs: the checked-out one first, each with its origin/ one).
  baseRows(k, el) {
    const from = this.baseRef(), remote = !!from && onOrigin(from, this.refs), fetch = remote && this.fetchFirst;
    const line = h_flex().px(10).pb(6).gap(8).h(30).items_center()
      .child(icon("git-commit-horizontal").size(14).flex_none().text_color(k.muted))
      .child(div().flex_none().max_w(240).truncate().text_size(12).child(baseLabel(from)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.muted)
        .child(this.base ? (fetch ? `after git fetch origin ${fetchArgs(from)[2]}` : remote ? "as last fetched" : "") : from ? "the branch checked out here" : "what is checked out here"))
      .child(h_flex().id("from-fetch").gap(6).flex_none().items_center().opacity(remote ? 1 : 0.5).role("check_box").accessibility_label(`Fetch first${fetch ? ": ticked" : ""}`)
        .tooltip("Runs git fetch origin <branch> before the worktree is made, so it starts from origin's latest commit. For a branch on origin.")
        .when(remote, (e) => e.cursor_pointer().on_click((_e, cx) => { this.fetchFirst = !this.fetchFirst; cx.notify(); }))
        .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border(1).border_color(fetch ? k.primary : k.input).bg(fetch ? k.primary : "#00000000")
          .text_color(k.primaryText).when(fetch, (e) => e.child(icon("check").size(12))))
        .child(div().text_size(12).text_color(fetch ? k.foreground : k.muted).child("Fetch first")))
      .child(button(k, "from-pick", this.pickBase ? "Done" : "Change…", (cx) => { this.pickBase = !this.pickBase; if (this.pickBase) this.baseQuery.focus(); cx.notify(); },
        { tip: "The branch the new worktree starts from" }));
    if (!this.pickBase) return el.child(line);
    const all = filterRefs(this.refs, this.baseQuery.value()), rows = all.slice(0, 80);
    return el.child(line).child(v_flex().id("ht3-from-pick").mx(10).mb(6).p(4).gap(2).rounded(8).border(1).border_color(k.border)
      .child(h_flex().h(28).px(8).gap(6).flex_none().items_center().text_size(13)
        .child(icon("search").size(14).flex_none().text_color(k.muted)).child(div().flex_1().child(Input.new(this.baseQuery))))
      .child(v_flex().id("ht3-from-list").gap(2).max_h(150).overflow_y_scrollbar()
        .children(rows.map((b, i) => h_flex().id(`from-ref-${i}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
          .role("button").accessibility_label(`Start from ${b.ref}`)
          .hover((st) => st.bg(alpha(k.accent, 0.6))).on_click((_e, cx) => { this.base = b.ref; this.pickBase = false; this.baseQuery.set_value(""); cx.notify(); })
          .child(icon(b.ref === from ? "check" : "git-branch").size(14).flex_none().text_color(k.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(b.local ? k.foreground : k.muted).child(b.ref))
          .when(b.current, (e) => e.child(badge(k, "current", "info")))
          .when(!b.local, (e) => e.child(div().flex_none().text_size(11).text_color(k.dim).child("on origin"))))))
      .when(this.refs == null, (e) => e.child(div().px(8).py(2).text_size(11).text_color(k.muted).child("Reading the branches…")))
      .when(this.refs != null && !rows.length, (e) => e.child(div().px(8).py(2).text_size(11).text_color(k.muted).child(this.refs.length ? "No branch matches." : "No branches here.")))
      .when(all.length > rows.length, (e) => e.child(div().px(8).py(2).text_size(11).text_color(k.muted).child(`Showing ${rows.length} of ${all.length} branches: type to narrow them.`))));
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
    // Several models is on (fanReady: "" when it can start, else why not yet).
    const fan = this.fanReady(), fanning = fan !== null;
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
            if (dir) { this.cwd = dir; this.repo = await repoOf(dir, null); if (!this.repo) this.wt = false; this.base = null; this.refs = null; await this.readRefs(); }
            cx.notify();
          })))))
        // Several models: one prompt, a background chat and a worktree per ticked model (fanRows). It takes New worktree's place.
        .when(!!this.repo, (el) => el.child(h_flex().px(10).pb(6).gap(8).h(34).items_center()
          .child(h_flex().id("fan-toggle").gap(8).flex_none().items_center().cursor_pointer().role("check_box").accessibility_label("Several models")
            .on_click((_e, cx) => { this.several = !this.several; if (this.several) this.prompt.focus(); cx.notify(); })
            .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border(1).border_color(this.several ? k.primary : k.input).bg(this.several ? k.primary : "#00000000")
              .text_color(k.primaryText).when(this.several, (e) => e.child(icon("check").size(12))))
            .child(div().text_size(13).text_color(this.several ? k.foreground : k.muted).child("Several models")))
          .when(!this.several, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.dim).child("one prompt to 2-4 models, each in a worktree of its own, to compare")))))
        .when(fanning, (el) => this.fanRows(k, el))
        // New worktree: the chat gets a folder and a branch of its own, <repo>/.worktrees/<branch>.
        .when(!!this.repo && !fanning, (el) => el.child(h_flex().px(10).pb(6).gap(8).h(34).items_center()
          .child(h_flex().id("wt-toggle").gap(8).flex_none().items_center().cursor_pointer().role("check_box").accessibility_label("New worktree")
            .on_click((_e, cx) => { this.wt = !this.wt; if (this.wt) this.branch.focus(); cx.notify(); })
            .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border(1).border_color(this.wt ? k.primary : k.input).bg(this.wt ? k.primary : "#00000000")
              .text_color(k.primaryText).when(this.wt, (e) => e.child(icon("check").size(12))))
            .child(div().text_size(13).text_color(this.wt ? k.foreground : k.muted).child("New worktree")))
          .when(this.wt, (e) => e.child(div().flex_1().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(13).child(Input.new(this.branch))))
          .when(!this.wt, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.dim).child("the chat gets a branch and a folder of its own: .worktrees/<branch>")))))
        .when(this.wt && !fanning && !!this.branch.value().trim(), (el) => el.child(div().px(10).pb(6).text_size(12).text_color(k.muted).truncate()
          .child(`git worktree add .worktrees/${this.branch.value().trim()} -b ${this.branch.value().trim()}${this.baseRef() ? ` ${this.baseRef()}` : ""}   in ${shortPath(this.repo)}`)))
        .when(this.wt || fanning, (el) => this.baseRows(k, el))
        .when(this.wt || fanning, (el) => this.setupRows(k, el))
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
        .child(fanning
          ? button(k, "open", `Start ${this.fanModels().length || ""} chats`.replace("  ", " "), (cx) => this.open(cx), { variant: "default", size: "default", disabled: fan !== "", tip: fan || "One background chat per model" })
          : button(k, "open", this.busy ? "Making the worktree…" : "Open chat", (cx) => this.open(cx), { variant: "default", size: "default", disabled: !ready || this.busy || (this.wt && !this.branch.value().trim()) })));
  }
}
