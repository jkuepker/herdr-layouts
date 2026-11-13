// The coordinator (not in T3 Code): one chat that manages the tasks of every project. It is an ordinary chat with a
// fixed id, "coordinator", on the coordinator's agent and model (settings.js `coordinatorAgent`, `coordinatorModel`),
// in a folder of its own, `data/ht3-panels/coordinator/` in the app's folder, shown in a space named "Coordinator".
// It can't see Herdr and `herdr-app do` prints nothing for a mod's command, so the two meet in that folder:
// - its role and the exact commands are in CLAUDE.md and AGENTS.md there (coord-template.js; written when missing or old);
// - the keeper (main.js Buttons) writes `state.json` there whenever it changes: the open spaces, every project's tasks
//   with their chats' states and last replies, and how the last commands went (coord-data.js `snapshot`);
// - it acts through the keeper's commands: `coord:<json>` adds, runs, marks done and deletes tasks of any project
//   (coord-data.js `parseOp`), the tasks the Tasks surface shows (tasks.js), run as that surface runs them (`startTask`);
//   its `answer` answers the approval a task's chat waits for, once, as the Inbox card does (chat.js `asking`);
//   its `ready` marks a task's work as looked at and good to merge (`run.ready`, with the commit its branch is at): the
//   Tasks row shows "Ready to merge", the Agents list its "Ready to merge" group, and the person is told by a
//   notification whose click shows that project's space and Tasks with the task in view (tasks.js showTasks). Merging is
//   the person's (the row's Merge button, tasks.js): no command here commits or merges;
//   its `tell` posts a message into a task's own chat, and its `update` posts the fixed one that sends a task whose
//   Merge conflicted back to its agent to rebase (tasks.js tellTask, askUpdate; tasklist.js updateText);
// - the keeper reads each run task's worktree (commits ahead of the branch it came from, uncommitted files, the commit
//   it is at): when its chat's state changed and every 15 seconds for an open task, once for a done one; kept in shared
//   "ht3-panels.work" for the Tasks surface and written into state.json as `ahead` and `dirty`. A ready task whose
//   branch is at another commit by now, or whose agent works again, loses its mark (tasklist.js readyStale), and so
//   does a conflicted one whose branch moved (conflictGone); state.json has the conflict as `conflict`;
// - the keeper tells it what happened: when a task's chat finished, failed, waits for an approval or was closed, one
//   short message goes into the coordinator chat (shared "ht3-panels.post", which chat.js takes), at most one in 45
//   seconds, unless settings.js `coordinatorNotify` is off. A Merge that conflicted is told at once, with the files.
//   `coord-post:<text>` posts any text to it the same way;
// - after a restart (a chat's copy starts only when its tab first shows, and a turn that ran at the quit is cut off):
//   the keeper's first pass reads the saved state of the coordinator's and every open task's chat that has no copy
//   running, and one that says a turn was running is marked cut (shared "ht3-panels.cut", report.js): its task's state is
//   "interrupted" and the coordinator is told once which ones (coord-data.js restartText), to have their agents go on.
//   And each pass, a chat that has posts waiting and no copy running (the coordinator's own too) is started: its
//   restored tab is shown for a moment and the person's space, tab and pane are shown again (`wake`, below).
// - the keeper keeps the cap on running tasks (settings.js `taskMaxRunning`, taskqueue.js): each pass it starts the
//   oldest queued tasks into the free slots (`drain`), and a `run` beyond the cap queues the task instead of starting it;
//   state.json has such a task's state as "queued" with its place, and the cap as `limit`;
// `coordinator` shows the chat, making the space and the chat when they aren't there.

