// node t3-panels/tests/compare-data.test.mjs [scratch dir]
// Runs compare-data.js against real git repositories (a main checkout and two worktrees) made under the scratch
// directory (default: .scratch/cmp-test in the current directory), and deletes them at the end.
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { lastReply, parseChanges, compareSides, keepCheck, keepSide, mergeBranch, removeWorktreeFolder } from "../mods/ht3-panels/compare-data.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
const exec = (cmd, args, { cwd } = {}) => new Promise((res) => execFile(cmd, args, { cwd, env, maxBuffer: 1 << 26 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const g = async (cwd, ...args) => { const r = await exec("git", args, { cwd }); assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

const root = resolve(process.argv[2] ?? ".scratch/cmp-test");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const base = realpathSync(root);
const main = `${base}/main`, wa = `${base}/wt-a`, wb = `${base}/wt-b`;
const put = (dir, f, text) => { mkdirSync(resolve(dir, f, ".."), { recursive: true }); writeFileSync(`${dir}/${f}`, text); };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

// ---- pure ----
await test("lastReply takes the first line of the newest agent message", () => {
  assert.equal(lastReply([{ kind: "agent", text: "old" }, { kind: "user", text: "q" }, { kind: "agent", text: "\n## Done: it works\nmore" }, { kind: "tool" }]), "Done: it works");
  assert.equal(lastReply([{ kind: "user", text: "q" }]), null);
  assert.equal(lastReply([{ kind: "agent", text: "x".repeat(300) }]).length, 140);
});
await test("parseChanges reads numstat and name-status, binary and odd names", () => {
  const f = parseChanges("3\t1\tb.txt\0-\t-\timg.png\0" + "0\t0\tnew file.txt\0", "M\0b.txt\0A\0img.png\0D\0new file.txt\0");
  assert.deepEqual(f.map((x) => [x.path, x.status, x.add, x.del, x.binary]), [["b.txt", "M", 3, 1, false], ["img.png", "A", 0, 0, true], ["new file.txt", "D", 0, 0, false]]);
});

// ---- real repositories ----
mkdirSync(main);
await g(main, "init", "-q", "-b", "main");
put(main, "readme.md", "one\ntwo\nthree\n");
put(main, "src/app.js", "a\nb\nc\n");
await g(main, "add", "."); await g(main, "commit", "-qm", "base");
await g(main, "worktree", "add", "-q", "-b", "feat-a", wa);
await g(main, "worktree", "add", "-q", "-b", "feat-b", wb);
// A: committed change to src/app.js and a new file, and an uncommitted edit + an untracked file.
put(wa, "src/app.js", "a\nb\nc\nd\ne\n"); put(wa, "src/new-a.js", "x\ny\n");
await g(wa, "add", "."); await g(wa, "commit", "-qm", "A work");
// B: edits readme.md, another file; leaves one untracked file and one modified.
put(wb, "readme.md", "one\nTWO\nthree\nfour\n"); await g(wb, "add", "."); await g(wb, "commit", "-qm", "B work");

await test("compareSides: files, counts, base and dirty flags", async () => {
  put(wb, "notes/todo.txt", "t1\nt2\nt3\n"); // untracked in B
  const r = await compareSides(exec, [{ folder: wa }, { folder: wb }]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.main.folder, main); assert.equal(r.main.branch, "main"); assert.equal(r.main.dirty, 0);
  const [a, b] = r.sides;
  assert.equal(a.branch, "feat-a"); assert.equal(a.linked, true); assert.equal(a.dirty, 0); assert.equal(a.ahead, 1);
  assert.equal(a.base, r.main.head);
  assert.deepEqual(a.changes.files.map((f) => [f.path, f.status, f.add, f.del]), [["src/app.js", "M", 2, 0], ["src/new-a.js", "A", 2, 0]]);
  assert.equal(a.changes.add, 4);
  assert.equal(b.dirty, 1); assert.equal(b.ahead, 1);
  assert.deepEqual(b.changes.files.map((f) => [f.path, f.status, f.add, f.del]), [["notes/todo.txt", "A", 3, 0], ["readme.md", "M", 2, 1]]);
  rmSync(`${wb}/notes`, { recursive: true });
});
await test("compareSides refuses another repository and the same folder", async () => {
  const other = `${base}/other`; mkdirSync(other); await g(other, "init", "-q"); put(other, "f", "1\n"); await g(other, "add", "."); await g(other, "commit", "-qm", "x");
  assert.match((await compareSides(exec, [{ folder: wa }, { folder: other }])).error, /different repositories/);
  assert.match((await compareSides(exec, [{ folder: wa }, { folder: wa }])).error, /same folder/);
  const gone = await compareSides(exec, [{ folder: wa }, { folder: `${base}/nope` }]);
  assert.equal(gone.ok, true); assert.ok(gone.sides[1].error);
});
await test("a chat in the main checkout compares as its uncommitted changes", async () => {
  put(main, "scratch.txt", "z\n");
  const r = await compareSides(exec, [{ folder: main }, { folder: wa }]);
  assert.equal(r.sides[0].linked, false); assert.deepEqual(r.sides[0].changes.files.map((f) => f.path), ["scratch.txt"]);
  assert.equal(keepCheck(r.sides[0], r.main).ok, false);
  rmSync(`${main}/scratch.txt`);
});
await test("keepSide refuses a dirty main checkout, then an uncommitted side", async () => {
  put(main, "readme.md", "dirty\n");
  let r = await keepSide(exec, { main, folder: wa });
  assert.equal(r.ok, false); assert.match(r.error, /main checkout has 1 uncommitted file/);
  await g(main, "checkout", "--", "readme.md");
  put(wa, "src/app.js", "a\nb\nc\nd\ne\nf\n"); // uncommitted in A
  r = await keepSide(exec, { main, folder: wa });
  assert.equal(r.ok, false); assert.match(r.error, /uncommitted file/);
  await g(wa, "checkout", "--", "src/app.js");
  assert.equal(await g(main, "rev-parse", "--verify", "-q", "MERGE_HEAD").catch(() => "none"), "none");
});
await test("keepSide merges A into main (clean), keeps both branches", async () => {
  const before = await g(main, "rev-parse", "HEAD");
  const r = await keepSide(exec, { main, folder: wa });
  assert.equal(r.ok, true, r.error); assert.equal(r.branch, "feat-a"); assert.equal(r.into, "main"); assert.equal(r.upToDate, false);
  assert.notEqual(await g(main, "rev-parse", "HEAD"), before);
  assert.equal(await g(main, "show", "HEAD:src/new-a.js"), "x\ny");
  assert.equal((await g(main, "status", "--porcelain")), "");
});
await test("a conflicting merge is aborted and the main checkout stays clean", async () => {
  // B and the new main now both change readme? make main change readme.md, then B conflicts.
  put(main, "readme.md", "one\nMAIN\nthree\n"); await g(main, "commit", "-qam", "main edits readme");
  const head = await g(main, "rev-parse", "HEAD");
  const r = await keepSide(exec, { main, folder: wb });
  assert.equal(r.ok, false); assert.equal(r.conflict, true); assert.equal(r.aborted, true);
  assert.deepEqual(r.files, ["readme.md"]);
  assert.equal(await g(main, "rev-parse", "HEAD"), head);
  assert.equal(await g(main, "status", "--porcelain"), "");
  assert.equal(existsSync(`${main}/.git/MERGE_HEAD`), false);
});
await test("a merge git refuses before it starts leaves nothing to abort", async () => {
  await g(wb, "checkout", "-q", "-b", "feat-c", "feat-b"); // wb is on feat-c; B's branch for this case: add a tracked file main has untracked
  put(wb, "clash.txt", "from c\n"); await g(wb, "add", "."); await g(wb, "commit", "-qm", "clash");
  put(main, "clash.txt", "untracked in main\n");
  const r = await mergeBranch(exec, { folder: main }, "feat-c");
  assert.equal(r.ok, false); assert.ok(!r.conflict); assert.match(r.error, /untracked|overwritten|clash/i);
  rmSync(`${main}/clash.txt`);
});
await test("removeWorktreeFolder removes the folder, keeps the branch, refuses a dirty one", async () => {
  put(wa, "dirt.txt", "x\n");
  await assert.rejects(() => removeWorktreeFolder(exec, { main, folder: wa }), /untracked|contains|modified/i);
  assert.equal(existsSync(wa), true);
  rmSync(`${wa}/dirt.txt`);
  await removeWorktreeFolder(exec, { main, folder: wa });
  assert.equal(existsSync(wa), false);
  assert.match(await g(main, "branch", "--list", "feat-a"), /feat-a/);
});
await test("a detached main checkout is refused", async () => {
  await g(main, "checkout", "-q", "--detach");
  const r = await keepSide(exec, { main, folder: wb });
  assert.equal(r.ok, false); assert.match(r.error, /detached/);
  await g(main, "checkout", "-q", "main");
});

rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed`);
