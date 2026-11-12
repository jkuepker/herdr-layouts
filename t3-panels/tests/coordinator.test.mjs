// node t3-panels/tests/coordinator.test.mjs
import assert from "node:assert/strict";
import { parseKey, keyOf, spaceIn } from "../mods/ht3-panels/tasklist.js";
import { parseOp, cleanId, expandHome, snapshot, logOp, templateDue, OPS_KEPT, pickAnswer, taskStates, noticeDiff, noticeText, NOTICE_MAX } from "../mods/ht3-panels/coord-data.js";
import { VERSION, roleText, SETTINGS } from "../mods/ht3-panels/coord-template.js";
import { ChatSession } from "../mods/ht3-panels/session.js";

// Project keys: "<machine or empty>:<repo root>".
assert.deepEqual(parseKey(":/opt/code/app"), { on: null, root: "/opt/code/app" });
assert.deepEqual(parseKey("spark1:/home/me/app"), { on: "spark1", root: "/home/me/app" });
assert.deepEqual(parseKey(":/opt/a:b"), { on: null, root: "/opt/a:b" });
assert.equal(parseKey(""), null); assert.equal(parseKey("nothing"), null); assert.equal(parseKey("m:relative"), null);
assert.equal(keyOf(null, "/x"), ":/x"); assert.equal(keyOf("m", "/x"), "m:/x");

// The space a project's chats go to: by its folder first, then by a pane working there; the machine must match.
const sps = [{ id: "a", folder: "/Users/me", machine: null }, { id: "b", folder: "/opt/code/app/.worktrees/x", machine: null }, { id: "c", folder: "/opt/code/app", machine: "spark1" }];
assert.equal(spaceIn(sps, "/opt/code/app"), "b");
assert.equal(spaceIn(sps, "/opt/code/app", "spark1"), "c");
assert.equal(spaceIn(sps, "/opt/code/ap"), null); // a longer name is not inside
assert.equal(spaceIn(sps, "/opt/code/other", null, { a: ["/opt/code/other/src"] }), "a");
assert.equal(spaceIn(sps, "/opt/code/other"), null);

// coord:<json>.
assert.equal(cleanId("fix-login.2"), "fix-login.2"); assert.equal(cleanId("a b"), null); assert.equal(cleanId(""), null); assert.equal(cleanId(7), "7");
assert.equal(expandHome("~/x/", "/Users/me"), "/Users/me/x"); assert.equal(expandHome("~", "/Users/me"), "/Users/me"); assert.equal(expandHome("/", "/h"), "/");
assert.deepEqual(parseOp('{"op":"add","project":"~/app/","title":"Fix: the login\\nmore","note":" n ","id":"fix","run":true}', "/Users/me"),
  { op: "add", project: "/Users/me/app", machine: null, id: "fix", title: "Fix: the login", note: "n", run: true });
assert.deepEqual(parseOp('{"op":"add","project":"/a","title":"T"}'), { op: "add", project: "/a", machine: null, id: null, title: "T", note: "", run: false });
assert.deepEqual(parseOp('{"op":"done","project":"/a","id":"x","machine":"spark1"}'), { op: "done", project: "/a", machine: "spark1", id: "x", done: true });
assert.equal(parseOp('{"op":"done","project":"/a","id":"x","done":false}').done, false);
assert.match(parseOp("{nope").error, /^Not JSON/);
assert.match(parseOp('{"op":"push","project":"/a"}').error, /Unknown op/);
assert.match(parseOp('{"op":"add","project":"app","title":"T"}').error, /absolute/);
assert.match(parseOp('{"op":"add","project":"/a"}').error, /title/);
assert.match(parseOp('{"op":"run","project":"/a"}').error, /id is missing/);
assert.match(parseOp('{"op":"add","project":"/a","title":"T","id":"a b"}').error, /id may hold/);

