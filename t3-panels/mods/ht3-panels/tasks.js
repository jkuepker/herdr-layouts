// Tasks (a surface of the side panel, `ht3-panels.tasks`; not in T3 Code): a backlog kept per project, whose tasks can be
// handed to an agent, and a notes box per folder.
//
// - Tasks: a title and an optional note each. Add with the input at the top (the chevron beside it opens the note box);
//   Edit, Delete (asks once more) and the up and down buttons per row; the check box marks one done, and done tasks
//   fold into "Done (N)". Kept per project in shared "ht3-panels.tasks": { "<machine or empty>:<project folder>": [task] },
//   the way scripts.js keeps scripts (a worktree's chat shares its repository's project, so its tasks show there too).
//   The task's shape and the pure logic (order, branch names, chat state) are in tasklist.js.
// - Run with agent: makes a worktree on a new branch from the branch the person is on (launcher.js `addWorktree`, so the
//   project's setup script runs there too) and starts a chat in it, on the tasks' agent (settings.js `taskAgent`, set to
//   `taskModel` first; neither set: the agent New chat comes up with), the task's title and note as its first message,
//   sent (the chat's `prompt` prop). `startTask` does it, for this surface and for the coordinator (coordinator.js),
//   which names the project by its key alone: the chat's tab then goes to the space that works in that repository.
//   The row then says "on <branch>" with the chat's state, read where the Inbox reads it (report.js: shared
//   "ht3-panels.places", ".status", ".turns"): working, waiting for you (the agent asks), done or failed; a click on the
//   row shows that chat. Marking a task done is the person's: a finished chat doesn't do it.
// - Merge: the agent is told to commit on its branch (tasklist.js PROMPT_RULES), and the person takes the work in with
//   one click. A run task's row says what its worktree holds ("2 commits, 3 uncommitted files": shared
//   "ht3-panels.work", which the keeper reads, coordinator.js) and, once the coordinator marked it, "Ready to merge".
//   Merge asks once in a row at the foot ("Merge task-x into main: 2 commits, commits 3 changed files first?" Yes / No),
//   then (tasklist.js mergeTask) commits what is uncommitted in the worktree and runs `git merge --no-ff <branch>
//   -m "Merge task: <title>"` in the folder that is on the branch the task was made from. Refused with the reason when
//   that branch is checked out nowhere, that folder has uncommitted files, or the agent still works; a conflict is
//   aborted. A merged task is marked done, keeps `run.merged = { at, commit }` and offers Remove worktree
//   (`git worktree remove`, `git branch -d`; kept while it has uncommitted files). How each went is said at the foot.
// - Notes: plain text per folder (a worktree is a folder of its own), saved a moment after the last change to
//   `data/ht3-panels/notes/<name from the folder>.txt` in the app's folder, never in the repository.
// For scripts: with the surface shown, `tasks-add:<title>`, `tasks-run:<n>` (the nth task, from 0, in the list's order),
// `tasks-done:<n>` (toggles), `tasks-delete:<n>` (twice deletes), `tasks-up:<n>`, `tasks-down:<n>`, `tasks-tab:<tasks|notes>`,
// `tasks-notes:<text>` (replaces the notes), `tasks-merge:<task id>` (asks), `tasks-yes` / `tasks-no` (answer it),
// `tasks-cleanup:<task id>` (Remove worktree).

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, run, shared, setShared, focused, spaces, panes, appHome, readTextFile, writeTextFile } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, badge, shortPath } from "./look.js";
import { activeSpace, placeOf, showing } from "./side.js";
import { projectOf } from "./scripts.js";
import { addWorktree, repoOf } from "./launcher.js";
import { AGENTS, detect } from "./agent-acp.js";
import { roleAgent, roleSet } from "./settings.js";
import { cleanTasks, newTask, patch, remove, move, canMove, promptOf, branchFor, chatState, STATE_LABEL, notesFile, TITLE_MAX, parseKey, spaceIn,
  readWork, workWords, hasWork, BUSY_STATES, mergePlan, mergeTask, mergeWords, cleanupTask } from "./tasklist.js";

const KEY = `${MOD}.tasks`;
const NOTES_SAVE_MS = 800; // after the last change
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const tasksOf = (key) => (key ? cleanTasks((shared(KEY) ?? {})[key]) : []);
function setTasks(key, list) {
  if (!key) return;
  const all = { ...(shared(KEY) ?? {}) };
  if (list.length) all[key] = list; else delete all[key];
  setShared(KEY, all);
}
// Changes the project's list as it is now (never from a copy held across an await).
export const update = (key, fn) => setTasks(key, fn(tasksOf(key)));
// Every project's key that has tasks.
export const taskKeys = () => Object.keys(shared(KEY) ?? {});

