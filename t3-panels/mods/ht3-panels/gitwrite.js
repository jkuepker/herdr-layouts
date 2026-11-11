// A commit message, or a pull request's title and body, written by an agent (T3 Code's git text generation:
// GitManager.ts, provider-core textGenerationPrompts.ts). The Project popover (menus.js) asks; the text goes into
// its fields for the person to read and change. Nothing here commits, pushes or opens a pull request.
// - What the agent reads is text only: the diff and the commit list, taken with `git` where the space runs
//   (`exec` with `on:`), cut to a size (the popover says when it was cut).
// - Who is asked: the agent of the chat in the shown tab, on that chat's model; with no chat there, the default
//   agent from Settings. It is asked once, in a session of its own that is thrown away (agent-acp.js askOnce),
//   which can only start an agent on this computer: for a space on another machine the diff comes from there
//   and an agent here writes from it.
// No drawing and no gpui here, so a test can run it under Node with a stand-in for `herdr`.

import { exec, appHome, home, readTextFile, focused, shared } from "herdr";
import { askOnce, detect, argvOf, agentOf, AGENTS } from "./agent-acp.js";
import { firstAgent, commitStyle } from "./settings.js";

const MOD = "ht3-panels";
// As T3 cuts them (textGenerationPrompts.ts limitSection).
export const MAX_PATCH = 40000, MAX_STAT = 8000, MAX_COMMITS = 12000, MAX_TEMPLATE = 8000;
export const ASK_MS = 60000;

// Stopped by the person (Cancel, or the popover closed): not an error to show.
export class Cancelled extends Error {
  constructor() { super("Cancelled"); this.cancelled = true; }
}

const lastLine = (r) => String(r?.stderr || r?.stdout || "").trim().split("\n").pop().replace(/^fatal: /, "");
const cut = (text, max) => (text.length > max ? { text: `${text.slice(0, max)}\n\n[truncated]`, cut: true } : { text, cut: false });
const mark = () => `@@ht3-${Math.random().toString(36).slice(2)}@@`;

// With $2 = 1: the commit template, `commit.template` (a "~/" path, an absolute one, or one relative to the folder or the repository's top), else the repository's .gitmessage.
const TEMPLATE_READ = 'if [ "$2" = 1 ]; then t=$(git config --get commit.template 2>/dev/null); top=$(git rev-parse --show-toplevel 2>/dev/null); '
  + 'case "$t" in "~/"*) t="$HOME/$(printf %s "$t" | cut -c3-)";; esac; '
  + 'for f in "$t" "$top/$t" "$top/.gitmessage"; do [ -n "$f" ] && [ -f "$f" ] && { head -c ' + MAX_TEMPLATE + ' "$f"; break; }; done; fi; ';

// What Commit would commit (`git add -A`: staged, not staged and new files alike) against HEAD, read through a
// throwaway index so the real one isn't touched. In a repository with no commit yet, against the empty tree.
// `template`: also read the repository's commit template (git config commit.template, else .gitmessage).
// -> { branch, files, summary, patch, truncated, template }
export async function commitContext({ cwd, on = null, branch = null, template = false }) {
  const sep = mark();
  const script = 'i=$(mktemp) || exit 1; cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null || rm -f "$i"; '
    + 'h=$(git rev-parse -q --verify HEAD 2>/dev/null) || h=$(git hash-object -t tree /dev/null); '
    + 'export GIT_INDEX_FILE="$i"; git add -N . 2>/dev/null; '
    + 'git diff --no-color --no-ext-diff --name-only "$h" | wc -l; printf \'%s\\n\' "$1"; '
    + `git diff --no-color --no-ext-diff --stat=120 "$h" | head -c ${MAX_STAT + 1}; printf '\\n%s\\n' "$1"; `
    + TEMPLATE_READ + `printf '\\n%s\\n' "$1"; `
    + `git diff --no-color --no-ext-diff "$h" | head -c ${MAX_PATCH + 1}; rm -f "$i"`;
  const r = await exec("sh", ["-c", script, "sh", sep, template ? "1" : "0"], { cwd, on, timeout: 20000 });
  const parts = r.stdout.split(`${sep}\n`);
  if (parts.length < 4) throw new Error(lastLine(r) || "git couldn't show the changes.");
  const files = Number(parts[0].trim()) || 0, summary = cut(parts[1].trim(), MAX_STAT), patch = cut(parts.slice(3).join(`${sep}\n`), MAX_PATCH);
  if (!files || !patch.text.trim()) throw new Error("Nothing changed: there is nothing to write a message for.");
  return { branch, files, summary: summary.text, patch: patch.text, truncated: summary.cut || patch.cut, template: parts[2].trim() };
}

