// node t3-panels/tests/quiet.test.mjs
import assert from "node:assert/strict";
import { QUIET_DEFAULT, quietMinutes, quietCommand, quietFor, quietPass } from "../mods/ht3-inbox/quiet.js";

const MIN = 60000, now = 1000 * MIN;
const row = (id, ago, over = {}) => ({ id, working: true, changed: now - ago * MIN, muted: false, ...over });

// The setting: 15 by default, 0 is off, junk is the default, fractions round down.
assert.equal(QUIET_DEFAULT, 15);
for (const raw of [undefined, null, {}, { quietMinutes: "x" }, { quietMinutes: "" }, { quietMinutes: true }, { quietMinutes: null }]) assert.equal(quietMinutes(raw), 15, JSON.stringify(raw));
assert.equal(quietMinutes({ quietMinutes: 0 }), 0);
assert.equal(quietMinutes({ quietMinutes: -5 }), 0);
assert.equal(quietMinutes({ quietMinutes: 30 }), 30);
assert.equal(quietMinutes({ quietMinutes: "5" }), 5);
assert.equal(quietMinutes({ quietMinutes: 2.9 }), 2);

// The command: quiet:minutes=<n>, quiet:off; anything else goes back to the settings.
assert.equal(quietCommand("minutes=1"), 1);
assert.equal(quietCommand("minutes=20"), 20);
assert.equal(quietCommand("minutes=0"), 0);
assert.equal(quietCommand("off"), 0);
for (const text of ["minutes=", "minutes=x", "minutes=-1", "", "on"]) assert.equal(quietCommand(text), null, text);

// Quiet: working, a known last change, at least the minutes ago; it says the whole minutes.
assert.equal(quietFor(row("a", 20), 15, now), 20);
assert.equal(quietFor(row("a", 15), 15, now), 15);
assert.equal(quietFor(row("a", 14.9), 15, now), 0);
assert.equal(quietFor(row("a", 20.7), 15, now), 20);
assert.equal(quietFor(row("a", 20, { working: false }), 15, now), 0);
assert.equal(quietFor(row("a", 20, { changed: 0 }), 15, now), 0);
assert.equal(quietFor(row("a", 20), 0, now), 0);
assert.equal(quietFor(undefined, 15, now), 0);

// A pass: the quiet ones are flagged, each told once.
let p = quietPass([row("hung", 20), row("busy", 2), row("idle", 90, { working: false }), row("term", 90, { changed: 0 })], 15, now);
assert.deepEqual(p.quiet, { hung: 20 });
assert.deepEqual(p.toast.map((r) => [r.id, r.minutes]), [["hung", 20]]);
assert.deepEqual(p.told, { hung: now - 20 * MIN });
assert.equal(p.dirty, true);
// The next pass, a minute on: still flagged, not told again, nothing to write.
const spell = now - 20 * MIN;
p = quietPass([{ ...row("hung", 0), changed: spell }], 15, now + MIN, p.told);
assert.deepEqual(p.quiet, { hung: 21 });
assert.deepEqual(p.toast, []);
assert.equal(p.dirty, false);
// A new change clears it; quiet again after that is a new spell with a new toast.
p = quietPass([row("hung", 1)], 15, now, { hung: spell });
assert.deepEqual([p.quiet, p.toast, p.told, p.dirty], [{}, [], {}, true]);
p = quietPass([row("hung", 16)], 15, now, p.told);
assert.deepEqual(p.toast.map((r) => r.id), ["hung"]);
assert.deepEqual(p.told, { hung: now - 16 * MIN });
// The turn ending clears it, even if the time didn't move.
p = quietPass([{ ...row("hung", 0), changed: spell, working: false }], 15, now, { hung: spell });
assert.deepEqual([p.quiet, p.toast, p.told], [{}, [], {}]);
// Then working again with the same time (nothing new yet) and quiet: said again.
p = quietPass([{ ...row("hung", 0), changed: spell }], 15, now, p.told);
assert.deepEqual(p.toast.map((r) => r.id), ["hung"]);
// A spell told under a short limit stays told under a longer one it hasn't reached.
p = quietPass([row("a", 3)], 15, now, { a: now - 3 * MIN });
assert.deepEqual([p.quiet, p.toast, p.told, p.dirty], [{}, [], { a: now - 3 * MIN }, false]);
// Snoozed: flagged, no toast, and not counted as told, so it is said once it's back.
p = quietPass([row("nap", 20, { muted: true })], 15, now);
assert.deepEqual([p.quiet, p.toast, p.told, p.dirty], [{ nap: 20 }, [], {}, false]);
p = quietPass([row("nap", 20)], 15, now, p.told);
assert.deepEqual(p.toast.map((r) => r.id), ["nap"]);
// Off: nothing flagged or told, and the record is left as it is.
const told = { hung: spell };
p = quietPass([{ ...row("hung", 0), changed: spell }], 0, now, told);
assert.deepEqual([p.quiet, p.toast, p.dirty], [{}, [], false]);
assert.equal(p.told, told);
// A row this copy doesn't list keeps its record while it exists, and loses it when it's gone.
p = quietPass([], 15, now, { other: spell, gone: spell }, (id) => id === "other");
assert.deepEqual([p.told, p.dirty], [{ other: spell }, true]);
assert.equal(quietPass([], 15, now, { other: spell }).dirty, false);
// No record given.
assert.deepEqual(quietPass([], 15, now).told, {});

console.log("quiet: ok");
