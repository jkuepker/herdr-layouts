// node t3-panels/tests/task-update.test.mjs [scratch dir]
// Round 26: a task whose Merge conflicted goes back to its own agent. The pure parts (tasklist.js conflictMark,
// conflictGone, updateText, checkOf, tellCheck, updateCheck; coord-data.js parseOp's tell and update, snapshot's
// `conflict`, conflictNews, conflictText, readyCheck), then the whole sequence against a real git repository made under
// the scratch directory (default: .scratch/task-update-test in the current directory) and deleted at the end: two
// tasks change the same line, the first merges, the second's Merge is aborted, its agent rebases, the same Merge goes through.
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { cleanTasks, patch, readWork, mergeTask, mergeWords, readyStale, readyTasks, conflictMark, conflictGone, unconflict, askedMark, checkOf, tellCheck, updateCheck, updateText,
  SENT_WORDS, TELL_MAX, CONFLICT_FILES_MAX } from "../mods/ht3-panels/tasklist.js";
import { parseOp, OPS, snapshot, taskStates, conflictNews, conflictText, readyCheck } from "../mods/ht3-panels/coord-data.js";
import { readyRows } from "../mods/ht3-agents/ready.js";

const A = "a".repeat(40), B = "b".repeat(40);
const run = (more = {}) => ({ chat: "c1", branch: "task-x", path: "/r/.worktrees/task-x", on: null, from: "main", at: 1, worked: true, ...more });
const work = (head, more = {}) => ({ ahead: 1, dirty: 0, branch: "task-x", head, ...more });
const res = { ok: false, conflict: true, files: ["src/app.js", "readme.md"], aborted: true, branch: "task-x", into: "main", committed: 0 };

// ---- the mark ----

// A conflicted Merge: ready goes, conflict says where it stood; the rest of the run stays.
const t0 = { id: "x", title: "Edit line b", note: "In src/app.js.\nCheck: npm test", done: false, at: 1, run: run({ ready: { at: 2, note: "ok", head: A } }) };
const [hit] = patch([t0], "x", conflictMark(res, A, 5));
assert.equal("ready" in hit.run, false);
assert.deepEqual(hit.run.conflict, { at: 5, files: ["src/app.js", "readme.md"], onto: "main", head: A });
assert.deepEqual({ ...hit.run, conflict: undefined }, { ...run(), conflict: undefined });
// So it is in no "Ready to merge" list any more, in either mod.
assert.equal(readyTasks({ ":/r": [t0] }).length, 1); assert.deepEqual(readyTasks({ ":/r": [hit] }), []); assert.deepEqual(readyRows({ ":/r": [hit] }), []);
// A head that isn't known, no files, a merged or never-run task.
assert.deepEqual(patch([t0], "x", conflictMark({ conflict: true, files: [], into: "dev" }, null, 5))[0].run.conflict, { at: 5, files: [], onto: "dev" });
assert.deepEqual(conflictMark(res, A, 5)({ id: "y", title: "Y" }), {}); assert.deepEqual(conflictMark(res, A, 5)({ id: "y", title: "Y", run: run({ merged: { at: 1, commit: "a" } }) }), {});
// Saved and read back: kept clean; dropped with a merge; junk is not a conflict.
const saved = cleanTasks([{ ...hit, run: { ...hit.run, conflict: { ...hit.run.conflict, files: [" a.js ", "", 7, ...Array(40).fill("f")], head: "HEAD; rm", asked: 9, junk: 1 } } },
  { id: "m", title: "M", run: run({ chat: "c2", conflict: hit.run.conflict, merged: { at: 3, commit: "abc" } }) }, { id: "j", title: "J", run: run({ chat: "c3", conflict: "yes" }) }]);
assert.equal(saved[0].run.conflict.files.length, CONFLICT_FILES_MAX); assert.deepEqual(saved[0].run.conflict.files.slice(0, 3), ["a.js", "7", "f"]);
assert.deepEqual({ ...saved[0].run.conflict, files: [] }, { at: 5, files: [], onto: "main", asked: 9 });
assert.equal("conflict" in saved[1].run, false); assert.equal("conflict" in saved[2].run, false);
assert.deepEqual(cleanTasks([hit])[0].run.conflict, hit.run.conflict);

