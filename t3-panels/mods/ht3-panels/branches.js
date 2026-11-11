// Git for the Project popover's Pull and its branch picker (T3's GitActionsControl.tsx pull and
// BranchPicker.tsx / BranchToolbarBranchSelector.tsx). The parsing and the picker's rows are pure and exported for
// tests; the functions that run git take `{ cwd, on }` (the folder and its machine) and go through herdr's exec,
// so they run where the space runs.

import { exec } from "herdr";
import { classifyPullFailure } from "./gitstate.js";

// What the branch list asks git for: local branches and remote-tracking ones, the newest commit first.
// Fields, tab separated: full ref name, "*" on the checked-out one, committer time, upstream.
export const REF_FORMAT = "%(refname)%09%(HEAD)%09%(committerdate:unix)%09%(upstream:short)";
export const REF_ARGS = ["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"];

// `git for-each-ref` output -> { locals: [{ name, current, date, upstream }], remotes: [{ ref, remote, name, date }] }.
// Remote HEADs (origin/HEAD) aren't branches. Keeps git's order (newest first).
export function parseRefs(text) {
  const locals = [], remotes = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [ref, head = "", date = "", upstream = ""] = line.split("\t");
    const when = Number(date) || 0;
    if (ref.startsWith("refs/heads/")) locals.push({ name: ref.slice(11), current: head.trim() === "*", date: when, upstream: upstream || null });
    else if (ref.startsWith("refs/remotes/")) {
      const full = ref.slice(13), at = full.indexOf("/");
      if (at <= 0 || full.endsWith("/HEAD")) continue;
      remotes.push({ ref: full, remote: full.slice(0, at), name: full.slice(at + 1), date: when });
    }
  }
  return { locals, remotes };
}

// `git worktree list --porcelain` -> [{ path, branch (short name or null), detached, bare }].
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text ?? "").split(/\n\s*\n/)) {
    const wt = { path: "", branch: null, detached: false, bare: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt.path = line.slice(9);
      else if (line.startsWith("branch ")) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") wt.detached = true;
      else if (line === "bare") wt.bare = true;
    }
    if (wt.path) out.push(wt);
  }
  return out;
}

const same = (a, b) => String(a ?? "").replace(/\/+$/, "") === String(b ?? "").replace(/\/+$/, "");

// The rows of the picker for what is typed. Local branches first (the checked-out one marked `current`), then the
// remote branches that have no local one; a branch another worktree has checked out has `elsewhere` (that
// worktree's folder). When what is typed matches no branch exactly, a "create" row comes first.
// refs: parseRefs, worktrees: parseWorktrees, root: this checkout's folder (its own worktree is not "elsewhere").
export function pickerRows({ refs, worktrees = [], root = null, query = "" }) {
  const q = String(query ?? "").trim(), low = q.toLowerCase();
  const taken = new Map();
  for (const w of worktrees) if (w.branch && !same(w.path, root)) taken.set(w.branch, w.path);
  const have = new Set(refs.locals.map((b) => b.name));
  const seen = new Set();
  const remotes = refs.remotes.filter((b) => !have.has(b.name) && !seen.has(b.name) && seen.add(b.name));
  const hit = (s) => !low || s.toLowerCase().includes(low);
  const rows = [
    ...refs.locals.filter((b) => hit(b.name)).map((b) => ({ kind: "local", name: b.name, current: b.current, elsewhere: taken.get(b.name) ?? null })),
    ...remotes.filter((b) => hit(b.ref)).map((b) => ({ kind: "remote", name: b.name, ref: b.ref, remote: b.remote, current: false, elsewhere: null })),
  ];
  const exact = refs.locals.some((b) => b.name === q) || refs.remotes.some((b) => b.name === q || b.ref === q);
  // Create comes last: Enter on a typed prefix takes the branch it matches; with no match it is the only row.
  return q && !exact ? [...rows, { kind: "create", name: q, current: false, elsewhere: null }] : rows;
}

// One line of why a row can't be used, or null. The current branch needs nothing; one in another worktree can't be
// checked out a second time.
export function rowBlocked(row) {
  return row.elsewhere ? `checked out in ${row.elsewhere}` : null;
}

