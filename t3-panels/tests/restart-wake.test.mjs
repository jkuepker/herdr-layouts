// node t3-panels/tests/restart-wake.test.mjs
// Round 27: after a Herdr restart, chats with work waiting. The pure parts: tasklist.js chatState's "interrupted",
// coord-data.js savedCut, snapshot with `cut`, restartNews, restartText, readyCheck, and the waking of chats that have
// posts but no copy running: wakeDue (which), wakeTab (where), wakeSteps (how, and back to where the person was).
import assert from "node:assert/strict";
import { chatState, STATE_LABEL, SENT_WORDS, CUT_WHY } from "../mods/ht3-panels/tasklist.js";
import { savedCut, snapshot, taskStates, noticeDiff, restartNews, restartText, readyCheck, wakeDue, wakeTab, wakeSteps, WAKE_AFTER_MS, WAKE_AGAIN_MS, NOTICE_MAX } from "../mods/ht3-panels/coord-data.js";
import { VERSION, roleText } from "../mods/ht3-panels/coord-template.js";

const run = (more = {}) => ({ chat: "c1", branch: "task-x", path: "/r/.worktrees/task-x", on: null, from: "main", at: 1, worked: true, ...more });

// ---- the saved state ----
assert.equal(savedCut(JSON.stringify({ status: "working", transcript: { items: [] } })), true);
for (const s of ["ready", "exited", "stopped", "starting"]) assert.equal(savedCut(JSON.stringify({ status: s })), false);
assert.equal(savedCut(null), false); assert.equal(savedCut("{not json"), false); assert.equal(savedCut("null"), false);

// ---- chatState ----
const tabs = new Set(["t1"]), cut = { c1: { at: 5 } };
// After a restart its tab has no place yet: interrupted, not "closed"; with no mark it is closed as before.
assert.deepEqual(chatState(run(), { tabs, cut }), { state: "interrupted", tab: null, pane: null, worked: true, why: CUT_WHY });
assert.equal(chatState(run(), { tabs }).state, "closed");
assert.equal(chatState(run({ worked: false }), { tabs, cut, now: 2 }).state, "interrupted");
// Its tab shown again (idle or an unread done): still interrupted, with its tab; working or waiting again is that.
const places = { c1: { tab: "t1", pane: "p1" } };
assert.deepEqual(chatState(run(), { places, tabs, cut, status: { t1: "idle" } }), { tab: "t1", pane: "p1", state: "interrupted", worked: true, why: CUT_WHY });
assert.equal(chatState(run(), { places, tabs, cut, status: { t1: "done" }, turns: { t1: 3 } }).state, "interrupted");
assert.equal(chatState(run(), { places, tabs, cut, status: { t1: "working" } }).state, "working");
assert.equal(chatState(run(), { places, tabs, cut, status: { t1: "blocked" } }).state, "waiting");
// Another chat's mark is not this one's; a run that never started says its own error.
assert.equal(chatState(run(), { places, tabs, cut: { other: { at: 1 } }, status: { t1: "idle" } }).state, "done");
assert.equal(chatState(run({ error: "no agent" }), { tabs, cut }).state, "failed");
assert.equal(STATE_LABEL.interrupted, "interrupted");
assert.ok(SENT_WORDS.waking.trim());

// ---- state.json and what the coordinator is told ----
const tasks = { ":/code/app": [{ id: "a", title: "Fix login", note: "", done: false, run: run() }, { id: "b", title: "Add tests", note: "", done: false, run: run({ chat: "c2" }) },
  { id: "n", title: "Never run", note: "", done: false }] };