// What the run tasks' worktrees hold, as last read (tasklist.js readWork): shared "ht3-panels.work",
// { "<project key>\n<task id>": { ahead, dirty, branch } | { missing: true } }. The keeper reads them (coordinator.js),
// an open task's at most every WORK_EVERY_MS; this surface reads one again after it changed it.
const WORK = `${MOD}.work`;
export const WORK_EVERY_MS = 15000;
export const workAll = () => shared(WORK) ?? {};
export function setWork(mark, w) {
  const all = workAll();
  if (w == null ? !(mark in all) : JSON.stringify(all[mark]) === JSON.stringify(w)) return;
  const next = { ...all };
  if (w == null) delete next[mark]; else next[mark] = w;
  setShared(WORK, next);
}

// The notes' folder and file; the folder is made with `mkdir -p` (a mod's fs has no mkdir).
const notesDir = () => `${appHome()}/data/${MOD}/notes`;
// Writes `text` to the file, `expected` being what was last read or written (writeTextFile refuses a stale snapshot, and then
// the file is read again and replaced: this surface is its only writer). -> what the file holds now.
async function writeNotes(path, text, expected) {
  await exec("mkdir", ["-p", notesDir()]).catch(() => null);
  try { await writeTextFile(path, text, expected); } catch {
    const now = await readTextFile(path).catch(() => null);
    await writeTextFile(path, text, now ?? null);
  }
  return text;
}

// The branch the folder is on (a detached HEAD: its commit), to start the task's branch from.
async function currentRef(cwd, on) {
  const r = await exec("sh", ["-c", 'b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); if [ "$b" = HEAD ] || [ -z "$b" ]; then git rev-parse HEAD 2>/dev/null; else printf %s "$b"; fi'], { cwd, on: on ?? undefined, timeout: 10000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

const nap = (ms) => exec("sleep", [String(ms / 1000)], { timeout: ms + 5000 }).catch(() => null);

// The space a project's chats go to (tasklist.js spaceIn); with none, one is made at the repository's folder. -> its id, or null.
async function spaceFor(root, on) {
  const cwds = {}, all = spaces();
  for (const p of panes()) { const sp = all.find((s) => s.tabs.some((t) => t.id === p.tab)); if (sp && p.cwd) (cwds[sp.id] ??= []).push(p.cwd); }
  const have = spaceIn(all, root, on, cwds);
  if (have) return have;
  const known = new Set(all.map((s) => s.id));
  run("space.new", { folder: root, machine: on ?? "" });
  for (let i = 0; i < 30; i++) {
    const made = spaces().find((s) => !known.has(s.id) && s.folder === root);
    if (made) return made.id;
    await nap(100);
  }
  return null;
}

// "Run with agent" for the task `t` of the project `key` ("<machine or empty>:<repo root>"): a worktree on a new branch,
// and a chat in it on the tasks' agent and model with the task as its first message. `opts.cwd`: the folder the person
// is in (the new branch starts from its branch; default: the repository's main checkout); `opts.space`: the space the
// chat's tab goes to (default: the one that works in the repository, made when there is none: never just the shown
// one); `opts.back`: a tab to show again once the chat has started (chat.js stepBack); `opts.step(words)`: told what
// it is doing now. Throws with the reason when it can't start.
export async function startTask(key, t, opts = {}) {
  const at = parseKey(key);
  if (!at) throw new Error("No project.");
  const on = at.on, cwd = opts.cwd ?? at.root;
  const repo = await repoOf(cwd, on);
  if (!repo) throw new Error("This folder isn't in a Git repository.");
  const from = await currentRef(cwd, on);
  const found = await detect(on);
  const agent = AGENTS.find((a) => a.id === roleAgent("task", found.found));
  if (!agent) throw new Error(found.error ?? "No chat agent is installed and turned on (Settings).");
  const branch = branchFor(t.title, Date.now().toString(36).slice(-4));
  const path = await addWorktree(repo, branch, on, { ...(from ? { from } : {}) });
  const chat = newId();
  opts.step?.("starting the chat");
  const space = opts.space ?? (await spaceFor(at.root, on));
  const set = roleSet("task", agent.id);
  update(key, (l) => patch(l, t.id, { run: { chat, branch, path, on, from, at: Date.now() } }));
  run("tab.new", { mod: MOD, ...(space ? { space } : {}), name: t.title.slice(0, 60),
    props: { panel: "chat", chat, agent: [found.found[agent.argv[0]], ...agent.argv.slice(1)], cwd: path, machine: on, prompt: promptOf(t),
      ...(set ? { set } : {}), ...(opts.back ? { back: { tab: opts.back, at: Date.now() } } : {}) } });
  return { chat, branch, path };
}

// The chat's state for a task (tasklist.js chatState) from what the chat tabs report, or null when it was never run.
export function taskState(t) {
  if (!t.run) return null;
  const tabs = new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id)));
  return chatState(t.run, { places: shared(`${MOD}.places`) ?? {}, status: shared(`${MOD}.status`) ?? {}, turns: shared(`${MOD}.turns`) ?? {}, tabs });
}
// A chat seen working is remembered with its task: an idle chat after that is a finished one, and a closed tab a closed chat.
export function observe(key) {
  if (!key) return;
  const need = tasksOf(key).filter((t) => t.run && !t.run.worked && taskState(t)?.worked);
  if (need.length) update(key, (l) => l.map((t) => (need.some((n) => n.id === t.id) && t.run ? { ...t, run: { ...t.run, worked: true } } : t)));
}

