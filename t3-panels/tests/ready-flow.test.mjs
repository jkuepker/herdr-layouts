// node t3-panels/tests/ready-flow.test.mjs
// Round 25: finding finished work. The pure parts: when "ready to merge" stops holding (tasklist.js readyStale), the
// ready tasks of every project (tasklist.js readyTasks, and the Agents list's own reading, ht3-agents/ready.js), and
// the commands that show a project's Tasks (tasklist.js parseShow, showCommand).
import assert from "node:assert/strict";
import { cleanTasks, patch, readyStale, unready, readyTasks, parseShow, showCommand } from "../mods/ht3-panels/tasklist.js";
import { readyCheck } from "../mods/ht3-panels/coord-data.js";
import { readyRows } from "../mods/ht3-agents/ready.js";

const A = "a".repeat(40), B = "b".repeat(40);
const run = (more = {}) => ({ chat: "c1", branch: "task-x", path: "/r/.worktrees/task-x", on: null, from: "main", at: 1, worked: true, ...more });
const work = (head, more = {}) => ({ ahead: 1, dirty: 0, branch: "task-x", head, ...more });

// ---- ready goes stale ----

// It holds while the branch is at the commit it was said of and the chat is at rest.
assert.equal(readyStale(run({ ready: { at: 2, note: "", head: A } }), work(A), "done"), null);
assert.equal(readyStale(run({ ready: { at: 2, note: "", head: A } }), work(A), "closed"), null);
assert.equal(readyStale(run({ ready: { at: 2, note: "", head: A } }), work(A, { dirty: 3 }), "done"), null); // uncommitted files: Merge commits them
// The branch moved: a new commit, or a reset to an older one.
assert.match(readyStale(run({ ready: { at: 2, note: "", head: A } }), work(B), "done"), /task-x moved since it was marked ready/);
// Its agent works again, or asks: what it leaves was not looked at.
assert.match(readyStale(run({ ready: { at: 2, note: "", head: A } }), work(A), "working"), /works again/);
assert.match(readyStale(run({ ready: { at: 2, note: "", head: A } }), work(A), "waiting"), /works again/);
// Nothing known says nothing: a worktree not read yet or gone, a mark from before heads were kept, a branch with no commit.
assert.equal(readyStale(run({ ready: { at: 2, note: "", head: A } }), undefined, "done"), null);
assert.equal(readyStale(run({ ready: { at: 2, note: "", head: A } }), { missing: true }, "done"), null);
assert.equal(readyStale(run({ ready: { at: 2, note: "" } }), work(B), "done"), null);
assert.equal(readyStale(run({ ready: { at: 2, note: "", head: A } }), work(null), "done"), null);
// Not ready, never run, or merged: nothing to take back.
assert.equal(readyStale(run(), work(B), "working"), null);
assert.equal(readyStale(null, work(B), "working"), null);
assert.equal(readyStale(run({ ready: { at: 2, note: "", head: A }, merged: { at: 3, commit: "abc" } }), work(B), "working"), null);

// The mark goes and the rest of the run stays; a task without one is left as it is.
const t = { id: "x", title: "X", note: "", done: false, at: 1, run: run({ ready: { at: 2, note: "ok", head: A } }) };
const [dropped] = patch([t], "x", unready);
assert.equal("ready" in dropped.run, false); assert.deepEqual(dropped.run, run()); assert.equal(dropped.title, "X");
assert.deepEqual(unready({ id: "y", title: "Y" }), {}); assert.deepEqual(unready({ id: "y", title: "Y", run: run() }), {});

// A saved task keeps the head it was marked at, when it is a commit's name.
const kept = cleanTasks([{ id: "a", title: "A", run: run({ ready: { at: 6, note: " fine ", head: A } }) }, { id: "b", title: "B", run: run({ chat: "c2", ready: { at: 6, note: "", head: "HEAD; rm -rf" } }) }]);
assert.deepEqual(kept[0].run.ready, { at: 6, note: "fine", head: A }); assert.deepEqual(kept[1].run.ready, { at: 6, note: "" });

// `ready` is refused while the agent is at work (it would go stale at once).
const ran = { id: "x", title: "X", run: run() };
assert.equal(readyCheck(ran, work(A), "done"), null); assert.equal(readyCheck(ran, work(A), "closed"), null); assert.equal(readyCheck(ran, work(A)), null);
assert.match(readyCheck(ran, work(A), "working"), /still working/); assert.match(readyCheck(ran, work(A), "waiting"), /waits for an answer/);

// ---- ready to merge, across projects ----

