// The branch a new worktree starts from (T3's WorktreeBaseBranchPicker.tsx and its "Start from remote" switch): New
// chat's "From" picker, for New worktree and for Several models. It lists the local branches, the one checked out
// first (the default), each with its branch on origin under it, and the branches only origin has at the end. "Fetch
// first" runs `git fetch origin <branch>` before the worktree is made when an origin/ branch is picked. This file is
// the part with no Herdr in it: the list, its order, the filter, the default and what to fetch. launcher.js draws the
// picker and hands the start point to its worktree script (`addWorktree`, `fanOut`).
// Run by node: t3-panels/tests/basebranch.test.mjs.

const REMOTE = "origin";

// branches.js `parseRefs` output -> the picker's rows, in order: [{ ref, local, current, name }]. `ref` is what git is
// given ("main", "origin/main"); `name` the branch without its remote. The checked-out branch and its origin/ one come
// first, then the other local ones as git gave them (newest first), each followed by its origin/ one, then the
// branches only origin has. Other remotes are left out.
export function baseRefs(parsed) {
  const locals = parsed?.locals ?? [], remotes = (parsed?.remotes ?? []).filter((r) => r.remote === REMOTE);
  const out = [], seen = new Set();
  const remote = (name) => {
    const r = remotes.find((x) => x.name === name);
    if (!r || seen.has(r.ref)) return;
    seen.add(r.ref);
    out.push({ ref: r.ref, local: false, current: false, name });
  };
  for (const b of [...locals.filter((x) => x.current), ...locals.filter((x) => !x.current)]) {
    out.push({ ref: b.name, local: true, current: !!b.current, name: b.name });
    remote(b.name);
  }
  for (const r of remotes) remote(r.name);
  return out;
}

// The start point when nothing was picked: the checked-out branch. null when HEAD is detached or the list is empty
// (the worktree then starts from HEAD, as it did before there was a picker).
export const defaultBase = (list) => (list ?? []).find((b) => b.current)?.ref ?? null;

// The rows a typed filter leaves: every word typed is somewhere in the ref, in any case. Keeps the order.
export function filterRefs(list, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? (list ?? []).filter((b) => words.every((w) => b.ref.toLowerCase().includes(w))) : [...(list ?? [])];
}

// A start point as it was typed or scripted (`from:<ref>`, fanout's "from"): trimmed. null for one git would take for
// an option or that has a space in it, and for none.
export function cleanFrom(ref) {
  const r = String(ref ?? "").trim();
  return r && !r.startsWith("-") && !/[\s\0]/.test(r) ? r : null;
}

// Whether a start point is a branch on origin: one of the list's origin/ rows, or, where there is no list (a script),
// anything named origin/<branch>.
export function onOrigin(ref, list = null) {
  const r = String(ref ?? "");
  if (list?.some((b) => b.ref === r)) return !list.find((b) => b.ref === r).local;
  return r.startsWith(`${REMOTE}/`) && r.length > REMOTE.length + 1;
}

// What "Fetch first" runs for a start point: the git arguments, or null when it isn't a branch on origin (a local
// branch or a commit is used as it is).
export function fetchArgs(ref, list = null) {
  return onOrigin(ref, list) ? ["fetch", REMOTE, String(ref).slice(REMOTE.length + 1)] : null;
}

// The picker's button: "From main", "From origin/main"; "From HEAD" when there is nothing to name.
export const baseLabel = (ref) => `From ${ref || "HEAD"}`;