import { exec, run, shared, setShared, spaces, panes, machines, focused, appHome, home, readTextFile, writeTextFile, notify } from "herdr";
import { mountedChats, cutAll, markCut } from "./report.js";
import { MOD } from "./look.js";
import { AGENTS, detect } from "./agent-acp.js";
import { repoOf } from "./launcher.js";
import { roleAgent, roleSet, coordinatorNotify, taskMaxRunning, prefsRead } from "./settings.js";
import { mustQueue, due as queueDue, queueOf, placeIn, enqueue, unqueued, markOf } from "./taskqueue.js";
import { tasksOf, taskKeys, update, newId, startTask, observe, workAll, setWork, WORK_EVERY_MS, postTo, tellTask, askUpdate } from "./tasks.js";
import { newTask, patch, remove, keyOf, parseKey, chatState, readWork, readyStale, unready, showCommand, conflictGone, unconflict, SENT_WORDS } from "./tasklist.js";
import { lastReply } from "./compare-data.js";
import { parseOp, logOp, snapshot, templateDue, pickAnswer, readyCheck, taskStates, noticeDiff, noticeText, conflictNews, conflictText,
  savedCut, restartNews, restartText, wakeDue, wakeTab, wakeSteps, resettleAfter } from "./coord-data.js";
import { VERSION, roleText, SETTINGS } from "./coord-template.js";

export const CHAT = "coordinator", SPACE = "Coordinator";
export const coordDir = () => `${appHome()}/data/${MOD}/coordinator`;
const chatsDir = () => `${appHome()}/data/${MOD}/chats`;
const REPLY_MAX = 400, REPLY_EVERY_MS = 10000;
const NOTICE_EVERY_MS = 45000;
const nap = (ms) => exec("sleep", [String(ms / 1000)], { timeout: ms + 5000 }).catch(() => null);
const why = (e) => String(e?.message ?? e).split("\n").pop();

let ops = []; // how the last commands went
const making = new Map(); // "<key>\n<task id>" -> what a run that has no chat yet is doing
const replies = new Map(); // chat id -> { stamp, at, text }
let written = null; // state.json's text as last written
let writing = false;
let seen = null; // each task's state at the last pass (coord-data.js taskStates); null until the first one
const due = new Map(); // the tasks whose news waits to be told: "<key>\n<task id>" -> the state it came into
let noticedAt = 0; // when the last notice went
const looked = new Map(); // "<key>\n<task id>" -> { at, state, chat }: when its worktree was last read, and its chat's state then
const looking = new Set(); // the ones being read now
let cutRead = false; // the saved states were looked through for cut-off turns (once per load of the mod)
const woke = new Map(); // chat id -> { at, post }: when it was started for its posts, and the newest post's time then
let waking = false;

// What chatState reads, as things are now, and the approvals that wait (tab -> ask).
const facts = () => ({ places: shared(`${MOD}.places`) ?? {}, status: shared(`${MOD}.status`) ?? {}, turns: shared(`${MOD}.turns`) ?? {},
  asks: shared(`${MOD}.asks`) ?? {}, cut: cutAll(), tabs: new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id))), now: Date.now() });

// Writes `text` to `path` whatever it holds now (writeTextFile wants what the file held: this is the file's only writer).
async function put(path, text) {
  const now = await readTextFile(path).catch(() => null);
  if (now !== text) await writeTextFile(path, text, now ?? null);
}

// ---- the commands ----

