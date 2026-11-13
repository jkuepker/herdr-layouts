// When a chat last really changed (ms): a message sent, the agent's reply, thought, tool call or plan while its turn
// runs, the turn's end, a stop. Kept in the chat's saved state (`state.lastChange`, state.json), so it is still known
// after a restart, and told to the lists (report.js, shared "ht3-panels.changed") so the Inbox can say how long a
// chat has been idle (its auto-settle, its "5m" times) without having watched it change. Redraws, notices, a
// resumed session's replay and the agent's exit don't count. Pure logic, no Herdr imports
// (tests/lastchange.test.mjs).

const REAL = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

// Whether a `session/update` is the agent at work on a turn. A loaded session replays its history with the same
// updates before any turn runs: that is not news.
export const isChange = (update, status) => status === "working" && REAL.has(update?.sessionUpdate);

// Notes a change on the chat's state; time never goes back.
export function noteChange(state, now = Date.now()) {
  state.lastChange = Math.max(Number(state.lastChange) || 0, Number(now) || 0);
}

// The time of the last change of a saved state, 0 when unknown. A chat saved before this was kept has none: its
// last context report (transcript.usageLog) or limit note is near its last turn, so that serves until it changes.
export function lastChangeOf(state) {
  const own = Number(state?.lastChange) || 0;
  if (own > 0) return own;
  const t = state?.transcript;
  return Math.max(0, Number(t?.usageLog?.at?.(-1)?.at) || 0, Number(t?.limit?.at) || 0);
}

// What a chat tells the lists: `at` as it is while it rests; while its turn runs, the time the turn began or last
// paused for the person (`had`, kept until the word changes), so each chunk of a reply isn't a shared write.
export function toldChange(had, at, { busy, turned }) {
  const now = Number(at) || 0;
  if (!now) return had ?? 0;
  return busy && !turned && had ? had : Math.max(now, had ?? 0);
}
