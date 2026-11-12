// The Tasks surface's logic (tasks.js), as pure functions: no Herdr imports, so node can test it.
//
// A task: { id, title, note, done, at, run? }. `run`, once "Run with agent" has started a chat for it:
// { chat (the chat's id), branch, path (the worktree), on (machine or null), from (the branch it was made from), at,
// worked? (the chat was seen working, so an idle chat after that is a finished one), error? }.

export const TITLE_MAX = 200;
export const NOTE_MAX = 8000;
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
        ...(r.worked ? { worked: true } : {}), ...(r.error ? { error: String(r.error) } : {}) } } : {}),
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

// The message a task hands to an agent: its title, then its note.
export const promptOf = (t) => (t.note ? `${t.title}\n\n${t.note}` : t.title);

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
