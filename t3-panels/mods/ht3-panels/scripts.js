// Project scripts (T3 Code's project scripts): named commands kept per project, run in a side terminal.
// shared("ht3-panels.scripts"): { "<machine or empty>:<project folder>": [{ name, command }] }. A project is the
// repository's main checkout (a chat's worktree shares its repository's scripts), or, outside Git, the folder itself.
// The Project popover lists and runs them (menus.js); Settings edits them (settings-ui.js). A script runs where the
// person is (the chat's or terminal's folder), typed into a new shell in the side panel, which stays open after it.
// One of a project's scripts can be its setup script (T3's "run on worktree creation"): New worktree runs it in the
// new worktree before the chat starts (setup.js). Which one is kept beside the scripts, by name:
// shared("ht3-panels.setup"): { "<project key>": "<script name>" }; scriptsOf gives that script `setup: true`.

import { exec, shared, setShared } from "herdr";
import { MOD } from "./look.js";
import { placeOf, send } from "./side.js";
import { repoOf } from "./launcher.js";

const KEY = `${MOD}.scripts`, RUN = `${MOD}.script`, SETUP = `${MOD}.setup`;

// The shown space's project: { key, root, on, cwd, name }, or null with no folder.
export async function projectOf(space) {
  const at = placeOf(space);
  if (!at?.cwd) return null;
  const root = (await repoOf(at.cwd, at.on)) ?? at.cwd;
  return { key: `${at.on ?? ""}:${root}`, root, on: at.on ?? null, cwd: at.cwd, name: root.split("/").filter(Boolean).pop() ?? root };
}

export const setupNameOf = (key) => { const n = key ? (shared(SETUP) ?? {})[key] : null; return typeof n === "string" && n ? n : null; };
export const scriptsOf = (key) => {
  const list = key ? (shared(KEY) ?? {})[key] : null, mark = setupNameOf(key);
  return Array.isArray(list) ? list.filter((s) => s?.name && s?.command).map((s) => (s.name === mark ? { ...s, setup: true } : s)) : [];
};
// The project's setup script, { name, command, setup: true }, or null.
export const setupOf = (key) => scriptsOf(key).find((s) => s.setup) ?? null;
// Marks the script of that name as the setup script (one per project); null, or a name the project doesn't have, unmarks.
export function setSetup(key, name) {
  if (!key) return;
  const all = { ...(shared(SETUP) ?? {}) };
  if (name && scriptsOf(key).some((s) => s.name === name)) all[key] = String(name); else delete all[key];
  setShared(SETUP, all);
}
export const toggleSetup = (key, name) => setSetup(key, setupNameOf(key) === name ? null : name);

export function setScripts(key, list) {
  const all = { ...(shared(KEY) ?? {}) }, was = scriptsOf(key), mark = setupNameOf(key);
  if (list.length) all[key] = list.map((s) => ({ name: String(s.name), command: String(s.command) }));
  else delete all[key];
  setShared(KEY, all);
  // The mark follows its script through a rename (one name changed, the rest in place) and goes with a removed one.
  if (mark && !list.some((s) => s.name === mark)) {
    const at = was.findIndex((s) => s.name === mark);
    setSetup(key, list.length === was.length && was.every((s, i) => i === at || s.name === list[i].name) ? list[at].name : null);
  }
}

// A setup script to start from, for the project at `root` (its main checkout): copy the main checkout's `.env*`
// files (none overwritten) when it has any, then install with the package manager its lockfile names. Offered when a
// setup script is created (launcher.js), to read and change; never run on its own account.
const INSTALL = [["pnpm-lock.yaml", "pnpm install --frozen-lockfile"], ["bun.lock", "bun install --frozen-lockfile"], ["bun.lockb", "bun install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"], ["package-lock.json", "npm ci"], ["uv.lock", "uv sync --frozen"], ["poetry.lock", "poetry install"],
  ["Gemfile.lock", "bundle install"], ["Cargo.lock", "cargo fetch --locked"], ["go.sum", "go mod download"]];
export const COPY_ENV = 'cp -n "$HT3_PROJECT_ROOT"/.env* . 2>/dev/null';
export async function setupTemplate(root, on) {
  const r = await exec("sh", ["-c", 'r="$1"; shift; cd "$r" && ls -d .env* "$@" 2>/dev/null; true', "sh", root, ...INSTALL.map((x) => x[0])], { cwd: root, on: on ?? undefined, timeout: 10000 }).catch(() => null);
  const has = new Set(String(r?.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  const install = INSTALL.find((x) => has.has(x[0]))?.[1] ?? null, env = [...has].some((f) => f.startsWith(".env"));
  return [env || !install ? COPY_ENV : null, install].filter(Boolean).join("; ");
}

// Runs one: the keeper (main.js Buttons, `script`) opens the terminal; this says which.
export function runScript(project, script) {
  if (!project || !script) return;
  setShared(RUN, { name: script.name, command: script.command, on: project.on, cwd: project.cwd, at: Date.now() });
  send("script");
}
export const pendingScript = () => shared(RUN) ?? null;
