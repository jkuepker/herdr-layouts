// node t3-panels/tests/coordinator.test.mjs
import assert from "node:assert/strict";
import { parseKey, keyOf, spaceIn, promptOf, PROMPT_RULES, cleanTasks, parseWork, parseTrees, workWords, hasWork, mergeCheck, mergeWords } from "../mods/ht3-panels/tasklist.js";
import { parseOp, cleanId, expandHome, snapshot, logOp, templateDue, OPS_KEPT, pickAnswer, readyCheck, taskStates, noticeDiff, noticeText, NOTICE_MAX } from "../mods/ht3-panels/coord-data.js";
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
  work: { ":/a\nt2": { ahead: 2, dirty: 3, branch: "task-c2" }, ":/a\nt4": { missing: true } },
});
assert.deepEqual(s.spaces, [{ name: "app", folder: "/a", machine: null }]);
assert.equal(s.projects.length, 1);
assert.deepEqual([s.projects[0].project, s.projects[0].machine], ["/a", null]);
assert.deepEqual(s.projects[0].tasks.map((t) => t.state), ["none", "working", "done", "failed", "making"]);
assert.deepEqual(s.projects[0].tasks[1], { id: "t2", title: "Two", note: "n", done: false, state: "working", branch: "task-c2", from: "main", ahead: 2, dirty: true, ready: false, merged: false, conflict: null, path: "/a/.worktrees/task-c2", chat: "c2", lastReply: "Reading the code" });
// A worktree not read yet, or gone: ahead null. A merged or ready task says so, and a merged one's old reading is not shown.
assert.deepEqual(s.projects[0].tasks.map((t) => [t.ahead, t.dirty]), [[null, false], [2, true], [null, false], [null, false], [null, false]]);
const marked = snapshot({ tasks: { ":/a": [{ id: "m", title: "M", note: "", done: true, at: 1, run: run("c9", { worked: true, ready: { at: 1, note: "ok" }, merged: { at: 2, commit: "abc1234" } }) }] }, facts: { now }, work: { ":/a\nm": { ahead: 1, dirty: 1, branch: "task-c9" } } }).projects[0].tasks[0];
assert.deepEqual([marked.ready, marked.merged, marked.ahead, marked.dirty], [true, true, null, false]);
assert.deepEqual(s.projects[0].tasks[0], { id: "t1", title: "One", note: "", done: false, state: "none", branch: null, from: null, ahead: null, dirty: false, ready: false, merged: false, conflict: null, path: null, chat: null, lastReply: null });
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
assert.deepEqual(shown.map((o) => o.error ?? o.op), ["add", "run", "done", "ready", "update", "tell", "delete", "answer"]);
assert.match(text, /mark it ready/); assert.match(text, /Merge commits them first/); assert.match(text, /never commit, merge or push/);
assert.equal(VERSION, 9); assert.match(text, /Never run the task again for a conflict/); assert.match(text, /git rebase --continue/); assert.match(text, /in four cases only/); assert.match(text, /takes the mark back/); assert.match(text, /## Approvals/); assert.match(text, /select\(\.ask\)/); assert.match(text, /Task updates \(from Herdr\):/);
assert.deepEqual(JSON.parse(SETTINGS).permissions.allow, ["Bash(herdr-app do:*)", "Bash(jq:*)", "Bash(cat:*)", "Bash(git -C * status*)", "Bash(git -C * diff*)", "Bash(git -C * log*)"]);

// ---- Round 24: commit and merge ----

// The task's first message ends with the fixed rules: commit on this branch, nothing more.
assert.equal(promptOf({ title: "Fix it", note: "" }), `Fix it\n\n${PROMPT_RULES}`);
assert.equal(promptOf({ title: "Fix it", note: "In src/a.js.\nCheck: npm test" }), `Fix it\n\nIn src/a.js.\nCheck: npm test\n\n${PROMPT_RULES}`);
assert.match(PROMPT_RULES, /^Work only in this worktree\./); assert.match(PROMPT_RULES, /git add -A && git commit -m/); assert.match(PROMPT_RULES, /Don't push, don't merge, don't switch branches\.$/);
assert.ok(PROMPT_RULES.length < 220);

// ready: { project, id, note? }.
assert.deepEqual(parseOp('{"op":"ready","project":"/a","id":"x","note":" Diff is small;\\n tests pass "}'), { op: "ready", project: "/a", machine: null, id: "x", note: "Diff is small; tests pass" });
assert.deepEqual(parseOp('{"op":"ready","project":"/a","id":"x","machine":"spark1"}'), { op: "ready", project: "/a", machine: "spark1", id: "x", note: "" });
assert.equal(parseOp('{"op":"ready","project":"/a"}').error, "id is missing.");
assert.equal(parseOp(JSON.stringify({ op: "ready", project: "/a", id: "x", note: "n".repeat(900) })).note.length, 400);
assert.match(parseOp('{"op":"merge","project":"/a","id":"x"}').error, /Unknown op "merge": one of add, run, done, delete, answer, ready, tell, update\./);
const ran = { id: "x", title: "X", run: run("c1") };
assert.equal(readyCheck(ran, undefined), null); assert.equal(readyCheck(ran, { ahead: 0, dirty: 2, branch: "task-c1" }), null); assert.equal(readyCheck(ran, { ahead: 1, dirty: 0 }), null);
assert.match(readyCheck({ id: "x", title: "X" }, undefined), /never run/);
assert.match(readyCheck({ ...ran, run: run("c1", { merged: { at: 1, commit: "a" } }) }, undefined), /merged already/);
assert.match(readyCheck(ran, { ahead: 0, dirty: 0, branch: "task-c1" }), /nothing to merge/); assert.match(readyCheck(ran, { missing: true }), /gone/);

// A saved task keeps ready and merged, cleaned.
const kept = cleanTasks([{ id: "a", title: "A", run: { chat: "c", branch: "task-a", path: "/r/.worktrees/task-a", from: "main", at: 5, ready: { at: 6, note: " fine " }, merged: { at: 7, commit: "abc1234", removed: true, junk: 1 } } },
  { id: "b", title: "B", run: { chat: "d", ready: "yes", merged: null } }]);
assert.deepEqual(kept[0].run.ready, { at: 6, note: "fine" }); assert.deepEqual(kept[0].run.merged, { at: 7, commit: "abc1234", removed: true });
assert.equal("ready" in kept[1].run, false); assert.equal("merged" in kept[1].run, false);

// What a worktree holds, and the repository's checkouts.
assert.deepEqual(parseWork("ahead 2\ndirty 3\nbranch task-x\n"), { ahead: 2, dirty: 3, branch: "task-x", head: null });
assert.deepEqual(parseWork("ahead \ndirty 0\nbranch \n"), { ahead: null, dirty: 0, branch: null, head: null }); // `from` is gone; a detached HEAD
assert.deepEqual(parseWork(""), { ahead: null, dirty: 0, branch: null, head: null });
assert.equal(parseWork(`ahead 1\ndirty 0\nbranch task-x\nhead ${"ab".repeat(20)}\n`).head, "ab".repeat(20));
assert.equal(parseWork("ahead 1\nhead \n").head, null); assert.equal(parseWork("head HEAD\n").head, null); // no commit yet
assert.deepEqual(parseTrees("worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.worktrees/task-x\nHEAD def\nbranch refs/heads/task-x\n\nworktree /r/.worktrees/d\nHEAD 123\ndetached\n"),
  [{ path: "/r", branch: "main" }, { path: "/r/.worktrees/task-x", branch: "task-x" }, { path: "/r/.worktrees/d", branch: null }]);
assert.equal(workWords({ ahead: 2, dirty: 3 }), "2 commits, 3 uncommitted files"); assert.equal(workWords({ ahead: 1, dirty: 0 }), "1 commit"); assert.equal(workWords({ ahead: 0, dirty: 1 }), "1 uncommitted file");
assert.equal(workWords({ ahead: 0, dirty: 0 }), ""); assert.equal(workWords({ missing: true }), ""); assert.equal(workWords(null), "");
assert.equal(hasWork({ ahead: 0, dirty: 1 }), true); assert.equal(hasWork({ ahead: 0, dirty: 0 }), false); assert.equal(hasWork({ missing: true }), false); assert.equal(hasWork(undefined), false);

// Merge: what it would do, or why not.
const mt = { id: "x", title: "Fix the login", run: { chat: "c", branch: "task-x", path: "/r/.worktrees/task-x", on: null, from: "main", at: 1 } };
const trees = [{ path: "/r", branch: "main" }, { path: "/r/.worktrees/task-x", branch: "task-x" }];
const w = (ahead, dirty, branch = "task-x") => ({ ahead, dirty, branch });
assert.deepEqual(mergeCheck(mt, { work: w(2, 0), trees }), { ok: true, branch: "task-x", into: "main", target: "/r", ahead: 2, dirty: 0, text: "Merge task-x into main: 2 commits?" });
assert.equal(mergeCheck(mt, { work: w(2, 3), trees }).text, "Merge task-x into main: 2 commits, commits 3 changed files first?");
assert.equal(mergeCheck(mt, { work: w(0, 1), trees, state: "done" }).text, "Merge task-x into main: commits 1 changed file first?");
// `from` checked out in another worktree, not the main checkout: merged there.
assert.equal(mergeCheck({ ...mt, run: { ...mt.run, from: "feat" } }, { work: w(1, 0), trees: [{ path: "/r", branch: "main" }, { path: "/r/.worktrees/feat", branch: "feat" }] }).target, "/r/.worktrees/feat");
const no = (t, o) => { const r = mergeCheck(t, o); assert.equal(r.ok, false); return r.why; };
assert.match(no({ id: "x", title: "X" }, {}), /no worktree/);
assert.match(no({ ...mt, run: { ...mt.run, merged: { at: 1, commit: "a" } } }, { work: w(1, 0), trees }), /merged already/);
assert.match(no(mt, { work: w(1, 0), trees, state: "working" }), /still working/); assert.match(no(mt, { work: w(1, 0), trees, state: "waiting" }), /waits for an answer/);
assert.match(no(mt, { work: { missing: true }, trees }), /\/r\/\.worktrees\/task-x is gone/);
assert.match(no(mt, { work: w(1, 0, "other"), trees }), /is on other, not on task-x/); assert.match(no(mt, { work: w(1, 0, null), trees }), /detached HEAD/);
assert.match(no(mt, { work: w(1, 0), trees: [{ path: "/r", branch: "dev" }, trees[1]] }), /main isn't checked out in any folder of this repository \(the main checkout is on dev\)\. Switch the main checkout to main first/);
assert.match(no({ ...mt, run: { ...mt.run, from: "a".repeat(40) } }, { work: w(1, 0), trees }), /isn't checked out in any folder/);
assert.match(no({ ...mt, run: { ...mt.run, from: null } }, { work: w(1, 0), trees }), /The branch it was made from isn't checked out/);
assert.match(no(mt, { work: w(null, 0), trees }), /can't be compared with main/);
assert.match(no(mt, { work: w(0, 0), trees }), /Nothing to merge: task-x has no commits ahead of main and no uncommitted changes/);
assert.match(no(mt, { work: w(1, 0), trees, targetDirty: 2 }), /The checkout of main \(\/r\) has 2 uncommitted files\. Commit or stash them first/);
assert.match(no({ ...mt, run: { ...mt.run, branch: "-x" } }, { work: w(1, 0, "-x"), trees }), /starts with a dash/);
// How it went, for the status line.
assert.equal(mergeWords({ ok: true, branch: "task-x", into: "main", commit: "abc1234", committed: 3 }).text, "Merged task-x into main (abc1234). Its 3 changed files were committed on task-x. The task is done.");
assert.match(mergeWords({ ok: false, conflict: true, aborted: true, files: ["a.js"], branch: "task-x", into: "main", committed: 0 }).text, /^task-x conflicts with main in a\.js\. The merge was aborted: main is as it was\. Ask agent to update \(on its row\) sends it back to its agent to rebase onto main; then merge again\.$/);
assert.deepEqual(mergeWords({ ok: false, refused: true, error: "Why." }), { bad: true, text: "Why." });

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
