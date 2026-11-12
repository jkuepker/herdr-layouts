// The Tasks surface's logic (tasks.js), as pure functions: no Herdr imports, so node can test it.
//
// A task: { id, title, note, done, at, run? }. `run`, once "Run with agent" has started a chat for it:
// { chat (the chat's id), branch, path (the worktree), on (machine or null), from (the branch it was made from), at,
// worked? (the chat was seen working, so an idle chat after that is a finished one), error?,
// ready? ({ at, note, head? }: the coordinator looked at the work and says it can be merged; head: the commit the task's
// branch was at then, so a branch that moved since is not called ready any more: readyStale),
// merged? ({ at, commit, removed? }: the person merged the branch into `from`; removed: its worktree and branch are gone) }.
//
// The git side of Merge and Remove worktree is at the end: functions that take `exec(cmd, args, { cwd, on, timeout })`
// (Herdr's, or a child_process shim: tests/task-merge.test.mjs runs them against real repositories).

import { mergeBranch, removeWorktreeFolder, plural } from "./compare-data.js";

export const TITLE_MAX = 200;
export const NOTE_MAX = 8000;
export const READY_NOTE_MAX = 400;
// An idle chat that never worked for this long, and a chat that never got a place for this long, are called failed.
export const IDLE_FAIL_MS = 120000;
export const PLACE_FAIL_MS = 60000;

// A project's key, "<machine or empty>:<repo root>" (scripts.js projectOf), and back: { on, root }, or null when it names no folder.
export const keyOf = (on, root) => `${on ?? ""}:${root}`;
export function parseKey(key) {
  const s = String(key ?? ""), at = s.indexOf(":");
  if (at < 0 || !s.slice(at + 1).startsWith("/")) return null;
  return { on: s.slice(0, at) || null, root: s.slice(at + 1) };
}
// The space a project's chats go to: the first on that machine whose folder is in the repository (its root, or a folder
// under it, a worktree's too), else the first with a pane working there (`cwds`: space id -> its panes' folders). -> its id, or null.
export function spaceIn(spaces, root, on = null, cwds = {}) {
  const inside = (f) => !!f && (f === root || String(f).startsWith(`${root}/`));
  const mine = (spaces ?? []).filter((s) => (s.machine ?? null) === (on ?? null));
  return (mine.find((s) => inside(s.folder)) ?? mine.find((s) => (cwds[s.id] ?? []).some(inside)))?.id ?? null;
}

// A commit's full name.
const SHA = /^[0-9a-f]{40,64}$/;
export const clip = (s, n) => { const t = String(s ?? "").trim(); return t.length > n ? t.slice(0, n) : t; };

// What was saved -> a clean list (a bad entry is dropped, not repaired).
export function cleanTasks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), out = [];
  for (const t of raw) {
    const title = clip(t?.title, TITLE_MAX), id = String(t?.id ?? "");
    if (!title || !id || seen.has(id)) continue;
    seen.add(id);
    const r = t.run && typeof t.run === "object" && t.run.chat ? t.run : null;
    out.push({
      id, title, note: clip(t.note, NOTE_MAX), done: t.done === true, at: Number(t.at) || 0,
      ...(r ? { run: { chat: String(r.chat), branch: String(r.branch ?? ""), path: String(r.path ?? ""), on: r.on ?? null, from: r.from ?? null, at: Number(r.at) || 0,
        ...(r.worked ? { worked: true } : {}), ...(r.error ? { error: String(r.error) } : {}),
        ...(r.ready && typeof r.ready === "object" ? { ready: { at: Number(r.ready.at) || 0, note: clip(r.ready.note, READY_NOTE_MAX), ...(SHA.test(r.ready.head ?? "") ? { head: r.ready.head } : {}) } } : {}),
        ...(r.merged && typeof r.merged === "object" ? { merged: { at: Number(r.merged.at) || 0, commit: String(r.merged.commit ?? ""), ...(r.merged.removed ? { removed: true } : {}) } } : {}) } } : {}),
    });
  }
  return out;
}

