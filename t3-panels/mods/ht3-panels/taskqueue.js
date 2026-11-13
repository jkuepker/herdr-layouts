// The task queue's logic (tasks.js, coordinator.js), as pure functions: no Herdr imports, so node can test it.
//
// A cap on how many tasks run at once (settings.js `taskMaxRunning`; 0: none), over every project. A task started
// beyond it waits: it keeps `queued = { at, cwd?, space?, started? }` with the task itself (shared "ht3-panels.tasks",
// so the queue is there again after a restart): when it was asked for, the folder its branch starts from and the space
// its chat goes to (Tasks' Run with agent; the coordinator's `run` has neither), and `started` once the keeper began
// to start it. The keeper (coordinator.js drain) is the only one that starts a task while a cap is set: each pass it
// starts the oldest queued ones into the free slots. A task whose start didn't work leaves the queue with `startError`.
//
// What holds a slot: a task that is being started (`making`: "<key>\n<task id>" -> words, the keeper's own), and a run
// task that isn't merged whose chat is starting, working, waiting for an approval (its agent goes on once answered) or
// interrupted by a restart (it goes on once told to). A chat that is done, failed or closed frees it, and so does a
// merged task. A task the person marked done holds one only while its agent still works.

import { chatState } from "./tasklist.js";

export const CAP_MAX = 32;
// The pref as a number: a whole number from 1 to CAP_MAX, else 0 (no cap).
export function cleanCap(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, CAP_MAX) : 0;
}
// The Settings button's choices, its words for one and the choice after one.
export const CAPS = [0, 1, 2, 3, 4, 6, 8];
export const capLabel = (n) => (cleanCap(n) ? `${cleanCap(n)} at once` : "No cap");
export const nextCap = (n) => CAPS.find((c) => c > cleanCap(n)) ?? 0;

export const HOLDS = ["making", "starting", "working", "waiting", "interrupted"];
export const markOf = (key, id) => `${key}\n${id}`;

// The marks of the tasks that hold a slot now. `tasks`: { key: [task] }; `facts`: what chatState reads.
export function holders({ tasks = {}, facts = {}, making = {} } = {}) {
  const out = new Set(Object.keys(making ?? {}));
  for (const [key, list] of Object.entries(tasks ?? {})) for (const t of list ?? []) {
    if (!t?.run || t.run.merged) continue;
    const state = chatState(t.run, facts).state;
    if (t.done ? state === "working" : HOLDS.includes(state)) out.add(markOf(key, t.id));
  }
  return out;
}
export const runningCount = (at) => holders(at).size;

// The queue, oldest first (the same moment: by project and place in its list): [{ key, id, at, n (from 1) }]. A task
// marked done waits for nothing, and one that is being started (`making`) has left it.
export function queueOf(tasks = {}, making = {}) {
  const out = [];
  let i = 0;
  for (const key of Object.keys(tasks ?? {}).sort()) for (const t of tasks[key] ?? []) {
    i++;
    if (t?.queued && !t.done && !(markOf(key, t.id) in (making ?? {}))) out.push({ key, id: t.id, at: Number(t.queued.at) || 0, i });
  }
  return out.sort((a, b) => a.at - b.at || a.i - b.i).map(({ key, id, at }, n) => ({ key, id, at, n: n + 1 }));
}
// A task's place in the queue from 1, or 0 when it isn't in it.
export const placeIn = (queue, key, id) => queue.find((q) => q.key === key && q.id === id)?.n ?? 0;

// Whether a task asked for now has to wait: a cap is set, and it is reached or others wait already (they go first).
export function mustQueue({ cap = 0, tasks = {}, facts = {}, making = {} } = {}) {
  const max = cleanCap(cap);
  return max > 0 && (runningCount({ tasks, facts, making }) >= max || queueOf(tasks, making).length > 0);
}
// The queued tasks to start now: the oldest into the free slots; all of them when there is no cap (it was taken away).
export function due({ cap = 0, tasks = {}, facts = {}, making = {} } = {}) {
  const max = cleanCap(cap), queue = queueOf(tasks, making);
  if (!max) return queue;
  return queue.slice(0, Math.max(0, max - runningCount({ tasks, facts, making })));
}

// A task without its place in the queue (and without what the last start said).
export function unqueued(t) {
  const { queued, startError, ...rest } = t;
  return rest;
}
// The list with the task `id` queued (`q`: { at, cwd?, space? }); one that waits already keeps its place.
export const enqueue = (list, id, q) => list.map((t) => (t.id === id && !t.queued ? { ...unqueued(t), queued: q } : t));
// The list with the task `id` out of the queue.
export const dequeue = (list, id) => list.map((t) => (t.id === id && t.queued ? unqueued(t) : t));
// The row's words.
export const queuedWords = (n) => (n > 0 ? `Queued (${n})` : "Queued");
