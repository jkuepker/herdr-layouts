// node t3-panels/tests/limit-resume.test.mjs
import assert from "node:assert/strict";
import { limitStopped, resumeAt, resumeDue, resumeArmed, resumePlan, clockText, RESUME_MARGIN_MS, RESUME_TEXT } from "../mods/ht3-panels/limit-resume.js";

assert.equal(RESUME_TEXT, "continue");
const noted = 1_700_000_000_000, resetsAt = noted / 1000 + 3600;
const limit = { status: "rejected", resetsAt, at: noted, type: "five_hour" };

// Stopped by a limit: the agent said rejected and the turn is over.
assert.equal(limitStopped({ limit, status: "ready" }), true);
assert.equal(limitStopped({ limit, status: "exited" }), true);
assert.equal(limitStopped({ limit, status: "working" }), false);
assert.equal(limitStopped({ limit, status: "blocked" }), false);
assert.equal(limitStopped({ limit: { ...limit, status: "allowed_warning" }, status: "ready" }), false);
assert.equal(limitStopped({ limit: null, status: "ready" }), false);

// When: the reset plus the margin; nothing without a reset time or with one that was already past when noted.
assert.equal(resumeAt(limit), resetsAt * 1000 + RESUME_MARGIN_MS);
assert.equal(resumeAt(limit, 0), resetsAt * 1000);
assert.equal(resumeAt({ status: "rejected", text: "Usage limit reached", at: noted }), null);
assert.equal(resumeAt({ ...limit, resetsAt: noted / 1000 - 5 }), null);
assert.equal(resumeAt({ ...limit, resetsAt: "x" }), null);
assert.equal(resumeAt(null), null);

// Due from that moment on.
const at = resumeAt(limit);
assert.equal(resumeDue({ at, now: at - 1 }), false);
assert.equal(resumeDue({ at, now: at }), true);
assert.equal(resumeDue({ at, now: at + 86_400_000 }), true);
assert.equal(resumeDue({ at: null, now: at }), false);

// Armed: the pref unless the person chose for this reset; a choice for another reset doesn't count.
assert.equal(resumeArmed({ limit, kept: null, pref: false }), false);
assert.equal(resumeArmed({ limit, kept: null, pref: true }), true);
assert.equal(resumeArmed({ limit, kept: { at: resetsAt, on: true }, pref: false }), true);
assert.equal(resumeArmed({ limit, kept: { at: resetsAt, on: false }, pref: true }), false);
assert.equal(resumeArmed({ limit, kept: { at: resetsAt - 18000, on: true }, pref: false }), false);
assert.equal(resumeArmed({ limit, kept: { at: resetsAt - 18000, on: false }, pref: true }), true);

// The whole plan.
assert.equal(resumePlan({ limit, status: "working", now: noted }), null);
assert.equal(resumePlan({ limit: { ...limit, status: "allowed" }, status: "ready", now: noted }), null);
assert.equal(resumePlan({ limit: { status: "rejected", text: "quota", at: noted }, status: "ready", now: noted }), null);
assert.deepEqual(resumePlan({ limit, status: "ready", now: noted }), { at, armed: false, due: false });
assert.deepEqual(resumePlan({ limit, status: "ready", pref: true, now: noted }), { at, armed: true, due: false });
assert.deepEqual(resumePlan({ limit, status: "ready", kept: { at: resetsAt, on: true }, now: at }), { at, armed: true, due: true });
// Past due after a restart: still due, however late.
assert.deepEqual(resumePlan({ limit, status: "ready", kept: { at: resetsAt, on: true }, now: at + 7 * 86_400_000 }), { at, armed: true, due: true });
// Sent once per reset; a later limit with another reset is a new plan.
assert.equal(resumePlan({ limit, status: "ready", kept: { at: resetsAt, on: false, sent: true }, pref: true, now: at }), null);
const later = { ...limit, resetsAt: resetsAt + 18000, at: at + 1000 };
assert.deepEqual(resumePlan({ limit: later, status: "ready", kept: { at: resetsAt, on: false, sent: true }, pref: true, now: at + 2000 }), { at: resumeAt(later), armed: true, due: false });

// Local 12-hour time.
const day = (h, m) => new Date(2026, 10, 12, h, m).getTime();
assert.equal(clockText(day(3, 5)), "3:05 AM");
assert.equal(clockText(day(0, 0)), "12:00 AM");
assert.equal(clockText(day(12, 30)), "12:30 PM");
assert.equal(clockText(day(23, 59)), "11:59 PM");
console.log("limit-resume: ok");
