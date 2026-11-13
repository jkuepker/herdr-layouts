// The coordinator's logic (coordinator.js), as pure functions: no Herdr imports, so node can test it.

import { queueOf, placeIn, runningCount, cleanCap } from "./taskqueue.js";
import { chatState, clip, TITLE_MAX, NOTE_MAX, READY_NOTE_MAX, TELL_MAX, parseKey, hasWork, conflictGone } from "./tasklist.js";

export const OPS = ["add", "run", "done", "delete", "answer", "ready", "tell", "update"];
export const OPS_KEPT = 20;
// A task id the caller may choose: letters, digits, ".", "_" and "-", at most 64.
export const cleanId = (id) => (typeof id === "string" || typeof id === "number") && /^[\w.-]{1,64}$/.test(String(id)) ? String(id) : null;

// "~" and "~/x" as the person's folder; a trailing "/" goes.
export function expandHome(path, home) {
  const p = String(path ?? "").trim();
  const full = p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;
  return full.length > 1 ? full.replace(/\/+$/, "") : full;
}

// What `coord:<json>` carries -> { op, project (a folder, absolute), machine, id, title, note, run, done }, or { error }.
// add: { project, title, note?, run?, id?, machine? }; run, done, delete: { project, id, machine? } (done: false reopens;
// a run beyond the cap on running tasks queues the task, coordinator.js runOne);
// answer: { project, id, ask, option, machine? } -> { op, project, machine, id, ask, option } (the ids as strings);
// ready: { project, id, note?, machine? } -> { op, project, machine, id, note } (the task's work can be merged, and why);
// tell: { project, id, text, machine? } -> { op, project, machine, id, text } (a message for the task's own agent, at most TELL_MAX);
// update: { project, id, machine? } -> { op, project, machine, id } (after a conflict: its agent is asked to rebase, tasklist.js updateText).
export function parseOp(text, home = "") {
  let o;
  try { o = JSON.parse(text); } catch (e) { return { error: `Not JSON: ${String(e?.message ?? e)}` }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "Not a JSON object." };
  if (!OPS.includes(o.op)) return { error: `Unknown op ${JSON.stringify(o.op ?? null)}: one of ${OPS.join(", ")}.` };
  const project = expandHome(o.project, home);
  if (!project.startsWith("/")) return { op: o.op, error: "project must be a folder's absolute path." };
  const machine = typeof o.machine === "string" && o.machine.trim() ? o.machine.trim() : null;
  const id = cleanId(o.id);
  if (o.id != null && !id) return { op: o.op, project, error: "id may hold letters, digits, '.', '_' and '-' only (at most 64)." };
  if (o.op === "answer") {
    if (!id) return { op: o.op, project, error: "id is missing." };
    const word = (v) => (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim() : null;
    const ask = word(o.ask), option = word(o.option);
    if (!ask) return { op: o.op, project, id, error: "ask is missing: the id of the task's ask in state.json." };
    if (!option) return { op: o.op, project, id, error: "option is missing: one of the ask's optionIds." };
    return { op: "answer", project, machine, id, ask, option };
  }
  if (o.op === "ready") return id ? { op: "ready", project, machine, id, note: clip(String(o.note ?? "").replace(/\s+/g, " "), READY_NOTE_MAX) } : { op: o.op, project, error: "id is missing." };
  if (o.op === "tell") {
    if (!id) return { op: o.op, project, error: "id is missing." };
    const text = typeof o.text === "string" ? clip(o.text, TELL_MAX) : "";
    return text ? { op: "tell", project, machine, id, text } : { op: o.op, project, id, error: "text is missing: what to tell the task's agent." };
  }
  if (o.op === "update") return id ? { op: "update", project, machine, id } : { op: o.op, project, error: "id is missing." };
  if (o.op !== "add") return id ? { op: o.op, project, machine, id, done: o.done !== false } : { op: o.op, project, error: "id is missing." };
  const title = clip(String(o.title ?? "").split("\n")[0], TITLE_MAX);
  if (!title) return { op: o.op, project, error: "title is missing." };
  return { op: "add", project, machine, id, title, note: clip(o.note, NOTE_MAX), run: o.run === true };
}

// An approval's answer, checked against the ask that waits now (`pending`: shared "ht3-panels.asks" for the task's tab,
// or null): the ask must be that one (an older id is stale: the agent asks something else by now) and the option one of
// its own. An option that stays in force ("allow_always", "reject_always") is the person's to pick, never a command's.
// -> { ask, optionId, title, name } or { error }.
export function pickAnswer(pending, ask, option) {
  if (!pending || !Array.isArray(pending.options)) return { error: "This task's chat asks nothing now." };
  if (String(pending.id) !== String(ask)) return { error: `Stale ask ${ask}: the chat now asks ${pending.id} (${clip(pending.title, 80)}). Read state.json again.` };
  const o = pending.options.find((x) => String(x.optionId) === String(option));
  if (!o) return { error: `This ask has no option ${option}: one of ${pending.options.map((x) => x.optionId).join(", ")}.` };
  if (/_always$/.test(String(o.kind ?? ""))) return { error: `Option ${option} stays in force (${o.kind}): that one is the person's to pick.` };
  return { ask: pending.id, optionId: o.optionId, title: String(pending.title ?? ""), name: String(o.name ?? o.optionId) };
}

// Whether `ready` may mark a task (`work`: its worktree as read now, or undefined when it wasn't read; `state`: its
// chat's state): it was run, isn't merged, its agent isn't at work (what it would still write was not looked at), and
// it has something to merge as far as is known, and its branch is not the one a Merge just conflicted on (it has to
// move first: `update`). -> null, or the reason it may not.
export function readyCheck(t, work, state = null) {
  if (!t?.run) return "This task was never run: there is nothing to merge.";
  if (t.run.merged) return "This task is merged already.";
  if (state === "interrupted") return "This task's turn was cut off by a restart: have its agent go on first (tell).";
  if (state === "working" || state === "waiting") return state === "waiting" ? "This task's agent waits for an answer: it isn't finished." : "This task's agent is still working: wait until it is done.";
  if (work?.missing) return "This task's worktree is gone.";
  if (work && !hasWork(work)) return "This task's branch has no commits ahead of the branch it was made from and no uncommitted changes: there is nothing to merge.";
  const c = t.run.conflict;
  if (c?.head && work && work.branch !== t.run.branch) return "This task's worktree is not on its branch (a rebase is under way?): it isn't finished.";
  if (c?.head && work && !conflictGone(t.run, work)) return `This task's branch still conflicts with ${c.onto ?? "the branch it was made from"} (it has not moved since the merge was aborted): send it back to its agent with update first.`;
  return null;
}

// The last results, newest last, for the state file: what was asked and how it went.
export const logOp = (log, entry) => [...(log ?? []), entry].slice(-OPS_KEPT);

// The state file's body. `tasks`: shared "ht3-panels.tasks" cleaned ({ key: [task] }); `facts`: what chatState reads
// ({ places, status, turns, tabs, now }, and `asks`: shared "ht3-panels.asks", tab -> the approval its chat waits for);
// `replies`: chat id -> its last reply's first line; `making`: "<key>\n<task id>" ->
// what a run that hasn't made its chat yet is doing; `skip`: a folder whose space isn't a project's (the coordinator's own);
// `work`: "<key>\n<task id>" -> its worktree as last read (tasklist.js readWork).
// `cap`: the cap on running tasks (settings.js taskMaxRunning; 0: none), written as `limit`: { max, running, queued }.
// A task's state: "none" (never run), "making", "queued" (it waits for a free slot under the cap, taskqueue.js; `queued`
// is its place in the queue, from 1), or chatState's: starting, working, waiting, done, failed, closed,
// interrupted (`facts.cut`: its turn was cut off by a restart; `why` says so).
// A task whose chat waits for an approval has it as `ask`: { id, title, options: [{ optionId, name, kind }] }.
// A task that was run also says how its work stands: `from` (the branch its own was made from), `ahead` (its commits
// ahead of that; null: not read yet, or its worktree is gone), `dirty` (it has uncommitted changes), `ready` (marked
// ready to merge), `merged` (the person merged it) and `conflict` (null, or { onto, files, at, asked }: the person's
// Merge into `onto` was aborted on a conflict in those files and the branch hasn't moved since; asked: its agent was
// asked to update it).
export function snapshot({ spaces = [], tasks = {}, facts = {}, replies = {}, making = {}, ops = [], skip = null, work = {}, cap = 0 } = {}) {
  const queue = queueOf(tasks, making);
  return {
    spaces: spaces.filter((s) => !skip || s.folder !== skip).map((s) => ({ name: String(s.name ?? "").replace(/​/g, ""), folder: s.folder ?? "", machine: s.machine ?? null })),
    projects: Object.keys(tasks).sort().map((key) => {
      const at = parseKey(key);
      return at && {
        project: at.root, machine: at.on,
        tasks: tasks[key].map((t) => {
          const busy = making[`${key}\n${t.id}`], s = t.run ? chatState(t.run, facts) : null;
          const ask = !busy && s?.tab ? facts.asks?.[s.tab] : null;
          const w = t.run && !t.run.merged ? work[`${key}\n${t.id}`] : null;
          const place = busy ? 0 : placeIn(queue, key, t.id);
          return { id: t.id, title: t.title, note: t.note, done: t.done, state: busy ? "making" : place ? "queued" : s?.state ?? "none",
            ...(place ? { queued: place } : {}),
            ...(s?.why && !busy ? { why: s.why } : {}),
            ...(ask?.id && Array.isArray(ask.options) ? { ask: { id: String(ask.id), title: String(ask.title ?? ""), options: ask.options.map((o) => ({ optionId: o.optionId, name: o.name ?? null, kind: o.kind ?? null })) } } : {}),
            branch: t.run?.branch ?? null, from: t.run?.from ?? null, ahead: w && !w.missing ? w.ahead ?? null : null, dirty: !!w && !w.missing && w.dirty > 0,
            ready: !!t.run?.ready, merged: !!t.run?.merged,
            conflict: t.run?.conflict && !t.run.merged ? { onto: t.run.conflict.onto ?? null, files: t.run.conflict.files ?? [], at: t.run.conflict.at ?? 0, asked: !!t.run.conflict.asked } : null, path: t.run?.path ?? null, chat: t.run?.chat ?? null, lastReply: (t.run && replies[t.run.chat]) || null };
        }),
      };
    }).filter(Boolean),
    limit: { max: cleanCap(cap), running: runningCount({ tasks, facts, making }), queued: queue.length },
    ops,
  };
}

// Whether the coordinator's folder needs its files written: none there yet, or an older template's.
export const templateDue = (have, version) => !(Number(String(have ?? "").trim()) >= version);

// ---- task notices ----

// The states the coordinator is told about when a task's chat comes into one. The others (none, making, starting,
// working) are steps on the way, and a task's `done` mark is the coordinator's or the person's own doing.
export const NOTICE_STATES = ["done", "failed", "waiting", "closed"];
export const NOTICE_TITLE_MAX = 60, NOTICE_REPLY_MAX = 160, NOTICE_MAX = 8;

// A state file's tasks by "<machine or empty>:<project>\n<task id>", each with its project, for noticeDiff.
export function taskStates(body) {
  const all = {};
  for (const p of body?.projects ?? []) for (const t of p.tasks ?? []) all[`${p.machine ?? ""}:${p.project}\n${t.id}`] = { ...t, project: p.project, machine: p.machine ?? null };
  return all;
}

// The tasks whose chat's state changed into one of NOTICE_STATES between two passes (`prev`, `now`: taskStates).
// With no pass before (`prev` null: the mod was just loaded) nothing is told, and neither is a task the pass before
// didn't have: what stood that way already is not news. A closed chat shown again ("closed" to "done") finished before.
export function noticeDiff(prev, now) {
  if (!prev) return [];
  return Object.keys(now ?? {}).filter((k) => {
    const was = prev[k]?.state, is = now[k].state;
    return was != null && was !== is && NOTICE_STATES.includes(is) && !(was === "closed" && is === "done");
  }).map((k) => ({ key: k, ...now[k] }));
}

// One short message for a batch of them, as the coordinator chat gets it.
export function noticeText(list) {
  const one = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const lines = list.slice(0, NOTICE_MAX).map((t) => {
    const more = t.state === "waiting" && t.ask ? ` — asks: ${one(t.ask.title, NOTICE_REPLY_MAX)} (ask ${t.ask.id})`
      : t.state === "failed" && t.why ? ` — ${one(t.why, NOTICE_REPLY_MAX)}`
      : t.lastReply ? ` — last reply: ${one(t.lastReply, NOTICE_REPLY_MAX)}` : "";
    return `${String(t.project ?? "").split("/").filter(Boolean).pop() ?? "/"}${t.machine ? ` on ${t.machine}` : ""} / ${t.id} "${one(t.title, NOTICE_TITLE_MAX)}": ${t.state}${more}`;
  });
  const rest = list.length - lines.length;
  return `Task updates (from Herdr): ${lines.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}. Read state.json and act per your rules.`;
}

// The tasks whose Merge conflicted between two passes (`prev`, `now`: taskStates): a conflict mark that wasn't there, or
// is a newer one. Nothing on the first pass after a load, as with noticeDiff.
export function conflictNews(prev, now) {
  if (!prev) return [];
  return Object.keys(now ?? {}).filter((k) => prev[k] && now[k].conflict && prev[k].conflict?.at !== now[k].conflict.at).map((k) => ({ key: k, ...now[k] }));
}
// One short message for them, as the coordinator chat gets it.
export function conflictText(list) {
  const one = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const lines = list.slice(0, NOTICE_MAX).map((t) => `Merge of ${String(t.project ?? "").split("/").filter(Boolean).pop() ?? "/"}${t.machine ? ` on ${t.machine}` : ""} / ${t.id} "${one(t.title, NOTICE_TITLE_MAX)}" `
    + `conflicted with ${t.conflict.onto ?? "the branch it was made from"} in ${t.conflict.files?.length ? one(t.conflict.files.join(", "), NOTICE_REPLY_MAX) : "some files"}`);
  const rest = list.length - lines.length;
  return `Task updates (from Herdr): ${lines.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}; consider op update (it sends the task back to its own agent; don't run it again). Read state.json and act per your rules.`;
}

// ---- after a restart: interrupted turns, and chats that have no copy running ----

// Whether a chat's saved state (its state.json's text) says a turn was running: read with no copy of the chat running,
// that turn was cut off (agent-acp.js keeps the status as it was when the pane closes or the app quits).
export function savedCut(text) {
  try { return JSON.parse(text)?.status === "working"; } catch { return false; }
}

// The interrupted tasks the coordinator wasn't told about yet (`now`: taskStates; `cut`: shared "ht3-panels.cut").
export const restartNews = (now, cut = {}) => Object.keys(now ?? {}).filter((k) => now[k].state === "interrupted" && cut[now[k].chat] && !cut[now[k].chat].told).map((k) => ({ key: k, ...now[k] }));
// One message for them, as the coordinator chat gets it. `own`: the coordinator's own turn was cut off too.
export function restartText(list, own = false) {
  const one = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const lines = list.slice(0, NOTICE_MAX).map((t) => `${String(t.project ?? "").split("/").filter(Boolean).pop() ?? "/"}${t.machine ? ` on ${t.machine}` : ""} / ${t.id} "${one(t.title, NOTICE_TITLE_MAX)}"`);
  const rest = list.length - lines.length;
  const tasks = lines.length ? ` these tasks' turns were cut off: ${lines.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}; use op tell to have each one's agent continue where it stopped, or ask the person.` : "";
  return `Task updates (from Herdr): Herdr restarted;${tasks}${own ? `${tasks ? " Y" : " y"}our own turn was cut off too: go on where you stopped.` : ""} Read state.json and act per your rules.`;
}

// A post is left alone this long before its chat is started for it: a chat that is just being made takes it by itself.
export const WAKE_AFTER_MS = 3000;
// A chat that was started once for its posts is started again only for a newer post, and not sooner than this.
export const WAKE_AGAIN_MS = 30000;
// The chats to start: the ones with posts waiting (`posts`: shared "ht3-panels.post") that have no copy running
// (`mounted`: a Set of chat ids, report.js mountedChats) and weren't tried for these posts (`tried`: chat id ->
// { at, post }: when, and the newest post's time then). -> [{ chat, post (its newest post's time) }].
export function wakeDue({ posts = {}, mounted = new Set(), tried = {}, now = Date.now() } = {}) {
  return Object.keys(posts ?? {}).map((chat) => {
    const at = (Array.isArray(posts[chat]) ? posts[chat] : []).map((m) => Number(m?.at) || 0);
    return at.length ? { chat, post: Math.max(...at), first: Math.min(...at) } : null;
  }).filter((p) => {
    if (!p || mounted.has(p.chat) || now - p.first < WAKE_AFTER_MS) return false;
    const had = tried[p.chat];
    return !had || (p.post > had.post && now - had.at >= WAKE_AGAIN_MS);
  }).map(({ chat, post }) => ({ chat, post }));
}

// The tab a chat's pane is in: the one it reported (`places`, when that tab is open), else, as after a restart (a tab's
// id changes, so its place is gone until it is shown): the coordinator's by its space's folder and its name (`coord`:
// { chat, folder, name }), a task's by its title on its machine among the tabs no chat has (tasks.js wakeChat's match).
// `tasks`: { key: [task] }. -> { tab, space } or null (no such tab: nothing is opened for a post here).
export function wakeTab(chat, { spaces = [], places = {}, tasks = {}, coord = null } = {}) {
  const of = (id) => { const s = spaces.find((x) => x.tabs.some((c) => c.id === id)); return s ? { tab: id, space: s.id } : null; };
  const placed = places[chat]?.tab ? of(places[chat].tab) : null;
  if (placed) return placed;
  if (coord && chat === coord.chat) {
    const s = spaces.find((x) => !x.machine && x.folder === coord.folder), c = s?.tabs.find((x) => x.name === coord.name);
    return c ? { tab: c.id, space: s.id } : null;
  }
  const t = Object.values(tasks).flat().find((x) => x.run?.chat === chat && !x.run.merged);
  if (!t) return null;
  const taken = new Set(Object.values(places).map((x) => x?.tab)), name = String(t.title ?? "").slice(0, 60);
  for (const s of spaces) {
    if ((s.machine ?? null) !== (t.run.on ?? null)) continue;
    const c = s.tabs.find((x) => x.name === name && !taken.has(x.id));
    if (c) return { tab: c.id, space: s.id };
  }
  return null;
}

// How chats are started without the person losing their place: a copy starts the first time its tab shows and no
// command starts one in the background, so each tab is shown once, one after the other, and then everything is put
// back. `targets`: [{ chat, tab, space }]; `at`: what is in front now ({ space, tab, pane }); `spaces`: spaces().
// -> null (nothing to show: a target that is the shown tab starts by itself, and with no place to return to nothing
// is touched), or { show: [{ chat, tab, steps }], back, settle }, steps and back lists of [command, args]: back gives every
// other space the tab it showed before, settles again a tab that was settled, and ends on the person's space, tab and pane.
// `settle`: the ids of the settled targets (showing a tab unsettles it), for when the person moves and back isn't run.
export function wakeSteps(targets, at, spaces = []) {
  if (!at?.space || !at.tab) return null;
  const list = (targets ?? []).filter((t) => t?.tab && t.space && t.tab !== at.tab);
  if (!list.length) return null;
  const back = [], settle = [], done = new Set();
  for (const t of list) {
    const s = spaces.find((x) => x.id === t.space);
    if (s?.tabs.find((c) => c.id === t.tab)?.settled) settle.push(["tab.settle", { id: t.tab }]);
    if (!s || done.has(s.id)) continue;
    done.add(s.id);
    const was = s.tabs.find((c) => c.active);
    if (was && was.id !== at.tab && !list.some((x) => x.tab === was.id)) back.push(["space.select", { id: s.id }], ["tab.select", { id: was.id }]);
  }
  back.push(...settle, ["space.select", { id: at.space }], ["tab.select", { id: at.tab }]);
  if (at.pane) back.push(["pane.focus", { pane: at.pane }]);
  return { show: list.map((t) => ({ chat: t.chat, tab: t.tab, steps: [["space.select", { id: t.space }], ["tab.select", { id: t.tab }]] })), back, settle: settle.map(([, a]) => a.id) };
}

// When the person moved before wake's back ran (showing a tab unsettles it): which settled targets to settle again:
// those that were shown (`passed`, a Set of tab ids), except the one in front now (`front`). -> [tab id].
export function resettleAfter(plan, passed, front, backRan) {
  if (backRan || !plan?.settle) return [];
  return plan.settle.filter((id) => passed.has(id) && id !== front);
}