// One `coord:<json>`; how it went is kept for the state file.
export async function coordCommand(text) {
  const o = parseOp(text, home());
  const entry = { at: Date.now(), op: o.op ?? null, project: o.project ?? null, id: o.id ?? null };
  try {
    if (o.error) throw new Error(o.error);
    const root = (await repoOf(o.project, o.machine)) ?? o.project, key = keyOf(o.machine, root);
    entry.project = root;
    const find = () => tasksOf(key).find((t) => t.id === o.id);
    if (o.op === "add") {
      const id = o.id ?? newId();
      entry.id = id;
      if (tasksOf(key).some((t) => t.id === id)) throw new Error(`This project already has a task ${id}.`);
      update(key, (l) => [...l, newTask(o.title, o.note, id, Date.now())]);
      o.id = id;
    } else if (!find()) throw new Error(`This project has no task ${o.id}.`);
    if (o.op === "done") update(key, (l) => patch(l, o.id, { done: o.done }));
    if (o.op === "delete") update(key, (l) => remove(l, o.id));
    // The approval the task's chat waits for, answered once: its chat takes it as it takes the Inbox card's answer
    // (chat.js `asking`). `always` is never set here: "Always allow this session" is the person's alone.
    if (o.op === "answer") {
      const f = facts(), t = find(), tab = t.run ? chatState(t.run, f).tab : null;
      const pick = pickAnswer(tab ? f.asks[tab] : null, o.ask, o.option);
      if (pick.error) throw new Error(pick.error);
      entry.ask = pick.title;
      entry.option = pick.name;
      setShared(`${MOD}.answers`, { ...(shared(`${MOD}.answers`) ?? {}), [tab]: { ask: pick.ask, optionId: pick.optionId } });
    }
    // The task's work was looked at and can be merged: the row says so and the person is told. Merging stays theirs.
    if (o.op === "ready") {
      // Its worktree is read now: what is marked is the commit the branch is at as this is said.
      const t = find(), mark = `${key}\n${t.id}`, open = !!t.run && !t.run.merged;
      const w = open ? await readWork(exec, t.run) : undefined;
      if (open) setWork(mark, w);
      const no = readyCheck(t, w, t.run ? chatState(t.run, facts()).state : null);
      if (no) throw new Error(no);
      update(key, (l) => patch(l, o.id, (x) => (x.run ? { run: { ...(unconflict(x).run ?? x.run), ready: { at: Date.now(), note: o.note, ...(w?.head ? { head: w.head } : {}) } } } : {})));
      // A click shows that project's space and its Tasks surface with the task in view (main.js `tasks-show`).
      notify({ title: "Ready to merge", body: `${t.title} is ready to merge`, level: "info", action: { name: `${MOD}.${showCommand(key, t.id)}` } });
    }
    // A message for the task's own agent, into its chat: any text (`tell`), or the fixed one that sends a task whose
    // Merge conflicted back to rebase (`update`). A closed chat's tab is opened again behind the one shown now.
    if (o.op === "tell" || o.op === "update") {
      const opts = { back: focused()?.tab ?? null };
      const how = o.op === "update" ? await askUpdate(key, o.id, opts) : await tellTask(key, o.id, o.text, opts);
      entry.sent = how;
      if (SENT_WORDS[how]) entry.note = SENT_WORDS[how].trim();
    }
    if (o.op === "run" || o.run) {
      const n = await runOne(key, find());
      if (n) { entry.queued = n; entry.note = `Queued (${n}): at most ${taskMaxRunning()} tasks run at once. Herdr starts it when a running one ends.`; }
    }
    entry.ok = true;
  } catch (e) {
    entry.ok = false;
    entry.error = why(e);
    console.log(`ht3-panels.coord: ${entry.error}`);
  }
  ops = logOp(ops, entry);
  await writeState();
}

// Starts a task the way Tasks does, in the space that works in its repository; the tab shown now is shown again once
// the chat has started, so the coordinator's chat stays in front. Beyond the cap on running tasks (or behind others that
// wait already) it is queued instead, as is one that waits already. -> its place in the queue, or 0 when it was started.
const allTasks = () => Object.fromEntries(taskKeys().map((key) => [key, tasksOf(key)]));
async function runOne(key, t) {
  const mark = `${key}\n${t.id}`;
  if (making.has(mark)) throw new Error("This task is being started already.");
  const mk = Object.fromEntries(making);
  if (t.queued || mustQueue({ cap: taskMaxRunning(), tasks: allTasks(), facts: facts(), making: mk })) {
    update(key, (l) => enqueue(l, t.id, { at: Date.now() }));
    return placeIn(queueOf(allTasks(), mk), key, t.id) || 1;
  }
  making.set(mark, "making the worktree");
  try { await startTask(key, t, { back: focused()?.tab ?? null, step: (words) => making.set(mark, words) }); }
  finally { making.delete(mark); }
  return 0;
}

