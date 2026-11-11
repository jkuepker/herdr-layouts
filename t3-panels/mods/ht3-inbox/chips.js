// The Inbox's filter chips (T3 Panels' own; T3 Code narrows its thread list by status, project and environment).
// Three groups: status, in the Inbox's own words; machine, offered once the cards come from more than one; project, the same.
// Chips of one group add up (any of them), groups narrow each other (all of them). Plain facts in, plain answers out:
// no storage, no drawing.

export const STATUSES = [
  { key: "needs", label: "Needs you" },
  { key: "working", label: "Working" },
  { key: "done", label: "Done" },
  { key: "settled", label: "Settled" },
];
export const GROUPS = ["status", "machine", "project"];
// This computer's key among the machines; a remote one's is its name.
export const LOCAL = "";

const names = (xs) => [...new Set((Array.isArray(xs) ? xs : []).filter((x) => typeof x === "string"))];

// What was stored, whatever it holds: three lists of strings.
export function readChips(text) {
  let raw = null;
  try { raw = JSON.parse(text ?? "null"); } catch { /* unreadable reads as none */ }
  return { status: names(raw?.status), machine: names(raw?.machine), project: names(raw?.project) };
}

// A card's place in each group. `status`: Settled once put away, else Needs you while it waits for the person, Working as
// the Working shelf has it (a run, or one just stopped), else Done: back with the person, read or not. A snoozed card
// goes by the same words. `machine`: where the card says it runs (a chat's agent, a terminal's address), else its
// space's. `project`: its space's name folded, so worktrees and other machines' checkouts of one repository, which Herdr
// names alike, are one project, as T3 groups them.
export function cardFacts(a, { settled, blocked, working, space }) {
  const own = a.mod ? a.program?.machine : a.address.includes("/") ? a.address.split("/")[0] : null;
  const name = (a.space_name ?? space?.name ?? "").trim();
  return {
    status: settled ? "settled" : blocked ? "needs" : working ? "working" : "done",
    machine: own ?? space?.machine ?? LOCAL,
    project: name.toLowerCase(),
    projectName: name,
    space: a.space,
  };
}

// The chips to offer for these cards: every status, the machines and projects only when there is more than one.
// This computer leads the machines; the rest go by name.
export function chipOptions(facts) {
  const machines = [...new Set(facts.map((f) => f.machine))].sort((x, y) => (x === LOCAL ? -1 : y === LOCAL ? 1 : x.localeCompare(y)));
  const projects = new Map();
  for (const f of facts) if (!projects.has(f.project)) projects.set(f.project, { key: f.project, label: f.projectName || "No name", space: f.space });
  return {
    status: STATUSES,
    machine: machines.length > 1 ? machines.map((m) => ({ key: m, label: m === LOCAL ? "Local" : m })) : [],
    project: projects.size > 1 ? [...projects.values()].sort((x, y) => x.label.localeCompare(y.label)) : [],
  };
}

// The chosen chips that count: only ones on offer, so a machine or project that went (or a group with one choice
// left) filters nothing. What was chosen stays stored and counts again when it is back.
export function activeChips(chosen, options) {
  return Object.fromEntries(GROUPS.map((g) => [g, (chosen[g] ?? []).filter((k) => options[g].some((o) => o.key === k))]));
}

export const chipsOn = (active) => GROUPS.some((g) => active[g].length > 0);

// Any chip of a group, and every group that has one.
export const chipKeeps = (active) => (f) => GROUPS.every((g) => !active[g].length || active[g].includes(f[g]));

export function toggleChip(chosen, group, key) {
  if (!GROUPS.includes(group)) return chosen;
  const had = chosen[group] ?? [];
  return { ...chosen, [group]: had.includes(key) ? had.filter((k) => k !== key) : [...had, key] };
}

// The × : every chip on offer goes off; ones that aren't on offer stay stored, as they filter nothing now.
export function clearChips(chosen, options) {
  return Object.fromEntries(GROUPS.map((g) => [g, (chosen[g] ?? []).filter((k) => !options[g].some((o) => o.key === k))]));
}
