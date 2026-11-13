// node t3-panels/tests/forcestop.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STOP_WAIT_MS, FORCE_STOP_NOTE, turnRuns, stopState, stopAge, afterForceStop } from "../mods/ht3-panels/forcestop.js";
import { ChatSession } from "../mods/ht3-panels/session.js";

// T3 waits 10 s for the agent to confirm a Stop.
assert.equal(STOP_WAIT_MS, 10000);
const asked = 1_700_000_000_000;

// A turn runs while the chat says working, or blocked on an approval.
assert.equal(turnRuns("working"), true);
assert.equal(turnRuns("blocked"), true);
for (const s of ["ready", "starting", "exited", "stopped", undefined]) assert.equal(turnRuns(s), false);

// No Stop asked, or the turn ended: nothing. Asked: stopping, and unresponsive from the wait on.
assert.equal(stopState({ askedAt: null, status: "working", now: asked }), null);
assert.equal(stopState({ askedAt: undefined, status: "working", now: asked }), null);
assert.equal(stopState({ askedAt: NaN, status: "working", now: asked }), null);
assert.equal(stopState({ askedAt: asked, status: "ready", now: asked + 60000 }), null);
assert.equal(stopState({ askedAt: asked, status: "stopped", now: asked + 60000 }), null);
assert.equal(stopState({ askedAt: asked, status: "working", now: asked }), "stopping");
assert.equal(stopState({ askedAt: asked, status: "working", now: asked + STOP_WAIT_MS - 1 }), "stopping");
assert.equal(stopState({ askedAt: asked, status: "working", now: asked + STOP_WAIT_MS }), "unresponsive");
assert.equal(stopState({ askedAt: asked, status: "blocked", now: asked + STOP_WAIT_MS + 5000 }), "unresponsive");
assert.equal(stopState({ askedAt: asked, status: "working", now: asked + 5000, wait: 5000 }), "unresponsive");

// How long ago, never under a second.
assert.equal(stopAge({ askedAt: asked, now: asked }), "1s");
assert.equal(stopAge({ askedAt: asked, now: asked + 12400 }), "12s");
assert.equal(stopAge({ askedAt: asked, now: asked + 65000 }), "1m 05s");

// After it: the agent's own session where it can load one and something was said, else a new one.
assert.equal(afterForceStop({ sessionId: "s", loadSession: true, said: true }), "resume");
assert.equal(afterForceStop({ sessionId: "s", loadSession: false, said: true }), "new");
assert.equal(afterForceStop({ sessionId: null, loadSession: true, said: true }), "new");
assert.equal(afterForceStop({ sessionId: "s", loadSession: true, said: false }), "new");

// The session itself against the scripted agent (acp-chat/tests/fake-agent.mjs): "hang" never ends its turn.
const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../acp-chat/tests/fake-agent.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forcestop-"));
function run(old, env = {}) {
  const proc = spawn(process.execPath, [agent], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env } });
  const session = new ChatSession({ argv: [agent], cwd: tmp, old, write: (l) => proc.stdin.write(l), kill: () => proc.kill("SIGKILL"), changed: () => {} });
  let buf = "";
  proc.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) session.feed(buf.slice(0, i));
  });
  const exited = new Promise((r) => proc.on("exit", (code, signal) => { session.exited(signal ? "a signal" : `code ${code}`, ""); r(); }));
  return { proc, session, exited };
}
const until = async (pred, what) => {
  for (let i = 0; i < 100; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 30)); }
  assert.fail(`timed out waiting for ${what}`);
};
const notices = (s) => s.state.transcript.items.filter((i) => i.kind === "notice").map((i) => i.text);

async function hangAndForce(env) {
  const a = run(null, env);
  assert.equal(await a.session.start(), true);
  assert.equal(a.session.forceStop(), false); // no turn runs
  a.session.handle({ type: "prompt", text: "hang on" });
  await until(() => a.session.state.transcript.items.some((i) => i.kind === "agent"), "the agent's word");
  assert.equal(a.session.stopAsked, null);
  a.session.handle({ type: "cancel" });
  const at = a.session.stopAsked;
  assert.equal(typeof at, "number");
  await new Promise((r) => setTimeout(r, 300));
  // Stop is ignored: the turn still runs, and a second Stop keeps the first one's time.
  assert.equal(a.session.state.status, "working");
  a.session.handle({ type: "cancel" });
  assert.equal(a.session.stopAsked, at);
  assert.equal(stopState({ askedAt: at, status: a.session.state.status, now: at + STOP_WAIT_MS }), "unresponsive");
  assert.equal(a.session.forceStop(), true);
  await a.exited;
  await a.session.inflight;
  // The turn ended as stopped, with the note and no error; the agent is gone.
  assert.equal(a.session.state.status, "stopped");
  assert.equal(a.session.state.forceStopped, true);
  assert.equal(a.session.state.error, null);
  assert.equal(a.session.stopAsked, null);
  assert.deepEqual(notices(a.session), [FORCE_STOP_NOTE]);
  assert.ok(a.session.state.transcript.items.every((i) => !i.open));
  assert.ok(a.proc.signalCode === "SIGKILL");
  // The next message's agent: started from the chat as it was saved.
  const b = run(JSON.parse(a.session.snapshot(1e6)), env);
  assert.equal(await b.session.start(), true);
  assert.equal(b.session.state.forceStopped, undefined);
  await b.session.prompt("hello");
  assert.equal(b.session.state.status, "ready");
  assert.equal(b.session.state.transcript.items.filter((i) => i.kind === "agent").at(-1).text, "(small) you said: hello");
  b.session.stop();
  await b.exited;
  return notices(b.session);
}

try {
  // An agent that can load sessions resumes its own; one that can't starts a new one under the old messages.
  assert.ok((await hangAndForce({ FAKE_AGENT_STORE: path.join(tmp, "store.json") })).includes("Resumed the agent's session."));
  const fresh = await hangAndForce({ FAKE_AGENT_STORE: "" });
  assert.deepEqual(fresh, [FORCE_STOP_NOTE, "New session: the agent doesn't remember the messages above."]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("forcestop: ok");