// Each pass of writeState: the queue (taskqueue.js). A queued task that was marked done leaves it; the oldest queued
// ones are started into the free slots (all of them once the cap is gone). A start is not awaited: `making` holds its
// slot from here on, and then its chat does. One the keeper began before a restart (`started`, with no start under way)
// is begun again. Nothing is started before the settings file was read (the cap isn't known) or while a machine's layout loads.
function drain(tasks, f) {
  if (!prefsRead() || machines().some((m) => m.layout === "loading")) return;
  for (const [key, list] of Object.entries(tasks)) if (list.some((t) => t.queued && t.done)) update(key, (l) => l.map((t) => (t.queued && t.done ? unqueued(t) : t)));
  for (const q of queueDue({ cap: taskMaxRunning(), tasks, facts: f, making: Object.fromEntries(making) })) startQueued(q.key, q.id);
}
function startQueued(key, id) {
  const mark = markOf(key, id), t = tasksOf(key).find((x) => x.id === id), q = t?.queued;
  if (!q || t.done || making.has(mark)) return;
  making.set(mark, "making the worktree");
  update(key, (l) => patch(l, id, { queued: { ...q, started: Date.now() } }));
  const entry = { at: Date.now(), op: "start", project: parseKey(key)?.root ?? null, id };
  // Where the person stood when they asked, if that space is still there; the tab shown now is shown again after.
  const space = q.space && spaces().some((s) => s.id === q.space) ? q.space : undefined;
  startTask(key, t, { ...(q.cwd ? { cwd: q.cwd } : {}), ...(space ? { space } : {}), back: focused()?.tab ?? null, step: (words) => making.set(mark, words) })
    .then(() => { entry.ok = true; })
    .catch((e) => {
      entry.ok = false;
      entry.error = why(e);
      console.log(`ht3-panels.coord: start of ${id}: ${entry.error}`);
      update(key, (l) => l.map((x) => (x.id === id ? { ...unqueued(x), startError: entry.error } : x)));
    })
    .finally(() => { making.delete(mark); ops = logOp(ops, entry); });
}

// ---- the state file ----

// A chat's last reply, read from its saved state: again when its state or its count of turns changed, and every ten
// seconds while it works.
async function replyOf(chat, stamp, working) {
  const had = replies.get(chat), now = Date.now();
  if (had && had.stamp === stamp && !(working && now - had.at > REPLY_EVERY_MS)) return had.text;
  let text = had?.text ?? null;
  try { text = lastReply(JSON.parse(await readTextFile(`${chatsDir()}/${chat}/state.json`))?.transcript?.items, REPLY_MAX) ?? text; } catch {}
  replies.set(chat, { stamp, at: now, text });
  return text;
}

// Each pass of writeState: reads the worktrees that are due (not awaited: the next pass writes what they found). A
// task that was run and isn't merged is read when it wasn't yet, when its chat's state changed, and every
// WORK_EVERY_MS while it is open; a done one is not read again on the clock.
function lookAtWork(tasks, f) {
  const now = Date.now(), have = new Set();
  for (const [key, list] of Object.entries(tasks)) for (const t of list) {
    if (!t.run?.path || t.run.merged) continue;
    const mark = `${key}\n${t.id}`, state = chatState(t.run, f).state, had = looked.get(mark);
    have.add(mark);
    if (looking.has(mark) || (had && had.chat === t.run.chat && had.state === state && (t.done || now - had.at < WORK_EVERY_MS))) continue;
    looking.add(mark);
    looked.set(mark, { at: now, state, chat: t.run.chat });
    readWork(exec, t.run).then((w) => setWork(mark, w)).catch(() => null).finally(() => looking.delete(mark));
  }
  for (const mark of looked.keys()) if (!have.has(mark)) looked.delete(mark);
  const all = workAll(), gone = Object.keys(all).filter((mark) => !have.has(mark));
  if (gone.length) for (const mark of gone) setWork(mark, null);
}

