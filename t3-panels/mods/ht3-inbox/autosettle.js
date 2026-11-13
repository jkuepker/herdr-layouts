// Auto-settle, as T3's (ThreadSettlementService resolveAutoSettlementAt): chats nobody touched for some days, or whose
// work was merged, are settled without a click. Pure logic, no Herdr imports, so tests/autosettle.test.mjs runs on it.
//
// The settings (ht3-panels' settings file, shared "ht3-panels.settings"; all off by default):
// - autoSettleDays (0 = off; 1, 3, 7 or 14): a chat with no activity for this many days is settled.
// - autoSettleOnMerge (false): a chat whose pull request merged is settled.
// - autoSettleKeepOpenPr (false): idleness doesn't settle a chat with an open pull request; a merge still does.
// The Inbox knows no pull requests (pr.js asks gh only while its surface shows), so a row's `pr` is its task's run
// (shared "ht3-panels.tasks", tasks.js): "merged" once Merge took it in (`run.merged.at`), "open" while it has a
// run that isn't merged.
//
// Never settled: a row that works or waits for the person, the one in front, a settled, snoozed or pinned one (T3
// leaves pinned threads alone too), and a card whose Settle would close its pane.

const DAY = 86400000, MINUTE = 60000;
export const AUTO_DAYS = [0, 1, 3, 7, 14]; // 0 = off

// The settings as the pass reads them; anything else is off.
export function autoPrefs(raw) {
  const days = Math.floor(Number(raw?.autoSettleDays));
  return { days: Number.isFinite(days) && days > 0 ? days : 0, onMerge: raw?.autoSettleOnMerge === true, keepOpenPr: raw?.autoSettleKeepOpenPr === true };
}

// `autosettle:minutes=<n>`'s value: the idle time in minutes for scripted checks, or null for none.
export function autoMinutes(text) {
  const n = Number(text);
  return String(text).trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

// Each task chat's row with what its run says: Map(`pane:<id>` → { pr: "merged" | "open", at }).
// `tasks` is shared "ht3-panels.tasks", `places` shared "ht3-panels.places" (chat → { pane, tab }).
export function taskPrStates(tasks, places) {
  const out = new Map();
  for (const list of Object.values(tasks ?? {})) {
    for (const t of Array.isArray(list) ? list : []) {
      const pane = t?.run?.chat != null ? places?.[t.run.chat]?.pane : null;
      if (!pane) continue;
      const at = Number(t.run.merged?.at) || 0;
      out.set(`pane:${pane}`, t.run.merged ? { pr: "merged", at } : { pr: "open", at: 0 });
    }
  }
  return out;
}

// rows: { id, lastActivity (ms; 0: unknown), busy, waiting, settled, snoozedUntil (ms; 0: none), pinned, inFront,
// closes (Settle would close its pane), pr ("merged" | "open" | null), prAt (ms, when it merged) }.
// prefs: autoPrefs(); `minutes`, when set, is the idle time instead of the days. Returns the ids to settle.
export function autoSettleIds(rows, prefs, now, minutes = null) {
  const idle = minutes != null ? minutes * MINUTE : prefs.days * DAY;
  const out = [];
  for (const r of rows) {
    if (r.busy || r.waiting || r.inFront || r.settled || r.pinned || r.closes) continue;
    if (r.snoozedUntil > now) continue;
    // A merge settles unless the chat went on after it, as T3's (the merge at or after the last activity): one brought
    // back by hand, or given new work, stays.
    if (prefs.onMerge && r.pr === "merged" && r.prAt > 0 && r.prAt >= (r.lastActivity || 0)) { out.push(r.id); continue; }
    if (!idle || (prefs.keepOpenPr && r.pr === "open")) continue;
    // A snooze that ran out counts as activity then, as T3's.
    const last = Math.max(r.lastActivity || 0, r.snoozedUntil || 0);
    // No known time: not ours to guess.
    if (last > 0 && last < now - idle) out.push(r.id);
  }
  return out;
}

// Whether a pass may run: at most one a minute over all copies (`last`: when any copy last ran, shared). One asked for
// (`autosettle:now`, which every copy hears) runs unless another copy just did.
export function autoPassDue(last, now, forced = false) {
  const since = now - (Number(last) || 0);
  return since < 0 || since >= (forced ? 1000 : 50000);
}
