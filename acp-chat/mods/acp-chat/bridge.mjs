#!/usr/bin/env node
// Holds one ACP agent session for the acp-chat mod, because a mod's `exec`
// can't keep a program running. The mod starts this in a herdr-core terminal:
//
//   node bridge.mjs --dir <chat folder> -- <agent argv...>
//
// It writes the whole chat to <dir>/state.json (atomically, a few times a
// second at most) and takes commands from <dir>/inbox/*.json, oldest first:
//   {type: "prompt", text} | {type: "cancel"} | {type: "permission", optionId}
//   | {type: "config", configId, value} | {type: "stop"}
// It stops when the agent exits, on SIGHUP/SIGTERM (`hc kill`), or when the
// mod stops touching <dir>/lease for LEASE_MS.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AcpConnection, PROTOCOL_VERSION, lineSplitter } from "./acp.js";
import { emptyTranscript, addUser, addNotice, applyUpdate, endTurn, trim } from "./transcript.js";

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

const state = {
  v: 1,
  seq: 0,
  status: "starting", // starting | ready | working | exited | stopped
  pid: process.pid,
  agentArgv,
  agentInfo: null,
  cwd: process.cwd(),
  sessionId: null,
  configOptions: [],
  permission: null, // {title, options: [{optionId, name, kind}]}
  error: null,
  transcript: emptyTranscript(),
};

// A restarted bridge continues the chat it finds: it resumes the agent's own
// session when the agent can load one, and otherwise keeps the old messages
// above a new session.
let resumeId = null;
try {
  const old = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  if (old?.transcript?.items) {
    state.transcript = old.transcript;
    state.seq = old.seq ?? 0;
    endTurn(state.transcript);
    resumeId = old.sessionId ?? null;
  }
} catch {}

let writeTimer = null;
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(flush, WRITE_EVERY_MS);
}
function flush() {
  clearTimeout(writeTimer);
  writeTimer = null;
  state.seq++;
  trim(state.transcript, MAX_STATE_BYTES);
  const file = path.join(dir, "state.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

// The agent
const child = spawn(agentArgv[0], agentArgv.slice(1), { stdio: ["pipe", "pipe", "pipe"], cwd: state.cwd });
let stderrTail = "";
child.stderr.on("data", (d) => {
  process.stderr.write(d);
  stderrTail = (stderrTail + d).slice(-2000);
});

let pendingPermission = null; // resolve function for the agent's request

const conn = new AcpConnection((line) => child.stdin.write(line), {
  onNotification(method, params) {
    if (method !== "session/update" || params?.sessionId !== state.sessionId) return;
    const u = params.update;
    // The bridge already shows what it sent; an agent echoing it mid-turn would double it.
    if (u.sessionUpdate === "user_message_chunk" && state.status === "working") return;
    if (u.sessionUpdate === "config_option_update" && u.configOptions) state.configOptions = u.configOptions;
    else if (u.sessionUpdate === "current_mode_update") setCurrent("mode", u.currentModeId);
    else applyUpdate(state.transcript, u);
    save();
  },
  onRequest(method, params) {
    if (method !== "session/request_permission") return undefined;
    return new Promise((resolve) => {
      answerPermission({ outcome: "cancelled" }); // only one at a time
      pendingPermission = resolve;
      state.permission = {
        title: params.toolCall?.title ?? "The agent asks to continue",
        options: (params.options ?? []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      };
      save();
    });
  },
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", lineSplitter((line) => conn.feed(line)));

function answerPermission(outcome) {
  if (!pendingPermission) return;
  pendingPermission({ outcome });
  pendingPermission = null;
  state.permission = null;
  save();
}

function setCurrent(id, value) {
  const opt = state.configOptions.find((o) => o.id === id);
  if (opt) opt.currentValue = value;
}

child.on("exit", (code, signal) => {
  conn.close("agent exited");
  if (state.status !== "stopped") {
    state.status = "exited";
    state.error = `The agent exited (${signal ?? `code ${code}`}).` + (stderrTail ? `\n\n${stderrTail.trim()}` : "");
  }
  flush();
  process.exit(0);
});
child.on("error", (e) => {
  state.status = "exited";
  state.error = `Couldn't start ${agentArgv[0]}: ${e.message}`;
  flush();
  process.exit(1);
});

// Older agents report modes outside configOptions; show them the same way.
function configFrom(result) {
  if (result?.configOptions?.length) return result.configOptions;
  const modes = result?.modes;
  if (!modes?.availableModes?.length) return [];
  return [{
    id: "mode", name: "Mode", category: "mode", type: "select", legacyMode: true,
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })),
  }];
}

async function start() {
  try {
    const init = await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "herdr-acp-chat", version: "0.1.0" },
    });
    state.agentInfo = init?.agentInfo ?? null;
    if (!(resumeId && init?.agentCapabilities?.loadSession && (await resume(resumeId)))) {
      const session = await conn.request("session/new", { cwd: state.cwd, mcpServers: [] });
      state.sessionId = session.sessionId;
      state.configOptions = configFrom(session);
      if (state.transcript.items.length) addNotice(state.transcript, "New session: the agent doesn't remember the messages above.");
    }
    state.status = "ready";
  } catch (e) {
    state.error = `The agent didn't start a session: ${e.message}`;
    state.status = "exited";
    flush();
    child.kill();
    return;
  }
  flush();
  drain();
}

