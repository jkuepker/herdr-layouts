// Compare two chats (compare.js): the git side of it, with no Herdr imports so node can run it against real
// repositories (t3-panels/tests/compare-data.test.mjs). `exec(cmd, args, { cwd, on, timeout })` resolves to
// { code, stdout, stderr }, Herdr's `exec` or a child_process shim.
//
// Two chats that did the same task usually work in a worktree each, of one repository. For each folder this reads its
// branch, whether it has uncommitted changes, and what changed against the merge base with the main checkout's HEAD:
// every changed file with its +/- counts, committed or not, new untracked files included (through a throwaway index,
// as the Project popover counts the Changes row, so the real one isn't touched). Reads only, until keepSide.
//
// keepSide merges one side's branch into the main checkout's branch: refused (with the reason, before anything is
// run) when the main checkout has uncommitted changes or a detached HEAD, when that side has none of its own to
// merge or has uncommitted changes a merge would leave behind; a merge that conflicts is aborted at once, so
// the main checkout is as it was. Branches are never deleted: removeWorktreeFolder is `git worktree remove` alone.

export const MAX_FILES = 300;
const SEP = "\x1fSTATUS\x1f";

const lastLine = (r, fallback) => (String(r?.stderr || r?.stdout || "").trim().split("\n").map((l) => l.trim()).filter(Boolean).join(" ") || fallback).replace(/^(fatal|error): /, "");
const git = (exec, ctx, args, timeout = 30000) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: ctx.cwd, on: ctx.on ?? undefined, timeout });
const nonEmpty = (s) => String(s ?? "").split("\n").filter((l) => l.trim()).length;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
export { plural };

// The first line of the last thing the agent said in a transcript's items, at most `max` characters; null if none.
export function lastReply(items, max = 140) {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const m = items[i];
    if (m?.kind !== "agent" || !m.text) continue;
    const line = String(m.text).split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return null;
}

