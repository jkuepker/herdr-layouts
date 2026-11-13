// node t3-panels/tests/autosettle.test.mjs
import assert from "node:assert/strict";
import { AUTO_DAYS, autoPrefs, autoMinutes, taskPrStates, autoSettleIds, autoPassDue } from "../mods/ht3-inbox/autosettle.js";

const DAY = 86400000, now = 100 * DAY;
const row = (id, over = {}) => ({ id, lastActivity: now - 10 * DAY, busy: false, waiting: false, settled: false, snoozedUntil: 0, pinned: false, inFront: false, closes: false, pr: null, prAt: 0, ...over });
const off = autoPrefs({}), week = autoPrefs({ autoSettleDays: 7 });

// Prefs: off by default, junk is off.
assert.deepEqual(off, { days: 0, onMerge: false, keepOpenPr: false });
assert.deepEqual(autoPrefs(undefined), off);
assert.deepEqual(autoPrefs({ autoSettleDays: "x", autoSettleOnMerge: "yes", autoSettleKeepOpenPr: 1 }), off);
assert.deepEqual(autoPrefs({ autoSettleDays: -3 }), off);
assert.deepEqual(autoPrefs({ autoSettleDays: 3, autoSettleOnMerge: true, autoSettleKeepOpenPr: true }), { days: 3, onMerge: true, keepOpenPr: true });
assert.deepEqual(AUTO_DAYS, [0, 1, 3, 7, 14]);

// All off: nothing, however old.
assert.deepEqual(autoSettleIds([row("a"), row("b", { pr: "merged", prAt: now - DAY })], off, now), []);

// Idle: older than the days, not younger, not exactly on the line, not with no known time.
assert.deepEqual(autoSettleIds([row("old"), row("young", { lastActivity: now - 6 * DAY }), row("edge", { lastActivity: now - 7 * DAY }), row("unknown", { lastActivity: 0 })], week, now), ["old"]);
assert.deepEqual(autoSettleIds([row("a", { lastActivity: now - 2 * DAY })], autoPrefs({ autoSettleDays: 1 }), now), ["a"]);

// Never: busy, waiting for the person, in front, settled, snoozed, pinned, or a card Settle would close.
for (const over of [{ busy: true }, { waiting: true }, { inFront: true }, { settled: true }, { snoozedUntil: now + 1000 }, { pinned: true }, { closes: true }]) {
  assert.deepEqual(autoSettleIds([row("a", over)], week, now), [], JSON.stringify(over));
  assert.deepEqual(autoSettleIds([row("a", { ...over, pr: "merged", prAt: now - DAY })], autoPrefs({ autoSettleDays: 7, autoSettleOnMerge: true }), now), [], JSON.stringify(over));
}
// A snooze that ran out counts from when it woke.
assert.deepEqual(autoSettleIds([row("woke", { snoozedUntil: now - DAY }), row("long", { snoozedUntil: now - 8 * DAY })], week, now), ["long"]);

// Merged: only with the setting, at once (no idle time), and not when the chat went on after the merge.
const merged = row("m", { lastActivity: now - 3600000, pr: "merged", prAt: now - 60000 });
assert.deepEqual(autoSettleIds([merged], week, now), []);
assert.deepEqual(autoSettleIds([merged], autoPrefs({ autoSettleOnMerge: true }), now), ["m"]);
assert.deepEqual(autoSettleIds([{ ...merged, lastActivity: now - 1000 }], autoPrefs({ autoSettleOnMerge: true }), now), []);
assert.deepEqual(autoSettleIds([{ ...merged, prAt: 0 }], autoPrefs({ autoSettleOnMerge: true }), now), []);
// Worked on after the merge, it still goes by idleness.
assert.deepEqual(autoSettleIds([{ ...merged, lastActivity: now - 8 * DAY, prAt: now - 9 * DAY }], autoPrefs({ autoSettleDays: 7, autoSettleOnMerge: true }), now), ["m"]);

// Keep open pull requests: idleness leaves them, without the setting it doesn't; a merged one isn't kept.
const open = row("o", { pr: "open" });
assert.deepEqual(autoSettleIds([open], week, now), ["o"]);
assert.deepEqual(autoSettleIds([open, row("plain"), row("done", { pr: "merged", prAt: now - 20 * DAY })], autoPrefs({ autoSettleDays: 7, autoSettleKeepOpenPr: true }), now), ["plain", "done"]);

// The test override: minutes instead of days, on even with the days off; the never-rules still hold.
assert.deepEqual(autoSettleIds([row("a", { lastActivity: now - 3 * 60000 }), row("b", { lastActivity: now - 60000 }), row("c", { lastActivity: now - 3 * 60000, busy: true })], off, now, 2), ["a"]);
assert.equal(autoMinutes("2"), 2);
assert.equal(autoMinutes("0.5"), 0.5);
for (const bad of ["", "0", "-1", "x", " "]) assert.equal(autoMinutes(bad), null, bad);

// Task runs as pull request state: merged with its time, open while unmerged; no run or no placed chat: no state.
const states = taskPrStates({ "": [{ id: "1", run: { chat: "c1", merged: { at: 5, commit: "abc" } } }, { id: "2", run: { chat: "c2" } }, { id: "3" }, { id: "4", run: { chat: "gone" } }], "m:/x": "junk" },
  { c1: { pane: "p1", tab: "t1" }, c2: { pane: "p2", tab: "t2" } });
assert.deepEqual([...states], [["pane:p1", { pr: "merged", at: 5 }], ["pane:p2", { pr: "open", at: 0 }]]);
assert.equal(taskPrStates(undefined, undefined).size, 0);

// One pass a minute over all copies; a forced one unless another copy just ran.
assert.equal(autoPassDue(undefined, now), true);
assert.equal(autoPassDue(now - 10000, now), false);
assert.equal(autoPassDue(now - 60000, now), true);
assert.equal(autoPassDue(now - 10000, now, true), true);
assert.equal(autoPassDue(now - 200, now, true), false);
assert.equal(autoPassDue(now + 5000, now), true);

console.log("autosettle: ok");
