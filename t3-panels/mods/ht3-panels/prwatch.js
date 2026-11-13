// PR watch (T3's PullRequestWatchReactor, orchestration-v2): a chat whose branch has an open GitHub pull request is told,
// in a message of its own, when checks failed on it or someone commented, so its agent can fix CI unattended. Off unless
// the "prWatch" setting is on (settings.js). The keeper (main.js Buttons) calls prwatch-run.js every two seconds; that
// sweeps the open chats at most every SWEEP_MS, as T3 does (checks take minutes; faster sweeps waste the host's quota).
//
// This file is the logic, with no Herdr imports (tests/prwatch.test.mjs): what of a `gh pr view` answer is news for a
// chat, the fingerprint that keeps one piece of news from being posted twice, the message's text, and `sweep`, which does
// the reading and posting through the functions it is given (prwatch-run.js gives it Herdr's).
//
// What a chat was told is kept per chat ({ pr, head, failed, seen, fp, wakes, at }) in data/ht3-panels/prwatch.json, so a
// restart posts nothing again:
// - checks: a check that failed is told once per head commit (`failed`: the names told on `head`; a push starts over).
//   Checks still running are left out, neither failed nor passed; a pull request whose checks pass posts nothing.
// - comments: the ids seen (`seen`). The ones there when the chat's pull request is first looked at are taken as read;
//   the pull request author's own (the agent's, through the person's gh) never count. Edits are not news.
// - only an open pull request is read into; a merged or closed one is forgotten.

export const SWEEP_MS = 2 * 60 * 1000;
// T3's PULL_REQUEST_WATCH_WAKE_LIMIT: after this many comment-only messages in a row (a bot answering the agent's
// answers) comments stop being posted until a push or a failed check.
export const WAKE_LIMIT = 10;
export const PR_FIELDS = "number,url,state,headRefOid,baseRefName,author,statusCheckRollup,comments,reviews";
const LISTED = 10, SNIPPET = 200, SEEN_KEPT = 400, KEPT_MS = 30 * 24 * 3600 * 1000, READS = 4;

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const login = (a) => String(a?.login ?? "").toLowerCase();

