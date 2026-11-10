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
// - sidePanelHiddenInNewSpaces (false): a space shown for the first time starts with the side panel hidden.
// Anything left out is its default; unknown keys are kept as they are.

import { shared, setShared, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { MOD } from "./look.js";
import { AGENTS } from "./agent-acp.js";

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
// The model ids an agent's picker is limited to, or null for all it offers.
export function modelsOf(id) {
  const m = plain(prefs().agents)[id]?.models;
  return Array.isArray(m) && m.length ? m.map(String) : null;
}
export const editorOn = (id) => plain(prefs().editors)[id] !== false;
export const sideStartsHidden = () => prefs().sidePanelHiddenInNewSpaces === true;
// "checkpoints": false turns the per-turn snapshots (checkpoint.js) off.
export const checkpointsOn = () => prefs().checkpoints !== false;
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
