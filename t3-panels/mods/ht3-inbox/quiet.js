// Quiet agents: a chat that says it is working but hasn't changed for some minutes is flagged on its card ("quiet
// 15 min", warning colour) and told once in a toast, so a hung agent is caught early. Pure logic, no Herdr imports, so
// tests/quiet.test.mjs runs on it.
//
// The setting (ht3-panels' settings file, shared "ht3-panels.settings"): quietMinutes (15 by default; 0 = off).
// A chat's last change is what it tells the lists (shared "ht3-panels.changed", main.js `changed_ms`). A terminal
// agent tells no such time (the Inbox only knows when its state last changed, which says nothing of its output), so
// it is never flagged.
//
// A quiet spell is one last-change time: a new change or the turn's end clears the flag, and the toast isn't said
// again until the chat goes quiet anew. Which spells were told is shared ("ht3-inbox.quiet": address → that time), so
// the copies of the Inbox say each one once between them.
const MINUTE = 60000;
export const QUIET_DEFAULT = 15;

// The setting as the pass reads it: whole minutes, 0 = off; none or junk is the default.
export function quietMinutes(raw) {
  const v = raw?.quietMinutes;
  if (v == null || v === "" || typeof v === "boolean") return QUIET_DEFAULT;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, n) : QUIET_DEFAULT;
}

// `quiet:<text>`'s value: "off" (or minutes=0) is 0, "minutes=<n>" is n, for scripted checks; anything else is null,
// back to the settings.
export function quietCommand(text) {
  if (text === "off") return 0;
  if (!text.startsWith("minutes=") || text.length === 8) return null;
  const n = Math.floor(Number(text.slice(8)));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// How many whole minutes a row has been quiet, 0 when it isn't: it works, its last change is known, and that is at
// least `minutes` ago. row: { working, changed (ms; 0: unknown) }.
export function quietFor(row, minutes, now) {
  const at = Number(row?.changed) || 0;
  if (!(minutes > 0) || !row?.working || at <= 0 || now - at < minutes * MINUTE) return 0;
  return Math.floor((now - at) / MINUTE);
}

// One pass. rows: { id, working, changed, muted (snoozed: flagged, but no toast until it's back) }; `told`: the spells
// already said (id → changed); `alive(id)`: whether a row this copy doesn't list still exists (another copy's).
// Returns { quiet: { id → minutes }, toast: [rows to tell now, each with `minutes`], told: the next record, dirty }.
// Off (minutes 0), nothing is flagged and the record is left alone, as another copy may still go by it.
export function quietPass(rows, minutes, now, told = {}, alive = () => true) {
  const quiet = {}, toast = [], next = {};
  if (!(minutes > 0)) return { quiet, toast, told, dirty: false };
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.id);
    const n = quietFor(r, minutes, now);
    if (n) quiet[r.id] = n;
    // The same spell (it works, nothing changed since) stays told, also under a longer limit it isn't over yet.
    if (told[r.id] !== undefined && r.working && told[r.id] === r.changed) next[r.id] = r.changed;
    else if (n && !r.muted) { next[r.id] = r.changed; toast.push({ ...r, minutes: n }); }
  }
  for (const [id, at] of Object.entries(told)) if (!seen.has(id) && alive(id)) next[id] = at;
  const dirty = JSON.stringify(Object.entries(next).sort()) !== JSON.stringify(Object.entries(told).sort());
  return { quiet, toast, told: dirty ? next : told, dirty };
}