const all = {
  ":/opt/code/zeta": [{ id: "z1", title: "Zeta one", run: run({ ready: { at: 2, note: "" } }) }],
  ":/opt/code/app": [
    { id: "a1", title: "Not run" },
    { id: "a2", title: "Run, not ready", run: run() },
    { id: "a3", title: "Fix the login", run: run({ ready: { at: 2, note: "ok", head: A } }) },
    { id: "a4", title: "Merged", done: true, run: run({ ready: { at: 2, note: "" }, merged: { at: 3, commit: "abc" } }) },
    { id: "a5", title: "Done by hand, still ready", done: true, run: run({ ready: { at: 2, note: "" } }) },
  ],
  "spark1:/home/me/svc": [{ id: "s1", title: "Remote", run: run({ on: "spark1", ready: { at: 2, note: "" } }) }],
  "junk": [{ id: "j", title: "J", run: run({ ready: { at: 2, note: "" } }) }],
  ":/opt/code/empty": "not a list",
};
const ready = readyTasks(all);
assert.deepEqual(ready.map((r) => `${r.key} ${r.id}`), [":/opt/code/app a3", ":/opt/code/app a5", ":/opt/code/zeta z1", "spark1:/home/me/svc s1"]);
assert.deepEqual(ready[0], { key: ":/opt/code/app", id: "a3", title: "Fix the login", project: "app", root: "/opt/code/app", on: null });
assert.equal(ready[3].project, "svc"); assert.equal(ready[3].on, "spark1");
assert.deepEqual(readyTasks(null), []); assert.deepEqual(readyTasks({}), []);

// The Agents list reads the same tasks, and each row's click is the command ht3-panels takes.
const rows = readyRows(all);
assert.deepEqual(rows.map(({ key, id, title, project, on }) => ({ key, id, title, project, on })), ready.map(({ key, id, title, project, on }) => ({ key, id, title, project, on })));
assert.deepEqual(rows.map((r) => r.command), ready.map((r) => showCommand(r.key, r.id)));
assert.equal(rows[0].command, 'tasks-show:{"project":"/opt/code/app","id":"a3"}');
assert.equal(rows[3].command, 'tasks-show:{"project":"/home/me/svc","machine":"spark1","id":"s1"}');
assert.deepEqual(readyRows(null), []); assert.deepEqual(readyRows("x"), []); assert.deepEqual(readyRows({ ":/a": [null, { id: "", title: "T" }, { id: "n", title: " " }] }), []);

// ---- the commands that show Tasks ----

assert.deepEqual(parseShow("tasks"), { group: null }); assert.deepEqual(parseShow("tasks:a"), { group: "a" }); assert.deepEqual(parseShow("tasks:b"), { group: "b" });
assert.deepEqual(parseShow("tasks:/opt/code/app/"), { project: "/opt/code/app", machine: null, id: null });
assert.deepEqual(parseShow("tasks:/opt/a:b"), { project: "/opt/a:b", machine: null, id: null }); // a colon in a folder's name
assert.deepEqual(parseShow("tasks:spark1:/home/me/svc"), { project: "/home/me/svc", machine: "spark1", id: null });
assert.deepEqual(parseShow("tasks::/opt/code/app"), { project: "/opt/code/app", machine: null, id: null }); // a project's key
assert.match(parseShow("tasks:c").error, /a, b or a project folder/); assert.match(parseShow("tasks:relative/x").error, /a, b or a project folder/);
assert.deepEqual(parseShow('tasks-show:{"project":"/opt/code/app","id":"a3"}'), { project: "/opt/code/app", machine: null, id: "a3" });
assert.deepEqual(parseShow('tasks-show:{"project":"/home/me/svc/","machine":" spark1 ","id":7}'), { project: "/home/me/svc", machine: "spark1", id: "7" });
assert.deepEqual(parseShow('tasks-show:{"project":"/opt/code/app"}'), { project: "/opt/code/app", machine: null, id: null });
assert.match(parseShow("tasks-show:{").error, /Not JSON/); assert.match(parseShow('tasks-show:{"project":"app"}').error, /absolute path/); assert.match(parseShow("tasks-show:null").error, /absolute path/);
assert.match(parseShow("tasks-add:x").error, /Not a tasks command/);
// Every project and task comes back from its command as it went in (a quote, a colon and a brace in the names too).
for (const [key, id] of [[":/opt/code/app", "a3"], ["spark1:/home/me/svc", "s1"], [':/opt/we"ird: {x}', "fix-login.2"]]) {
  const o = parseShow(showCommand(key, id));
  assert.equal(`${o.machine ?? ""}:${o.project}`, key); assert.equal(o.id, id);
}
assert.equal(showCommand("junk", "x"), "tasks");

console.log("ready-flow: ok");
