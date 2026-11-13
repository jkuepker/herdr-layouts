// Resume when the usage limit resets (T3's UsageLimitRecoveryBanner, "Resume at reset"): a chat whose turn was ended by a
// usage limit sends "continue" once the limit is over. Pure: chat.js draws the banner's button and sends the message.
//
// `limit` is the chat's (transcript.js noteLimit): { status, resetsAt (seconds), at (ms, when it was noted), text?, type? }.
// `kept` is what the chat keeps of the person's choice (chat.js keep, `resume`): { at: <the resetsAt it is for>, on, sent? }.

// What is sent, and how long after the reset: the limit's clock and ours need not agree to the second.
export const RESUME_TEXT = "continue";
export const RESUME_MARGIN_MS = 30000;

// Whether a limit stopped the chat: the agent said "rejected" and no turn runs (`status`: the chat's word, session.js).
export function limitStopped({ limit, status }) {
  return limit?.status === "rejected" && !["working", "blocked", "starting"].includes(status);
}

// When to send (ms), or null when no time is known: the limit has no reset time (a refusal that came only as an error's
// text), or its reset was already past when the agent named it (T3: resetAt must be after stoppedAt), which would send
// "continue" into the same limit again and again.
export function resumeAt(limit, margin = RESUME_MARGIN_MS) {
  const reset = Number(limit?.resetsAt) * 1000;
  if (!Number.isFinite(reset) || reset <= 0) return null;
  if (Number.isFinite(limit.at) && reset <= limit.at) return null;
  return reset + margin;
}

export const resumeDue = ({ at, now }) => typeof at === "number" && Number.isFinite(at) && now >= at;

// Whether it will send: the person's choice for this reset when there is one, else the pref (`autoResumeLimit`).
export function resumeArmed({ limit, kept, pref }) {
  if (kept && kept.at === limit?.resetsAt) return kept.on === true;
  return pref === true;
}

// All of it for one chat: null when there is nothing to offer (not stopped by a limit, no reset time, or "continue" was
// already sent for this reset), else { at, armed, due }.
export function resumePlan({ limit, status, kept = null, pref = false, now, margin = RESUME_MARGIN_MS }) {
  if (!limitStopped({ limit, status })) return null;
  const at = resumeAt(limit, margin);
  if (at == null) return null;
  if (kept && kept.at === limit.resetsAt && kept.sent) return null;
  return { at, armed: resumeArmed({ limit, kept, pref }), due: resumeDue({ at, now }) };
}

// "3:05 AM", in local time, for the button and its line.
export function clockText(ms) {
  const d = new Date(ms), h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
