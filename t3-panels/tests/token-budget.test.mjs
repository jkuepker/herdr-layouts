// node t3-panels/tests/token-budget.test.mjs
import assert from "node:assert/strict";
import { addUsage, budgetNotice, totalOf } from "../mods/ht3-panels/token-budget.js";

// Claude Code's adapter: totalTokens includes cache reads; they stay out of the total.
let t = addUsage(null, { inputTokens: 12, outputTokens: 900, cachedReadTokens: 90000, cachedWriteTokens: 6000, totalTokens: 96912 });
assert.deepEqual(t, { input: 12, output: 900, total: 6912, turns: 1, cached: 90000 });
t = addUsage(t, { inputTokens: 8, outputTokens: 100, cachedReadTokens: 50000, cachedWriteTokens: 0, totalTokens: 50108 });
assert.equal(t.total, 7020); assert.equal(t.cached, 140000); assert.equal(t.turns, 2);
assert.equal(budgetNotice(t, 100000), null);
// No cache counts: the agent's total, else input + output.
assert.equal(addUsage(null, { inputTokens: 5, outputTokens: 5, totalTokens: 30 }).total, 30);
assert.equal(addUsage(null, { input_tokens: 5, output_tokens: 7 }).total, 12);
assert.equal(addUsage(null, {}), null);
assert.equal(totalOf(addUsage(null, { inputTokens: 85000, outputTokens: 0 })), 85000);
assert.equal(budgetNotice(addUsage(null, { inputTokens: 85000, outputTokens: 0 }), 100000).level, 1);
console.log("token-budget: ok");
