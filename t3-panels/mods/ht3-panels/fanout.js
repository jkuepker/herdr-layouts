// One prompt to several models (T3's useMultipleModelSend.ts and its composer toggle): the same first message goes to
// two to four models, each in a background chat of its own, in a worktree of its own on a branch `<branch>-<model>`
// from one start point, so the answers can be compared (compare.js) and one kept. This file is the part with no Herdr
// in it: the names, the branches and what each chat is started with. launcher.js `fanOut` makes the worktrees and the
// chats; the New chat dialog's "Several models" and `ht3-panels.fanout:<json>` both go through it.
// Run by node: t3-panels/tests/fanout.test.mjs.

import { cleanFrom } from "./basebranch.js";

export const FANOUT_MIN = 2, FANOUT_MAX = 4;
const TITLE_MAX = 60, SLUG_MAX = 24;

const words = (text, max) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");

// A model's name as part of a branch name: git-safe and short. An id with a provider in front
// ("fleetq-tatooine-r9700-8080/Qwen3.8") gives its last part ("qwen3-8").
export function modelSlug(model) {
  const id = String(model ?? "").trim(), last = id.split("/").filter(Boolean).pop() ?? "";
  return words(last, SLUG_MAX) || words(id, SLUG_MAX) || "model";
}

// Each name once: one that is `taken`, or was given before, gets -2, -3, … (never the same as another).
export function uniqueNames(names, taken = []) {
  const used = new Set([...taken].map(String)), out = [];
  for (const name of names) {
    let n = String(name), i = 2;
    while (used.has(n)) n = `${name}-${i++}`;
    used.add(n);
    out.push(n);
  }
  return out;
}

// The models as they were given (ids, or { value, name } as settings.js knownModels has them): trimmed, each once.
export function cleanModels(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const value = String((m && typeof m === "object" ? m.value : m) ?? "").trim();
    if (!value || out.some((x) => x.value === value)) continue;
    out.push({ value, name: String((m && typeof m === "object" && m.name) || value).trim() || value });
  }
  return out;
}

// Model names typed into one field, split at commas and line ends.
export const typedModels = (text) => cleanModels(String(text ?? "").split(/[,\n]/)).map((m) => m.value);

// A tick on a model: on or off, and never more than FANOUT_MAX (a tick too many changes nothing).
export function toggleModel(picked, value) {
  const list = (picked ?? []).map(String), v = String(value);
  if (list.includes(v)) return list.filter((x) => x !== v);
  return list.length >= FANOUT_MAX ? list : [...list, v];
}

// What the chats are called before their models: the prompt's first line, cut.
export function fanoutTitle(prompt) {
  const first = String(prompt ?? "").trim().split("\n")[0].trim();
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first || "Chat";
}

// The branch the models' branches are named after when none was given: words of the title and a short unique tail.
export function fanoutBranch(title, suffix) {
  return `${words(title, 32) || "fanout"}-${String(suffix ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "x"}`;
}

// The branches, one per model: <branch>-<model slug>, each unlike the others and unlike the `taken` ones.
export function fanoutBranches(branch, models, taken = []) {
  const base = String(branch ?? "").trim().replace(/[-/.]+$/, "");
  return uniqueNames(cleanModels(models).map((m) => `${base}-${modelSlug(m.value)}`), taken);
}

// Why a fan-out can't start, as a sentence, or null.
export function fanoutProblem({ prompt, models, branch }) {
  const n = cleanModels(models).length;
  if (!String(prompt ?? "").trim()) return "Several models need a prompt to send.";
  if (n < FANOUT_MIN) return `Pick at least ${FANOUT_MIN} models.`;
  if (n > FANOUT_MAX) return `Pick at most ${FANOUT_MAX} models.`;
  if (branch != null && String(branch).trim() && !/^[\w][\w./-]*$/.test(String(branch).trim())) return `Not a branch name: ${String(branch).trim()}`;
  return null;
}

// The scripted command's argument (`fanout:<json>`): { folder, prompt, models: [...], branch?, agent?, from?, fetch? }.
// `from`: the branch (origin/<branch>, a commit) every model's worktree starts from (basebranch.js); `fetch: true`
// fetches one on origin first. -> { folder, prompt, models, branch, agent } (and from, fetch when given) or { error }.
export function parseFanout(text) {
  let o;
  try { o = JSON.parse(String(text ?? "")); } catch { return { error: "fanout takes a JSON object: {\"folder\":…,\"prompt\":…,\"models\":[…]}." }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "fanout takes a JSON object." };
  const folder = typeof o.folder === "string" ? o.folder.trim().replace(/(.)\/+$/, "$1") : "";
  if (!folder.startsWith("/") && !folder.startsWith("~")) return { error: "fanout needs \"folder\", an absolute path." };
  if (!Array.isArray(o.models)) return { error: "fanout needs \"models\", a list of model names." };
  const from = typeof o.from === "string" ? cleanFrom(o.from) : null;
  if (o.from != null && o.from !== "" && !from) return { error: "fanout's \"from\" is a branch or a commit, e.g. \"origin/main\"." };
  const out = { folder, prompt: String(o.prompt ?? "").trim(), models: cleanModels(o.models),
    branch: typeof o.branch === "string" && o.branch.trim() ? o.branch.trim() : null, agent: typeof o.agent === "string" && o.agent.trim() ? o.agent.trim() : null,
    ...(from ? { from } : {}), ...(from && o.fetch === true ? { fetch: true } : {}) };
  const why = fanoutProblem(out);
  return why ? { error: why } : out;
}

// What each model's chat is started with: { model, name, branch, title ("<title> · <model>"), prompt, set } (`set`: the
// chat's options before its first message, chat.js; "model" is found by what it is for, session.js setConfig).
// `suffix`: the tail of a branch made up here; `taken`: the repository's branches.
export function fanoutSpecs({ prompt, models, branch = null, suffix = "x", taken = [] }) {
  const list = cleanModels(models), text = String(prompt ?? "").trim(), title = fanoutTitle(text);
  const branches = fanoutBranches(branch || fanoutBranch(title, suffix), list, taken);
  return list.map((m, i) => ({ model: m.value, name: m.name, branch: branches[i], title: `${title} · ${m.name}`, prompt: text, set: { model: m.value } }));
}

// The notice after the chats were started. `started`: [{ chat, title, branch }], `failed`: [{ name, why }].
// -> { title, body, level, compare } (`compare`: the two chat ids when exactly two started, else null).
export function fanoutNotice(started, failed = []) {
  const n = started.length, lines = started.map((s) => `${s.title} (${s.branch})`);
  for (const f of failed) lines.push(`${f.name} didn't start: ${f.why}`);
  const compare = n === 2 && !failed.length ? [started[0].chat, started[1].chat] : null;
  if (compare) lines.push("Click to compare the two.");
  return { title: n ? `Started ${n} chat${n === 1 ? "" : "s"} in the background` : "Several models: nothing started",
    body: lines.join("\n"), level: failed.length ? (n ? "warning" : "error") : "info", compare };
}