// Each pass of writeState: a task marked ready whose branch moved since, or whose agent works again, isn't ready any
// more (tasklist.js readyStale): the mark goes, and with it the row's badge and the Agents list's row. And a task whose
// Merge conflicted and whose branch moved since (its agent rebased) no longer says "Conflicts with" (conflictGone).
function staleMarks(keys, f) {
  const work = workAll();
  for (const key of keys) {
    const why = (t) => [readyStale(t.run, work[`${key}\n${t.id}`], t.run ? chatState(t.run, f).state : null), conflictGone(t.run, work[`${key}\n${t.id}`])];
    const gone = tasksOf(key).map((t) => ({ id: t.id, why: why(t) })).filter((g) => g.why[0] || g.why[1]);
    if (!gone.length) continue;
    for (const g of gone) console.log(`ht3-panels.coord: ${g.id}: ${g.why.filter(Boolean).join(" ")}`);
    update(key, (l) => l.map((t) => { const g = gone.find((x) => x.id === t.id); if (!g) return t; const a = g.why[0] ? { ...t, ...unready(t) } : t; return g.why[1] ? { ...a, ...unconflict(a) } : a; }));
  }
}

// The keeper's, every two seconds and after each command: state.json as things are now, written when it changed.
export async function writeState() {
  if (writing) return;
  writing = true;
  try {
    const keys = taskKeys();
    for (const key of keys) observe(key);
    let tasks = Object.fromEntries(keys.map((key) => [key, tasksOf(key)]));
    if (!cutRead) { cutRead = true; await readCut(tasks); }
    const f = facts(), { turns, places, status } = f;
    staleMarks(keys, f);
    tasks = Object.fromEntries(keys.map((key) => [key, tasksOf(key)]));
    drain(tasks, f);
    tasks = Object.fromEntries(keys.map((key) => [key, tasksOf(key)]));
    lookAtWork(tasks, f);
    const said = {};
    for (const t of Object.values(tasks).flat()) {
      if (!t.run) continue;
      const tab = places[t.run.chat]?.tab, word = status[tab] ?? "";
      said[t.run.chat] = await replyOf(t.run.chat, `${word}:${turns[tab] ?? 0}`, word === "working");
    }
    for (const chat of replies.keys()) if (!(chat in said)) replies.delete(chat);
    const body = snapshot({ spaces: spaces(), tasks, facts: f, replies: said, making: Object.fromEntries(making), ops, skip: coordDir(), work: workAll(), cap: taskMaxRunning() });
    const text = JSON.stringify(body, null, 2) + "\n";
    if (text !== written) {
      await exec("mkdir", ["-p", coordDir()]).catch(() => null);
      await put(`${coordDir()}/state.json`, text);
      written = text;
    }
    notices(body, f);
    wake(tasks, f).catch((e) => console.log(`ht3-panels coordinator wake: ${why(e)}`));
  } catch (e) { console.log(`ht3-panels coordinator state: ${why(e)}`); }
  writing = false;
}

// ---- what the coordinator is told ----

// A message for a chat, by its id: tasks.js `postTo` (shared "ht3-panels.post", which chat.js `takePosts` sends).
export { postTo };

// Whether there is a coordinator chat to tell: its tab is open, or stands in its space from before a restart.
const chatOpen = (f) => f.tabs.has(f.places[CHAT]?.tab) || spaces().some((s) => !s.machine && s.folder === coordDir() && s.tabs.some((t) => t.name === SPACE));

