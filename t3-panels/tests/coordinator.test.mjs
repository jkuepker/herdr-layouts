// node t3-panels/tests/coordinator.test.mjs
import assert from "node:assert/strict";
import { parseKey, keyOf, spaceIn } from "../mods/ht3-panels/tasklist.js";
import { parseOp, cleanId, expandHome, snapshot, logOp, templateDue, OPS_KEPT } from "../mods/ht3-panels/coord-data.js";
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
  facts: { places: { c2: { tab: "tab2", pane: "p2" }, c3: { tab: "tab3", pane: "p3" } }, status: { tab2: "working", tab3: "idle" }, turns: { tab3: 1 }, tabs: new Set(["tab2", "tab3"]), now },
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
assert.deepEqual(shown.map((o) => o.error ?? o.op), ["add", "run", "done", "delete"]);
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