// statusCheckRollup's check runs (status, conclusion, name) and commit statuses (state, context), as pr.js checkOf
// reads them: -> [{ name, tone: "bad" | "ok" | "wait", word, url }].
export function checksOf(pr) {
  return (Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : []).map((c) => {
    const raw = String(c?.conclusion || c?.state || c?.status || "").toUpperCase();
    return { name: String(c?.name ?? c?.context ?? "check"), tone: FAILED.has(raw) ? "bad" : PASSED.has(raw) ? "ok" : "wait",
      word: raw.toLowerCase().replace(/_/g, " "), url: c?.detailsUrl ?? c?.targetUrl ?? null };
  });
}
// The checks that failed, one per name (a matrix can name two alike), by name.
export function failedChecks(pr) {
  const by = new Map();
  for (const c of checksOf(pr)) if (c.tone === "bad" && !by.has(c.name)) by.set(c.name, c);
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// What people said on the pull request: its comments, its reviews (one that only carries line comments says nothing
// itself) and, when they were read (`inline`: `gh api repos/{owner}/{repo}/pulls/<n>/comments`), the comments on lines.
// -> [{ id, author, body, path, url, at, state }], oldest first.
export function remarksOf(pr, inline = []) {
  const out = [];
  for (const c of Array.isArray(pr?.comments) ? pr.comments : []) {
    if (c?.id == null) continue;
    out.push({ id: `c:${c.id}`, author: c.author?.login ?? null, body: String(c.body ?? ""), path: null, url: c.url ?? null, at: c.createdAt ?? "", state: null });
  }
  for (const r of Array.isArray(pr?.reviews) ? pr.reviews : []) {
    const state = String(r?.state ?? "").toUpperCase(), body = String(r?.body ?? "");
    if (r?.id == null || state === "PENDING" || (!body.trim() && (state === "COMMENTED" || state === ""))) continue;
    out.push({ id: `r:${r.id}`, author: r.author?.login ?? null, body, path: null, url: r.url ?? null, at: r.submittedAt ?? "", state: state.toLowerCase().replace(/_/g, " ") });
  }
  for (const c of Array.isArray(inline) ? inline : []) {
    if (c?.id == null) continue;
    out.push({ id: `l:${c.id}`, author: c.user?.login ?? null, body: String(c.body ?? ""), path: c.path ?? null, url: c.html_url ?? null, at: c.created_at ?? "", state: null });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// One piece of news as a string: the head commit, the failed checks' names and the comments' ids. The same news has
// the same fingerprint whatever order the host lists it in; no news has "".
export function fingerprint({ head = "", failed = [], remarks = [] } = {}) {
  const names = [...new Set(failed.map((c) => (typeof c === "string" ? c : c.name)))].sort();
  const ids = [...new Set(remarks.map((r) => (typeof r === "string" ? r : r.id)))].sort();
  if (!names.length && !ids.length) return "";
  return JSON.stringify([names.length ? String(head ?? "") : "", names, ids]);
}

// What is news for a chat. `saved`: what it was told so far (null: never looked at); `pr`: `gh pr view --json PR_FIELDS`;
// `inline`: the line comments, or null when they couldn't be read. -> { post, next }: `post` is null or { number, url,
// base, head, failed: [check], remarks: [remark], fp }, `next` what to keep (null: forget the chat, its pull request
// is no longer open).
export function evaluate(saved, pr, inline = null, now = Date.now()) {
  if (!pr || String(pr.state ?? "").toUpperCase() !== "OPEN" || pr.number == null) return { post: null, next: null };
  const first = !saved || saved.pr !== pr.number;
  const had = first ? { failed: [], seen: [], fp: "", wakes: 0, head: null } : saved;
  const head = pr.headRefOid ?? had.head ?? null, moved = head !== had.head;

  // A read with no checks at all can be a failed read: what was told stays.
  const told = moved ? [] : (had.failed ?? []);
  const failed = failedChecks(pr), fresh = failed.filter((c) => !told.includes(c.name));
  const toldNow = [...told, ...fresh.map((c) => c.name)];

  const own = login(pr.author), seen = new Set(had.seen ?? []);
  const all = remarksOf(pr, inline ?? []);
  const unseen = all.filter((r) => !seen.has(r.id));
  // Taken as read: everything there at the first look, and the author's own.
  const news = first ? [] : unseen.filter((r) => !own || login({ login: r.author }) !== own);
  const seenNow = [...(had.seen ?? []), ...unseen.map((r) => r.id)].slice(-SEEN_KEPT);

  const progress = moved || fresh.length > 0;
  const quiet = !progress && (had.wakes ?? 0) >= WAKE_LIMIT;
  const remarks = quiet ? [] : news;
  const fp = fingerprint({ head, failed: fresh, remarks });
  const post = fp && fp !== had.fp ? { number: pr.number, url: pr.url ?? "", base: pr.baseRefName ?? "", head, failed: fresh, remarks, fp } : null;
  const wakes = progress ? 0 : (had.wakes ?? 0) + (post ? 1 : 0);
  return { post, next: { pr: pr.number, head, failed: toldNow, seen: seenNow, fp: post ? fp : (had.fp ?? ""), wakes, at: now } };
}

const snippet = (body) => {
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET) return text;
  // Half an emoji is a lone surrogate, which an agent's JSON parser may reject.
  const last = text.charCodeAt(SNIPPET - 4);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? SNIPPET - 4 : SNIPPET - 3)}...`;
};
const listed = (items, line) => [...items.slice(0, LISTED).map(line), ...(items.length > LISTED ? [`  - and ${items.length - LISTED} more`] : [])];

// The message a chat gets for `post` (evaluate's), as T3's pullRequestWatchMessage words it.
export function message(post) {
  const commit = post.head ? ` on ${String(post.head).slice(0, 7)}` : "", n = post.remarks.length;
  return [
    `Update on pull request #${post.number}${post.url ? ` (${post.url})` : ""}, which Herdr is watching for you:`,
    ...(post.failed.length ? [`- Checks failed${commit}:`, ...listed(post.failed, (c) => `  - ${c.name}${c.word && c.word !== "failure" ? ` (${c.word})` : ""}${c.url ? ` ${c.url}` : ""}`)] : []),
    ...(n ? [`- ${n} new ${n === 1 ? "comment" : "comments"}:`, ...listed(post.remarks, (r) => {
      const body = snippet(r.body);
      return `  - ${r.author ?? "someone"}${r.path ? ` on ${r.path}` : ""}: ${body ? `"${body}"` : (r.state ?? "reviewed")}${r.url ? ` ${r.url}` : ""}`;
    })] : []),
    "",
    `Look into each item and act on it as your task requires${post.failed.length ? " (`gh run view <run id> --log-failed` shows a failed job's log)" : ""}. The pull request stays watched: end your turn when you are done, and Herdr tells you of the next failed check or comment.`,
  ].join("\n");
}

// Whether a sweep is due: the setting is on, none runs, and the last one began at least SWEEP_MS ago.
export function sweepDue({ on, running = false, last = 0, now = Date.now(), every = SWEEP_MS } = {}) {
  if (!on || running) return false;
  const at = Number(last) || 0;
  return at <= 0 || at > now || now - at >= every;
}

