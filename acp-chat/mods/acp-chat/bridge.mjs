#!/usr/bin/env node
// Holds one ACP agent session for the acp-chat mod when Herdr has no `spawn`,
// so a mod's `exec` can't keep a program running. The mod starts this in a
// herdr-core terminal:
//
//   node bridge.mjs --dir <chat folder> -- <agent argv...>
//
// It writes the whole chat to <dir>/state.json (atomically, a few times a
// second at most) and takes commands from <dir>/inbox/*.json, oldest first
// (see ChatSession.handle). It stops when the agent exits, on
// SIGHUP/SIGTERM (`hc kill`), or when the mod stops touching <dir>/lease for
// LEASE_MS.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineSplitter } from "./acp.js";
import { ChatSession } from "./session.js";

const LEASE_MS = 10 * 60 * 1000;
const MAX_STATE_BYTES = 800 * 1024; // the mod's readTextFile reads at most 1 MiB
const WRITE_EVERY_MS = 80;

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const dirAt = argv.indexOf("--dir");
if (sep < 0 || dirAt < 0 || sep === argv.length - 1) {
  console.error("usage: bridge.mjs --dir <dir> -- <agent argv...>");
  process.exit(2);
}
const dir = argv[dirAt + 1];
const agentArgv = argv.slice(sep + 1);
const inbox = path.join(dir, "inbox");
fs.mkdirSync(inbox, { recursive: true });

let old = null;
try {
  old = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
} catch {}

let writeTimer = null;
function flush() {
  clearTimeout(writeTimer);
  writeTimer = null;
  const file = path.join(dir, "state.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, session.snapshot(MAX_STATE_BYTES));
  fs.renameSync(tmp, file);
}

const child = spawn(agentArgv[0], agentArgv.slice(1), { stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd() });
const session = new ChatSession({
  argv: agentArgv,
  cwd: process.cwd(),
  old,
  write: (line) => child.stdin.write(line),
  kill: () => {
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      process.exit(0);
    }, 2000).unref();
  },
  changed: (urgent) => {
    if (urgent) flush();
    else if (!writeTimer) writeTimer = setTimeout(flush, WRITE_EVERY_MS);
  },
});
session.state.pid = process.pid;

let stderrTail = "";
child.stderr.on("data", (d) => {
  process.stderr.write(d);
  stderrTail = (stderrTail + d).slice(-2000);
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", lineSplitter((line) => session.feed(line)));
child.on("exit", (code, signal) => {
  session.exited(signal ?? `code ${code}`, stderrTail);
  process.exit(0);
});
child.on("error", (e) => {
  session.failed(`Couldn't start ${agentArgv[0]}: ${e.message}`);
  process.exit(1);
});

// Commands from the mod
let draining = false;
async function drain() {
  if (draining || !session.state.sessionId || session.state.status === "starting") return;
  draining = true;
  try {
    for (let round = 0; round < 50; round++) {
      const names = fs.readdirSync(inbox).filter((n) => n.endsWith(".json")).sort();
      if (!names.length) break;
      for (const name of names) {
        const file = path.join(inbox, name);
        let cmd = null;
        try {
          cmd = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          // Half written: try again next round, and drop it only once it's clearly stale.
          if (Date.now() - fs.statSync(file).mtimeMs < 5000) continue;
        }
        fs.rmSync(file, { force: true });
        if (cmd) session.handle(cmd);
      }
    }
  } finally {
    draining = false;
  }
}

fs.watch(inbox, () => drain());
setInterval(drain, 1000); // fs.watch can miss events; the inbox is tiny
setInterval(() => {
  try {
    if (Date.now() - fs.statSync(path.join(dir, "lease")).mtimeMs > LEASE_MS) session.stop();
  } catch {
    session.stop(); // the mod removed the chat
  }
}, 30 * 1000);
for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(sig, () => session.stop());

fs.writeFileSync(path.join(dir, "lease"), String(Date.now()));
flush();
session.start().then((ok) => ok && drain());