const TONE = { starting: "secondary", working: "info", waiting: "warning", done: "success", failed: "error", closed: "secondary", making: "info" };

export class TasksPanel {
  init(p, cx) {
    this.group = p.group ?? "a";
    this.tab = "tasks"; // "tasks" | "notes"
    this.where = null; // { on, cwd }
    this.project = null; // { key, root, on, cwd, name }
    this.seen = null;
    this.making = new Map(); // task id -> what the run is doing now
    this.errors = new Map(); // task id -> why the last run didn't start
    this.editing = null; // task id
    this.armed = null; // task id whose bin was pressed once
    this.asking = null; // Merge's question: { id (the task's), text }
    this.busy = new Map(); // task id -> "merging" | "removing"
    this.said = null; // how the last merge or removal went: { text, bad, offer? (a merged task's id, to remove its worktree) }
    this.doneOpen = false;
    this.showNote = false; // the add box's note field
    this.title = InputState.new({ placeholder: "Add a task" });
    this.noteIn = TextareaState.new({ placeholder: "Note (optional): what the agent should know", rows: 3 });
    this.title.on("change", (_e, cx) => cx.notify());
    this.title.on("submit", (_e, cx) => { this.add(cx); });
    this.editTitle = InputState.new({ placeholder: "Title" });
    this.editNote = TextareaState.new({ placeholder: "Note", rows: 3 });
    this.editTitle.on("change", (_e, cx) => cx.notify());
    this.editTitle.on("submit", (_e, cx) => { this.saveEdit(cx); });
    // Notes: the text, the file it is kept in and what that held when last read or written; `token` marks the latest change.
    this.notes = TextareaState.new({ placeholder: "Notes for this folder: plain text, saved as you type", rows: 14 });
    this.notes.set_auto_grow(14, 400);
    this.notePath = null;
    this.noteDisk = null;
    this.noteLoaded = false;
    this.noteDirty = false;
    this.noteToken = 0;
    this.noteSaved = null; // when it was last saved
    this.noteError = null;
    this.notes.on("change", (_e, cx) => { this.onNoteChange(cx); });
    this.follow(cx);
    // While shown: the chats' states come in through the shared state, so redraw each second (and remember a chat that worked).
    // Also while hidden: a chat that works and ends (and whose tab is closed) before the surface is shown again must be
    // remembered as having worked, or it would read as one that never started.
    cx.timer.every(1000, (cx) => {
      this.observe();
      if (showing(this.group, "tasks")) cx.notify();
    });
  }
  close() { this.flushNotes(); }

  // The folder shown, its project and its notes: a new folder is looked up again, and the old folder's notes are saved first.
  follow(cx) {
    const sp = activeSpace(), where = placeOf(sp);
    const key = `${where.on ?? ""}|${where.cwd ?? ""}`;
    if (key === this.seen) return;
    this.flushNotes();
    this.seen = key;
    this.where = where.cwd ? { on: where.on ?? null, cwd: where.cwd } : null;
    this.project = null;
    this.editing = null;
    this.armed = null;
    this.asking = null;
    this.said = null;
    this.noteLoaded = false;
    this.notePath = null;
    this.notes.set_value("");
    if (!this.where) return;
    const seen = this.seen, at = this.where;
    this.notePath = `${notesDir()}/${notesFile(at.on, at.cwd)}`;
    const path = this.notePath;
    cx.spawn(async (cx) => {
      const pr = await projectOf(sp).catch(() => null);
      if (this.seen === seen) { this.project = pr; cx.notify(); }
      const text = await readTextFile(path).catch(() => null);
      if (this.seen !== seen) return;
      this.noteDisk = text;
      this.notes.set_value(text ?? "");
      this.noteDirty = false;
      this.noteLoaded = true;
      cx.notify();
    });
  }

  list() { return tasksOf(this.project?.key); }

  // ---- tasks ----

  add(cx) {
    const key = this.project?.key, title = this.title.value().trim();
    if (!key || !title) return;
    update(key, (l) => [...l, newTask(title.split("\n")[0], this.noteIn.value(), newId(), Date.now())]);
    this.title.set_value("");
    this.noteIn.set_value("");
    this.showNote = false;
    cx.notify();
  }
  toggleDone(t, cx) {
    const key = this.project?.key;
    if (!key) return;
    update(key, (l) => patch(l, t.id, { done: !t.done }));
    cx.notify();
  }
  startEdit(t, cx) {
    this.editing = t.id;
    this.armed = null;
    this.editTitle.set_value(t.title);
    this.editNote.set_value(t.note);
    this.editTitle.focus();
    cx.notify();
  }
  saveEdit(cx) {
    const key = this.project?.key, id = this.editing, title = this.editTitle.value().trim();
    if (!key || !id || !title) return;
    update(key, (l) => patch(l, id, { title: title.split("\n")[0].slice(0, TITLE_MAX), note: this.editNote.value().trim() }));
    this.editing = null;
    cx.notify();
  }
  del(t, cx) {
    const key = this.project?.key;
    if (!key) return;
    if (this.armed !== t.id) {
      this.armed = t.id;
      cx.timer.after(4000, (acx) => { if (this.armed === t.id) { this.armed = null; acx.notify(); } });
      return cx.notify();
    }
    this.armed = null;
    update(key, (l) => remove(l, t.id));
    cx.notify();
  }
  shift(t, by, cx) {
    const key = this.project?.key;
    if (key) update(key, (l) => move(l, t.id, by));
    cx.notify();
  }