// Each pass of writeState: the tasks whose chat came into a state worth telling (coord-data.js noticeDiff) wait in
// `due`, and go to the coordinator chat as one message, the first at once, then at most one in NOTICE_EVERY_MS. A task
// that left that state before the message went (the person answered its approval) is not told. The first pass after
// a load tells nothing: a reload or a restart doesn't say it all again.
function notices(body, f) {
  const now = taskStates(body), on = coordinatorNotify() && chatOpen(f);
  if (on) for (const n of noticeDiff(seen, now)) due.set(n.key, n.state);
  // A Merge that conflicted is told at once, on its own: the person just clicked, and `update` is the next step.
  const hit = on ? conflictNews(seen, now) : [];
  if (hit.length) postTo(CHAT, conflictText(hit));
  // Turns a restart cut off, once per mark: which tasks, and whether the coordinator's own was one.
  const stopped = on ? restartNews(now, f.cut) : [], own = on && !!f.cut[CHAT] && !f.cut[CHAT].told;
  if (stopped.length || own) {
    postTo(CHAT, restartText(stopped, own));
    const cut = { ...cutAll() };
    for (const chat of [...stopped.map((t) => t.chat), ...(own ? [CHAT] : [])]) if (cut[chat]) cut[chat] = { ...cut[chat], told: Date.now() };
    setShared(`${MOD}.cut`, cut);
  }
  for (const [k, state] of due) if (!on || now[k]?.state !== state) due.delete(k);
  seen = now;
  if (!due.size || Date.now() - noticedAt < NOTICE_EVERY_MS) return;
  postTo(CHAT, noticeText([...due.keys()].map((k) => now[k])));
  due.clear();
  noticedAt = Date.now();
}

// ---- after a restart ----

// The first pass after a load: the coordinator's chat and every open task's (run, not merged, not done) that has no
// copy running has its saved state read; one that says a turn was running was cut off (a chat with a copy says so
// itself as it loads, chat.js). Marks of chats that are none of these go.
async function readCut(tasks) {
  const live = mountedChats(), chats = new Set([CHAT, ...Object.values(tasks).flat().filter((t) => t.run?.chat && !t.run.merged && !t.done).map((t) => t.run.chat)]);
  for (const chat of chats) {
    if (live.has(chat) || cutAll()[chat]) continue;
    if (savedCut(await readTextFile(`${chatsDir()}/${chat}/state.json`).catch(() => null))) markCut(chat);
  }
  const all = cutAll(), kept = Object.fromEntries(Object.entries(all).filter(([chat]) => chats.has(chat) || live.has(chat)));
  if (Object.keys(kept).length !== Object.keys(all).length) setShared(`${MOD}.cut`, kept);
}

// What is in front: the focused pane's space and tab, else the shown space's shown tab.
function inFront() {
  const f = focused();
  if (f?.space && f.tab) return { space: f.space, tab: f.tab, pane: f.pane ?? null };
  const s = spaces().find((x) => x.active), t = s?.tabs.find((c) => c.active);
  return s && t ? { space: s.id, tab: t.id, pane: null } : null;
}

// A chat started by wake hasn't been drawn, so it can't find its pane by itself (report.js place): the one chat pane
// of its tab that no chat has is its own. Only said once its copy runs: then the tab was the right one.
function givePlace(chat, tab) {
  const places = shared(`${MOD}.places`) ?? {};
  if (places[chat]) return;
  const taken = new Set(Object.values(places).map((at) => at?.pane)), mine = panes().filter((p) => p.mod === MOD && p.tab === tab && !taken.has(p.pane));
  if (mine.length === 1) setShared(`${MOD}.places`, { ...places, [chat]: { pane: mine[0].pane, tab } });
}

