// node t3-panels/tests/prwatch.test.mjs
import assert from "node:assert/strict";
import { checksOf, failedChecks, remarksOf, fingerprint, evaluate, message, sweepDue, pruned, readPr, sweep, summary, SWEEP_MS, WAKE_LIMIT } from "../mods/ht3-panels/prwatch.js";

const run = (name, conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/1/job/${name}` });
const comment = (id, login, body, at = "2026-11-01T10:00:00Z") => ({ id, author: { login }, body, createdAt: at, url: `https://github.com/o/r/pull/7#issuecomment-${id}` });
const pr = (over = {}) => ({ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", headRefOid: "aaaaaaa1111", baseRefName: "main", author: { login: "Me" }, statusCheckRollup: [], comments: [], reviews: [], ...over });

// ---- checks ----
const mixed = pr({ statusCheckRollup: [run("lint", "SUCCESS"), run("test", "FAILURE"), run("build", "", "IN_PROGRESS"), { context: "ci/legacy", state: "ERROR", targetUrl: "https://ci/1" }, run("deploy", "CANCELLED"), run("test", "FAILURE")] });
assert.deepEqual(checksOf(mixed).map((c) => c.tone), ["ok", "bad", "wait", "bad", "bad", "bad"]);
// Failed only, one per name, by name; a running check is neither.
assert.deepEqual(failedChecks(mixed).map((c) => c.name), ["ci/legacy", "deploy", "test"]);
assert.deepEqual(failedChecks(pr({ statusCheckRollup: [run("a", "SUCCESS"), run("b", "", "QUEUED"), { context: "s", state: "PENDING" }] })), []);
assert.deepEqual(failedChecks({}), []);

// ---- remarks ----
const talk = pr({
  comments: [comment("C2", "bob", "second", "2026-11-02T10:00:00Z"), comment("C1", "amy", "first")],
  reviews: [
    { id: "R1", author: { login: "amy" }, state: "COMMENTED", body: "", submittedAt: "2026-11-01T11:00:00Z" }, // only carries line comments
    { id: "R2", author: { login: "amy" }, state: "CHANGES_REQUESTED", body: "", submittedAt: "2026-11-01T12:00:00Z" },
    { id: "R3", author: { login: "bob" }, state: "PENDING", body: "draft" },
  ],
});
const inline = [{ id: 55, user: { login: "amy" }, body: "rename this", path: "src/a.js", html_url: "https://github.com/o/r/pull/7#discussion_r55", created_at: "2026-11-01T11:00:01Z" }];
assert.deepEqual(remarksOf(talk, inline).map((r) => r.id), ["c:C1", "l:55", "r:R2", "c:C2"]);
assert.equal(remarksOf(talk, inline)[1].path, "src/a.js");
assert.equal(remarksOf(talk, inline)[2].state, "changes requested");
assert.deepEqual(remarksOf({}), []);

// ---- fingerprint ----
assert.equal(fingerprint({ head: "abc" }), "");
assert.equal(fingerprint({ head: "abc", failed: ["b", "a"], remarks: ["2", "1"] }), fingerprint({ head: "abc", failed: [{ name: "a" }, { name: "b" }, { name: "a" }], remarks: [{ id: "1" }, { id: "2" }] }));
assert.notEqual(fingerprint({ head: "abc", failed: ["a"] }), fingerprint({ head: "def", failed: ["a"] }));
assert.notEqual(fingerprint({ head: "abc", failed: ["a"] }), fingerprint({ head: "abc", failed: ["a", "b"] }));
// Comments alone don't depend on the head.
assert.equal(fingerprint({ head: "abc", remarks: ["1"] }), fingerprint({ head: "def", remarks: ["1"] }));

// ---- evaluate ----
// Not open, or nothing: nothing to post, and the chat is forgotten.
for (const state of ["MERGED", "CLOSED"]) assert.deepEqual(evaluate({ pr: 7 }, pr({ state, statusCheckRollup: [run("t", "FAILURE")] })), { post: null, next: null });
assert.deepEqual(evaluate(null, null), { post: null, next: null });

// A passing pull request posts nothing; so does one whose checks still run.
let e = evaluate(null, pr({ statusCheckRollup: [run("lint", "SUCCESS"), run("test", "SKIPPED")] }), [], 1000);
assert.equal(e.post, null);
assert.deepEqual(e.next, { pr: 7, head: "aaaaaaa1111", failed: [], seen: [], fp: "", wakes: 0, at: 1000 });
assert.equal(evaluate(null, pr({ statusCheckRollup: [run("build", "", "IN_PROGRESS"), run("lint", "SUCCESS")] })).post, null);

// First look: a failed check is news; the comments there already are taken as read.
const failing = pr({ statusCheckRollup: [run("lint", "SUCCESS"), run("test", "FAILURE"), run("build", "", "IN_PROGRESS")], comments: [comment("C1", "amy", "old")] });
e = evaluate(null, failing, inline);
assert.deepEqual(e.post.failed.map((c) => c.name), ["test"]);
assert.deepEqual(e.post.remarks, []);
assert.deepEqual(e.next.failed, ["test"]);
assert.deepEqual(e.next.seen, ["c:C1", "l:55"]);
assert.equal(e.next.fp, e.post.fp);
// The same answer again: nothing (never the same fingerprint twice), also over a restart (the state is plain JSON).
const kept = JSON.parse(JSON.stringify(e.next));
assert.equal(evaluate(kept, failing, inline).post, null);
assert.deepEqual(evaluate(kept, failing, inline).next.failed, ["test"]);
// The failed check is re-run (pending) and fails again on the same commit: told already.
const rerun = evaluate(kept, pr({ statusCheckRollup: [run("test", "", "IN_PROGRESS")], comments: failing.comments }), inline);
assert.equal(rerun.post, null);
assert.equal(evaluate(rerun.next, failing, inline).post, null);
// The check that was still running fails too: only that one is news.
e = evaluate(kept, pr({ statusCheckRollup: [run("test", "FAILURE"), run("build", "FAILURE")], comments: failing.comments }), inline);
assert.deepEqual(e.post.failed.map((c) => c.name), ["build"]);
assert.deepEqual(e.next.failed, ["test", "build"]);
// A push: the same check failing on the new commit is news again.
e = evaluate(kept, pr({ headRefOid: "bbbbbbb2222", statusCheckRollup: [run("test", "FAILURE")], comments: failing.comments }), inline);
assert.deepEqual(e.post.failed.map((c) => c.name), ["test"]);
assert.equal(e.post.head, "bbbbbbb2222");
assert.notEqual(e.post.fp, kept.fp);
// A read with no checks (a failed read) keeps what was told.
assert.deepEqual(evaluate(kept, pr({ comments: failing.comments }), inline).next.failed, ["test"]);

// New comments: posted once; the author's own never; a failed read of the line comments (null) loses none later.
const more = pr({ statusCheckRollup: failing.statusCheckRollup, comments: [comment("C1", "amy", "old"), comment("C2", "bob", "please fix  the\n typo <!-- hidden -->"), comment("C3", "me", "done")] });
e = evaluate(kept, more, null);
assert.deepEqual(e.post.remarks.map((r) => r.id), ["c:C2"]);
assert.deepEqual(e.post.failed, []);
assert.deepEqual(e.next.seen, ["c:C1", "l:55", "c:C2", "c:C3"]);
assert.equal(e.next.wakes, 1);
assert.equal(evaluate(e.next, more, inline).post, null);
const line2 = [...inline, { id: 56, user: { login: "bob" }, body: "", path: "b.js", created_at: "2026-11-03T00:00:00Z" }];
assert.deepEqual(evaluate(e.next, more, line2).post.remarks.map((r) => r.id), ["l:56"]);
// Another pull request on the chat's branch: a first look again.
e = evaluate(kept, pr({ number: 8, comments: [comment("C9", "bob", "hi")], statusCheckRollup: [run("test", "FAILURE")] }), []);
assert.deepEqual([e.post.number, e.post.remarks.length, e.post.failed.length], [8, 0, 1]);
assert.deepEqual(e.next.seen, ["c:C9"]);
// Comment-only messages stop after WAKE_LIMIT in a row, and start again with a push.
let s = { ...kept, wakes: WAKE_LIMIT };
e = evaluate(s, more, inline);
assert.equal(e.post, null);
assert.ok(e.next.seen.includes("c:C2"));
e = evaluate(s, { ...more, headRefOid: "ccccccc3333", statusCheckRollup: [] }, inline);
assert.deepEqual(e.post.remarks.map((r) => r.id), ["c:C2"]);
assert.equal(e.next.wakes, 0);

// ---- message ----
const text = message(evaluate(kept, { ...more, headRefOid: "bbbbbbb2222" }, line2).post);
assert.match(text, /^Update on pull request #7 \(https:\/\/github\.com\/o\/r\/pull\/7\), which Herdr is watching for you:\n- Checks failed on bbbbbbb:\n  - test https:\/\/github\.com\/o\/r\/actions\/runs\/1\/job\/test\n- 2 new comments:\n/);
assert.match(text, /  - bob: "please fix the typo" https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-C2\n/);
assert.match(text, /  - bob on b\.js: reviewed\n/);
assert.match(text, /gh run view/);
const many = message({ number: 1, url: "", head: null, remarks: [], failed: Array.from({ length: 12 }, (_, i) => ({ name: `job${i}`, word: i ? "failure" : "timed out", url: null })) });
assert.match(many, /^Update on pull request #1, which/);
assert.match(many, /- Checks failed:\n  - job0 \(timed out\)\n  - job1\n/);
assert.match(many, /  - and 2 more\n/);
const long = message({ number: 1, url: "", head: null, failed: [], remarks: [{ id: "c:1", author: null, body: "x".repeat(500), path: null, url: null }] });
assert.match(long, /- 1 new comment:\n  - someone: "x{197}\.\.\."\n/);
assert.doesNotMatch(long, /gh run view/);

// ---- sweepDue, pruned ----
assert.equal(sweepDue({ on: false, last: 0, now: 10 * SWEEP_MS }), false);
assert.equal(sweepDue({ on: true, last: null, now: 5 }), true);
assert.equal(sweepDue({ on: true, last: 1000, now: 1000 + SWEEP_MS - 1 }), false);
assert.equal(sweepDue({ on: true, last: 1000, now: 1000 + SWEEP_MS }), true);
assert.equal(sweepDue({ on: true, running: true, last: 0, now: 10 * SWEEP_MS }), false);
assert.equal(sweepDue({ on: true, last: 9e15, now: 1000 }), true); // a stamp from the future (the clock was set back)
assert.deepEqual(Object.keys(pruned({ a: { at: 1000 }, b: { at: 40 * 24 * 3600 * 1000 }, c: null }, 41 * 24 * 3600 * 1000)), ["b"]);

// ---- readPr, sweep (a made-up exec) ----
const calls = [];
const answers = {
  "/w/fail": { pr: failing, inline },
  "/w/pass": { pr: pr({ number: 9, url: "https://github.com/o/r/pull/9", statusCheckRollup: [run("lint", "SUCCESS")] }), inline: [] },
  "/w/merged": { pr: pr({ number: 3, state: "MERGED", statusCheckRollup: [run("test", "FAILURE")] }) },
};
const exec = async (cmd, args, opts) => {
  calls.push([cmd, args.slice(0, 2).join(" "), opts.cwd, opts.on ?? null]);
  assert.equal(cmd, "gh");
  if (opts.cwd === "/w/gone") throw new Error("can't start gh: ENOENT");
  const a = answers[opts.cwd];
  if (!a) return { code: 1, stdout: "", stderr: opts.cwd === "/w/auth" ? "To get started with GitHub CLI, please run:  gh auth login\n" : 'no pull requests found for branch "main"\n' };
  if (args[0] === "pr") return { code: 0, stdout: JSON.stringify(a.pr), stderr: "" };
  return a.inline ? { code: 0, stdout: JSON.stringify(a.inline), stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 404" };
};
assert.deepEqual(await readPr(exec, "/w/none"), { none: true });
assert.deepEqual(await readPr(exec, "/w/gone"), { error: "can't start gh: ENOENT" });
assert.match((await readPr(exec, "/w/auth")).error, /gh auth login/);
assert.equal((await readPr(exec, "/w/merged")).inline, null);
assert.equal((await readPr(exec, "/w/fail", "spark1")).inline.length, 1);
assert.deepEqual(calls.at(-1), ["gh", "api repos/{owner}/{repo}/pulls/7/comments?per_page=100", "/w/fail", "spark1"]);
// A merged pull request's line comments aren't asked for.
assert.equal(calls.filter((c) => c[2] === "/w/merged").length, 1);

let disk = { old: { pr: 3, head: "x", failed: [], seen: [], fp: "", wakes: 0, at: Date.now() } }, saves = 0;
const posted = [];
const deps = {
  exec, load: async () => JSON.parse(JSON.stringify(disk)), save: async (v) => { saves++; disk = JSON.parse(JSON.stringify(v)); }, post: (chat, body) => posted.push([chat, body]),
  chats: [{ id: "a", cwd: "/w/fail", on: null }, { id: "b", cwd: "/w/fail", on: null }, { id: "c", cwd: "/w/pass", on: null }, { id: "old", cwd: "/w/merged", on: null },
    { id: "d", cwd: "/w/none", on: null }, { id: "e", cwd: "/w/auth", on: "spark1" }, { id: "f", cwd: null }],
};
calls.length = 0;
let out = await sweep(deps);
// Two chats in one folder share one read (2 calls: the pull request, its line comments).
assert.equal(calls.filter((c) => c[2] === "/w/fail").length, 2);
assert.deepEqual(posted.map((p) => p[0]).sort(), ["a", "b"]);
assert.match(posted[0][1], /Checks failed on aaaaaaa:\n  - test /);
assert.deepEqual([out.chats, out.prs, out.posted.length, out.errors.length], [6, 2, 2, 1]);
assert.deepEqual(Object.keys(disk).sort(), ["a", "b", "c"]); // the merged one's chat is forgotten
assert.equal(saves, 1);
assert.match(summary(out), /^6 chats, 2 open pull requests: told 2 chats \(2 failed checks: #7\)\. 1 folder couldn't be read: \/w\/auth: To get started/);
// Again, as after a restart (only the file is left): nothing is posted twice, and nothing is written.
out = await sweep({ ...deps, now: Date.now() + SWEEP_MS });
assert.equal(posted.length, 2);
assert.deepEqual(out.posted, []);
assert.match(summary(out), /2 open pull requests: nothing new/);
// A new comment reaches both chats, once.
answers["/w/fail"] = { pr: { ...failing, comments: [...failing.comments, comment("C5", "bob", "one more thing")] }, inline };
out = await sweep(deps);
assert.equal(posted.length, 4);
assert.match(posted[3][1], /- 1 new comment:\n  - bob: "one more thing"/);
assert.match(summary(out), /told 2 chats \(2 new comments: #7\)/);
await sweep(deps);
assert.equal(posted.length, 4);
assert.equal(summary({ chats: 1, prs: 0, posted: [], errors: [] }), "1 chat, 0 open pull requests: nothing new");

console.log("prwatch: ok");