  // ---- Run with agent ----

  runTask(t, cx) {
    const project = this.project, where = this.where;
    if (!project || !where || this.making.has(t.id)) return;
    const space = focused()?.space ?? activeSpace()?.id ?? null;
    this.errors.delete(t.id);
    this.making.set(t.id, "making the worktree");
    cx.notify();
    // The click's cx goes stale at the first await: the run reports through the spawn's own.
    cx.spawn(async (acx) => {
      try {
        await startTask(project.key, t, { cwd: where.cwd, space, step: (words) => { this.making.set(t.id, words); acx.notify(); } });
      } catch (e) {
        this.errors.set(t.id, String(e?.message ?? e).split("\n").pop());
      }
      this.making.delete(t.id);
      acx.notify();
    });
  }

  // The chat's state for a task (tasklist.js chatState) from what the chat tabs report.
  stateOf(t) { return taskState(t); }
  observe() { observe(this.project?.key); }
  focusChat(t) {
    const s = this.stateOf(t);
    if (!s?.tab) return;
    run("tab.select", { id: s.tab });
    if (s.pane) run("pane.focus", { pane: s.pane });
  }

  // ---- Merge and Remove worktree ----

  workOf(t) { return this.project ? workAll()[`${this.project.key}\n${t.id}`] ?? null : null; }
  byId(id) { return this.list().find((t) => t.id === id) ?? null; }
  // Merge, first click: what it would do is read now and asked in the row at the foot; a refusal is said there instead.
  askMerge(t, cx) {
    const project = this.project;
    if (!project || this.busy.has(t.id)) return;
    this.busy.set(t.id, "merging");
    this.said = null;
    this.asking = null;
    cx.notify();
    // The click's cx goes stale at the first await: the spawn's own is used after it.
    cx.spawn(async (acx) => {
      let plan;
      try { plan = await mergePlan(exec, { root: project.root, t, state: this.stateOf(t)?.state ?? null }); } catch (e) { plan = { ok: false, why: String(e?.message ?? e).split("\n").pop() }; }
      this.busy.delete(t.id);
      if (this.project?.key === project.key) {
        if (plan.ok) this.asking = { id: t.id, text: plan.text }; else this.said = { text: plan.why, bad: true };
      }
      acx.notify();
    });
  }
  // The question's answer. Yes merges, if things still stand as the question said; if not, it asks again with what is true now.
  answerMerge(yes, cx) {
    const q = this.asking, project = this.project, t = q ? this.byId(q.id) : null;
    this.asking = null;
    if (!yes || !q || !project || !t || this.busy.has(t.id)) return cx.notify();
    this.busy.set(t.id, "merging");
    cx.notify();
    cx.spawn(async (acx) => {
      const mark = `${project.key}\n${t.id}`;
      let r;
      try { r = await mergeTask(exec, { root: project.root, t, state: this.stateOf(t)?.state ?? null, expect: q.text }); } catch (e) { r = { ok: false, refused: true, error: String(e?.message ?? e).split("\n").pop() }; }
      if (r.ok) {
        update(project.key, (l) => patch(l, t.id, (x) => (x.run ? { done: true, run: { ...x.run, merged: { at: Date.now(), commit: r.commit } } } : {})));
        setWork(mark, null);
      } else if (r.committed) setWork(mark, await readWork(exec, t.run));
      this.busy.delete(t.id);
      if (this.project?.key === project.key) {
        if (r.changed) this.asking = { id: t.id, text: r.plan.text };
        else this.said = { ...mergeWords(r), ...(r.ok ? { offer: t.id } : {}) };
      }
      acx.notify();
    });
  }
  // Remove worktree, for a merged task: its folder and its branch (tasklist.js cleanupTask).
  cleanup(t, cx) {
    const project = this.project;
    if (!project || this.busy.has(t.id)) return;
    this.busy.set(t.id, "removing");
    this.said = null;
    cx.notify();
    cx.spawn(async (acx) => {
      let r;
      try { r = await cleanupTask(exec, { root: project.root, t }); } catch (e) { r = { ok: false, error: String(e?.message ?? e).split("\n").pop() }; }
      if (r.ok) update(project.key, (l) => patch(l, t.id, (x) => (x.run?.merged ? { run: { ...x.run, merged: { ...x.run.merged, removed: true } } } : {})));
      // Its chat's tab works in the folder that is gone now: it is closed too (the chat's saved state is kept), unless it works.
      const s = r.ok ? taskState(t) : null;
      if (s?.tab && !BUSY_STATES.includes(s.state)) run("tab.close", { id: s.tab, confirmed: true });
      this.busy.delete(t.id);
      if (this.project?.key === project.key) {
        this.said = r.ok ? { bad: false, text: `Removed the worktree of ${t.run.branch}${r.branch === "deleted" ? " and deleted the branch." : `. The branch was kept: ${r.why}`}` } : { bad: true, text: r.error };
      }
      acx.notify();
    });
  }