const body = snapshot({ tasks, facts: { tabs, cut, places: {}, status: {}, turns: {} } });
const [a, b, n] = body.projects[0].tasks;
assert.equal(a.state, "interrupted"); assert.equal(a.why, CUT_WHY); assert.equal(b.state, "closed"); assert.equal(n.state, "none");
const now = taskStates(body);
// The first pass tells nothing by the ordinary notices; the restart's own notice names the cut task, once.
assert.deepEqual(noticeDiff(null, now), []);
const news = restartNews(now, cut);
assert.deepEqual(news.map((t) => t.id), ["a"]);
assert.deepEqual(restartNews(now, { c1: { at: 5, told: 9 } }), []);
assert.deepEqual(restartNews(now, {}), []); assert.deepEqual(restartNews(null, cut), []);
const text = restartText(news);
assert.equal(text, 'Task updates (from Herdr): Herdr restarted; these tasks\' turns were cut off: app / a "Fix login"; use op tell to have each one\'s agent continue where it stopped, or ask the person. Read state.json and act per your rules.');
assert.match(restartText(news, true), /or ask the person\. Your own turn was cut off too: go on where you stopped\. Read state\.json/);
assert.equal(restartText([], true), "Task updates (from Herdr): Herdr restarted; your own turn was cut off too: go on where you stopped. Read state.json and act per your rules.");
const many = Array.from({ length: NOTICE_MAX + 3 }, (_, i) => ({ project: "/code/app", machine: i ? null : "spark1", id: `t${i}`, title: "T ".repeat(80) }));
const long = restartText(many);
assert.match(long, /app on spark1 \/ t0 "/); assert.match(long, /; and 3 more; use op tell/); assert.ok(!long.includes("t9"));
// ready is refused for a task whose turn was cut off.
assert.match(readyCheck(tasks[":/code/app"][0], { ahead: 1, dirty: 0, branch: "task-x", head: "a".repeat(40) }, "interrupted"), /cut off/);
// The role text says what to do (template 8).
assert.equal(VERSION, 8);
const role = roleText("/h/coordinator", "/h/chats");
assert.match(role, /"interrupted"/); assert.match(role, /continue where it stopped/); assert.match(role, /Never run the task again for that/);

// ---- which chats to start ----
const T = 1_000_000, post = (at, text = "x") => ({ text, at });
const posts = { coordinator: [post(T - 60000), post(T - 5000)], c1: [post(T - 4000)], c2: [post(T - 100)], c3: [], c4: [post(T - 9000)] };
// Not one whose copy runs (c4), not one with nothing posted (c3), not a post too fresh (c2: a chat being made takes it itself).
assert.deepEqual(wakeDue({ posts, mounted: new Set(["c4"]), now: T }), [{ chat: "coordinator", post: T - 5000 }, { chat: "c1", post: T - 4000 }]);
assert.deepEqual(wakeDue({ posts, mounted: new Set(["c4", "coordinator", "c1"]), now: T }), []);
assert.deepEqual(wakeDue({ posts: { c2: posts.c2 }, now: T - 100 + WAKE_AFTER_MS }), [{ chat: "c2", post: T - 100 }]);
// Once per batch of posts: not again for the same posts, nor for a newer one too soon; again for a newer one later.
const tried = { c1: { at: T - 1000, post: T - 4000 } };
assert.deepEqual(wakeDue({ posts: { c1: posts.c1 }, tried, now: T + 10 * WAKE_AGAIN_MS }), []);
const newer = { c1: [...posts.c1, post(T + 500)] };
assert.deepEqual(wakeDue({ posts: newer, tried, now: T + 5000 }), []);
assert.deepEqual(wakeDue({ posts: newer, tried, now: T - 1000 + WAKE_AGAIN_MS }), [{ chat: "c1", post: T + 500 }]);
assert.deepEqual(wakeDue(), []); assert.deepEqual(wakeDue({ posts: { x: "junk" }, now: T }), []);

// ---- where its tab is ----
const tab = (id, name, more = {}) => ({ id, name, active: false, settled: false, ...more });
const spaces = [
  { id: "s1", folder: "/code/app", machine: null, active: true, tabs: [tab("t1", "1", { active: true }), tab("t2", "Fix login"), tab("t3", "Add tests", { settled: true })] },
  { id: "s2", folder: "/h/coordinator", machine: null, active: false, tabs: [tab("t4", "notes", { active: true }), tab("t5", "Coordinator")] },
  { id: "s3", folder: "/code/app", machine: "spark1", active: false, tabs: [tab("t6", "Fix login", { active: true })] },
];
const coord = { chat: "coordinator", folder: "/h/coordinator", name: "Coordinator" };
const where = { spaces, places: {}, tasks, coord };
assert.deepEqual(wakeTab("coordinator", where), { tab: "t5", space: "s2" });
// A task's restored tab by its title, on its own machine, among the tabs no chat has.
assert.deepEqual(wakeTab("c1", where), { tab: "t2", space: "s1" });
assert.deepEqual(wakeTab("c2", where), { tab: "t3", space: "s1" });
assert.deepEqual(wakeTab("c1", { ...where, tasks: { "spark1:/code/app": [{ id: "a", title: "Fix login", run: run({ on: "spark1" }) }] } }), { tab: "t6", space: "s3" });
assert.equal(wakeTab("c1", { ...where, places: { old: { tab: "t2", pane: "p" } } }), null);
// The place it reported wins while that tab is open; a place whose tab is gone doesn't count.
assert.deepEqual(wakeTab("c1", { ...where, places: { c1: { tab: "t4", pane: "p" } } }), { tab: "t4", space: "s2" });
assert.deepEqual(wakeTab("c1", { ...where, places: { c1: { tab: "gone", pane: "p" } } }), { tab: "t2", space: "s1" });
// No tab: nothing (never a new one); a merged task's chat, an unknown chat, no Coordinator tab.
assert.equal(wakeTab("zz", where), null);
assert.equal(wakeTab("c1", { ...where, tasks: { ":/code/app": [{ id: "a", title: "Fix login", run: run({ merged: { at: 1 } }) }] } }), null);
assert.equal(wakeTab("coordinator", { ...where, spaces: spaces.slice(0, 1) }), null);

// ---- how, and back ----
const at = { space: "s1", tab: "t1", pane: "p9" };
// The coordinator's tab in another space: shown, then that space gets the tab it showed before, then the person's own.
assert.deepEqual(wakeSteps([{ chat: "coordinator", tab: "t5", space: "s2" }], at, spaces), {
  show: [{ chat: "coordinator", tab: "t5", steps: [["space.select", { id: "s2" }], ["tab.select", { id: "t5" }]] }],
  back: [["space.select", { id: "s2" }], ["tab.select", { id: "t4" }], ["space.select", { id: "s1" }], ["tab.select", { id: "t1" }], ["pane.focus", { pane: "p9" }]],
  settle: [],
});
// Several in one go, one return; a tab of the person's own space needs no other tab put back; a settled one is settled again.
const plan = wakeSteps([{ chat: "c1", tab: "t2", space: "s1" }, { chat: "c2", tab: "t3", space: "s1" }, { chat: "coordinator", tab: "t5", space: "s2" }], at, spaces);
assert.deepEqual(plan.show.map((s) => s.tab), ["t2", "t3", "t5"]);
assert.deepEqual(plan.settle, ["t3"]); // for when the person moves and back isn't run
assert.deepEqual(plan.back, [["space.select", { id: "s2" }], ["tab.select", { id: "t4" }], ["tab.settle", { id: "t3" }], ["space.select", { id: "s1" }], ["tab.select", { id: "t1" }], ["pane.focus", { pane: "p9" }]]);
// The tab its space showed already (the remote one's only tab): nothing to put back there.
assert.deepEqual(wakeSteps([{ chat: "c1", tab: "t6", space: "s3" }], { space: "s1", tab: "t1", pane: null }, spaces).back, [["space.select", { id: "s1" }], ["tab.select", { id: "t1" }]]);
// The shown tab starts by itself; no targets, a target with no tab, or no place to return to: nothing is touched.
assert.equal(wakeSteps([{ chat: "c1", tab: "t1", space: "s1" }], at, spaces), null);
assert.equal(wakeSteps([], at, spaces), null); assert.equal(wakeSteps([{ chat: "c1" }], at, spaces), null);
assert.equal(wakeSteps([{ chat: "c1", tab: "t2", space: "s1" }], null, spaces), null);
// The last step always is where the person was.
for (const p of [plan, wakeSteps([{ chat: "c1", tab: "t2", space: "s1" }], { ...at, pane: null }, spaces)]) {
  const tabsBack = p.back.filter(([c]) => c === "tab.select");
  assert.deepEqual(tabsBack[tabsBack.length - 1], ["tab.select", { id: "t1" }]);
}

console.log("restart-wake: ok");