export const newTask = (title, note, id, at) => ({ id, title: clip(title, TITLE_MAX), note: clip(note, NOTE_MAX), done: false, at });
export const patch = (list, id, change) => list.map((t) => (t.id === id ? { ...t, ...(typeof change === "function" ? change(t) : change) } : t));
export const remove = (list, id) => list.filter((t) => t.id !== id);

// Up (-1) or down (+1) among the tasks of the same section (open or done): the neighbour it swaps with is the nearest
// task of that section in that direction, so a done task between two open ones doesn't hold them apart.
export function move(list, id, by) {
  const at = list.findIndex((t) => t.id === id);
  if (at < 0) return list;
  const done = list[at].done;
  let to = at + (by < 0 ? -1 : 1);
  while (to >= 0 && to < list.length && list[to].done !== done) to += by < 0 ? -1 : 1;
  if (to < 0 || to >= list.length) return list;
  const out = list.slice();
  [out[at], out[to]] = [out[to], out[at]];
  return out;
}
// Whether the task can move that way (for the buttons).
export const canMove = (list, id, by) => move(list, id, by) !== list;

// What every task's agent is told after the task itself: where to work and how to leave its work (Merge is the person's).
export const PROMPT_RULES = 'Work only in this worktree. When the check passes, commit your changes on this branch (`git add -A && git commit -m "<short message>"`). Don\'t push, don\'t merge, don\'t switch branches.';
// The message a task hands to an agent: its title, then its note, then those rules.
export const promptOf = (t) => `${t.note ? `${t.title}\n\n${t.note}` : t.title}\n\n${PROMPT_RULES}`;