// What `git diff --numstat -z` and `--name-status -z` (with --no-renames) said, as [{ path, status, add, del, binary }] in path order.
export function parseChanges(numstat, nameStatus) {
  const status = new Map();
  const ns = String(nameStatus ?? "").split("\0");
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i][0]);
  const files = [];
  for (const rec of String(numstat ?? "").split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ""));
    if (!m) continue;
    const binary = m[1] === "-";
    files.push({ path: m[3], status: status.get(m[3]) ?? "M", add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// $1: the base. The changes of the working tree against it, new files included, through a copy of the index.
const CHANGES = 'i=$(mktemp "${TMPDIR:-/tmp}/ht3cmp.XXXXXX") || exit 1; cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null || rm -f "$i"; export GIT_INDEX_FILE="$i"; git add -N . >/dev/null 2>&1; '
  + 'git -c core.fsmonitor=false diff --no-color --no-ext-diff --no-renames --numstat -z "$1" --; printf "\\037STATUS\\037"; '
  + 'git -c core.fsmonitor=false diff --no-color --no-ext-diff --no-renames --name-status -z "$1" --; rm -f "$i"';

export async function changesOf(exec, ctx, base) {
  const r = await exec("sh", ["-c", CHANGES, "sh", base], { cwd: ctx.cwd, on: ctx.on ?? undefined, timeout: 60000 });
  if (r.code !== 0) throw new Error(lastLine(r, "git diff failed"));
  const [a, b] = String(r.stdout).split(SEP);
  const all = parseChanges(a, b);
  return { files: all.slice(0, MAX_FILES), total: all.length, add: all.reduce((n, f) => n + f.add, 0), del: all.reduce((n, f) => n + f.del, 0) };
}

// One folder: { folder (its top level), common (its git directory shared by all worktrees), main (the main checkout's
// folder; null for a bare repository), linked (it is a worktree, not the main checkout), head, branch (null when
// detached), dirty (how many files are uncommitted, untracked ones too) }. Throws when it isn't a repository with a commit.
export async function lookAt(exec, ctx) {
  const t = await git(exec, ctx, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], 15000);
  if (t.code !== 0) throw new Error(lastLine(t, "Not a Git repository."));
  const [folder, common] = t.stdout.trim().split("\n");
  const h = await git(exec, ctx, ["rev-parse", "HEAD"], 15000);
  if (h.code !== 0) throw new Error("This repository has no commit yet.");
  const b = await git(exec, ctx, ["branch", "--show-current"], 15000);
  const s = await git(exec, ctx, ["status", "--porcelain"], 30000);
  const main = common && common.endsWith("/.git") ? common.slice(0, -5) : null;
  return { folder, common, main, linked: !!main && folder !== main, head: h.stdout.trim(), branch: b.stdout.trim() || null, dirty: nonEmpty(s.stdout) };
}

// Reads both sides: `sides` is [{ folder, on }, { folder, on }]. -> { ok: true, main: { folder, branch, head, dirty }, sides: [side, side] } where a
// side is lookAt's with `base` (merge base with the main checkout's HEAD), `ahead` (its commits since), and `changes`
// ({ files, total, add, del }), or `error` (that folder couldn't be read: the other side still is); or { ok: false, error } when
// the two can't be compared (different repositories or machines, the same folder).
export async function compareSides(exec, sides) {
  const ctxs = sides.map((s) => ({ cwd: s.folder, on: s.on ?? null }));
  const looks = await Promise.all(ctxs.map((c) => lookAt(exec, c).then((v) => ({ v }), (e) => ({ e: String(e?.message ?? e) }))));
  const good = looks.filter((l) => l.v).map((l) => l.v);
  if ((ctxs[0].on ?? null) !== (ctxs[1].on ?? null)) return { ok: false, error: "The two chats work on different machines." };
  if (good.length === 2) {
    if (good[0].common !== good[1].common) return { ok: false, error: "The two chats work in different repositories." };
    if (good[0].folder === good[1].folder) return { ok: false, error: "Both chats work in the same folder: there is nothing to tell apart." };
  }
  const ref = good[0];
  if (!ref?.main) return { ok: false, error: looks.map((l) => l.e).find(Boolean) ?? "This repository has no main checkout to compare against." };
  const mctx = { cwd: ref.main, on: ctxs[0].on };
  const mainLook = await lookAt(exec, mctx).catch((e) => ({ error: String(e?.message ?? e) }));
  if (mainLook.error) return { ok: false, error: `The main checkout can't be read: ${mainLook.error}` };
  const out = await Promise.all(looks.map(async (l, i) => {
    if (!l.v) return { folder: sides[i].folder, error: l.e };
    try {
      const m = await git(exec, ctxs[i], ["merge-base", l.v.head, mainLook.head]);
      if (m.code !== 0) return { ...l.v, error: "No history in common with the main checkout's HEAD." };
      const base = m.stdout.trim();
      const n = await git(exec, ctxs[i], ["rev-list", "--count", `${base}..${l.v.head}`]);
      return { ...l.v, base, ahead: Number(n.stdout.trim()) || 0, changes: await changesOf(exec, { cwd: l.v.folder, on: ctxs[i].on }, base) };
    } catch (e) { return { ...l.v, error: String(e?.message ?? e) }; }
  }));
  return { ok: true, main: { folder: mainLook.folder, branch: mainLook.branch, head: mainLook.head, dirty: mainLook.dirty }, sides: out };
}

// Whether `side` (one of compareSides' sides) may be merged into `main`: { ok: true } or { ok: false, why }.
export function keepCheck(side, main) {
  if (!side || side.error) return { ok: false, why: side?.error ?? "That chat's folder couldn't be read." };
  if (!side.linked) return { ok: false, why: "That chat works in the main checkout itself: there is nothing to merge." };
  if (!side.branch) return { ok: false, why: "That chat's worktree is on a detached HEAD: make a branch of it first." };
  if (!main.branch) return { ok: false, why: "The main checkout is on a detached HEAD: switch it to a branch first." };
  if (main.dirty > 0) return { ok: false, why: `The main checkout has ${plural(main.dirty, "uncommitted file")}. Commit or stash them first: nothing was merged.` };
  if (side.dirty > 0) return { ok: false, why: `That chat's worktree has ${plural(side.dirty, "uncommitted file")}, which a merge would leave behind. Commit them there first: nothing was merged.` };
  if (side.branch === main.branch) return { ok: false, why: `Both are on ${main.branch}.` };
  if (side.branch.startsWith("-")) return { ok: false, why: "That branch's name starts with a dash." };
  return { ok: true };
}

// Merges `branch` into the main checkout's current branch (`git merge --no-edit`). A conflict is aborted at once.
// -> { ok: true, upToDate, head } | { ok: false, conflict: true, files, aborted } | { ok: false, error }.
export async function mergeBranch(exec, main, branch) {
  const ctx = { cwd: main.folder, on: main.on };
  const r = await git(exec, ctx, ["merge", "--no-edit", branch], 120000);
  if (r.code === 0) {
    const h = await git(exec, ctx, ["rev-parse", "--short", "HEAD"], 15000);
    return { ok: true, upToDate: /Already up to date/i.test(r.stdout), head: h.stdout.trim() };
  }
  // A merge that stopped leaves MERGE_HEAD; one git refused before it began (an untracked file in the way) leaves nothing to abort.
  const mh = await git(exec, ctx, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], 15000);
  if (mh.code !== 0) return { ok: false, error: lastLine(r, "git merge failed") };
  const u = await git(exec, ctx, ["diff", "--name-only", "--diff-filter=U"], 15000);
  const ab = await git(exec, ctx, ["merge", "--abort"], 60000);
  return { ok: false, conflict: true, files: u.stdout.split("\n").map((l) => l.trim()).filter(Boolean), aborted: ab.code === 0, ...(ab.code === 0 ? {} : { error: lastLine(ab, "git merge --abort failed") }) };
}

// Keep one side: look again at both folders (what was read may be old), refuse by keepCheck, merge. `side` is the folder
// and machine; the check runs on what is there now. -> { ok, ... } as mergeBranch, or { ok: false, refused: true, error }.
export async function keepSide(exec, { main, folder, on }) {
  const mctx = { cwd: main, on: on ?? null };
  let m, s;
  try { [m, s] = await Promise.all([lookAt(exec, mctx), lookAt(exec, { cwd: folder, on: on ?? null })]); } catch (e) { return { ok: false, refused: true, error: String(e?.message ?? e) }; }
  const c = keepCheck(s, m);
  if (!c.ok) return { ok: false, refused: true, error: c.why };
  const res = await mergeBranch(exec, { folder: m.folder, on: on ?? null }, s.branch);
  return { ...res, branch: s.branch, into: m.branch };
}

// The Project popover's Remove worktree (menus.js uses this too): `git worktree remove <folder>` in the main checkout, without
// --force, so a folder with uncommitted changes stays and git's last line is the error. The branch is not touched.
export async function removeWorktreeFolder(exec, { main, folder, on }) {
  const r = await exec("git", ["worktree", "remove", folder], { cwd: main, on: on ?? undefined, timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop().replace(/^fatal: /, "") || "git worktree remove failed");
}
