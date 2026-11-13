// node t3-panels/tests/taskqueue.test.mjs
import assert from "node:assert/strict";
import { cleanCap, capLabel, nextCap, CAPS, CAP_MAX, holders, runningCount, queueOf, placeIn, mustQueue, due, enqueue, dequeue, unqueued, queuedWords, markOf } from "../mods/ht3-panels/taskqueue.js";
import { cleanTasks } from "../mods/ht3-panels/tasklist.js";
import { snapshot } from "../mods/ht3-panels/coord-data.js";

// The pref: a whole number from 1 to CAP_MAX, else no cap.
assert.equal(cleanCap(undefined), 0); assert.equal(cleanCap(0), 0); assert.equal(cleanCap(-2), 0); assert.equal(cleanCap("x"), 0);
assert.equal(cleanCap(2), 2); assert.equal(cleanCap("3"), 3); assert.equal(cleanCap(2.9), 2); assert.equal(cleanCap(1000), CAP_MAX);
assert.equal(capLabel(0), "No cap"); assert.equal(capLabel(2), "2 at once");
assert.deepEqual(CAPS.map(nextCap), [1, 2, 3, 4, 6, 8, 0]); assert.equal(nextCap(5), 6); assert.equal(nextCap(20), 0);
assert.equal(queuedWords(2), "Queued (2)"); assert.equal(queuedWords(0), "Queued");

// Chats by state: the facts chatState reads. Chat "w" works, "b" waits for an approval, "d" is done, "c" closed, "i" interrupted.
const now = 1000000;
const facts = { places: { w: { tab: "tw" }, w2: { tab: "tw2" }, b: { tab: "tb" }, d: { tab: "td" }, s: { tab: "ts" } }, status: { tw: "working", tw2: "working", tb: "blocked", td: "done", ts: "idle" },
  turns: {}, tabs: new Set(["tw", "tw2", "tb", "td", "ts"]), cut: { i: { at: 1 } }, now };
const ran = (chat, more = {}) => ({ chat, branch: `task-${chat}`, path: `/wt/${chat}`, on: null, from: "main", at: now - 1000, ...more });
const task = (id, more = {}) => ({ id, title: id, note: "", done: false, at: 1, ...more });
const A = ":/a", B = ":/b";

// What holds a slot: starting, working, waiting, interrupted and a start under way; not done, failed, closed, merged.
const tasks = {
  [A]: [task("work", { run: ran("w") }), task("wait", { run: ran("b") }), task("done", { run: ran("d") }), task("closed", { run: ran("c", { worked: true }) }),
    task("cut", { run: ran("i", { worked: true }) }), task("starting", { run: ran("s") }), task("never", {})],
  [B]: [task("merged", { run: ran("w2", { merged: { at: 1, commit: "abc" } }) }), task("failed", { run: ran("x", { error: "no agent" }) }), task("old", { run: ran("gone", { at: now - 999999 }) })],
};
assert.deepEqual([...holders({ tasks, facts })].sort(), [markOf(A, "cut"), markOf(A, "starting"), markOf(A, "wait"), markOf(A, "work")].sort());
assert.equal(runningCount({ tasks, facts }), 4);
assert.equal(runningCount({ tasks, facts, making: { [markOf(B, "new")]: "making the worktree", [markOf(A, "work")]: "again" } }), 5); // a task counts once
// A task the person marked done holds a slot only while its agent still works.
assert.equal(runningCount({ tasks: { [A]: [task("x", { done: true, run: ran("w") }), task("y", { done: true, run: ran("b") })] }, facts }), 1);
assert.equal(runningCount(), 0);

// The queue: oldest first over every project; the same moment by project and place; done and starting ones are not in it.
const q = {
  [B]: [task("b1", { queued: { at: 30 } }), task("b2", { queued: { at: 10 } })],
  [A]: [task("a1", { queued: { at: 20 } }), task("a2", { queued: { at: 10 } }), task("a3", { queued: { at: 5 }, done: true }), task("a4", {})],
};
assert.deepEqual(queueOf(q).map((x) => `${x.id}:${x.n}`), ["a2:1", "b2:2", "a1:3", "b1:4"]);
assert.deepEqual(queueOf(q, { [markOf(A, "a2")]: "making" }).map((x) => x.id), ["b2", "a1", "b1"]);
assert.equal(placeIn(queueOf(q), B, "b2"), 2); assert.equal(placeIn(queueOf(q), A, "a4"), 0); assert.equal(placeIn(queueOf(q), A, "a3"), 0);
assert.deepEqual(queueOf({}), []); assert.deepEqual(queueOf(), []);

