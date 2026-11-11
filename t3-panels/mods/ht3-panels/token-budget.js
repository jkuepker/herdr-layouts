// The per-chat token budget (setting `chatTokenBudget`), as pure logic; no Herdr imports, so `.scratch/token-budget.test.mjs`
// runs on it.
//
// What counts: only the tokens the agent reports with an answer (session.js `usage`: input and output), added up per chat in
// the transcript's `tokens` = { input, output, total, turns }. An agent that sends none has no total, so no budget line.
// `budgetNotice` says what the line over the message box shows for a total and a budget:
//   - below 80% of the budget: nothing;
//   - from 80%: "This chat used N of M tokens" (level 1, a warning);
//   - from 100%: the same line with Stop and New session (level 2).
// Each level shows once per budget: its key goes into `dismissed` (the line's ×, or New session) and it doesn't come back
// until the budget changes (the key holds the budget).

export const BUDGETS = [0, 100000, 250000, 500000, 1000000, 2000000]; // 0 = off
export const WARN_AT = 0.8;

// The setting's value as a budget: one of BUDGETS (a number off the list is taken as it is when positive), else 0.
export function cleanBudget(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// The next choice after `budget` in BUDGETS, round to Off.
export function nextBudget(budget) {
  const at = BUDGETS.indexOf(cleanBudget(budget));
  return at < 0 ? BUDGETS[1] : BUDGETS[(at + 1) % BUDGETS.length];
}
export const budgetLabel = (n) => (!n ? "Off" : n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1e3)}k`);
export const grouped = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Adds one answer's `usage` ({ inputTokens, outputTokens, totalTokens } or snake_case) to a chat's `tokens`; returns it.
// Nothing is added for a usage with no number in it.
export function addUsage(tokens, usage) {
  if (!usage || typeof usage !== "object") return tokens ?? null;
  const n = (...keys) => keys.map((key) => Number(usage[key])).find((v) => Number.isFinite(v));
  const input = n("inputTokens", "input_tokens"), output = n("outputTokens", "output_tokens"), total = n("totalTokens", "total_tokens");
  if (input == null && output == null && total == null) return tokens ?? null;
  const t = tokens ?? { input: 0, output: 0, total: 0, turns: 0 };
  t.input += input ?? 0;
  t.output += output ?? 0;
  t.total += total || (input ?? 0) + (output ?? 0);
  t.turns += 1;
  return t;
}

// A chat's total tokens as the agent reported them, or null when it reported none.
export function totalOf(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const t = Number(tokens.total) || (Number(tokens.input) || 0) + (Number(tokens.output) || 0);
  return t > 0 ? t : null;
}

// -> null, or { level: 1 | 2, used, budget, text, key }. `dismissed`: the keys already dismissed (a Set or an array).
export function budgetNotice(tokens, budget, dismissed = []) {
  const max = cleanBudget(budget), used = totalOf(tokens);
  if (!max || used == null) return null;
  const level = used >= max ? 2 : used >= max * WARN_AT ? 1 : 0;
  if (!level) return null;
  const key = `tb${level}:${max}`;
  if ((dismissed instanceof Set ? dismissed.has(key) : dismissed.includes(key))) return null;
  return { level, used, budget: max, text: `This chat used ${grouped(used)} of ${grouped(max)} tokens`, key };
}
// The keys a dismissal at `level` covers: the level itself (a warning dismissed doesn't hide the later "reached").
export const keyOf = (level, budget) => `tb${level}:${cleanBudget(budget)}`;
