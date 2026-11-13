// Force stop (T3's useForceStopThread, runStopNowItem): an agent that was asked to stop and doesn't end its turn can be
// killed. Pure: session.js notes when Stop was asked and kills the agent, chat.js draws the banner and its button.

// How long a Stop waits for the agent to end its turn before Force stop is offered (T3: ACP_STOP_CONFIRM_TIMEOUT_MS).
export const STOP_WAIT_MS = 10000;

// What the transcript says where a turn was force stopped, and what the banner says.
export const FORCE_STOP_NOTE = "Force stopped: the agent didn't answer Stop. Your next message starts it again.";
export const FORCE_STOP_TITLE = "The agent isn't answering Stop.";
export const FORCE_STOP_DETAIL = "Force stop ends its process. Your next message starts it again.";

// Whether a turn runs that Stop can be asked of (`status`: the chat's word, session.js; "blocked" waits for an approval).
export const turnRuns = (status) => status === "working" || status === "blocked";

// Where a Stop stands: null (none asked, or the turn ended), "stopping" (asked, the agent still has time) or
// "unresponsive" (asked `wait` ms ago and the turn still runs: Force stop is offered). `askedAt`: ms, when Stop was asked.
export function stopState({ askedAt, status, now, wait = STOP_WAIT_MS }) {
  if (typeof askedAt !== "number" || !Number.isFinite(askedAt) || !turnRuns(status)) return null;
  return now - askedAt >= wait ? "unresponsive" : "stopping";
}

// How long ago Stop was asked, for the banner: "12s", "1m 05s". Never under a second (T3 shows at least 1s).
export function stopAge({ askedAt, now }) {
  const s = Math.max(1, Math.floor((now - askedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// How the chat goes on after a force stop, once its agent runs again: "resume" (the agent loads its own session) or
// "new" (a new session under the old messages, with the "New session" notice). As session.js start() decides it.
export function afterForceStop({ sessionId, loadSession, said }) {
  return said && !!sessionId && loadSession === true ? "resume" : "new";
}