// Whether a new one has to wait.
const two = { [A]: [task("work", { run: ran("w") }), task("wait", { run: ran("b") }), task("fin", { run: ran("d") })] };
assert.equal(mustQueue({ cap: 0, tasks: two, facts }), false); // no cap
assert.equal(mustQueue({ cap: 3, tasks: two, facts }), false); // a slot is free
assert.equal(mustQueue({ cap: 2, tasks: two, facts }), true); // a waiting task still holds its slot
assert.equal(mustQueue({ cap: 1, tasks: two, facts }), true);
assert.equal(mustQueue({ cap: 3, tasks: two, facts, making: { [markOf(B, "n")]: "making" } }), true); // a start under way holds one
assert.equal(mustQueue({ cap: 5, tasks: { ...two, [B]: [task("q", { queued: { at: 1 } })] }, facts }), true); // others wait already: behind them
assert.equal(mustQueue({ cap: "junk", tasks: two, facts }), false);

// What to start now: the oldest into the free slots.
const C = ":/c", mix = { [C]: two[A], ...q }; // 2 running, 4 queued
assert.deepEqual(due({ cap: 2, tasks: mix, facts }), []);
assert.deepEqual(due({ cap: 3, tasks: mix, facts }).map((x) => x.id), ["a2"]);
assert.deepEqual(due({ cap: 4, tasks: mix, facts }).map((x) => x.id), ["a2", "b2"]);
assert.deepEqual(due({ cap: 4, tasks: mix, facts, making: { [markOf(A, "a2")]: "making" } }).map((x) => x.id), ["b2"]); // a2 is being started: it holds a slot
assert.deepEqual(due({ cap: 99, tasks: mix, facts }).map((x) => x.id), ["a2", "b2", "a1", "b1"]);
assert.deepEqual(due({ cap: 0, tasks: mix, facts }).map((x) => x.id), ["a2", "b2", "a1", "b1"]); // the cap was taken away: all go
assert.deepEqual(due({ cap: 1, tasks: mix, facts }), []); // over the cap already
// A running one ends (its chat is done): the oldest queued one is due; ready and merged ones hold nothing either.
const ended = { ...facts, status: { ...facts.status, tw: "done" } };
assert.deepEqual(due({ cap: 2, tasks: mix, facts: ended }).map((x) => x.id), ["a2"]);
const merged = { ...mix, [C]: mix[C].map((t) => (t.id === "wait" ? { ...t, run: { ...t.run, merged: { at: 1, commit: "x" } } } : t)) };
assert.deepEqual(due({ cap: 2, tasks: merged, facts }).map((x) => x.id), ["a2"]);
// One the keeper began before a restart (started, nothing under way) is still in the queue, so it is begun again.
assert.deepEqual(due({ cap: 1, tasks: { [A]: [task("r", { queued: { at: 1, started: 2 } })] }, facts }).map((x) => x.id), ["r"]);

// Into and out of the queue; a task that waits keeps its place.
let list = [task("a", { startError: "no repo" }), task("b")];
list = enqueue(list, "a", { at: 5, cwd: "/a" });
assert.deepEqual(list[0], task("a", { queued: { at: 5, cwd: "/a" } }));
assert.deepEqual(enqueue(list, "a", { at: 9 })[0].queued, { at: 5, cwd: "/a" });
assert.deepEqual(dequeue(list, "a"), [task("a"), task("b")]);
assert.equal(dequeue(list, "b")[1], list[1]);
assert.deepEqual(unqueued(task("a", { queued: { at: 1 }, startError: "x", run: ran("w") })), task("a", { run: ran("w") }));

// Kept with the task over a restart (cleanTasks), junk dropped.
const kept = cleanTasks([{ id: "a", title: "A", queued: { at: 5, cwd: "/a", space: "s1", started: 7, junk: 1 }, startError: "boom" }, { id: "b", title: "B", queued: { at: "x" } }, { id: "c", title: "C", queued: true }]);
assert.deepEqual(kept[0].queued, { at: 5, cwd: "/a", space: "s1", started: 7 }); assert.equal(kept[0].startError, "boom");
assert.equal("queued" in kept[1], false); assert.equal("queued" in kept[2], false);
assert.deepEqual(cleanTasks(JSON.parse(JSON.stringify(kept))), kept);

// state.json: a queued task's state and place, and the cap.
const snap = snapshot({ tasks: mix, facts, cap: 2, making: { [markOf(B, "b2")]: "making the worktree" } });
const byId = Object.fromEntries(snap.projects.flatMap((p) => p.tasks).map((t) => [t.id, t]));
assert.equal(byId.a2.state, "queued"); assert.equal(byId.a2.queued, 1); assert.equal(byId.a1.queued, 2); assert.equal(byId.b1.queued, 3);
assert.equal(byId.b2.state, "making"); assert.equal("queued" in byId.b2, false);
assert.equal(byId.a3.state, "none"); assert.equal(byId.work.state, "working"); assert.equal("queued" in byId.work, false);
assert.deepEqual(snap.limit, { max: 2, running: 3, queued: 3 });
assert.deepEqual(snapshot({ tasks: two, facts }).limit, { max: 0, running: 2, queued: 0 });

console.log("taskqueue ok");