// The saved map without the chats not looked at for a month.
export function pruned(state, now = Date.now()) {
  return Object.fromEntries(Object.entries(state ?? {}).filter(([, s]) => s && typeof s === "object" && now - (Number(s.at) || 0) < KEPT_MS));
}

// ---- reading and posting, through what it is given ----

// The pull request of the branch checked out in `cwd` (on machine `on`): -> { pr, inline } or { none: true } (the branch
// has none) or { error: "<gh's first line>" }. `exec` is Herdr's: (program, args, { cwd, on, timeout }) -> { code, stdout, stderr }.
export async function readPr(exec, cwd, on = null) {
  const at = { cwd, on: on ?? undefined, timeout: 25000 };
  let r;
  try { r = await exec("gh", ["pr", "view", "--json", PR_FIELDS], at); } catch (e) { return { error: String(e?.message ?? e).split("\n")[0] }; }
  if (r.code !== 0) {
    const why = String(r.stderr || r.stdout || "").trim();
    return /no pull requests? found|no open pull requests/i.test(why) ? { none: true } : { error: why.split("\n")[0] || "gh failed" };
  }
  let pr;
  try { pr = JSON.parse(r.stdout); } catch { return { error: "gh answered with no JSON" }; }
  if (String(pr?.state ?? "").toUpperCase() !== "OPEN") return { pr, inline: null };
  // The comments on lines aren't in `gh pr view`. Best effort: without them the reviews' own words still come.
  let inline = null;
  try {
    const c = await exec("gh", ["api", `repos/{owner}/{repo}/pulls/${pr.number}/comments?per_page=100`], at);
    if (c.code === 0) { const list = JSON.parse(c.stdout); if (Array.isArray(list)) inline = list; }
  } catch {}
  return { pr, inline };
}

// One sweep. `chats`: [{ id, cwd, on }], the chats to look at; `load()` -> the saved map; `save(map)`; `post(chat id, text)`.
// Chats in one folder share one read. A chat whose folder can't be read keeps what it was told.
// -> { chats, prs, posted: [{ chat, number, failed, remarks }], errors: [text] }.
export async function sweep({ exec, chats, load, save, post, now = Date.now() }) {
  const folders = new Map();
  for (const c of chats ?? []) {
    if (!c?.id || !c.cwd) continue;
    const key = `${c.on ?? ""}\n${c.cwd}`;
    folders.set(key, { cwd: c.cwd, on: c.on ?? null, chats: [...(folders.get(key)?.chats ?? []), c.id] });
  }
  const todo = [...folders.values()], reads = new Map();
  await Promise.all(Array.from({ length: Math.min(READS, todo.length) }, async () => {
    for (let f; (f = todo.pop());) reads.set(f, await readPr(exec, f.cwd, f.on));
  }));
  // Read after the host was asked, so what another sweep kept meanwhile isn't lost.
  const state = pruned(await load(), now), out = { chats: 0, prs: 0, posted: [], errors: [] };
  const before = JSON.stringify(state), seenPrs = new Set(), posts = [];
  for (const [f, got] of reads) {
    out.chats += f.chats.length;
    if (got.error) { out.errors.push(`${f.cwd}: ${got.error}`); continue; }
    if (got.none) continue;
    for (const chat of f.chats) {
      const { post: news, next } = evaluate(state[chat] ?? null, got.pr, got.inline, now);
      if (next) { state[chat] = next; seenPrs.add(`${f.on ?? ""}\n${got.pr.url ?? got.pr.number}`); } else delete state[chat];
      if (news) posts.push({ chat, news });
    }
  }
  out.prs = seenPrs.size;
  // Kept before anything is posted: a post that was kept but not sent is lost, one sent but not kept would come twice.
  if (JSON.stringify(state) !== before) await save(state);
  for (const { chat, news } of posts) {
    post(chat, message(news));
    out.posted.push({ chat, number: news.number, failed: news.failed.length, remarks: news.remarks.length });
  }
  return out;
}

// What a sweep found, in a line (the `prwatch:now` notice).
export function summary(out) {
  const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const failed = out.posted.reduce((a, p) => a + p.failed, 0), remarks = out.posted.reduce((a, p) => a + p.remarks, 0);
  const told = out.posted.length
    ? `told ${n(out.posted.length, "chat")} (${[failed ? n(failed, "failed check") : "", remarks ? n(remarks, "new comment") : ""].filter(Boolean).join(", ")}: ${[...new Set(out.posted.map((p) => `#${p.number}`))].join(", ")})`
    : "nothing new";
  return `${n(out.chats, "chat")}, ${n(out.prs, "open pull request")}: ${told}${out.errors.length ? `. ${n(out.errors.length, "folder")} couldn't be read: ${out.errors[0]}` : ""}`;
}