// A branch name for a task: task/<words of the title>-<suffix>, git-safe, never long. `suffix`: a short unique tail.
export function branchFor(title, suffix) {
  const words = String(title ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return `task-${words || "work"}-${String(suffix).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "x"}`;
}

// The state a task's chat is in, from what chat tabs report (report.js): places (chat id -> { tab, pane }), status
// (tab -> working | blocked | done | idle), turns (tab -> how many turns ended), tabs (the open tab ids).
// -> { state: "making" | "starting" | "working" | "waiting" | "done" | "failed" | "closed", tab, pane, worked }.
//  working, waiting (the agent asks you: blocked) and done (a turn ended: "done", or "idle" after one) are the chat's own;
//  starting: the chat is made and hasn't worked yet; failed: it never started (the worktree or the agent didn't come
//  up, or no work after IDLE_FAIL_MS idle, or no tab after PLACE_FAIL_MS); closed: its tab is gone after it worked.
export function chatState(run, { places = {}, status = {}, turns = {}, tabs = new Set(), now = Date.now() } = {}) {
  if (!run) return { state: null };
  if (run.error) return { state: "failed", tab: null, pane: null, worked: false, why: run.error };
  const at = places[run.chat], tab = at?.tab ?? null, here = !!at && tabs.has(tab);
  const age = now - (run.at || now);
  if (!here) {
    if (run.worked) return { state: "closed", tab: null, pane: null, worked: true };
    return age < PLACE_FAIL_MS ? { state: "starting", tab: null, pane: null, worked: false } : { state: "failed", tab: null, pane: null, worked: false, why: "The chat never started." };
  }
  const s = status[tab] ?? "idle", base = { tab, pane: at.pane ?? null };
  if (s === "working") return { ...base, state: "working", worked: true };
  if (s === "blocked") return { ...base, state: "waiting", worked: true };
  if (s === "done" || run.worked || (turns[tab] ?? 0) > 0) return { ...base, state: "done", worked: true };
  return age < IDLE_FAIL_MS ? { ...base, state: "starting", worked: false } : { ...base, state: "failed", worked: false, why: "The agent never started working." };
}
export const STATE_LABEL = { making: "making the worktree", starting: "starting", working: "working", waiting: "waiting for you", done: "done", failed: "failed", closed: "chat closed" };

// ---- notes ----

// The file a folder's notes are kept in, by name: <last two folder names>-<hash of machine and path>.txt. The same
// folder on another machine is another file.
export function notesFile(on, cwd) {
  const key = `${on ?? ""}:${cwd ?? ""}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  const tail = String(cwd ?? "").split("/").filter(Boolean).slice(-2).join("-").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-40) || "root";
  return `${tail}-${h.toString(36)}.txt`;
}

// ---- merge: the person's step ----

// A task's work, read in its worktree: how many commits its branch is ahead of `from`, how many files are uncommitted
// (untracked ones too, each counted), the branch the folder is on and the commit it is at.
const WORK = 'printf "ahead %s\\n" "$(git rev-list --count "$1..HEAD" 2>/dev/null)"; printf "dirty %s\\n" "$(git status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d " ")"; printf "branch %s\\n" "$(git branch --show-current 2>/dev/null)"; printf "head %s\\n" "$(git rev-parse HEAD 2>/dev/null)"';
// Its output -> { ahead (null: `from` isn't there to count from), dirty, branch (null: detached), head (null: no commit yet) }.
export function parseWork(text) {
  const at = {};
  for (const l of String(text ?? "").split("\n")) { const m = /^(ahead|dirty|branch|head) ?(.*)$/.exec(l); if (m) at[m[1]] = m[2].trim(); }
  const num = (v) => (/^\d+$/.test(v ?? "") ? Number(v) : null);
  return { ahead: num(at.ahead), dirty: num(at.dirty) ?? 0, branch: at.branch || null, head: SHA.test(at.head ?? "") ? at.head : null };
}
// -> parseWork's, or { missing: true } when the worktree's folder isn't there (or isn't a repository) any more.
export async function readWork(exec, run) {
  if (!run?.path) return { missing: true };
  const r = await Promise.resolve(exec("sh", ["-c", `git rev-parse --git-dir >/dev/null 2>&1 || exit 9; ${WORK}`, "sh", String(run.from ?? "HEAD")], { cwd: run.path, on: run.on ?? undefined, timeout: 15000 })).catch(() => null);
  return r?.code === 0 ? parseWork(r.stdout) : { missing: true };
}
// `git worktree list --porcelain` -> [{ path, branch (null: detached or bare) }], the main checkout first.
export function parseTrees(text) {
  const out = [];
  for (const l of String(text ?? "").split("\n")) {
    if (l.startsWith("worktree ")) out.push({ path: l.slice(9), branch: null });
    else if (l.startsWith("branch refs/heads/") && out.length) out.at(-1).branch = l.slice(18);
  }
  return out;
}
// "2 commits", "3 uncommitted files", or both; "" when there is neither (or it isn't known).
export function workWords(w) {
  if (!w || w.missing) return "";
  return [w.ahead > 0 ? plural(w.ahead, "commit") : "", w.dirty > 0 ? plural(w.dirty, "uncommitted file") : ""].filter(Boolean).join(", ");
}
export const hasWork = (w) => !!w && !w.missing && (w.ahead > 0 || w.dirty > 0);
// The chat states in which a task's agent may still write: no merge then.
export const BUSY_STATES = ["making", "starting", "working", "waiting"];

// ---- ready to merge ----

// Why a task's "ready to merge" no longer holds, or null while it does (or the task isn't ready). `work`: its worktree as
// last read (readWork), `state`: its chat's state now. It was said of the commit the branch was at (`run.ready.head`): a
// branch that is at another commit now was not looked at, and neither is what an agent that works again will leave.
// (A task that is run again gets a new `run`, without `ready`.) A worktree that wasn't read, or is gone, says nothing.
export function readyStale(run, work, state = null) {
  if (!run?.ready || run.merged) return null;
  if (state === "working" || state === "waiting") return "Its agent works again.";
  if (run.ready.head && work && !work.missing && work.head && work.head !== run.ready.head) return `${run.branch} moved since it was marked ready.`;
  return null;
}
// The task without its ready mark (for patch).
export const unready = (t) => { if (!t.run?.ready) return {}; const { ready: _was, ...run } = t.run; return { run }; };
// Every task that is ready to merge and isn't merged, of every project (`all`: shared "ht3-panels.tasks", as saved), in
// the projects' order and each list's own: [{ key, id, title, project (the folder's name), root, on }].
export function readyTasks(all) {
  return Object.keys(all ?? {}).sort().flatMap((key) => {
    const at = parseKey(key);
    return !at ? [] : cleanTasks(all[key]).filter((t) => t.run?.ready && !t.run.merged)
      .map((t) => ({ key, id: t.id, title: t.title, project: at.root.split("/").filter(Boolean).pop() ?? at.root, root: at.root, on: at.on }));
  });
}
// What `tasks:<rest>` and `tasks-show:<json>` name (main.js): -> { group } ("a" | "b" | null: the one that has Tasks),
// or { project (a folder, absolute), machine, id (a task to bring into view, or null) }, or { error }.
// `tasks`, `tasks:a`, `tasks:b`; `tasks:/folder`, `tasks:<machine>:/folder`; `tasks-show:{"project","machine"?,"id"?}`.
export function parseShow(c) {
  const s = String(c ?? "");
  if (s === "tasks") return { group: null };
  if (s === "tasks:a" || s === "tasks:b") return { group: s.slice(6) };
  if (s.startsWith("tasks:")) {
    const rest = s.slice(6).replace(/(.)\/+$/, "$1"), at = rest.startsWith("/") ? { on: null, root: rest } : parseKey(rest);
    return at ? { project: at.root, machine: at.on, id: null } : { error: "tasks: takes a, b or a project folder's absolute path." };
  }
  if (!s.startsWith("tasks-show:")) return { error: "Not a tasks command." };
  let o;
  try { o = JSON.parse(s.slice(11)); } catch (e) { return { error: `Not JSON: ${String(e?.message ?? e)}` }; }
  if (!o || typeof o.project !== "string" || !o.project.startsWith("/")) return { error: "project must be a folder's absolute path." };
  return { project: o.project.replace(/(.)\/+$/, "$1"), machine: typeof o.machine === "string" && o.machine.trim() ? o.machine.trim() : null, id: o.id == null ? null : String(o.id) };
}
// The command that shows a project's Tasks with one task in view, as a notification's action and a list's row send it.
export const showCommand = (key, id) => { const at = parseKey(key); return at ? `tasks-show:${JSON.stringify({ project: at.root, ...(at.on ? { machine: at.on } : {}), ...(id ? { id } : {}) })}` : "tasks"; };

// Whether a task's branch may be merged, and what Merge would do. `work`: readWork's for its worktree; `trees`:
// parseTrees' for its repository; `targetDirty(folder)`: how many files are uncommitted in the folder `from` is checked
// out in (read by mergePlan once that folder is known; a number here); `state`: its chat's state.
// -> { ok: true, branch, into, target (the folder that is on `from`), ahead, dirty, text (what the confirm row asks) } or { ok: false, why }.
export function mergeCheck(t, { work, trees = [], targetDirty = 0, state = null } = {}) {
  const run = t?.run;
  if (!run?.branch || !run.path) return { ok: false, why: "This task has no worktree: run it first." };
  if (run.merged) return { ok: false, why: `${run.branch} is merged already.` };
  if (BUSY_STATES.includes(state)) return { ok: false, why: state === "waiting" ? "Its agent waits for an answer: answer it and let it finish first." : "Its agent is still working: wait until it is done." };
  if (run.branch.startsWith("-")) return { ok: false, why: "That branch's name starts with a dash." };
  if (!work || work.missing) return { ok: false, why: `Its worktree ${run.path} is gone.` };
  if (work.branch !== run.branch) return { ok: false, why: `Its worktree is on ${work.branch ?? "a detached HEAD"}, not on ${run.branch}: switch it back first.` };
  const from = run.from, at = from ? trees.find((w) => w.branch === from) : null;
  if (!at) {
    const main = trees[0]?.branch;
    return { ok: false, why: `${from ?? "The branch it was made from"} isn't checked out in any folder of this repository${main ? ` (the main checkout is on ${main})` : ""}. Switch the main checkout to ${from && !/^[0-9a-f]{40}$/.test(from) ? from : "the branch you want it in"} first: nothing was merged.` };
  }
  if (at.path === run.path) return { ok: false, why: `Its worktree is on ${from} itself: there is nothing to merge.` };
  if (work.ahead == null) return { ok: false, why: `${run.branch} can't be compared with ${from}.` };
  if (!hasWork(work)) return { ok: false, why: `Nothing to merge: ${run.branch} has no commits ahead of ${from} and no uncommitted changes.` };
  if (targetDirty > 0) return { ok: false, why: `The checkout of ${from} (${at.path}) has ${plural(targetDirty, "uncommitted file")}. Commit or stash them first: nothing was merged.` };
  const commits = work.ahead > 0 ? plural(work.ahead, "commit") : "";
  const first = work.dirty > 0 ? `commits ${plural(work.dirty, "changed file")} first` : "";
  return { ok: true, branch: run.branch, into: from, target: at.path, ahead: work.ahead, dirty: work.dirty,
    text: `Merge ${run.branch} into ${from}: ${[commits, first].filter(Boolean).join(", ")}?` };
}

