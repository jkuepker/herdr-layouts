// PR watch's Herdr side (prwatch.js has the logic): which chats are looked at, where what they were told is kept, and
// the keeper's pass. The chats are the ones open in a tab (shared "ht3-panels.places"); each one's folder and machine
// are its saved state's (data/ht3-panels/chats/<id>/state.json), and `gh` runs there, as the Pull request surface's does
// (pr.js). News goes out as a post by chat id (tasks.js postTo, shared "ht3-panels.post"): chat.js sends it as a message
// of the chat's own, queued behind a running turn, never steering it.
// Commands (main.js): `ht3-panels.prwatch:on`, `prwatch:off` (the "prWatch" setting), `prwatch:now` (one sweep at once,
// whatever the setting says; a notice says what it found).

import { exec, shared, setShared, appHome, readTextFile, notify } from "herdr";
import * as fs from "fs/promises";
import { MOD } from "./look.js";
import { prWatchOn, setPref } from "./settings.js";
import { postTo } from "./tasks.js";
import { sweep, sweepDue, summary } from "./prwatch.js";

// When the last sweep began (ms), shared so a second window's keeper, or a reloaded one, doesn't start another.
const AT = `${MOD}.prwatchAt`;
const file = () => `${appHome()}/data/${MOD}/prwatch.json`;
let running = false;

async function watched() {
  const ids = Object.keys(shared(`${MOD}.places`) ?? {});
  const all = await Promise.all(ids.map(async (id) => {
    try {
      const s = JSON.parse(await readTextFile(`${appHome()}/data/${MOD}/chats/${id}/state.json`));
      return s?.cwd ? { id, cwd: s.cwd, on: s.machine ?? null } : null;
    } catch { return null; }
  }));
  return all.filter(Boolean);
}
const load = async () => { try { const v = JSON.parse(await readTextFile(file())); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const save = async (state) => { await fs.mkdir(`${appHome()}/data/${MOD}`, { recursive: true }); await fs.writeFile(file(), JSON.stringify(state, null, 1) + "\n"); };

// One sweep now. -> prwatch.js sweep's result, or null when one is running already.
export async function prWatchSweep() {
  if (running) return null;
  running = true;
  setShared(AT, Date.now());
  try { return await sweep({ exec, chats: await watched(), load, save, post: postTo }); }
  finally { running = false; }
}

// The keeper's, every two seconds: a sweep when the setting is on and the last one began two minutes ago or more.
export async function prWatch() {
  if (!sweepDue({ on: prWatchOn(), running, last: shared(AT) })) return;
  try { await prWatchSweep(); } catch (e) { console.log(`ht3 pr watch: ${String(e?.message ?? e)}`); }
}

// prwatch:on | off | now.
export async function prWatchCommand(what) {
  if (what === "on" || what === "off") {
    setPref("prWatch", what === "on" ? true : undefined);
    notify({ title: "PR watch", body: what === "on" ? "On: chats are told of failed checks and new comments on their pull requests." : "Off.", level: "info" });
    return;
  }
  if (what !== "now") throw new Error("prwatch:on, prwatch:off or prwatch:now");
  const out = await prWatchSweep();
  notify({ title: "PR watch", body: out ? summary(out) : "A sweep is running already.", level: out?.errors.length ? "warning" : "info" });
}
