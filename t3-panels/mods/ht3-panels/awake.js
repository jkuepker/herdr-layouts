// Keep the Mac awake while agents work (T3's "Keep the computer awake" for background activity, here for chats and tasks).
// Pure: report.js keepAwake runs `caffeinate` when this says so.

export const AWAKE_EVERY_MS = 60000;
// Seconds each caffeinate lasts: more than twice the renewal, so one missed pass doesn't let the Mac sleep, and it ends
// by itself soon after the last agent stops or Herdr quits.
export const AWAKE_SECONDS = 150;

// Whether to start (renew) caffeinate now: `working` (at least one agent works) and `on` (the pref), and the last start
// (`last`, ms, or null) is at least `every` ms ago. Nothing when off or idle; a `last` in the future (clock change) counts as due.
export function awakeDue({ working, on, last = null, now, every = AWAKE_EVERY_MS }) {
  if (!working || !on) return false;
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  return now - last >= every || now < last;
}