// It holds while the branch is where it was; goes when the branch moved; stays while a rebase is under way (HEAD
// detached: no branch) and when nothing is known.
assert.equal(conflictGone(hit.run, work(A)), null);
assert.match(conflictGone(hit.run, work(B)), /task-x moved since its merge conflicted/);
assert.equal(conflictGone(hit.run, work(B, { branch: null })), null);
assert.equal(conflictGone(hit.run, undefined), null); assert.equal(conflictGone(hit.run, { missing: true }), null); assert.equal(conflictGone(hit.run, work(null)), null);
assert.equal(conflictGone(run(), work(B)), null); assert.equal(conflictGone(null, work(B)), null);
assert.equal(conflictGone(run({ conflict: { at: 5, files: [], onto: "main" } }), work(B)), null); // marked without a head: only a merge clears it
assert.match(conflictGone(run({ conflict: hit.run.conflict, merged: { at: 9, commit: "a" } }), work(A)), /merged/);
const [cleared] = patch([hit], "x", unconflict);
assert.equal("conflict" in cleared.run, false); assert.deepEqual(cleared.run, run()); assert.deepEqual(unconflict({ id: "y", title: "Y", run: run() }), {});
assert.equal(patch([hit], "x", askedMark(7))[0].run.conflict.asked, 7); assert.deepEqual(askedMark(7)({ id: "y", title: "Y", run: run() }), {});

// ---- the message ----

assert.equal(updateText(hit), "main moved on since this task started and your branch conflicts with it in src/app.js, readme.md. In this worktree run `git rebase main`, "
  + "resolve the conflicts keeping both changes' intent, run the check again (`npm test`), and commit. Don't push, don't merge, don't switch branches.");
