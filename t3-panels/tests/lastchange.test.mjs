// node t3-panels/tests/lastchange.test.mjs
import assert from "node:assert/strict";
import { isChange, noteChange, lastChangeOf, toldChange } from "../mods/ht3-panels/lastchange.js";
import { ChatSession } from "../mods/ht3-panels/session.js";
import { inboxFields, trackInboxRows } from "../mods/ht3-inbox/row-model.js";

const DAY = 86400000, now = 100 * DAY;

// The agent at work on a turn is a change; a replay before any turn, usage and command lists are not.
for (const u of ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]) {
  assert.equal(isChange({ sessionUpdate: u }, "working"), true, u);
  assert.equal(isChange({ sessionUpdate: u }, "starting"), false, u);
  assert.equal(isChange({ sessionUpdate: u }, "ready"), false, u);
}
for (const u of ["usage_update", "available_commands_update", "user_message_chunk", "config_option_update"]) assert.equal(isChange({ sessionUpdate: u }, "working"), false, u);
assert.equal(isChange(undefined, "working"), false);

// Noted on the state; time never goes back.
const st = {};
noteChange(st, 500);
assert.equal(st.lastChange, 500);
noteChange(st, 300);
assert.equal(st.lastChange, 500);
noteChange(st, 900);
assert.equal(st.lastChange, 900);

// A saved state's time: its own; an older chat's last context report or limit note; else unknown.
assert.equal(lastChangeOf({ lastChange: 700, transcript: { usageLog: [{ at: 900 }] } }), 700);
assert.equal(lastChangeOf({ transcript: { usageLog: [{ at: 100 }, { at: 400 }], limit: { at: 300 } } }), 400);
assert.equal(lastChangeOf({ transcript: { usageLog: [], limit: { at: 300 } } }), 300);
assert.equal(lastChangeOf({ transcript: { items: [] } }), 0);
assert.equal(lastChangeOf(null), 0);

// Told to the lists: as it is at rest; held while a turn runs; again when the word changes; never back, never lost.
assert.equal(toldChange(null, 500, { busy: false, turned: false }), 500);
assert.equal(toldChange(500, 800, { busy: true, turned: true }), 800);
assert.equal(toldChange(800, 950, { busy: true, turned: false }), 800);
assert.equal(toldChange(null, 950, { busy: true, turned: false }), 950);
assert.equal(toldChange(800, 990, { busy: false, turned: true }), 990);
assert.equal(toldChange(800, 600, { busy: false, turned: false }), 800);
assert.equal(toldChange(800, 0, { busy: false, turned: false }), 800);
assert.equal(toldChange(null, 0, { busy: false, turned: false }), 0);

// A session: the old state's time is kept, a turn's updates move it, a replay and usage don't.
{
  const sent = [];
  const old = { seq: 3, sessionId: null, lastChange: 1000, transcript: { items: [{ id: "1", kind: "user", text: "hi" }], dropped: 0, usage: null, commands: [], nextId: 2 } };
  const s = new ChatSession({ argv: ["agent"], cwd: "/tmp", old, write: (l) => sent.push(l), kill() {}, changed() {} });
  assert.equal(s.state.lastChange, 1000);
  s.state.sessionId = "S";
  const say = (sessionUpdate, more = {}) => s.conn.handlers.onNotification("session/update", { sessionId: "S", update: { sessionUpdate, ...more } });
  say("agent_message_chunk", { content: { type: "text", text: "replayed" } });
  assert.equal(s.state.lastChange, 1000);
  s.state.status = "working";
  say("usage_update", { used: 1, size: 2 });
  assert.equal(s.state.lastChange, 1000);
  say("agent_message_chunk", { content: { type: "text", text: "now" } });
  assert.ok(s.state.lastChange > 1000);
  // Stopping an agent that rests is no change; stopping a turn is.
  const r = new ChatSession({ argv: ["agent"], cwd: "/tmp", old: { ...old, lastChange: 1000 }, write() {}, kill() {}, changed() {} });
  r.state.status = "ready";
  r.stop();
  assert.equal(r.state.lastChange, 1000);
  r.state.status = "working";
  r.stop();
  assert.ok(r.state.lastChange > 1000);
  assert.ok(JSON.parse(r.snapshot(1e6)).lastChange > 1000);
}

// The Inbox: a chat card's time is what its chat says, not when the Inbox first saw it.
{
  const card = { address: "pane:p1", mod: "ht3-panels", pane: "p1", tab: "t1", status: "idle", program: { keep: true } };
  const agent = { address: "term:1", tab: "t2", status: "idle" };
  const fields = (changed, changedMs) => inboxFields({ every: [card, agent], all: [{ address: "term:1", state: "live", status: "idle", status_ms: now - 5 * DAY }],
    term: new Map([["pane:p1", { address: "pane:p1", state: "live", status: "idle", labels: {}, turn: 2, changed_ms: changedMs }],
      ["term:1", { address: "term:1", state: "live", status: "idle", status_ms: now - 5 * DAY }]]),
    pending: { settled: {}, snoozed: {} }, changed, now, inView: null });
  // First sight dates a mod pane now (the Inbox just started).
  const row = { address: "pane:p1", s: "idle", turn: 2, excluded: false, first: now, changed: null, returned: false };
  const { changes } = trackInboxRows({}, [row], [], now);
  assert.equal(changes["pane:p1"].at, now);
  // With no time from the chat: as before.
  assert.equal(fields(changes, 0).since(card), now);
  // With one: the chat's, however lately the Inbox saw it.
  assert.equal(fields(changes, now - 9 * DAY).since(card), now - 9 * DAY);
  // An agent's row is untouched.
  assert.equal(fields(changes, now - 9 * DAY).since(agent), now - 5 * DAY);
  assert.equal(fields({ ...changes, "term:1": { s: "idle", at: now - DAY, turn: 0 } }, 0).since(agent), now - DAY);
  // Brought back by hand: from then, until the chat changes again.
  const back = trackInboxRows(changes, [{ ...row, returned: true }], [], now + 1000).changes;
  assert.equal(back["pane:p1"].back, true);
  assert.equal(fields(back, now - 9 * DAY).since(card), now + 1000);
  assert.equal(fields(back, now + 5000).since(card), now + 5000);
  // The Working shelf's order stays by when the run was seen to start.
  const run = { "pane:p1": { s: "working", at: now - 60000, turn: 2 } };
  assert.equal(fields(run, now - 1000).begun({ ...card, status: "working" }), now - 60000);
}

console.log("lastchange: ok");
