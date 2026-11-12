// The coordinator (not in T3 Code): one chat that manages the tasks of every project. It is an ordinary chat with a
// fixed id, "coordinator", on the coordinator's agent and model (settings.js `coordinatorAgent`, `coordinatorModel`),
// in a folder of its own, `data/ht3-panels/coordinator/` in the app's folder, shown in a space named "Coordinator".
// It can't see Herdr and `herdr-app do` prints nothing for a mod's command, so the two meet in that folder:
// - its role and the exact commands are in CLAUDE.md and AGENTS.md there (coord-template.js; written when missing or old);
// - the keeper (main.js Buttons) writes `state.json` there whenever it changes: the open spaces, every project's tasks
//   with their chats' states and last replies, and how the last commands went (coord-data.js `snapshot`);
// - it acts through the keeper's commands: `coord:<json>` adds, runs, marks done and deletes tasks of any project
//   (coord-data.js `parseOp`), the tasks the Tasks surface shows (tasks.js), run as that surface runs them (`startTask`).
// `coordinator` shows the chat, making the space and the chat when they aren't there.

import { exec, run, shared, spaces, focused, appHome, home, readTextFile, writeTextFile, notify } from "herdr";
import { MOD } from "./look.js";
import { AGENTS, detect } from "./agent-acp.js";
import { repoOf } from "./launcher.js";
import { roleAgent, roleSet } from "./settings.js";
import { tasksOf, taskKeys, update, newId, startTask, observe } from "./tasks.js";
import { newTask, patch, remove, keyOf } from "./tasklist.js";
import { lastReply } from "./compare-data.js";
import { parseOp, logOp, snapshot, templateDue } from "./coord-data.js";
import { VERSION, roleText, SETTINGS } from "./coord-template.js";

export const CHAT = "coordinator", SPACE = "Coordinator";
export const coordDir = () => `${appHome()}/data/${MOD}/coordinator`;
const chatsDir = () => `${appHome()}/data/${MOD}/chats`;
const REPLY_MAX = 400, REPLY_EVERY_MS = 10000;
const nap = (ms) => exec("sleep", [String(ms / 1000)], { timeout: ms + 5000 }).catch(() => null);
const why = (e) => String(e?.message ?? e).split("\n").pop();

let ops = []; // how the last commands went
const making = new Map(); // "<key>\n<task id>" -> what a run that has no chat yet is doing
const replies = new Map(); // chat id -> { stamp, at, text }
let written = null; // state.json's text as last written
let writing = false;

// Writes `text` to `path` whatever it holds now (writeTextFile wants what the file held: this is the file's only writer).
async function put(path, text) {
  const now = await readTextFile(path).catch(() => null);
  if (now !== text) await writeTextFile(path, text, now ?? null);
}

// ---- the commands ----

// One `coord:<json>`; how it went is kept for the state file.
export async function coordCommand(text) {
  const o = parseOp(text, home());
  const entry = { at: Date.now(), op: o.op ?? null, project: o.project ?? null, id: o.id ?? null };
  try {
    if (o.error) throw new Error(o.error);
    const root = (await repoOf(o.project, o.machine)) ?? o.project, key = keyOf(o.machine, root);
    entry.project = root;
    const find = () => tasksOf(key).find((t) => t.id === o.id);
    if (o.op === "add") {
      const id = o.id ?? newId();
      entry.id = id;
      if (tasksOf(key).some((t) => t.id === id)) throw new Error(`This project already has a task ${id}.`);
      update(key, (l) => [...l, newTask(o.title, o.note, id, Date.now())]);
      o.id = id;
    } else if (!find()) throw new Error(`This project has no task ${o.id}.`);
    if (o.op === "done") update(key, (l) => patch(l, o.id, { done: o.done }));
    if (o.op === "delete") update(key, (l) => remove(l, o.id));
    if (o.op === "run" || o.run) await runOne(key, find());
    entry.ok = true;
  } catch (e) {
    entry.ok = false;
    entry.error = why(e);
    console.log(`ht3-panels.coord: ${entry.error}`);
  }
  ops = logOp(ops, entry);
  await writeState();
}

// Starts a task the way Tasks does, in the space that works in its repository; the tab shown now is shown again once
// the chat has started, so the coordinator's chat stays in front.
async function runOne(key, t) {
  const mark = `${key}\n${t.id}`;
  if (making.has(mark)) throw new Error("This task is being started already.");
  making.set(mark, "making the worktree");
  try { await startTask(key, t, { back: focused()?.tab ?? null, step: (words) => making.set(mark, words) }); }
  finally { making.delete(mark); }
}