// The branch against its base: the commits the base doesn't have and their diff from the merge base. The base is
// the remote's copy of the default branch when there is one. Changes that aren't committed aren't part of it.
// -> { base, branch, commits (count), log, summary, patch, template, truncated }
export async function prContext({ cwd, on = null, branch = null, base = null }) {
  const sep = mark();
  const script = 'b="$2"; r=; for c in ${b:+"origin/$b"} ${b:+"$b"} origin/main origin/master main master; do '
    + 'git rev-parse -q --verify "$c^{commit}" >/dev/null 2>&1 && r=$c && break; done; '
    + '[ -n "$r" ] || { echo "no base branch to compare with" >&2; exit 3; }; '
    + 'm=$(git merge-base HEAD "$r") || { echo "no history shared with $r" >&2; exit 3; }; '
    + 'printf \'%s\\n%s\\n\' "$r" "$1"; git rev-list --count "$m..HEAD"; printf \'%s\\n\' "$1"; '
    + `git log --no-color --format='%h %s' "$m..HEAD" | head -c ${MAX_COMMITS + 1}; printf '\\n%s\\n' "$1"; `
    + `git diff --no-color --no-ext-diff --stat=120 "$m" HEAD | head -c ${MAX_COMMITS + 1}; printf '\\n%s\\n' "$1"; `
    + 'for f in .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE.md docs/pull_request_template.md pull_request_template.md; do '
    + `[ -f "$f" ] && { head -c ${MAX_TEMPLATE} "$f"; break; }; done; printf '\\n%s\\n' "$1"; `
    + `git diff --no-color --no-ext-diff "$m" HEAD | head -c ${MAX_PATCH + 1}`;
  const r = await exec("sh", ["-c", script, "sh", sep, base ?? ""], { cwd, on, timeout: 20000 });
  const parts = r.stdout.split(`${sep}\n`);
  if (r.code === 3 || parts.length < 6) throw new Error(`Can't compare the branch: ${lastLine(r) || "git gave nothing"}.`);
  const against = parts[0].trim(), commits = Number(parts[1].trim()) || 0;
  if (!commits) throw new Error(`${branch ?? "This branch"} has no commits that ${against} doesn't have: commit first.`);
  const log = cut(parts[2].trim(), MAX_COMMITS), summary = cut(parts[3].trim(), MAX_COMMITS), patch = cut(parts.slice(5).join(`${sep}\n`), MAX_PATCH);
  return { base: against, branch, commits, log: log.text, summary: summary.text, patch: patch.text, template: parts[4].trim(), truncated: log.cut || summary.cut || patch.cut };
}

const ALONE = "Do not use any tools: everything you need is below. Reply with only the JSON object, no code fence and no other text.";

// How a commit message is written: "plain" (T3's), "conventional" (Conventional Commits) or "template" (the repository's).
// The first line of a conventional message: a type, an optional (scope), an optional ! for a breaking change, ": " and a subject.
export const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?: .+/;
export const CONVENTIONAL_TYPES = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "build", "ci"];
// null when the message's first line is a conventional one (or there is no message yet), else a line to show under the field.
export function conventionalIssue(message) {
  const first = String(message ?? "").split(/\r?\n/)[0].trim();
  if (!first || CONVENTIONAL.test(first)) return null;
  return "Not a conventional commit: the first line should look like type(scope): subject, with a type such as feat, fix, docs, refactor, test or chore. You can still commit it.";
}
// The style a prompt really uses: "template" without a template to follow is "plain".
export const effectiveStyle = (c) => (c?.style === "conventional" ? "conventional" : c?.style === "template" && String(c.template ?? "").trim() ? "template" : "plain");

