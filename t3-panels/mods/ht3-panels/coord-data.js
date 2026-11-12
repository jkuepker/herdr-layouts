// The coordinator's logic (coordinator.js), as pure functions: no Herdr imports, so node can test it.

import { chatState, clip, TITLE_MAX, NOTE_MAX, parseKey } from "./tasklist.js";

export const OPS = ["add", "run", "done", "delete"];
export const OPS_KEPT = 20;
// A task id the caller may choose: letters, digits, ".", "_" and "-", at most 64.
export const cleanId = (id) => (typeof id === "string" || typeof id === "number") && /^[\w.-]{1,64}$/.test(String(id)) ? String(id) : null;

// "~" and "~/x" as the person's folder; a trailing "/" goes.
export function expandHome(path, home) {
  const p = String(path ?? "").trim();
  const full = p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;
  return full.length > 1 ? full.replace(/\/+$/, "") : full;
}

// What `coord:<json>` carries -> { op, project (a folder, absolute), machine, id, title, note, run, done }, or { error }.
// add: { project, title, note?, run?, id?, machine? }; run, done, delete: { project, id, machine? } (done: false reopens).
export function parseOp(text, home = "") {
  let o;
  try { o = JSON.parse(text); } catch (e) { return { error: `Not JSON: ${String(e?.message ?? e)}` }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "Not a JSON object." };
  if (!OPS.includes(o.op)) return { error: `Unknown op ${JSON.stringify(o.op ?? null)}: one of ${OPS.join(", ")}.` };
  const project = expandHome(o.project, home);
  if (!project.startsWith("/")) return { op: o.op, error: "project must be a folder's absolute path." };
  const machine = typeof o.machine === "string" && o.machine.trim() ? o.machine.trim() : null;
  const id = cleanId(o.id);
  if (o.id != null && !id) return { op: o.op, project, error: "id may hold letters, digits, '.', '_' and '-' only (at most 64)." };
  if (o.op !== "add") return id ? { op: o.op, project, machine, id, done: o.done !== false } : { op: o.op, project, error: "id is missing." };
  const title = clip(String(o.title ?? "").split("\n")[0], TITLE_MAX);
  if (!title) return { op: o.op, project, error: "title is missing." };
  return { op: "add", project, machine, id, title, note: clip(o.note, NOTE_MAX), run: o.run === true };
}

// The last results, newest last, for the state file: what was asked and how it went.
export const logOp = (log, entry) => [...(log ?? []), entry].slice(-OPS_KEPT);

// The state file's body. `tasks`: shared "ht3-panels.tasks" cleaned ({ key: [task] }); `facts`: what chatState reads
// ({ places, status, turns, tabs, now }); `replies`: chat id -> its last reply's first line; `making`: "<key>\n<task id>" ->
// what a run that hasn't made its chat yet is doing; `skip`: a folder whose space isn't a project's (the coordinator's own).
// A task's state: "none" (never run), "making", or chatState's: starting, working, waiting, done, failed, closed.
export function snapshot({ spaces = [], tasks = {}, facts = {}, replies = {}, making = {}, ops = [], skip = null } = {}) {
  return {
    spaces: spaces.filter((s) => !skip || s.folder !== skip).map((s) => ({ name: String(s.name ?? "").replace(/​/g, ""), folder: s.folder ?? "", machine: s.machine ?? null })),
    projects: Object.keys(tasks).sort().map((key) => {
      const at = parseKey(key);
      return at && {
        project: at.root, machine: at.on,
        tasks: tasks[key].map((t) => {
          const busy = making[`${key}\n${t.id}`], s = t.run ? chatState(t.run, facts) : null;
          return { id: t.id, title: t.title, note: t.note, done: t.done, state: busy ? "making" : s?.state ?? "none",
            ...(s?.why && !busy ? { why: s.why } : {}),
            branch: t.run?.branch ?? null, path: t.run?.path ?? null, chat: t.run?.chat ?? null, lastReply: (t.run && replies[t.run.chat]) || null };
        }),
      };
    }).filter(Boolean),
    ops,
  };
}

// Whether the coordinator's folder needs its files written: none there yet, or an older template's.
export const templateDue = (have, version) => !(Number(String(have ?? "").trim()) >= version);