// ---- the state file ----

// A chat's last reply, read from its saved state: again when its state or its count of turns changed, and every ten
// seconds while it works.
async function replyOf(chat, stamp, working) {
  const had = replies.get(chat), now = Date.now();
  if (had && had.stamp === stamp && !(working && now - had.at > REPLY_EVERY_MS)) return had.text;
  let text = had?.text ?? null;
  try { text = lastReply(JSON.parse(await readTextFile(`${chatsDir()}/${chat}/state.json`))?.transcript?.items, REPLY_MAX) ?? text; } catch {}
  replies.set(chat, { stamp, at: now, text });
  return text;
}

// The keeper's, every two seconds and after each command: state.json as things are now, written when it changed.
export async function writeState() {
  if (writing) return;
  writing = true;
  try {
    const keys = taskKeys();
    for (const key of keys) observe(key);
    const tasks = Object.fromEntries(keys.map((key) => [key, tasksOf(key)]));
    const turns = shared(`${MOD}.turns`) ?? {}, places = shared(`${MOD}.places`) ?? {}, status = shared(`${MOD}.status`) ?? {};
    const facts = { places, status, turns, tabs: new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id))), now: Date.now() };
    const said = {};
    for (const t of Object.values(tasks).flat()) {
      if (!t.run) continue;
      const tab = places[t.run.chat]?.tab, word = status[tab] ?? "";
      said[t.run.chat] = await replyOf(t.run.chat, `${word}:${turns[tab] ?? 0}`, word === "working");
    }
    for (const chat of replies.keys()) if (!(chat in said)) replies.delete(chat);
    const body = snapshot({ spaces: spaces(), tasks, facts, replies: said, making: Object.fromEntries(making), ops, skip: coordDir() });
    const text = JSON.stringify(body, null, 2) + "\n";
    if (text !== written) {
      await exec("mkdir", ["-p", coordDir()]).catch(() => null);
      await put(`${coordDir()}/state.json`, text);
      written = text;
    }
  } catch (e) { console.log(`ht3-panels coordinator state: ${why(e)}`); }
  writing = false;
}

// ---- the chat ----

// The folder's files, when there are none or they are an older template's (the version is kept beside them).
async function ensureFolder() {
  const dir = coordDir(), mark = `${dir}/.template-version`;
  if (!templateDue(await readTextFile(mark).catch(() => null), VERSION)) return;
  await exec("mkdir", ["-p", `${dir}/.claude`]);
  const text = roleText(dir, chatsDir());
  await put(`${dir}/CLAUDE.md`, text);
  await put(`${dir}/AGENTS.md`, text);
  await put(`${dir}/.claude/settings.json`, SETTINGS);
  await put(mark, `${VERSION}\n`);
}

// Shows the coordinator chat: its tab if it is open, else a new tab for it (a closed chat's saved state comes back with
// it) in the Coordinator space, which is made once at the coordinator's folder.
export async function openCoordinator() {
  const dir = coordDir();
  await ensureFolder();
  await writeState();
  const tabs = new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id))), at = (shared(`${MOD}.places`) ?? {})[CHAT];
  if (at && tabs.has(at.tab)) { run("tab.select", { id: at.tab }); if (at.pane) run("pane.focus", { pane: at.pane }); return; }
  const mine = () => spaces().find((s) => !s.machine && s.folder === dir);
  let sp = mine();
  if (!sp) {
    run("space.new", { name: SPACE, folder: dir, machine: "" });
    for (let i = 0; i < 30 && !(sp = mine()); i++) await nap(100);
    if (!sp) throw new Error("The Coordinator space didn't come up.");
  }
  // Its tab from before a restart has no place until it is shown: it is the one named after it.
  const had = sp.tabs.find((t) => t.name === SPACE);
  if (had) return void run("tab.select", { id: had.id });
  const found = await detect(null), agent = AGENTS.find((a) => a.id === roleAgent("coordinator", found.found));
  if (!agent) {
    notify({ title: "Coordinator", body: "No chat agent is installed and turned on (Settings).", level: "warning" });
    throw new Error("No chat agent is installed and turned on.");
  }
  const set = roleSet("coordinator", agent.id);
  run("tab.new", { mod: MOD, space: sp.id, name: SPACE,
    props: { panel: "chat", chat: CHAT, agent: [found.found[agent.argv[0]], ...agent.argv.slice(1)], cwd: dir, machine: null, ...(set ? { set } : {}) } });
}
