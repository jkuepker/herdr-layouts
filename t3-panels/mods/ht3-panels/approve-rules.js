// Approval rules: command patterns a chat's approvals are answered "allow once" for by themselves, so an unattended
// chat doesn't stall at `npm test` or `git status`. Kept in the settings file (settings.js, "approveRules"):
//
//   { "global": ["git status"], "projects": { "<machine or empty>:<project folder>": ["npm test"] } }
//
// A project is the repository's main checkout (its worktrees share the rules), or, outside Git, the folder: the key
// project scripts and parked drafts use. Settings edits both lists (one pattern a line), an approval card's
// "Always allow `<cmd>` here" adds the asked command to the project's, and `ht3-panels.allowrule:…` does it for scripts.
//
// What a rule can answer (decide):
// - only a request to run a command (ACP tool kind "execute") whose command text is known: an edit, a delete, a move,
//   a fetch or any other tool is never answered by a rule, in the chat's folder or outside it;
// - a pattern matches the command it spells, and that command followed by more arguments: `npm test` matches
//   `npm test -- foo`, not `npm testx`;
// - with more arguments the command must be one plain command: one that chains, redirects or substitutes
//   (; & | < > ` $( or a line break) is only matched by a pattern that spells it whole;
// - only the agent's "allow once" option is picked: never an "always" one, and nothing when it offers none.
// Pure logic, no Herdr imports (tests/approve-rules.test.mjs).

// What makes a command more than one plain command: chaining (; && || & and a line break), pipes, redirection,
// command and process substitution.
const UNSAFE = /[;&|<>`\n\r]|\$\(/;
export const plainCommand = (command) => !UNSAFE.test(String(command ?? ""));

const SHELLS = new Set(["sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/env"]);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// The command of a tool call's raw input, as agents send it: { command: "npm test" } (Claude Code), { command:
// ["bash", "-lc", "npm test"] } (Codex), { cmd: "…" }. An argv that isn't a shell's `-c` line is joined only when
// every word is plain, so the text can't read as something the argv isn't.
export function commandOf(rawInput) {
  const c = rawInput?.command ?? rawInput?.cmd ?? null;
  if (typeof c === "string") return text(c);
  if (!Array.isArray(c) || !c.length || !c.every((w) => typeof w === "string")) return null;
  if (c.length === 3 && SHELLS.has(c[0]) && /^-l?c$/.test(c[1])) return text(c[2]);
  return c.every((w) => /^[\w@%+=:,./-]+$/.test(w)) ? c.join(" ") : null;
}

// What a `session/request_permission` asks, from its toolCall and what the agent said of that tool call before
// (`known`: the tool_call update of the same id): { kind, command, titled }. `titled`: the command is the request's
// title, as the agent sent no raw input: an agent's title is its own wording, so the rule's notice says so.
export function requestOf(toolCall, known = null) {
  const kind = toolCall?.kind ?? known?.kind ?? null;
  const raw = commandOf(toolCall?.rawInput) ?? commandOf(known?.rawInput);
  if (kind !== "execute") return { kind, command: null, titled: false };
  if (raw) return { kind, command: raw, titled: false };
  const title = text(toolCall?.title ?? known?.title), bare = title?.match(/^`([^`]+)`$/)?.[1] ?? title;
  return { kind, command: text(bare), titled: !!bare };
}

// The patterns of a text area: one a line; empty lines and # comments are left out, and each pattern once.
export function parseRules(lines) {
  const out = [];
  for (const l of Array.isArray(lines) ? lines : String(lines ?? "").split("\n")) {
    const p = typeof l === "string" ? l.trim() : "";
    if (p && !p.startsWith("#") && !out.includes(p)) out.push(p);
  }
  return out;
}

// Whether `pattern` matches `command`: the same text, or the pattern, a space and more arguments of one plain command.
export function matches(pattern, command) {
  const p = String(pattern ?? "").trim(), c = String(command ?? "").trim();
  if (!p || !c) return false;
  if (c === p) return true;
  return plainCommand(c) && c.startsWith(p) && /\s/.test(c[p.length]);
}

const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
// The rules that hold for a project (`key`), of the kept `store`: [{ pattern, scope: "global" | "project" }].
export function rulesFor(store, key) {
  const s = plain(store);
  return [...parseRules(plain(s.projects)[key]).map((pattern) => ({ pattern, scope: "project" })),
    ...parseRules(s.global).map((pattern) => ({ pattern, scope: "global" }))];
}
export const projectRules = (store, key) => parseRules(plain(plain(store).projects)[key]);
export const globalRules = (store) => parseRules(plain(store).global);

// The store with a list set: `key` null is the global list. Empty lists and an empty store aren't kept (undefined).
export function withRules(store, key, lines) {
  const s = plain(store), list = parseRules(lines), projects = { ...plain(s.projects) };
  if (key != null) { if (list.length) projects[key] = list; else delete projects[key]; }
  const global = key == null ? list : parseRules(s.global);
  const next = { ...s, global, projects };
  if (!global.length) delete next.global;
  if (!Object.keys(projects).length) delete next.projects;
  return Object.keys(next).length ? next : undefined;
}
export const addRule = (store, key, pattern) => withRules(store, key, [...(key == null ? globalRules(store) : projectRules(store, key)), pattern]);
export const removeRule = (store, key, pattern) => withRules(store, key, (key == null ? globalRules(store) : projectRules(store, key)).filter((p) => p !== String(pattern ?? "").trim()));

// The agent's "allow once" option of an approval, or null: an "always" option is never a rule's to pick.
export const onceOption = (options) => (options ?? []).find((o) => o?.kind === "allow_once") ?? null;

// A rule's answer to an approval. `permission`: { options, request: requestOf() }; `rules`: rulesFor().
// -> { optionId, command, pattern, scope, titled } when a rule answers it, else null.
export function decide(permission, rules) {
  const r = permission?.request, yes = onceOption(permission?.options);
  if (!yes || r?.kind !== "execute" || !r.command) return null;
  const rule = (rules ?? []).find((x) => matches(x.pattern, r.command));
  return rule ? { optionId: yes.optionId, command: r.command, pattern: rule.pattern, scope: rule.scope, titled: r.titled === true } : null;
}

// The command an approval card can offer as a rule ("Always allow `<cmd>` here"), or null: a command, with an
// "allow once" to answer it with.
export const offerOf = (permission) => (onceOption(permission?.options) && permission?.request?.kind === "execute" ? permission.request.command ?? null : null);

// The thread's line for an approval a rule answered.
export const ruleNotice = (d) => `Allowed automatically: \`${d.command}\` (rule \`${d.pattern}\`${d.titled ? ", matched on the request's title" : ""})`;
