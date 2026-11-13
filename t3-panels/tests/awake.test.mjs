// node t3-panels/tests/awake.test.mjs
import assert from "node:assert/strict";
import { awakeDue } from "../mods/ht3-panels/awake.js";

const base = { working: true, on: true, last: null, now: 1_000_000 };
// Off or idle: never.
assert.equal(awakeDue({ ...base, on: false }), false);
assert.equal(awakeDue({ ...base, working: false }), false);
assert.equal(awakeDue({ ...base, on: false, working: false }), false);
// Working and on, never started (or a bad stamp): now.
assert.equal(awakeDue(base), true);
assert.equal(awakeDue({ ...base, last: undefined }), true);
assert.equal(awakeDue({ ...base, last: "x" }), true);
// Renewed every 60 s by default, or `every`.
assert.equal(awakeDue({ ...base, last: base.now - 59_999 }), false);
assert.equal(awakeDue({ ...base, last: base.now - 60_000 }), true);
assert.equal(awakeDue({ ...base, last: base.now - 10_000, every: 10_000 }), true);
assert.equal(awakeDue({ ...base, last: base.now - 9_999, every: 10_000 }), false);
// A start in the future (the clock went back) renews.
assert.equal(awakeDue({ ...base, last: base.now + 5_000 }), true);
console.log("awake: ok");