// T3's buildCommitMessagePrompt, with `c.style` ("plain" by default) and, for "template", `c.template` (its text).
export function commitPrompt(c) {
  const style = effectiveStyle(c);
  const rules = {
    plain: ["- subject must be imperative, <= 72 chars, and no trailing period"],
    conventional: [
      `- subject must follow Conventional Commits: type(scope): description, where type is one of ${CONVENTIONAL_TYPES.join(", ")}`,
      "- scope is optional: a short lowercase noun for the area changed; add ! before the colon for a breaking change",
      "- the whole subject line must be imperative, <= 72 chars, and no trailing period",
    ],
    template: [
      "- the commit message must follow the repository's commit message template below: keep its format, its section headings and its trailers, and fill them in for this change",
      "- subject is the first line of the message, imperative, <= 72 chars, and no trailing period, in the format the template asks for",
      "- body is everything after the subject line, laid out the way the template lays it out",
      "- drop the template's comment lines (those starting with #) and any placeholder text you can't fill in",
    ],
  }[style];
  return [
    "You write concise git commit messages.",
    "Return a JSON object with keys: subject, body.",
    "Rules:",
    ...rules,
    "- body can be empty string or short bullet points",
    "- capture the primary user-visible or developer-visible change",
    ALONE,
    ...(style === "template" ? ["", "Commit message template:", String(c.template).trim()] : []),
    "",
    `Branch: ${c.branch ?? "(detached)"}`,
    "",
    "Changed files:",
    c.summary,
    "",
    "Patch:",
    c.patch,
  ].join("\n");
}

// T3's buildPrContentPrompt, without a thread's context.
export function prPrompt(c) {
  const rules = c.template
    ? ["- body must be markdown and follow the repository change request template structure",
      "- fill in the template sections appropriately for this change",
      "- drop HTML comments from the template in the generated body",
      "- keep the template's markdown structure"]
    : ["- body must be markdown and include headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate"];
  return [
    "You write source control change request content.",
    "Return a JSON object with keys: title, body.",
    "Rules:",
    "- title should be concise and specific",
    ...rules,
    ALONE,
    ...(c.template ? ["", "Repository change request template:", c.template] : []),
    "",
    `Base branch: ${c.base}`,
    `Head branch: ${c.branch ?? "(detached)"}`,
    "",
    "Commits:",
    c.log,
    "",
    "Diff stat:",
    c.summary,
    "",
    "Diff patch:",
    c.patch,
    "",
    "Now write the title and body for these code changes.",
  ].join("\n");
}

// The JSON object in an agent's answer: the answer itself, the inside of a code fence, or from its first { to its
// last }. null when there is none (a refusal, an apology, a question back).
export function jsonIn(answer) {
  const t = String(answer ?? "").trim(), fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(t)?.[1];
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  for (const c of [t, fence, a >= 0 && b > a ? t.slice(a, b + 1) : null]) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch {}
  }
  return null;
}

const said = (answer) => String(answer ?? "").trim().split("\n")[0].slice(0, 120);

// -> the commit message: the subject (one line, at most 72 characters, no period at its end), then the body.
export function commitFrom(answer) {
  const o = jsonIn(answer);
  let subject = String(o?.subject ?? "").trim().split(/\r?\n/)[0].trim().replace(/[.]+$/, "").trim();
  if (!subject) throw new Error(`The agent wrote no commit message${said(answer) ? `: "${said(answer)}"` : "."}`);
  if (subject.length > 72) subject = subject.slice(0, 72).trimEnd();
  const body = String(o.body ?? "").trim();
  return { subject, body, message: body ? `${subject}\n\n${body}` : subject };
}

// -> { title, body }
export function prFrom(answer) {
  const o = jsonIn(answer);
  const title = String(o?.title ?? "").trim().split(/\r?\n/)[0].trim();
  if (!title) throw new Error(`The agent wrote no title${said(answer) ? `: "${said(answer)}"` : "."}`);
  return { title, body: String(o.body ?? "").trim() };
}