// Each pass of writeState: chats with posts waiting and no copy running are started (coord-data.js wakeDue: each once
// per batch of posts). Herdr has no command that starts a pane's mod in the background (tab.select, tab.new and
// pane.focus take no such argument, and a copy starts the first time it shows), so each one's tab is shown until its
// copy began (at most two seconds), all in one go, and then the person's space, tab and pane are shown again
// (wakeSteps). Should the person go elsewhere meanwhile, nothing more is touched but settling again a settled tab shown. A tab is never opened here: a chat
// with no tab waits (tasks.js wakeChat opens a closed task's again when it is told something).
async function wake(tasks, f) {
  if (waking || machines().some((m) => m.layout === "loading")) return;
  const due = wakeDue({ posts: shared(`${MOD}.post`) ?? {}, mounted: mountedChats(), tried: Object.fromEntries(woke), now: Date.now() });
  if (!due.length) return;
  const all = spaces(), where = { spaces: all, places: f.places, tasks, coord: { chat: CHAT, folder: coordDir(), name: SPACE } };
  const targets = due.map((d) => ({ ...d, ...wakeTab(d.chat, where) })).filter((t) => t.tab);
  const plan = wakeSteps(targets, inFront(), all);
  if (!plan) return;
  waking = true;
  const passed = new Set();
  let back = false;
  try {
    let shown = inFront().tab, moved = false;
    for (const t of plan.show) {
      if (inFront()?.tab !== shown) return; // the person went elsewhere: where they are is theirs
      woke.set(t.chat, { at: Date.now(), post: targets.find((x) => x.chat === t.chat).post });
      for (const [name, args] of t.steps) run(name, args);
      passed.add(t.tab);
      for (let i = 0; i < 40 && !mountedChats().has(t.chat); i++) await nap(50);
      if (mountedChats().has(t.chat)) givePlace(t.chat, t.tab);
      else console.log(`ht3-panels coordinator wake: the chat ${t.chat} didn't start in its tab.`);
      const now = inFront()?.tab;
      if (now === t.tab) { shown = t.tab; moved = true; }
      else if (now !== shown) return;
    }
    if (moved) { for (const [name, args] of plan.back) run(name, args); back = true; }
  } finally {
    // The person moved before back ran: a settled tab that was shown is settled again, unless it is where they are now.
    for (const id of resettleAfter(plan, passed, inFront()?.tab, back)) run("tab.settle", { id });
    waking = false;
  }
}

// ---- the chat ----

// The folder's files, when there are none or they are an older template's (the version is kept beside them).
async function ensureFolder() {
  const dir = coordDir(), mark = `${dir}/.template-version`, had = await readTextFile(mark).catch(() => null);
  if (!templateDue(had, VERSION)) return;
  // A coordinator chat started on an older template read that one when its session began: tell it to read the new one.
  if (had != null) postTo(CHAT, `Herdr updated your instructions: CLAUDE.md in your folder is now version ${VERSION}. Read it again before you act.`);
  await exec("mkdir", ["-p", `${dir}/.claude`]);
  const text = roleText(dir, chatsDir());
  await put(`${dir}/CLAUDE.md`, text);
  await put(`${dir}/AGENTS.md`, text);
  await put(`${dir}/.claude/settings.json`, SETTINGS);
  await put(mark, `${VERSION}\n`);
}

// Shows the coordinator chat: its tab if it is open, else a new tab for it (a closed chat's saved state comes back with
// it) in the Coordinator space, which is made once at the coordinator's folder.
export async function openCoordinator() {
  const dir = coordDir();
  await ensureFolder();
  await writeState();
  const tabs = new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id))), at = (shared(`${MOD}.places`) ?? {})[CHAT];
  if (at && tabs.has(at.tab)) { run("tab.select", { id: at.tab }); if (at.pane) run("pane.focus", { pane: at.pane }); return; }
  const mine = () => spaces().find((s) => !s.machine && s.folder === dir);
  let sp = mine();
  if (!sp) {
    run("space.new", { name: SPACE, folder: dir, machine: "" });
    for (let i = 0; i < 30 && !(sp = mine()); i++) await nap(100);
    if (!sp) throw new Error("The Coordinator space didn't come up.");
  }
  // Its tab from before a restart has no place until it is shown: it is the one named after it.
  const had = sp.tabs.find((t) => t.name === SPACE);
  if (had) return void run("tab.select", { id: had.id });
  const found = await detect(null), agent = AGENTS.find((a) => a.id === roleAgent("coordinator", found.found));
  if (!agent) {
    notify({ title: "Coordinator", body: "No chat agent is installed and turned on (Settings).", level: "warning" });
    throw new Error("No chat agent is installed and turned on.");
  }
  const set = roleSet("coordinator", agent.id);
  run("tab.new", { mod: MOD, space: sp.id, name: SPACE,
    props: { panel: "chat", chat: CHAT, agent: [found.found[agent.argv[0]], ...agent.argv.slice(1)], cwd: dir, machine: null, ...(set ? { set } : {}) } });
}