// session/load replays the session's history as session/update notifications,
// so the transcript is rebuilt from the agent instead of the old file.
async function resume(sessionId) {
  const kept = state.transcript;
  state.transcript = emptyTranscript();
  state.sessionId = sessionId;
  try {
    const r = await conn.request("session/load", { sessionId, cwd: state.cwd, mcpServers: [] });
    state.configOptions = configFrom(r);
    endTurn(state.transcript);
    addNotice(state.transcript, "Resumed the agent's session.");
    return true;
  } catch (e) {
    state.transcript = kept;
    state.sessionId = null;
    addNotice(state.transcript, `Couldn't resume the agent's session (${e.message}).`, "warn");
    return false;
  }
}

// Commands from the mod
let draining = false;
async function drain() {
  if (draining || !state.sessionId) return;
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
        if (cmd) handle(cmd);
      }
    }
  } finally {
    draining = false;
  }
}

function handle(cmd) {
  switch (cmd.type) {
    case "prompt":
      return prompt(String(cmd.text ?? ""));
    case "cancel":
      answerPermission({ outcome: "cancelled" });
      conn.notify("session/cancel", { sessionId: state.sessionId });
      return;
    case "permission":
      return answerPermission({ outcome: "selected", optionId: cmd.optionId });
    case "config":
      return setConfig(cmd.configId, cmd.value);
    case "stop":
      return stop();
  }
}

async function prompt(text) {
  if (!text.trim()) return;
  if (state.status === "working") {
    addNotice(state.transcript, "Still working on the last message; send again when it's done.", "warn");
    return save();
  }
  addUser(state.transcript, text);
  state.status = "working";
  state.error = null;
  save();
  try {
    const r = await conn.request("session/prompt", { sessionId: state.sessionId, prompt: [{ type: "text", text }] });
    if (r?.stopReason && r.stopReason !== "end_turn") addNotice(state.transcript, stopNote(r.stopReason), "warn");
  } catch (e) {
    addNotice(state.transcript, e.message, "error");
  }
  endTurn(state.transcript);
  if (state.status === "working") state.status = "ready";
  save();
}

function stopNote(reason) {
  return {
    cancelled: "Stopped.",
    max_tokens: "The reply hit the model's token limit.",
    max_turn_requests: "The agent hit its limit of model requests for one turn.",
    refusal: "The agent refused.",
  }[reason] ?? `The turn ended: ${reason}.`;
}

async function setConfig(configId, value) {
  const opt = state.configOptions.find((o) => o.id === configId);
  try {
    if (opt?.legacyMode) {
      await conn.request("session/set_mode", { sessionId: state.sessionId, modeId: value });
      setCurrent(configId, value);
    } else {
      const r = await conn.request("session/set_config_option", { sessionId: state.sessionId, configId, value });
      if (r?.configOptions) state.configOptions = r.configOptions;
      else setCurrent(configId, value);
    }
  } catch (e) {
    addNotice(state.transcript, `Couldn't change ${opt?.name ?? configId}: ${e.message}`, "error");
  }
  save();
}

function stop() {
  state.status = "stopped";
  answerPermission({ outcome: "cancelled" });
  flush();
  child.kill("SIGTERM");
  setTimeout(() => {
    child.kill("SIGKILL");
    process.exit(0);
  }, 2000).unref();
}

fs.watch(inbox, () => drain());
setInterval(drain, 1000); // fs.watch can miss events; the inbox is tiny
setInterval(() => {
  try {
    if (Date.now() - fs.statSync(path.join(dir, "lease")).mtimeMs > LEASE_MS) stop();
  } catch {
    stop(); // the mod removed the chat
  }
}, 30 * 1000);
for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(sig, stop);

fs.writeFileSync(path.join(dir, "lease"), String(Date.now()));
flush();
start();
