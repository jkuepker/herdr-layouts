// Project scripts (T3 Code's project scripts): named commands kept per project, run in a side terminal.
// shared("ht3-panels.scripts"): { "<machine or empty>:<project folder>": [{ name, command }] }. A project is the
// repository's main checkout (a chat's worktree shares its repository's scripts), or, outside Git, the folder itself.
// The Project popover lists and runs them (menus.js); Settings edits them (settings-ui.js). A script runs where the
// person is (the chat's or terminal's folder), typed into a new shell in the side panel, which stays open after it.

import { shared, setShared } from "herdr";
import { MOD } from "./look.js";
import { placeOf, send } from "./side.js";
import { repoOf } from "./launcher.js";

const KEY = `${MOD}.scripts`, RUN = `${MOD}.script`;

// The shown space's project: { key, root, on, cwd, name }, or null with no folder.
export async function projectOf(space) {
  const at = placeOf(space);
  if (!at?.cwd) return null;
  const root = (await repoOf(at.cwd, at.on)) ?? at.cwd;
  return { key: `${at.on ?? ""}:${root}`, root, on: at.on ?? null, cwd: at.cwd, name: root.split("/").filter(Boolean).pop() ?? root };
}

export const scriptsOf = (key) => { const list = key ? (shared(KEY) ?? {})[key] : null; return Array.isArray(list) ? list.filter((s) => s?.name && s?.command) : []; };

export function setScripts(key, list) {
  const all = { ...(shared(KEY) ?? {}) };
  if (list.length) all[key] = list.map((s) => ({ name: String(s.name), command: String(s.command) }));
  else delete all[key];
  setShared(KEY, all);
}

// Runs one: the keeper (main.js Buttons, `script`) opens the terminal; this says which.
export function runScript(project, script) {
  if (!project || !script) return;
  setShared(RUN, { name: script.name, command: script.command, on: project.on, cwd: project.cwd, at: Date.now() });
  send("script");
}
export const pendingScript = () => shared(RUN) ?? null;