  // ---- notes ----

  onNoteChange(cx) {
    if (!this.noteLoaded || !this.notePath) return;
    this.noteDirty = true;
    const token = ++this.noteToken;
    cx.notify();
    cx.timer.after(NOTES_SAVE_MS, (acx) => { if (token === this.noteToken) this.saveNotes(acx); });
  }
  // Saves what the box holds now (a newer change is saved by its own timer, which this one's token no longer matches).
  saveNotes(cx) {
    if (!this.noteDirty || !this.notePath) return;
    const path = this.notePath, text = this.notes.value(), expected = this.noteDisk;
    this.noteDirty = false;
    if (text === "" && expected == null) return;
    cx.spawn(async (acx) => {
      try { this.noteDisk = await writeNotes(path, text, expected); this.noteSaved = Date.now(); this.noteError = null; }
      catch (e) { this.noteDirty = true; this.noteError = String(e?.message ?? e).split("\n").pop(); }
      acx.notify();
    });
  }
  // Without a cx (the folder changed, or the panel closes): saves at once.
  flushNotes() {
    if (!this.noteDirty || !this.notePath || !this.noteLoaded) return;
    const path = this.notePath, text = this.notes.value(), expected = this.noteDisk;
    this.noteDirty = false;
    this.noteToken++;
    writeNotes(path, text, expected).catch(() => {});
  }

  // For scripts: see the header.
  command_(c, cx) {
    const list = this.list(), at = (s) => list[Number(s)];
    if (c.startsWith("tasks-add:")) { this.title.set_value(c.slice(10)); this.add(cx); }
    else if (c.startsWith("tasks-run:")) { const t = at(c.slice(10)); if (t) this.runTask(t, cx); }
    else if (c.startsWith("tasks-done:")) { const t = at(c.slice(11)); if (t) this.toggleDone(t, cx); }
    else if (c.startsWith("tasks-delete:")) { const t = at(c.slice(13)); if (t) this.del(t, cx); }
    else if (c.startsWith("tasks-up:")) { const t = at(c.slice(9)); if (t) this.shift(t, -1, cx); }
    else if (c.startsWith("tasks-down:")) { const t = at(c.slice(11)); if (t) this.shift(t, 1, cx); }
    else if (c === "tasks-tab:notes" || c === "tasks-tab:tasks") this.tab = c.slice(10);
    else if (c.startsWith("tasks-merge:")) { const t = this.byId(c.slice(12)); if (t) this.askMerge(t, cx); }
    else if (c === "tasks-yes" || c === "tasks-no") this.answerMerge(c === "tasks-yes", cx);
    else if (c.startsWith("tasks-cleanup:")) { const t = this.byId(c.slice(14)); if (t) this.cleanup(t, cx); }
    else if (c.startsWith("tasks-notes:")) { this.notes.set_value(c.slice(12)); this.onNoteChange(cx); } // set_value sends no change event
    cx.notify();
  }
  command(c, cx) { if (showing(this.group, "tasks")) this.command_(c, cx); }

  // ---- drawing ----