// answer: the task, the ask's id and one of its options, the ids as strings.
assert.deepEqual(parseOp('{"op":"answer","project":"/a","id":"x","ask":1731400000000,"option":"allow"}'), { op: "answer", project: "/a", machine: null, id: "x", ask: "1731400000000", option: "allow" });
assert.match(parseOp('{"op":"answer","project":"/a","ask":"1","option":"allow"}').error, /id is missing/);
assert.match(parseOp('{"op":"answer","project":"/a","id":"x","option":"allow"}').error, /ask is missing/);
assert.match(parseOp('{"op":"answer","project":"/a","id":"x","ask":"1"}').error, /option is missing/);
assert.match(parseOp('{"op":"answer","project":"/a","id":"x","ask":{"id":1},"option":"allow"}').error, /ask is missing/);
// It must be the ask that waits now, and an option of its own that doesn't stay in force.
const pending = { id: "17", title: "Run npm test", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }] };
assert.deepEqual(pickAnswer(pending, "17", "allow"), { ask: "17", optionId: "allow", title: "Run npm test", name: "Allow" });
assert.equal(pickAnswer(pending, "17", "no").optionId, "no");
assert.equal("always" in pickAnswer(pending, "17", "allow"), false);
assert.match(pickAnswer(null, "17", "allow").error, /asks nothing/);
assert.match(pickAnswer(pending, "16", "allow").error, /^Stale ask 16/);
assert.match(pickAnswer(pending, "17", "yes").error, /no option yes: one of allow, always, no/);
assert.match(pickAnswer(pending, "17", "always").error, /person's to pick/);

// The state file: spaces without the coordinator's own, each project's tasks with their chat's state and last reply.
const now = 1_000_000, run = (chat, more = {}) => ({ chat, branch: `task-${chat}`, path: `/a/.worktrees/task-${chat}`, on: null, from: "main", at: now - 5000, ...more });
const s = snapshot({
  spaces: [{ name: "app\u200b", folder: "/a", machine: null }, { name: "Coordinator", folder: "/coord", machine: null }],
  tasks: { ":/a": [
    { id: "t1", title: "One", note: "", done: false, at: 1 },
    { id: "t2", title: "Two", note: "n", done: false, at: 2, run: run("c2") },
    { id: "t3", title: "Three", note: "", done: true, at: 3, run: run("c3", { worked: true }) },
    { id: "t4", title: "Four", note: "", done: false, at: 4, run: run("c4", { at: now - 600000 }) },
    { id: "t5", title: "Five", note: "", done: false, at: 5 },
  ], "bad key": [{ id: "x", title: "X", note: "", done: false, at: 1 }] },
  facts: { places: { c2: { tab: "tab2", pane: "p2" }, c3: { tab: "tab3", pane: "p3" } }, status: { tab2: "working", tab3: "idle" }, turns: { tab3: 1 }, tabs: new Set(["tab2", "tab3"]), now,
    asks: { tab9: { id: "1", title: "Another tab's", options: [] } } },
  replies: { c2: "Reading the code", c3: "Done." }, making: { ":/a\nt5": "making the worktree" }, ops: [{ op: "add", ok: true }], skip: "/coord",
});
assert.deepEqual(s.spaces, [{ name: "app", folder: "/a", machine: null }]);
assert.equal(s.projects.length, 1);
assert.deepEqual([s.projects[0].project, s.projects[0].machine], ["/a", null]);
assert.deepEqual(s.projects[0].tasks.map((t) => t.state), ["none", "working", "done", "failed", "making"]);
assert.deepEqual(s.projects[0].tasks[1], { id: "t2", title: "Two", note: "n", done: false, state: "working", branch: "task-c2", path: "/a/.worktrees/task-c2", chat: "c2", lastReply: "Reading the code" });
assert.deepEqual(s.projects[0].tasks[0], { id: "t1", title: "One", note: "", done: false, state: "none", branch: null, path: null, chat: null, lastReply: null });
assert.equal(s.projects[0].tasks[3].why, "The chat never started.");
assert.deepEqual(s.ops, [{ op: "add", ok: true }]);
// A task whose chat waits for an approval carries it; what the agent sent besides id, title and the options' three fields stays out.
const facts2 = { places: { c2: { tab: "tab2" } }, status: { tab2: "blocked" }, turns: {}, tabs: new Set(["tab2"]), now,
  asks: { tab2: { id: 17, title: "Run npm test", extra: 1, options: [{ optionId: "allow", name: "Allow", kind: "allow_once", more: 1 }, { optionId: "no", name: "Reject", kind: "reject_once" }] } } };
const waits = snapshot({ tasks: { ":/a": [{ id: "t2", title: "Two", note: "n", done: false, at: 2, run: run("c2") }] }, facts: facts2 });
assert.equal(waits.projects[0].tasks[0].state, "waiting");
assert.deepEqual(waits.projects[0].tasks[0].ask, { id: "17", title: "Run npm test", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
assert.equal("ask" in s.projects[0].tasks[1], false);

// Task notices: a task's chat coming into done, failed, waiting or closed is told, once; steps on the way are not.
const body = (states, more = {}) => ({ projects: [{ project: "/opt/code/app", machine: null, tasks: Object.entries(states).map(([id, state]) => ({ id, title: `Title of ${id}`, done: false, state, lastReply: `Reply of ${id}`, ...(more[id] ?? {}) })) }] });
const st = (states, more) => taskStates(body(states, more));
assert.deepEqual(Object.keys(st({ a: "working" })), [":/opt/code/app\na"]);
const before = st({ a: "working", b: "working", c: "starting", d: "none", e: "done", f: "working", g: "closed", h: "working" });
const after = st({ a: "done", b: "waiting", c: "working", d: "making", e: "done", f: "failed", g: "done", h: "closed", z: "done" });
assert.deepEqual(noticeDiff(before, after).map((n) => `${n.id}:${n.state}`), ["a:done", "b:waiting", "f:failed", "h:closed"]);
assert.equal(noticeDiff(before, after)[0].key, ":/opt/code/app\na");
// The first pass after a load has nothing before it: nothing is told again. Nothing changed: nothing told.
assert.deepEqual(noticeDiff(null, after), []);
assert.deepEqual(noticeDiff(after, after), []);
// The `done` mark alone is no news; waiting again after working is.
assert.deepEqual(noticeDiff(st({ a: "done" }), st({ a: "done" }, { a: { done: true } })), []);
assert.deepEqual(noticeDiff(st({ a: "working" }), st({ a: "waiting" })).length, 1);
// One short message for the batch.
const told = noticeText(noticeDiff(before, st({ a: "done", b: "waiting", f: "failed" }, { a: { lastReply: `All ${"x".repeat(400)}\nsecond line` }, b: { ask: { id: "17", title: "Run npm test", options: [] } }, f: { why: "The chat never started." } })));
assert.match(told, /^Task updates \(from Herdr\): app \/ a "Title of a": done — last reply: All x+…; app \/ b "Title of b": waiting — asks: Run npm test \(ask 17\); app \/ f "Title of f": failed — The chat never started\.\. Read state\.json and act per your rules\.$/);
assert.ok(told.length < 420, String(told.length));
const many = noticeText(Object.values(st(Object.fromEntries(Array.from({ length: NOTICE_MAX + 3 }, (_v, i) => [`t${i}`, "done"])))));
assert.match(many, /; and 3 more\. Read state\.json/);
assert.equal(noticeText([{ project: "/r", machine: "spark1", id: "x", title: "T", state: "closed" }]), 'Task updates (from Herdr): r on spark1 / x "T": closed. Read state.json and act per your rules.');

assert.doesNotThrow(() => JSON.stringify(s));

let log = [];
for (let i = 0; i < OPS_KEPT + 5; i++) log = logOp(log, { n: i });
assert.equal(log.length, OPS_KEPT); assert.equal(log.at(-1).n, OPS_KEPT + 4);

// The folder's files: written when none are there or they are older.
assert.equal(templateDue(null, VERSION), true); assert.equal(templateDue(`${VERSION}\n`, VERSION), false);
assert.equal(templateDue(String(VERSION - 1), VERSION), true); assert.equal(templateDue("junk", VERSION), true);
const text = roleText("/coord", "/chats");
assert.match(text, /herdr-app do 'ht3-panels\.coord:\{"op":"add"/); assert.match(text, /\/coord\/state\.json/); assert.match(text, /\/chats\/<chat>\/state\.json/);
// Every command it shows is one parseOp takes.
const shown = [...text.matchAll(/ht3-panels\.coord:(\{.*\})'/g)].map((m) => parseOp(m[1]));
assert.deepEqual(shown.map((o) => o.error ?? o.op), ["add", "run", "done", "delete", "answer"]);
assert.equal(VERSION, 3); assert.match(text, /## Approvals/); assert.match(text, /select\(\.ask\)/); assert.match(text, /Task updates \(from Herdr\):/);
assert.deepEqual(JSON.parse(SETTINGS).permissions.allow, ["Bash(herdr-app do:*)", "Bash(jq:*)", "Bash(cat:*)", "Bash(git -C * status*)", "Bash(git -C * diff*)", "Bash(git -C * log*)"]);

// session.js setConfig: an option is found by its id, else by what it is for, and the agent gets the option's real id.
const sent = [];
const session = new ChatSession({ argv: ["x"], cwd: "/", write: (l) => sent.push(JSON.parse(l)), kill() {}, changed() {} });
session.state.sessionId = "s1";
session.state.configOptions = [{ id: "llm", category: "model", type: "select", currentValue: "a", options: [{ value: "a" }, { value: "b" }] }, { id: "mode", type: "select", currentValue: "ask", options: [] }];
const answer = () => { const m = sent.at(-1); session.feed(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} })); return m; };
let p = session.setConfig("model", "b");
assert.deepEqual(answer().params, { sessionId: "s1", configId: "llm", value: "b" });
await p;
assert.equal(session.state.configOptions[0].currentValue, "b");
p = session.setConfig("mode", "code");
assert.equal(answer().params.configId, "mode");
await p;
assert.equal(session.state.configOptions[1].currentValue, "code");
p = session.setConfig("unknown", 1);
assert.equal(answer().params.configId, "unknown");
await p;
console.log("coordinator: ok");