// git's own words for a failed command: the last lines of its output, without the `error:` / `fatal:` prefixes, the
// hints and a fetch's progress lines, on one line.
const FETCH = /^(From |remote: |\s*[0-9a-f]{7,}\.\.\.?[0-9a-f]{7,}\s|\* \[new |\+ [0-9a-f]|Fetching |Updating [0-9a-f])/;
const words = (r) => String(r?.stderr || r?.stdout || "").split("\n").map((l) => l.trim().replace(/^(error|fatal): /, "")).filter((l) => l && !/^hint:/.test(l) && !FETCH.test(l) && !/^\S+\.\.\S+\s+\S+\s+->/.test(l));
export function gitMessage(r, lines = 3, fallback = "git failed") {
  return words(r).slice(-lines).join(" ") || fallback;
}
// A failed switch keeps git's first lines: they name the files that block it.
export function switchMessage(r) {
  return words(r).slice(0, 5).join(" ") || "git switch failed";
}

// A failed pull in plain words, then git's message. What kind of failure it is is gitstate.js classifyPullFailure.
export function pullError(r) {
  const kind = classifyPullFailure(r).kind, msg = gitMessage(r, 4, "git pull failed");
  if (kind === "diverged") return `Not a fast-forward: this branch and its upstream have both moved on. ${msg}`;
  if (kind === "local-changes") return `Local changes are in the way: ${msg}`;
  return msg;
}

// The line for a pull that worked: before and after are the commits HEAD was at, `count` how many came in.
export function pullSummary({ before, after, count = 0 }) {
  if (!after || before === after) return "Already up to date";
  return `Pulled ${count > 0 ? count : "new"} commit${count === 1 ? "" : "s"}`;
}

const opt = (o, timeout) => ({ cwd: o.cwd, on: o.on ?? undefined, ...(timeout ? { timeout } : {}) });

// ---- git, where the folder is ----

// -> { refs, worktrees }
export async function readBranches(o) {
  const r = await exec("git", REF_ARGS, opt(o, 30000));
  if (r.code !== 0) throw new Error(gitMessage(r, 2, "Cannot list branches"));
  const w = await exec("git", ["worktree", "list", "--porcelain"], opt(o, 15000)).catch(() => null);
  return { refs: parseRefs(r.stdout), worktrees: w?.code === 0 ? parseWorktrees(w.stdout) : [] };
}

// Switch to a picked row: a local branch (`git switch <b>`), a remote-only one (`git switch --track <remote>/<b>`), or
// a new one (`git switch -c <name>`, from where HEAD is). A tree that blocks the switch throws git's message.
export async function switchRow(o, row) {
  if (row.kind === "create") {
    const ok = await exec("git", ["check-ref-format", "--branch", row.name], opt(o, 15000));
    if (ok.code !== 0) throw new Error(`"${row.name}" is not a valid branch name`);
  }
  const args = row.kind === "create" ? ["switch", "-c", row.name] : row.kind === "remote" ? ["switch", "--track", row.ref] : ["switch", row.name];
  const r = await exec("git", args, opt(o, 60000));
  if (r.code !== 0) throw new Error(switchMessage(r));
  return row.kind === "create" ? `Created and switched to ${row.name}` : `Switched to ${row.name}`;
}

// `git pull --ff-only`: never a merge or a rebase. -> the line to show; throws the plain-words error.
export async function pullFastForward(o) {
  const head = async () => { const r = await exec("git", ["rev-parse", "HEAD"], opt(o, 15000)).catch(() => null); return r?.code === 0 ? r.stdout.trim() : null; };
  const before = await head();
  const r = await exec("git", ["pull", "--ff-only"], opt(o, 120000));
  if (r.code !== 0) {
    // `localChanges` (and `untracked`: the files in the way aren't tracked) is what the popover's "Stash and retry" goes by.
    const why = classifyPullFailure(r), err = new Error(pullError(r));
    err.localChanges = why.kind === "local-changes";
    err.untracked = why.untracked;
    throw err;
  }
  const after = await head();
  let count = 0;
  if (before && after && before !== after) {
    const c = await exec("git", ["rev-list", "--count", `${before}..${after}`], opt(o, 15000)).catch(() => null);
    count = c?.code === 0 ? Number(c.stdout.trim()) || 0 : 0;
  }
  return pullSummary({ before, after, count });
}