// git's reason: its error line, else its last line that isn't a hint.
const lastOf = (r, fallback) => {
  const lines = String(r?.stderr || r?.stdout || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:"));
  return (lines.find((l) => /^(fatal|error): /.test(l)) ?? lines.pop() ?? fallback).replace(/^(fatal|error): /, "");
};
const gitIn = (exec, cwd, on, args, timeout = 30000) => exec("git", args, { cwd, on: on ?? undefined, timeout });

// Reads what mergeCheck needs, as things are now, and checks. `root`: the repository's main checkout.
export async function mergePlan(exec, { root, t, state = null }) {
  const run = t?.run, on = run?.on ?? null;
  if (!run?.path) return mergeCheck(t, {});
  const [work, list] = await Promise.all([readWork(exec, run), Promise.resolve(gitIn(exec, root, on, ["worktree", "list", "--porcelain"])).catch(() => null)]);
  const trees = list?.code === 0 ? parseTrees(list.stdout) : [];
  const at = run.from ? trees.find((w) => w.branch === run.from) : null;
  let targetDirty = 0;
  if (at) {
    const s = await Promise.resolve(gitIn(exec, at.path, on, ["status", "--porcelain"])).catch(() => null);
    if (s?.code !== 0) return { ok: false, why: `The checkout of ${run.from} (${at.path}) couldn't be read.` };
    targetDirty = s.stdout.split("\n").filter((l) => l.trim()).length;
  }
  return mergeCheck(t, { work, trees, targetDirty, state });
}

// Merge, after the person's Yes: checks again (what the confirm row said may be old; `expect`: that row's text, and a
// plan that reads differently now is not carried out but handed back to ask again), commits what the worktree has
// uncommitted (`git add -A`, `git commit -m "<task title>"` there), then in the folder that is on `from`:
// `git merge --no-ff <branch> -m "Merge task: <title>"`. A conflict is aborted at once (compare-data.js mergeBranch).
// -> { ok: true, branch, into, commit, committed (files committed first) }
//  | { ok: false, refused: true, error } | { ok: false, changed: true, plan } | { ok: false, conflict: true, files, aborted, branch, into, committed }
//  | { ok: false, error, branch, into, committed }.
export async function mergeTask(exec, { root, t, state = null, expect = null }) {
  const plan = await mergePlan(exec, { root, t, state });
  if (!plan.ok) return { ok: false, refused: true, error: plan.why };
  if (expect != null && plan.text !== expect) return { ok: false, changed: true, plan };
  const run = t.run, on = run.on ?? null, base = { branch: plan.branch, into: plan.into };
  let committed = 0;
  if (plan.dirty > 0) {
    const a = await gitIn(exec, run.path, on, ["add", "-A"], 60000);
    if (a.code !== 0) return { ok: false, error: `git add failed in the worktree: ${lastOf(a, "no reason given")}`, ...base, committed };
    const c = await gitIn(exec, run.path, on, ["commit", "-m", t.title], 120000);
    if (c.code !== 0) return { ok: false, error: `The commit in the worktree failed: ${lastOf(c, "no reason given")}. Nothing was merged.`, ...base, committed };
    committed = plan.dirty;
  }
  const res = await mergeBranch(exec, { folder: plan.target, on }, plan.branch, { noFf: true, message: `Merge task: ${t.title}` });
  if (res.ok) return { ok: true, ...base, commit: res.head, committed };
  return { ...res, ...base, committed };
}
// How a merge went, for the status line. -> { text, bad }.
export function mergeWords(r) {
  const did = r.committed ? ` Its ${plural(r.committed, "changed file")} ${r.committed === 1 ? "was" : "were"} committed on ${r.branch}.` : "";
  if (r.ok) return { bad: false, text: `Merged ${r.branch} into ${r.into} (${r.commit}).${did} The task is done.` };
  if (r.refused) return { bad: true, text: r.error };
  if (r.conflict) return { bad: true, text: `${r.branch} conflicts with ${r.into} in ${r.files?.length ? r.files.join(", ") : "some files"}. ${r.aborted ? `The merge was aborted: ${r.into} is as it was.` : `The merge could not be aborted (${r.error}): look at that checkout.`}${did} Ask the task's agent to rebase onto ${r.into}, then merge again.` };
  return { bad: true, text: `${r.error ?? "git merge failed"}${did}` };
}

// Remove worktree, after a merge: `git worktree remove <path>` (compare-data.js removeWorktreeFolder; never --force:
// refused here while files are uncommitted) and `git branch -d <branch>`, which git refuses while the branch isn't merged.
// -> { ok: true, branch: "deleted" | "kept", why } | { ok: false, error }.
export async function cleanupTask(exec, { root, t }) {
  const run = t?.run, on = run?.on ?? null;
  if (!run?.path || !run.branch) return { ok: false, error: "This task has no worktree." };
  if (!run.merged) return { ok: false, error: `${run.branch} isn't merged yet: merge it first.` };
  const work = await readWork(exec, run);
  if (!work.missing && work.dirty > 0) return { ok: false, error: `${run.path} has ${plural(work.dirty, "uncommitted file")}, so it was kept. Commit or discard them there, then remove it.` };
  if (!work.missing) {
    try { await removeWorktreeFolder(exec, { main: root, folder: run.path, on }); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  } else await Promise.resolve(gitIn(exec, root, on, ["worktree", "prune"])).catch(() => null);
  // git judges "merged" against the HEAD of the folder it runs in: the one that is on `from`, where the merge went.
  const list = await Promise.resolve(gitIn(exec, root, on, ["worktree", "list", "--porcelain"])).catch(() => null);
  const at = (list?.code === 0 ? parseTrees(list.stdout) : []).find((w) => run.from && w.branch === run.from);
  const b = await gitIn(exec, at?.path ?? root, on, ["branch", "-d", run.branch]);
  return b.code === 0 ? { ok: true, branch: "deleted", why: null } : { ok: true, branch: "kept", why: lastOf(b, "git branch -d refused") };
}
