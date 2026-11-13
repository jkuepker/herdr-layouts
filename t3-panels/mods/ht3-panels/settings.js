// The T3 mods' settings: one file the person can edit by hand, ~/.config/herdr-app/data/ht3-settings.json,
// and the Settings dialog (settings-ui.js) that writes it. Herdr has no settings of a mod's own, so
// this is the mod's: the keeper (main.js Buttons) reads the file when it starts and every two
// seconds, and shares what it holds as "ht3-panels.settings"; every copy reads that, so a change
// here or in the file shows at once, with no restart.
//
//   { "agents": { "<id>": { "enabled": false, "models": ["<model id>", ...] } },
//     "defaultAgent": "<id>", "editors": { "<id>": false }, "sidePanelHiddenInNewSpaces": true }
//
// - agents.<id>.enabled (true): whether New chat and Side chat offer that agent (ids: agent-acp.js AGENTS).
// - agents.<id>.models (absent: all): the models that agent's chats list in their model picker.
// - defaultAgent (absent: the first installed): the agent those two come up with.
// - editors.<id> (true): whether the Project popover lists that editor (ids: menus.js EDITORS).
// - checkpoints (true): in a Git repository a chat snapshots the files before and after each turn (checkpoint.js).
// - followUp ("queue"): "steer" makes a message sent while the agent works interrupt it.
// - notifications (true): a toast when a chat that isn't looked at finishes or needs an approval; sounds (false): a sound then.
// - diffIgnoreWhitespace (true, as T3's): the Diff surface puts -w on every diff and show it runs; false shows whitespace changes.
// - diffHideTestFiles (false): the Diff surface leaves test files out of its list and diff, and says how many (the flask button).
// - commitStyle ("plain"): what "Write message" asks the agent for: "plain" (a short imperative subject), "conventional"
//   (type(scope): subject), or "template" (the repository's commit.template or .gitmessage as the format). The Commit step
//   warns, without blocking, when a typed message's first line isn't Conventional Commits and the style is "conventional".
// - mdPreviewDefault (true): a Markdown file (.md, .mdx, .markdown) opens in the Files editor as its rendered preview;
//   false opens it as text. The Preview button still switches one file, and the choice is kept for the session.
// - chatTokenBudget (0 = off; 100000, 250000, 500000, 1000000 or 2000000): a chat whose reported input + output tokens reach
//   80% of it gets a warning line over the message box, and at 100% the line offers Stop and New session (token-budget.js).
// - taskAgent, taskModel (absent: the default agent, on its own model): the agent a task's chat starts on (Tasks' "Run with
//   agent", the coordinator's tasks) and the model it is set to before the task is sent, e.g. "omp" and
//   "fleetq-tatooine-r9700-8080/Qwen3.8". An agent that is off or not installed falls back to the default one, on its own model.
// - coordinatorAgent ("claude"), coordinatorModel (absent: the agent's own): the same for the coordinator chat (coordinator.js).
// - coordinatorNotify (true): Herdr tells the coordinator chat, in a message of its own, when a task's chat finished, failed,
//   waits for an approval or was closed (at most one message in 45 seconds); false: it learns of them when it reads its state file.
// - keepAwake (false): while a chat or task agent works, the Mac doesn't go to sleep (caffeinate, macOS only; report.js keepAwake).
// - autoResumeLimit (false): a chat stopped by a usage limit sends "continue" when the limit resets (limit-resume.js); off, its
//   banner's "Resume at …" button arms it for that one stop.
// - prWatch (false): a chat whose branch has an open GitHub pull request gets a message when checks failed on it or someone
//   commented (prwatch.js; looked at every two minutes through gh).
// - sidePanelHiddenInNewSpaces (false): a space shown for the first time starts with the side panel hidden.
// Anything left out is its default; unknown keys are kept as they are.