  head(k) {
    const w = this.where, tab = (id, label) => {
      const on = this.tab === id;
      return h_flex().id(`tasks-tab-${id}`).h(24).px(8).items_center().rounded(8).cursor_pointer().text_size(12).font_medium()
        .bg(on ? k.accent : "#00000000").text_color(on ? k.foreground : k.muted).hover((s) => s.bg(k.accent).text_color(k.foreground))
        .role("button").accessibility_label(`${label}${on ? " (shown)" : ""}`).on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    };
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
      .child(icon("list-todo").size(14).flex_none().text_color(k.muted))
      .child(h_flex().flex_none().gap(2).child(tab("tasks", "Tasks")).child(tab("notes", "Notes")))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(w ? `${w.on ? `${w.on}: ` : ""}${shortPath(this.tab === "notes" ? w.cwd : this.project?.root ?? w.cwd)}` : ""));
  }

  checkbox(k, id, on, label, onClick) {
    return h_flex().id(id).size(16).flex_none().items_center().justify_center().rounded(4).border(1).cursor_pointer()
      .border_color(on ? k.primary : k.input).bg(on ? k.primary : "#00000000").text_color(k.primaryText)
      .role("check_box").accessibility_label(label).on_click((_e, cx) => onClick(cx))
      .when(on, (e) => e.child(icon("check").size(12)));
  }

  addBox(k) {
    const ok = !!this.title.value().trim() && !!this.project;
    return v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(alpha(k.border, 0.6))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).h(28).px(8).rounded(8).border(1).border_color(k.input).text_size(13).child(Input.new(this.title)))
        .child(iconButton(k, "task-note-toggle", this.showNote ? "chevron-up" : "chevron-down", (cx) => { this.showNote = !this.showNote; if (this.showNote) this.noteIn.focus(); cx.notify(); }, { tip: this.showNote ? "Hide the note" : "Add a note", on: this.showNote }))
        .child(button(k, "task-add", "Add", (cx) => this.add(cx), { variant: "default", disabled: !ok, tip: "Kept for this project" })))
      .when(this.showNote, (el) => el.child(div().min_h(60).px(8).py(4).rounded(8).border(1).border_color(k.input).text_size(13).line_height("20px").child(Textarea.new(this.noteIn))));
  }

  editForm(k, t) {
    return v_flex().id(`task-edit-${t.id}`).flex_none().mx(8).p(8).gap(6).rounded(8).border(1).border_color(k.input)
      .child(div().h(28).px(8).rounded(8).border(1).border_color(k.input).text_size(13).child(Input.new(this.editTitle)))
      .child(div().min_h(60).px(8).py(4).rounded(8).border(1).border_color(k.input).text_size(13).line_height("20px").child(Textarea.new(this.editNote)))
      .child(h_flex().gap(6).justify_end()
        .child(button(k, `task-edit-cancel-${t.id}`, "Cancel", (cx) => { this.editing = null; cx.notify(); }))
        .child(button(k, `task-edit-save-${t.id}`, "Save", (cx) => this.saveEdit(cx), { variant: "default", disabled: !this.editTitle.value().trim() })));
  }

  // "on <branch>" and the chat's state, or what the run is doing now, or why it didn't start.
  runLine(k, t) {
    const making = this.making.get(t.id), err = this.errors.get(t.id);
    if (!t.run && !making && !err) return null;
    if (!t.run) {
      return h_flex().gap(6).items_center().min_w(0).text_size(12)
        .child(making ? icon("loader-circle").size(14).flex_none().text_color(k.muted).spin(1000) : icon("circle-alert").size(14).flex_none().text_color(k.destructiveText))
        .child(div().flex_1().min_w(0).text_color(making ? k.muted : k.destructiveText).child(making ? `${making}…` : `Didn't start: ${err}`));
    }
    const s = this.stateOf(t), state = making ? "making" : s.state, label = making ? `${making}` : STATE_LABEL[state] ?? state;
    const live = !!s.tab && !making;
    const glyph = { working: "loader-circle", waiting: "circle-alert", done: "circle-check", failed: "circle-x", starting: "loader-circle", closed: "circle-dashed", making: "loader-circle" }[state] ?? "circle-dot";
    const tone = { working: k.info, waiting: k.warningText, done: k.successText, failed: k.destructiveText }[state] ?? k.muted;
    const g = icon(glyph).size(14).flex_none().text_color(tone);
    return h_flex().id(`task-run-${t.id}`).gap(6).items_center().min_w(0).h(22).px(6).rounded(6).text_size(12)
      .when(live, (el) => el.cursor_pointer().role("button").accessibility_label(`Show the chat of ${t.title}`).hover((x) => x.bg(alpha(k.foreground, 0.07))).on_click((_e, cx) => { this.focusChat(t); cx.notify(); }))
      .child(["working", "starting", "making"].includes(state) ? g.spin(1000) : g)
      .child(div().flex_1().min_w(0).truncate().text_color(k.muted).tooltip(`${t.run.path}\nfrom ${t.run.from ?? "HEAD"}`).child(`on ${t.run.branch}`))
      .child(badge(k, label, TONE[state] ?? "secondary"))
      .when(state === "failed" && !!s.why, (el) => el.tooltip(s.why));
  }

  // What the task's worktree holds and the person's step with it: "2 commits, 3 uncommitted files", "Ready to merge"
  // once the coordinator said so, and Merge; after the merge, where it went and Remove worktree. Null when there is nothing to say.
  mergeLine(k, t) {
    const r = t.run, doing = this.busy.get(t.id);
    if (!r) return null;
    if (r.merged) {
      return h_flex().pl(24).gap(6).items_center().min_w(0).text_size(12)
        .child(icon("git-merge").size(14).flex_none().text_color(k.successText))
        .child(div().flex_1().min_w(0).truncate().text_color(k.muted).child(`merged into ${r.from ?? "its branch"}${r.merged.commit ? ` (${r.merged.commit})` : ""}${r.merged.removed ? ", worktree removed" : ""}`))
        .when(!r.merged.removed, (el) => el.child(button(k, `task-cleanup-${t.id}`, doing === "removing" ? "Removing…" : "Remove worktree", (cx) => this.cleanup(t, cx),
          { variant: "outline", size: "xs", glyph: "trash-2", disabled: !!doing, tip: "Removes the task's worktree folder and deletes its branch (git branch -d). Kept while it has uncommitted files." })));
    }
    const w = this.workOf(t), words = workWords(w), state = this.stateOf(t)?.state;
    if (!words && !r.ready) return null;
    const wait = BUSY_STATES.includes(state) || this.making.has(t.id);
    return h_flex().pl(24).gap(6).items_center().min_w(0).text_size(12)
      .child(icon("git-commit-horizontal").size(14).flex_none().text_color(k.muted))
      .child(div().min_w(0).truncate().text_color(k.muted).child(words || "nothing to merge yet"))
      .when(!!r.ready, (el) => el.child(div().id(`task-ready-${t.id}`).flex_none().tooltip(r.ready.note ? `The coordinator: ${r.ready.note}` : "The coordinator looked at it and says it can be merged").child(badge(k, "Ready to merge", "success"))))
      .child(div().flex_1())
      .when(hasWork(w) || !!r.ready, (el) => el.child(button(k, `task-merge-${t.id}`, doing === "merging" ? "Merging…" : "Merge", (cx) => this.askMerge(t, cx),
        { variant: r.ready ? "default" : "outline", size: "xs", glyph: "git-merge", disabled: !!doing || wait || !this.project,
          tip: wait ? "Its agent is still at work" : `Merges ${r.branch} into ${r.from ?? "the branch it was made from"}${w?.dirty > 0 ? ", committing its uncommitted files first" : ""}. Asks once.` })));
  }

  // The foot: Merge's question, or how the last merge or removal went (with Remove worktree after a merge).
  foot(k) {
    const q = this.asking, said = this.said, offer = said?.offer ? this.byId(said.offer) : null;
    if (q) {
      return h_flex().id("tasks-ask").flex_none().px(12).py(6).gap(8).items_center().border_t(1).border_color(k.border).bg(k.card).text_size(12)
        .child(icon("git-merge").size(14).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).child(q.text))
        .child(button(k, "tasks-merge-no", "No", (cx) => this.answerMerge(false, cx), { variant: "outline" }))
        .child(button(k, "tasks-merge-yes", "Yes", (cx) => this.answerMerge(true, cx), { variant: "default" }));
    }
    if (!said) return null;
    return h_flex().id("tasks-said").flex_none().px(12).py(6).gap(8).items_center().border_t(1).border_color(k.border).bg(k.card).text_size(12)
      .child(icon(said.bad ? "circle-alert" : "circle-check").size(14).flex_none().text_color(said.bad ? k.destructiveText : k.successText))
      .child(div().flex_1().min_w(0).text_color(said.bad ? k.destructiveText : k.foreground).child(said.text))
      .when(!!offer && !!offer.run?.merged && !offer.run.merged.removed, (el) => el.child(button(k, "tasks-said-cleanup", this.busy.get(offer.id) === "removing" ? "Removing…" : "Remove worktree", (cx) => this.cleanup(offer, cx),
        { variant: "outline", glyph: "trash-2", disabled: this.busy.has(offer.id), tip: "Removes the task's worktree folder and deletes its branch (git branch -d)" })))
      .child(iconButton(k, "tasks-said-close", "x", (cx) => { this.said = null; cx.notify(); }, { size: "micro", tip: "Dismiss" }));
  }

  taskRow(k, t, i, list) {
    if (this.editing === t.id) return this.editForm(k, t);
    const idle = !this.making.has(t.id), s = this.stateOf(t), again = !!t.run && ["failed", "closed"].includes(s?.state);
    const live = !!s?.tab;
    const first = !canMove(list, t.id, -1), last = !canMove(list, t.id, 1);
    const note = t.note.replace(/\s+/g, " "), ml = this.mergeLine(k, t);
    return v_flex().id(`task-${t.id}`).flex_none().mx(8).px(8).py(6).gap(4).rounded(8).hover((x) => x.bg(alpha(k.foreground, 0.04)))
      .child(h_flex().gap(8).items_center()
        .child(this.checkbox(k, `task-done-${t.id}`, t.done, t.done ? `Reopen ${t.title}` : `Mark ${t.title} done`, (cx) => this.toggleDone(t, cx)))
        .child(div().id(`task-title-${t.id}`).flex_1().min_w(0).truncate().font_medium().text_color(t.done ? k.muted : k.foreground).tooltip(live ? `${t.title}\nClick to show its chat` : t.title)
          .when(live, (e) => e.cursor_pointer().role("button").accessibility_label(`Show the chat of ${t.title}`).on_click((_e, cx) => { this.focusChat(t); cx.notify(); }))
          .child(t.title))
        .when(!t.done, (el) => el
          .child(iconButton(k, `task-up-${t.id}`, "arrow-up", (cx) => this.shift(t, -1, cx), { size: "micro", tip: "Move up", color: first ? alpha(k.muted, 0.35) : null }))
          .child(iconButton(k, `task-down-${t.id}`, "arrow-down", (cx) => this.shift(t, 1, cx), { size: "micro", tip: "Move down", color: last ? alpha(k.muted, 0.35) : null })))
        .child(iconButton(k, `task-edit-${t.id}`, "pen-line", (cx) => this.startEdit(t, cx), { size: "micro", tip: "Edit" }))
        .child(this.armed === t.id
          ? button(k, `task-del-${t.id}`, "Delete?", (cx) => this.del(t, cx), { variant: "destructive", size: "xs", tip: "Deletes this task for good" })
          : iconButton(k, `task-del-${t.id}`, "trash-2", (cx) => this.del(t, cx), { size: "micro", tip: "Delete" })))
      .when(!!note, (el) => el.child(div().id(`task-note-${t.id}`).pl(24).max_h(48).overflow_hidden().text_size(12).line_height("16px").text_color(t.done ? alpha(k.muted, 0.8) : k.muted)
        .when(live, (e) => e.cursor_pointer().role("button").accessibility_label(`Show the chat of ${t.title}`).on_click((_e, cx) => { this.focusChat(t); cx.notify(); }))
        .child(note)))
      .child(div().pl(18).child(this.runLine(k, t) ?? div()))
      .when(!!ml, (el) => el.child(ml))
      .when(!t.done, (el) => el.child(h_flex().pl(24).gap(6).items_center()
        .child(button(k, `task-run-btn-${t.id}`, this.making.has(t.id) ? "Working…" : again ? "Run again" : t.run ? "Run again" : "Run with agent", (cx) => this.runTask(t, cx),
          { variant: !t.run || again ? "outline" : "ghost-muted", size: "xs", glyph: "play", disabled: !idle || !this.project,
            tip: "Makes a worktree on a new branch from the current one and starts a chat there with this task as its first message" }))
        .when(live && !!t.run, (e) => e.child(button(k, `task-show-${t.id}`, "Show chat", () => this.focusChat(t), { variant: "ghost-muted", size: "xs", glyph: "message-square" })))
        .child(button(k, `task-mark-${t.id}`, "Mark done", (cx) => this.toggleDone(t, cx), { variant: "ghost-muted", size: "xs", glyph: "check", tip: "Moves it to Done" }))));
  }

  tasksBody(k) {
    const list = this.list(), open = list.filter((t) => !t.done), done = list.filter((t) => t.done);
    const foot = this.foot(k);
    return v_flex().flex_1().min_h(0)
      .child(this.addBox(k))
      .child(v_flex().id("ht3-tasks-list").flex_1().min_h(0).py(6).gap(2).overflow_y_scrollbar()
        .when(!this.project, (el) => el.child(div().px(12).py(6).text_size(12).text_color(k.muted).child("Looking up the project…")))
        .when(!!this.project && !list.length, (el) => el.child(div().px(24).py(16).text_size(12).line_height("18px").text_center().text_color(k.muted).child("No tasks yet. Add one above: Run with agent makes a worktree and starts a chat on it.")))
        .children(open.map((t, i) => this.taskRow(k, t, i, list)))
        .when(done.length > 0, (el) => el.child(h_flex().id("tasks-done-head").h(28).flex_none().mx(8).px(8).gap(6).items_center().cursor_pointer().rounded(6).text_size(12).font_medium().text_color(k.muted)
          .hover((s) => s.bg(alpha(k.foreground, 0.05)).text_color(k.foreground)).role("button").accessibility_label(this.doneOpen ? "Fold the done tasks" : "Show the done tasks")
          .on_click((_e, cx) => { this.doneOpen = !this.doneOpen; cx.notify(); })
          .child(icon(this.doneOpen ? "chevron-down" : "chevron-right").size(14).flex_none())
          .child(div().child(`Done (${done.length})`))))
        .when(this.doneOpen, (el) => el.children(done.map((t, i) => this.taskRow(k, t, i, list)))))
      .when(!!foot, (el) => el.child(foot));
  }

  notesBody(k) {
    const saved = this.noteError ? `Couldn't save: ${this.noteError}` : this.noteDirty ? "Saving…" : this.noteSaved ? "Saved" : "";
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("ht3-tasks-notes").flex_1().min_h(0).p(12).overflow_y_scrollbar()
        .child(div().min_h(200).px(8).py(6).rounded(8).border(1).border_color(k.input).bg(k.background).text_size(13).line_height("20px").child(Textarea.new(this.notes))))
      .child(h_flex().h(26).flex_none().px(12).gap(8).items_center().border_t(1).border_color(alpha(k.border, 0.6)).text_size(11).text_color(this.noteError ? k.destructiveText : k.muted)
        .child(div().flex_1().min_w(0).truncate().child(this.noteLoaded ? "Notes for this folder, kept in Herdr's data folder, not in the repository." : "Reading…"))
        .child(div().flex_none().child(saved)));
  }

  render(cx) {
    this.follow(cx);
    const k = tokens();
    const root = v_flex().id("ht3-tasks").size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(13);
    if (!this.where) return root.child(this.head(k)).child(v_flex().flex_1().items_center().justify_center().px(24).text_size(12).text_color(k.muted).child("No folder: focus a terminal or a chat in a project."));
    return root.child(this.head(k)).child(this.tab === "notes" ? this.notesBody(k) : this.tasksBody(k));
  }
}