assert.match(updateText({ ...hit, note: "Just do it." }), /run the check again \(the task's check\), and commit\./);
assert.match(updateText({ ...hit, run: run({ from: "dev", conflict: { at: 1, files: [], onto: "dev" } }) }), /^dev moved on .* conflicts with it in some files\. In this worktree run `git rebase dev`,/);
assert.equal(checkOf("Goal.\nCheck: npm test"), "npm test"); assert.equal(checkOf("- check: `node t.mjs`."), "node t.mjs"); assert.equal(checkOf("The check to run: make test"), "make test");
assert.equal(checkOf("Check that it works"), null); assert.equal(checkOf(""), null); assert.equal(checkOf("Check: `a` then `b`"), null); assert.equal(checkOf(`Check: ${"x".repeat(300)}`), null);
// Who may be told, and who may be asked to update.
assert.match(tellCheck({ id: "y", title: "Y" }), /never run/); assert.match(tellCheck({ id: "y", title: "Y", run: run({ merged: { at: 1, commit: "a" } }) }), /merged already/);
assert.equal(tellCheck(t0), null); assert.equal(updateCheck(hit), null);
assert.match(updateCheck(t0), /no merge conflict/); assert.match(updateCheck({ id: "y", title: "Y" }), /never run/);
assert.deepEqual(Object.keys(SENT_WORDS), ["open", "reopened", "shown", "waiting"]); assert.match(SENT_WORDS.waiting, /open its chat to send it/);

// ---- the coordinator's side ----

assert.deepEqual(OPS, ["add", "run", "done", "delete", "answer", "ready", "tell", "update"]);
assert.deepEqual(parseOp('{"op":"update","project":"/a/","id":"x","machine":"spark1","text":"ignored"}'), { op: "update", project: "/a", machine: "spark1", id: "x" });
assert.equal(parseOp('{"op":"update","project":"/a"}').error, "id is missing.");
assert.deepEqual(parseOp('{"op":"tell","project":"/a","id":"x","text":"  Keep the query string.\\nRun the check.  "}'), { op: "tell", project: "/a", machine: null, id: "x", text: "Keep the query string.\nRun the check." });
assert.match(parseOp('{"op":"tell","project":"/a","id":"x"}').error, /text is missing/); assert.match(parseOp('{"op":"tell","project":"/a","id":"x","text":"  "}').error, /text is missing/);
assert.match(parseOp('{"op":"tell","project":"/a","id":"x","text":7}').error, /text is missing/); assert.equal(parseOp('{"op":"tell","project":"/a","text":"t"}').error, "id is missing.");
assert.equal(parseOp(JSON.stringify({ op: "tell", project: "/a", id: "x", text: "n".repeat(5000) })).text.length, TELL_MAX);

// state.json: `conflict` per task.
const snap = (list) => snapshot({ tasks: { ":/opt/code/app": list }, facts: { now: 10 } });
const of = (list) => snap(list).projects[0].tasks.map((t) => t.conflict);
assert.deepEqual(of([t0, hit, patch([hit], "x", askedMark(7))[0], { id: "n", title: "N", note: "", done: false, at: 1 }]),
  [null, { onto: "main", files: ["src/app.js", "readme.md"], at: 5, asked: false }, { onto: "main", files: ["src/app.js", "readme.md"], at: 5, asked: true }, null]);
assert.equal(snap([hit]).projects[0].tasks[0].ready, false);
// The notice: a conflict that is new since the pass before; nothing on the first pass, nothing twice.
const before = taskStates(snap([t0])), after = taskStates(snap([hit]));
assert.deepEqual(conflictNews(null, after), []); assert.deepEqual(conflictNews(before, before), []); assert.deepEqual(conflictNews(after, after), []);
const news = conflictNews(before, after);
assert.equal(news.length, 1);
assert.equal(conflictText(news), 'Task updates (from Herdr): Merge of app / x "Edit line b" conflicted with main in src/app.js, readme.md; consider op update (it sends the task back to its own agent; don\'t run it again). Read state.json and act per your rules.');
assert.equal(conflictNews(after, taskStates(snap(patch([hit], "x", conflictMark(res, B, 6))))).length, 1); // conflicted again, later
assert.deepEqual(conflictNews(after, taskStates(snap(patch([hit], "x", askedMark(7))))), []);
// `ready` again: refused while the branch stands where it conflicted or a rebase is under way; allowed once it moved.
assert.match(readyCheck(hit, work(A), "done"), /still conflicts with main .* update first/);
assert.match(readyCheck(hit, work(B, { branch: null }), "done"), /not on its branch/);
assert.equal(readyCheck(hit, work(B), "done"), null); assert.equal(readyCheck(hit, undefined, "done"), null);

// ---- the real sequence ----

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
const exec = (cmd, args, { cwd } = {}) => new Promise((ok, no) => {
  if (!existsSync(cwd)) return no(new Error(`no folder ${cwd}`)); // as Herdr's exec does for a folder that is gone
  execFile(cmd, args, { cwd, env, maxBuffer: 1 << 26 }, (err, stdout, stderr) => ok({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});
const g = async (cwd, ...args) => { const r = await exec("git", args, { cwd }); assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
const scratch = resolve(process.argv[2] ?? ".scratch/task-update-test");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const root = `${realpathSync(scratch)}/repo`;
const put = (dir, f, text) => { mkdirSync(resolve(dir, f, ".."), { recursive: true }); writeFileSync(`${dir}/${f}`, text); };
mkdirSync(root);
await g(root, "init", "-q", "-b", "main");
put(root, "src/app.js", "a\nb\nc\n"); put(root, "readme.md", "one\n");
await g(root, "add", "."); await g(root, "commit", "-qm", "base");
appendFileSync(`${root}/.git/info/exclude`, "\n.worktrees/\n");
const task = async (id, title, note) => {
  const branch = `task-${id}`, path = `${root}/.worktrees/${branch}`;
  await g(root, "worktree", "add", "-q", path, "-b", branch, "main");
  return { id, title, note, done: false, at: 1, run: { chat: `c-${id}`, branch, path, on: null, from: "main", at: 1, worked: true } };
};
// Two tasks, side by side, change the same line; each commits on its branch.
let one = await task("one", "Upper-case b", "Check: node -e 1"), two = await task("two", "Rename b", "In src/app.js.\nCheck: grep -q beta src/app.js");
put(one.run.path, "src/app.js", "a\nB\nc\n"); await g(one.run.path, "commit", "-qam", "upper b");
put(two.run.path, "src/app.js", "a\nbeta\nc\n"); put(two.run.path, "readme.md", "one\ntwo\n"); await g(two.run.path, "commit", "-qam", "beta");
// Both were marked ready at their commits.
const mark = async (t) => ({ ...t, run: { ...t.run, ready: { at: 2, note: "ok", head: (await readWork(exec, t.run)).head } } });
[one, two] = [await mark(one), await mark(two)];
let list = [one, two];
assert.deepEqual(readyTasks({ [`:${root}`]: list }).map((r) => r.id), ["one", "two"]);
// The first merges.
const r1 = await mergeTask(exec, { root, t: one, state: "done" });
assert.equal(r1.ok, true);
list = patch(list, "one", (x) => ({ done: true, run: { ...x.run, merged: { at: 3, commit: r1.commit } } }));
// The second's Merge is aborted: main is as it was, and the task is marked (what tasks.js answerMerge does).
const mainAt = await g(root, "rev-parse", "HEAD");
const r2 = await mergeTask(exec, { root, t: two, state: "done" });
assert.deepEqual([r2.ok, r2.conflict, r2.aborted, r2.files, r2.into], [false, true, true, ["src/app.js"], "main"]);
assert.equal(await g(root, "rev-parse", "HEAD"), mainAt); assert.equal(await g(root, "status", "--porcelain"), "");
assert.match(mergeWords(r2).text, /^task-two conflicts with main in src\/app\.js\. The merge was aborted: main is as it was\. Ask agent to update \(on its row\) sends it back to its agent to rebase onto main; then merge again\.$/);
const w2 = await readWork(exec, two.run);
list = patch(list, "two", conflictMark(r2, w2.head, 4));
two = list[1];
assert.equal("ready" in two.run, false); assert.deepEqual(two.run.conflict, { at: 4, files: ["src/app.js"], onto: "main", head: w2.head });
assert.deepEqual(readyTasks({ [`:${root}`]: list }), []); // no longer in "Ready to merge"
assert.equal(conflictGone(two.run, w2), null);
assert.match(readyCheck(two, w2, "done"), /still conflicts with main/);
// What its agent is told, and does: the rebase stops on the conflict (the mark stays: HEAD is detached), it resolves
// keeping both changes' intent, continues, and runs the check.
const told = updateText(two);
assert.match(told, /conflicts with it in src\/app\.js\. In this worktree run `git rebase main`, .* run the check again \(`grep -q beta src\/app\.js`\), and commit\./);
const stop = await exec("git", ["rebase", "main"], { cwd: two.run.path });
assert.notEqual(stop.code, 0);
const mid = await readWork(exec, two.run);
assert.equal(mid.branch, null); assert.notEqual(mid.head, w2.head);
assert.equal(conflictGone(two.run, mid), null); // still updating: the coordinator's approvals for the rebase hold
assert.match(readyCheck(two, mid, "done"), /not on its branch/);
assert.match(readFileSync(`${two.run.path}/src/app.js`, "utf8"), /<<<<<<< /);
put(two.run.path, "src/app.js", "a\nBETA\nc\n");
await g(two.run.path, "add", "src/app.js"); await g(two.run.path, "rebase", "--continue");
assert.equal((await exec("grep", ["-q", "-i", "beta", "src/app.js"], { cwd: two.run.path })).code, 0);
const w3 = await readWork(exec, two.run);
assert.deepEqual([w3.branch, w3.ahead, w3.dirty], ["task-two", 1, 0]); assert.notEqual(w3.head, w2.head);
// The branch moved: the keeper drops the mark, and the coordinator may mark it ready again.
assert.match(conflictGone(two.run, w3), /task-two moved since its merge conflicted/);
assert.equal(readyCheck(two, w3, "done"), null);
list = patch(list, "two", unconflict);
list = patch(list, "two", (x) => ({ run: { ...x.run, ready: { at: 6, note: "rebased, check passes", head: w3.head } } }));
two = list[1];
assert.equal("conflict" in two.run, false); assert.equal(readyStale(two.run, w3, "done"), null);
assert.deepEqual(readyTasks({ [`:${root}`]: list }).map((r) => r.id), ["two"]);
// The same Merge goes through now, and main has both changes' intent.
const r3 = await mergeTask(exec, { root, t: two, state: "done" });
assert.deepEqual([r3.ok, r3.into, r3.committed], [true, "main", 0]);
assert.equal(await g(root, "log", "-1", "--format=%s"), "Merge task: Rename b");
assert.equal(readFileSync(`${root}/src/app.js`, "utf8"), "a\nBETA\nc\n"); assert.equal(readFileSync(`${root}/readme.md`, "utf8"), "one\ntwo\n");
assert.equal(await g(root, "status", "--porcelain"), "");

rmSync(scratch, { recursive: true, force: true });
console.log("task-update: ok");