import { shared, setShared, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { MOD } from "./look.js";
import { AGENTS } from "./agent-acp.js";
import { cleanBudget } from "./token-budget.js";

const KEY = `${MOD}.settings`, MODELS = `${MOD}.models`;
export const settingsFile = () => `${appHome()}/data/ht3-settings.json`;

const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
export const prefs = () => plain(shared(KEY));

export const agentOn = (id) => plain(prefs().agents)[id]?.enabled !== false;
export const enabledAgents = () => AGENTS.filter((a) => agentOn(a.id));
// The agent to come up with: the chosen default if it is offered and installed (`found`: detect()'s), else the first that is.
export function firstAgent(found) {
  const can = enabledAgents().filter((a) => found?.[a.argv[0]]);
  return (can.find((a) => a.id === prefs().defaultAgent) ?? can[0])?.id ?? null;
}
// A role's agent ("task": a task's chat; "coordinator": the coordinator chat): the one set for it (`<role>Agent`; the
// coordinator's is Claude Code unless set) if it is offered and installed, else the one New chat comes up with.
const ROLE_DEFAULT = { coordinator: "claude" };
export function roleAgent(role, found) {
  const want = prefs()[`${role}Agent`] ?? ROLE_DEFAULT[role] ?? null;
  return enabledAgents().find((a) => a.id === want && found?.[a.argv[0]])?.id ?? firstAgent(found);
}
// The role's model (`<role>Model`), or null for the agent's own.
export function roleModel(role) {
  const m = prefs()[`${role}Model`];
  return typeof m === "string" && m.trim() ? m.trim() : null;
}
// What a role's chat is set to before its first message (the chat's `set` prop): its model, when `id`, the agent it
// starts on, is the role's own (another agent's models are not its), else null.
export function roleSet(role, id) {
  const model = roleModel(role);
  return model && id && id === (prefs()[`${role}Agent`] ?? ROLE_DEFAULT[role] ?? id) ? { model } : null;
}
// The model ids an agent's picker is limited to, or null for all it offers.
export function modelsOf(id) {
  const m = plain(prefs().agents)[id]?.models;
  return Array.isArray(m) && m.length ? m.map(String) : null;
}
export const editorOn = (id) => plain(prefs().editors)[id] !== false;
export const sideStartsHidden = () => prefs().sidePanelHiddenInNewSpaces === true;
// "checkpoints": false turns the per-turn snapshots (checkpoint.js) off.
export const checkpointsOn = () => prefs().checkpoints !== false;
// "diffIgnoreWhitespace": false shows whitespace changes in the Diff surface; the default hides them (T3's diffIgnoreWhitespace).
export const diffHidesWhitespace = () => prefs().diffIgnoreWhitespace !== false;
// "diffHideTestFiles": true leaves test files (testfiles.js) out of the Diff surface; the default shows them (T3's diffHideTestFiles).
export const diffHidesTests = () => prefs().diffHideTestFiles === true;
// "notifications": false: no toast when a chat that isn't looked at ends its turn or asks for an approval.
// "sounds": true: Herdr's done / blocked sound with it (or alone).
export const toastsOn = () => prefs().notifications !== false;
export const soundsOn = () => prefs().sounds === true;
// "commitStyle": "plain" | "conventional" | "template" (see the header); anything else is "plain".
export const COMMIT_STYLES = ["plain", "conventional", "template"];
export const commitStyle = () => (COMMIT_STYLES.includes(prefs().commitStyle) ? prefs().commitStyle : "plain");
// "mdPreviewDefault": false opens Markdown files as text; the default opens them as the rendered preview.
export const mdPreviewDefault = () => prefs().mdPreviewDefault !== false;
// "chatTokenBudget": the per-chat token budget, 0 when off.
export const chatTokenBudget = () => cleanBudget(prefs().chatTokenBudget);
// "coordinatorNotify": false: no task notices are sent into the coordinator chat (coordinator.js).
export const coordinatorNotify = () => prefs().coordinatorNotify !== false;
// "keepAwake": true keeps the Mac awake while a chat works; the default does not.
export const keepAwakeOn = () => prefs().keepAwake === true;
// "autoResumeLimit": true arms "Resume at reset" in every chat a usage limit stops; the default leaves it to the banner's button.
export const autoResumeLimit = () => prefs().autoResumeLimit === true;
// "prWatch": true has chats told of failed checks and new comments on their pull requests (prwatch.js); the default does not.
export const prWatchOn = () => prefs().prWatch === true;
// "followUp": "steer" makes a message sent while the agent works interrupt it; the default queues it.
export const followUp = () => (prefs().followUp === "steer" ? "steer" : "queue");

// A chat's options with its model choices cut to the agent's list; the model in use always stays.
export function limitModels(id, options) {
  const only = id ? modelsOf(id) : null;
  if (!only) return options;
  return options.map((o) => ((o.category ?? o.id) !== "model" ? o
    : { ...o, choices: o.choices.filter((c) => c.value === o.current || only.includes(String(c.value))) }));
}

// The models each agent has offered, remembered so Settings can list them: { <id>: [{ value, name }] }.
export const knownModels = (id) => plain(shared(MODELS))[id] ?? [];
export function rememberModels(id, options) {
  const o = options?.find((x) => (x.category ?? x.id) === "model");
  if (!id || !o?.choices?.length) return;
  const list = o.choices.map((c) => ({ value: String(c.value), name: c.name }));
  if (JSON.stringify(knownModels(id)) !== JSON.stringify(list)) setShared(MODELS, { ...plain(shared(MODELS)), [id]: list });
}

let onDisk = null; // the file's text as last read or written
const write = (value) => {
  onDisk = JSON.stringify(value, null, 2) + "\n";
  setShared(KEY, value);
  fs.mkdir(`${appHome()}/data`, { recursive: true }).then(() => fs.writeFile(settingsFile(), onDisk)).catch((e) => console.log(`ht3 settings: ${String(e?.message ?? e)}`));
};

// Sets one setting by its path ("agents.pi.enabled"); undefined takes it out, back to its default.
export function setPref(path, value) {
  const all = JSON.parse(JSON.stringify(prefs())), keys = path.split(".");
  let at = all;
  for (const k of keys.slice(0, -1)) at = at[k] = plain(at[k]);
  if (value === undefined) delete at[keys.at(-1)];
  else at[keys.at(-1)] = value;
  write(all);
}

// The keeper's: the file as it is now. A file that isn't JSON is left alone and the last good settings stay.
export async function loadPrefs() {
  const text = await readTextFile(settingsFile()).catch(() => null);
  if (text == null) { if (onDisk == null) onDisk = ""; return; }
  if (text === onDisk) return;
  onDisk = text;
  try {
    const value = plain(JSON.parse(text));
    if (JSON.stringify(value) !== JSON.stringify(prefs())) setShared(KEY, value);
  } catch {}
}
