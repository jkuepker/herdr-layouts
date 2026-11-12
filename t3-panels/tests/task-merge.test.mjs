// node t3-panels/tests/task-merge.test.mjs [scratch dir]
// Runs the Tasks surface's Merge and Remove worktree (tasklist.js mergePlan, mergeTask, cleanupTask, readWork) against a
// real git repository with task worktrees, made under the scratch directory (default: .scratch/task-merge-test in the
// current directory) and deleted at the end.
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { readWork, mergePlan, mergeTask, mergeWords, cleanupTask, readyStale } from "../mods/ht3-panels/tasklist.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
const ran = [];
const exec = (cmd, args, { cwd } = {}) => new Promise((res, rej) => {
  if (!existsSync(cwd)) return rej(new Error(`no folder ${cwd}`)); // as Herdr's exec does for a folder that is gone
  if (cmd === "git") ran.push(args.join(" ").replace(/^--no-optional-locks -c core\.fsmonitor=false /, ""));
  execFile(cmd, args, { cwd, env, maxBuffer: 1 << 26 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});
const g = async (cwd, ...args) => { const r = await exec("git", args, { cwd }); assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

const scratch = resolve(process.argv[2] ?? ".scratch/task-merge-test");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const root = `${realpathSync(scratch)}/repo`;
const put = (dir, f, text) => { mkdirSync(resolve(dir, f, ".."), { recursive: true }); writeFileSync(`${dir}/${f}`, text); };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

mkdirSync(root);
await g(root, "init", "-q", "-b", "main");
put(root, "readme.md", "one\ntwo\nthree\n");
put(root, "src/app.js", "a\nb\nc\n");
await g(root, "add", "."); await g(root, "commit", "-qm", "base");
appendFileSync(`${root}/.git/info/exclude`, "\n.worktrees/\n"); // as launcher.js addWorktree does
// A task as startTask leaves it: a worktree on a new branch from `from`.
const task = async (id, title, from = "main") => {
  const branch = `task-${id}`, path = `${root}/.worktrees/${branch}`;
  await g(root, "worktree", "add", "-q", path, "-b", branch, from);
  return { id, title, note: "", done: false, at: 1, run: { chat: `c-${id}`, branch, path, on: null, from, at: 1 } };
};
const sansHead = ({ head: _head, ...w }) => w; // the commit the worktree is at: its own test below
const merged = (t, commit) => ({ ...t, done: true, run: { ...t.run, merged: { at: 2, commit } } });

await test("committed work: asked, merged with a merge commit, worktree and branch removed", async () => {
  const t = await task("one", "Add a greeting");
  assert.deepEqual(sansHead(await readWork(exec, t.run)), { ahead: 0, dirty: 0, branch: "task-one" });
  assert.match((await mergePlan(exec, { root, t })).why, /^Nothing to merge/);
  put(t.run.path, "src/hello.js", "hello\n"); await g(t.run.path, "add", "-A"); await g(t.run.path, "commit", "-qm", "hello");
  put(t.run.path, "src/app.js", "a\nb\nc\nd\n"); await g(t.run.path, "add", "-A"); await g(t.run.path, "commit", "-qm", "d");
  assert.deepEqual(sansHead(await readWork(exec, t.run)), { ahead: 2, dirty: 0, branch: "task-one" });
  // The commit the worktree is at is read with it: "ready" is said of that one, and a later commit takes it back.
  const at = (await readWork(exec, t.run)).head;
  assert.equal(at, await g(t.run.path, "rev-parse", "HEAD"));
  const marked = { ...t.run, ready: { at: 2, note: "", head: at } };
  assert.equal(readyStale(marked, await readWork(exec, t.run), "done"), null);
  put(t.run.path, "later.txt", "x\n"); await g(t.run.path, "add", "."); await g(t.run.path, "commit", "-qm", "later");
  assert.match(readyStale(marked, await readWork(exec, t.run), "done"), /moved since/);
  await g(t.run.path, "reset", "-q", "--hard", at);
  assert.equal(readyStale(marked, await readWork(exec, t.run), "done"), null);
  const plan = await mergePlan(exec, { root, t, state: "done" });
  assert.deepEqual([plan.ok, plan.target, plan.text], [true, root, "Merge task-one into main: 2 commits?"]);
  ran.length = 0;
  const r = await mergeTask(exec, { root, t, state: "done", expect: plan.text });
  assert.equal(r.ok, true); assert.equal(r.committed, 0);
  assert.ok(ran.some((c) => c.endsWith("merge --no-ff task-one -m Merge task: Add a greeting")), ran.join("\n"));
  assert.ok(!ran.some((c) => /^(add|commit)\b/.test(c)));
  assert.equal(await g(root, "log", "-1", "--format=%s"), "Merge task: Add a greeting");
  assert.equal((await g(root, "log", "-1", "--format=%p")).split(" ").length, 2); // --no-ff: a merge commit though it could fast-forward
  assert.equal(await g(root, "rev-parse", "--short", "HEAD"), r.commit);
  assert.equal(existsSync(`${root}/src/hello.js`), true);
  assert.equal(mergeWords(r).text, `Merged task-one into main (${r.commit}). The task is done.`);
  assert.match((await cleanupTask(exec, { root, t })).error, /isn't merged yet/);
  ran.length = 0;
  assert.deepEqual(await cleanupTask(exec, { root, t: merged(t, r.commit) }), { ok: true, branch: "deleted", why: null });
  assert.ok(ran.includes(`worktree remove ${t.run.path}`)); assert.ok(ran.includes("branch -d task-one")); assert.ok(!ran.some((c) => /--force|-D\b/.test(c)));
  assert.equal(existsSync(t.run.path), false);
  assert.equal(await g(root, "branch", "--list", "task-one"), "");
});

await test("uncommitted work (the agent didn't commit): Merge commits it in the worktree first, then merges", async () => {
  const t = await task("two", "Change the readme");
  put(t.run.path, "readme.md", "one\ntwo\nthree\nfour\n"); put(t.run.path, "notes/new.txt", "new\n");
  assert.deepEqual(sansHead(await readWork(exec, t.run)), { ahead: 0, dirty: 2, branch: "task-two" });
  const plan = await mergePlan(exec, { root, t });
  assert.equal(plan.text, "Merge task-two into main: commits 2 changed files first?");
  // What the row asked is no longer true (one more commit by now): not carried out, asked again.
  const stale = await mergeTask(exec, { root, t, expect: "Merge task-two into main: 1 commit?" });
  assert.deepEqual([stale.ok, stale.changed, stale.plan.text], [false, true, plan.text]);
  assert.equal((await readWork(exec, t.run)).dirty, 2);
  ran.length = 0;
  const r = await mergeTask(exec, { root, t, expect: plan.text });
  assert.deepEqual([r.ok, r.committed, r.into], [true, 2, "main"]);
  const order = ran.filter((c) => /^(add|commit|merge)\b/.test(c));
  assert.deepEqual(order, ["add -A", "commit -m Change the readme", "merge --no-ff task-two -m Merge task: Change the readme"]);
  assert.equal(await g(t.run.path, "log", "-1", "--format=%s"), "Change the readme");
  assert.equal(await g(t.run.path, "status", "--porcelain"), "");
  assert.equal(await g(root, "log", "-1", "--format=%s"), "Merge task: Change the readme");
  assert.equal(existsSync(`${root}/notes/new.txt`), true);
  assert.match(mergeWords(r).text, /Its 2 changed files were committed on task-two\./);
  // A file left in the worktree after the merge: it is kept, with the reason; then removed once it is clean.
  put(t.run.path, "left.txt", "x\n");
  const kept = await cleanupTask(exec, { root, t: merged(t, r.commit) });
  assert.equal(kept.ok, false); assert.match(kept.error, /has 1 uncommitted file, so it was kept/);
  assert.equal(existsSync(t.run.path), true);
  rmSync(`${t.run.path}/left.txt`);
  assert.equal((await cleanupTask(exec, { root, t: merged(t, r.commit) })).branch, "deleted");
});

await test("a conflict is aborted: the checkout is as it was, and what was committed stays on the branch", async () => {
  const t = await task("three", "Edit line b");
  put(t.run.path, "src/app.js", "a\nB-task\nc\nd\n"); put(t.run.path, "extra.txt", "e\n"); // uncommitted
  put(root, "src/app.js", "a\nB-main\nc\nd\n"); await g(root, "commit", "-qam", "main edits b");
  const before = await g(root, "rev-parse", "HEAD");
  const r = await mergeTask(exec, { root, t });
  assert.deepEqual([r.ok, r.conflict, r.aborted, r.files, r.committed], [false, true, true, ["src/app.js"], 2]);
  assert.equal(await g(root, "rev-parse", "HEAD"), before);
  assert.equal(await g(root, "status", "--porcelain"), "");
  assert.equal((await exec("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: root })).code !== 0, true);
  assert.deepEqual(sansHead(await readWork(exec, t.run)), { ahead: 1, dirty: 0, branch: "task-three" });
  const said = mergeWords(r);
  assert.equal(said.bad, true);
  assert.match(said.text, /^task-three conflicts with main in src\/app\.js\. The merge was aborted: main is as it was\. Its 2 changed files were committed on task-three\. Ask the task's agent to rebase onto main, then merge again\.$/);
  // The agent rebased (here: took main's line): the same button merges now.
  await g(t.run.path, "reset", "-q", "--hard", "main"); put(t.run.path, "extra.txt", "e\n"); await g(t.run.path, "add", "-A"); await g(t.run.path, "commit", "-qm", "extra");
  const again = await mergeTask(exec, { root, t });
  assert.equal(again.ok, true);
  assert.equal((await cleanupTask(exec, { root, t: merged(t, again.commit) })).branch, "deleted");
});

await test("refused with the reason, and nothing is run: dirty checkout, another branch, a busy agent", async () => {
  const t = await task("four", "Small fix");
  put(t.run.path, "fix.txt", "f\n"); await g(t.run.path, "add", "-A"); await g(t.run.path, "commit", "-qm", "fix");
  const head = await g(root, "rev-parse", "HEAD");
  const refused = async (state = null) => { ran.length = 0; const r = await mergeTask(exec, { root, t, state }); assert.deepEqual([r.ok, r.refused], [false, true]); assert.ok(!ran.some((c) => /^(add|commit|merge)\b/.test(c)), ran.join("\n")); return r.error; };
  assert.match(await refused("working"), /still working/);
  put(root, "readme.md", "changed\n");
  assert.match(await refused(), new RegExp(`^The checkout of main \\(${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) has 1 uncommitted file\\. Commit or stash them first`));
  await g(root, "checkout", "-q", "--", "readme.md");
  await g(root, "checkout", "-q", "-b", "dev");
  assert.match(await refused(), /^main isn't checked out in any folder of this repository \(the main checkout is on dev\)/);
  await g(root, "checkout", "-q", "main"); await g(root, "branch", "-q", "-D", "dev");
  assert.equal(await g(root, "rev-parse", "HEAD"), head);
  // The worktree switched to another branch.
  await g(t.run.path, "checkout", "-q", "-b", "elsewhere");
  assert.match(await refused(), /is on elsewhere, not on task-four/);
  await g(t.run.path, "checkout", "-q", "task-four"); await g(root, "branch", "-q", "-D", "elsewhere");
  // `from` checked out in a worktree of its own, not the main checkout: merged there.
  const f = `${root}/.worktrees/feat`;
  await g(root, "worktree", "add", "-q", f, "-b", "feat", "main");
  const t5 = await task("five", "On feat", "feat");
  put(t5.run.path, "feat.txt", "x\n");
  const r5 = await mergeTask(exec, { root, t: t5 });
  assert.deepEqual([r5.ok, r5.into, r5.committed], [true, "feat", 1]);
  assert.equal(await g(f, "log", "-1", "--format=%s"), "Merge task: On feat");
  assert.equal(await g(root, "rev-parse", "HEAD"), head);
  // A worktree folder that is gone: merge refused; Remove worktree still drops git's record and the branch.
  rmSync(t5.run.path, { recursive: true, force: true });
  assert.deepEqual(await readWork(exec, t5.run), { missing: true });
  assert.match((await mergePlan(exec, { root, t: t5 })).why, /is gone/);
  assert.equal((await cleanupTask(exec, { root, t: merged(t5, r5.commit) })).branch, "deleted");
  // Not merged into main: git keeps the branch (never -D), and says why.
  const r4 = await mergeTask(exec, { root, t });
  assert.equal(r4.ok, true);
  await g(t.run.path, "commit", "-q", "--allow-empty", "-m", "one more after the merge");
  const c4 = await cleanupTask(exec, { root, t: merged(t, r4.commit) });
  assert.deepEqual([c4.ok, c4.branch], [true, "kept"]); assert.match(c4.why, /not fully merged/);
  assert.equal(await g(root, "branch", "--list", "task-four") !== "", true);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`task-merge: ok (${passed} tests)`);