// Who writes: the agent of the chat in the shown tab, on the model that chat is on; else the default agent from
// Settings (the first installed one that is on). Always on this computer: a chat that runs on another machine
// gives its kind of agent if that is installed here too. `on`: the machine the space runs on, for what the error says.
// -> { argv, set, name, from: "chat" | "settings" }; rejects when there is no agent to ask here.
export async function writer(on = null) {
  const tab = focused()?.tab, places = shared(`${MOD}.places`) ?? {};
  const chat = tab == null ? null : Object.entries(places).find(([, at]) => at?.tab === tab)?.[0] ?? null;
  let s = null;
  if (chat) try { s = JSON.parse(await readTextFile(`${appHome()}/data/${MOD}/chats/${chat}/state.json`)); } catch {}
  const mine = Array.isArray(s?.agentArgv) && s.agentArgv.length > 0;
  const nameOf = (argv) => agentOf(argv)?.name ?? String(argv[0]).split("/").pop();
  if (mine && !s.machine) {
    const model = s.configOptions?.find((o) => (o.category ?? o.id) === "model" && !o.legacyMode);
    return { argv: s.agentArgv, set: model?.currentValue != null ? { [model.id]: model.currentValue } : null, name: s.agentInfo?.title ?? s.agentInfo?.name ?? nameOf(s.agentArgv), from: "chat" };
  }
  const d = await detect(null);
  const same = mine ? agentOf(s.agentArgv) : null;
  const id = (same && argvOf(same.id, d.found) ? same.id : null) ?? firstAgent(d.found);
  const argv = id ? argvOf(id, d.found) : null;
  if (!argv) {
    throw new Error(on
      ? `No agent on this computer to write it. This space runs on ${on}, and a one-off question can only be asked of an agent here: install one, or turn one on in Settings.`
      : "No agent to write it: none is installed and turned on (Settings, Agents).");
  }
  return { argv, set: null, name: AGENTS.find((a) => a.id === id)?.name ?? nameOf(argv), from: "settings" };
}

// Writes the text. kind: "commit" | "pr". where: { cwd, on, branch, base } (the repository's folder and machine).
// after(ms): a promise that settles after that long (mods have no setTimeout: `cx.timer.after`).
// cancel: a promise that settles when the person stops it. agent: who to ask (default: writer()).
// -> commit: { message, subject, body }, pr: { title, body }; both with { agent, from, truncated, files | commits, base }.
// Rejects with Cancelled when stopped, else with one short line to show: nothing to write about, no agent, the
// agent's own error, no answer within `timeout`, or an answer that isn't the text asked for.
export async function write(kind, where, { after, cancel = new Promise(() => {}), agent = null, timeout = ASK_MS } = {}) {
  let over = null;
  cancel.then(() => { over ??= "cancel"; });
  const stopped = () => { if (over === "cancel") throw new Cancelled(); };
  const style = commitStyle();
  const c = await (kind === "pr" ? prContext(where) : commitContext({ ...where, template: style === "template" }));
  if (kind !== "pr") c.style = style;
  // A turn of the event loop, so a Cancel pressed while git ran is seen.
  await null;
  stopped();
  const who = agent ?? (await writer(where.on ?? null));
  await null;
  stopped();
  const timer = Promise.race([cancel, after(timeout).then(() => { over ??= "timeout"; })]);
  let answer = null, failed = null;
  try {
    // The agent is asked in the repository's folder when that is on this computer.
    answer = await askOnce(who.argv, where.on ? home() : where.cwd, kind === "pr" ? prPrompt(c) : commitPrompt(c), { set: who.set, timer });
  } catch (e) { failed = e; }
  stopped();
  if (over === "timeout") throw new Error(`${who.name} didn't answer within ${Math.round(timeout / 1000)} seconds.`);
  if (failed) throw new Error(`${who.name}: ${String(failed?.message ?? failed).trim().split("\n")[0].slice(0, 200)}`);
  const text = kind === "pr" ? prFrom(answer) : commitFrom(answer);
  const note = kind === "pr" || style !== "template" || effectiveStyle(c) === "template" ? null : "No commit template found (git config commit.template, or .gitmessage), so it is written plain.";
  return { ...text, note, agent: who.name, from: who.from, truncated: c.truncated, files: c.files ?? null, commits: c.commits ?? null, base: c.base ?? null };
}

// One line under the field: who wrote it, from what, and whether the agent saw all of it.
export function wroteLine(kind, r, on = null) {
  const n = (c, w) => `${c} ${w}${c === 1 ? "" : "s"}`;
  const what = kind === "pr" ? `${n(r.commits, "commit")} against ${r.base}` : n(r.files, "changed file");
  return `Written by ${r.agent}${on ? " on this computer" : ""} from ${what}${on ? ` on ${on}` : ""}.`
    + (r.truncated ? ` The diff is long: the agent saw its first ${String(MAX_PATCH).replace(/\B(?=(\d{3})+$)/g, ",")} characters.` : "")
    + (r.note ? ` ${r.note}` : "")
    + (kind === "pr" ? " Read it, change it, then Create." : " Read it, change it, then Commit.");
}
