// T3 Code's Pull request and Linked pull requests surfaces, through the GitHub CLI.
// - "Pull request" (props.panel "pr"): the pull request of the shown space's branch, from
//   `gh pr view` run in its folder: title, state, branches, checks, reviews, description, and a
//   button that opens it in the browser.
// - "Linked pull requests" (props.panel "prs"): the open pull requests you authored in the
//   repository (`gh pr list --author @me`), the branch's own marked; a click opens one.
// Reads only. Without `gh`, without a sign-in, a GitHub remote or a pull request, it says so.
// - "Start chat from PR" (T3's PullRequestThreadDialog; both surfaces, and `ht3-panels.prChat`, which asks for a number
//   or an address): the pull request's head in a worktree of its own, <repo>/.worktrees/pr-<number>, and a chat there
//   with the pull request (title, description, reviews, open review threads, comments) in its message box, not sent.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import { exec, run, notify, focused, openOverlay, closeOverlay } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, badge } from "./look.js";
import { activeSpace, placeOf, showing } from "./side.js";
import { repoOf, addWorktree, setupWorktree } from "./launcher.js";
import { AGENTS, detect } from "./agent-acp.js";
import { firstAgent } from "./settings.js";

const FIELDS = "number,title,state,isDraft,url,author,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup,reviews,additions,deletions,changedFiles,body,updatedAt";
const LIST_FIELDS = "number,title,state,isDraft,url,author,headRefName,reviewDecision,statusCheckRollup,updatedAt";

// What went wrong, in words: gh missing, not signed in, no remote, no pull request. Herdr's exec
// rejects with "cannot run gh: No such file or directory (os error 2)" here and "cannot start gh: …"
// on another machine when the program is missing.
export function explain(err, branch, on = null) {
  const text = String(err?.message ?? err ?? "");
  if (/ENOENT|not found|No such file|can't start|cannot start|failed to spawn/i.test(text) && !/pull request/i.test(text)) return { kind: "missing", text: `The GitHub CLI (gh) isn't installed ${on ? `on ${on}` : "here"}. Install it from cli.github.com, then sign in with gh auth login.` };
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401/i.test(text)) return { kind: "auth", text: "gh isn't signed in. Run gh auth login in a terminal." };
  if (/no pull requests? found|could not find any pull request/i.test(text)) return { kind: "none", text: branch ? `No pull request for ${branch} yet.` : "No pull request for this branch yet." };
  if (/none of the git remotes|no git remotes|not a git repository|not a github|could not determine|unknown owner|Could not resolve to a Repository/i.test(text)) return { kind: "remote", text: "This folder has no GitHub repository to ask about." };
  return { kind: "error", text: text.trim().split("\n")[0] || "gh failed." };
}

// A pull request's tone: open green, draft grey, merged purple, closed red.
export function prState(pr, k) {
  if (pr.state === "MERGED") return { label: "Merged", glyph: "git-merge", color: "#a855f7" };
  if (pr.state === "CLOSED") return { label: "Closed", glyph: "git-pull-request-closed", color: k.destructiveText };
  if (pr.isDraft) return { label: "Draft", glyph: "git-pull-request-draft", color: k.muted };
  return { label: "Open", glyph: "git-pull-request", color: k.successText };
}

// statusCheckRollup holds check runs (status, conclusion, name) and commit statuses (state, context).
export function checkOf(c) {
  const name = c.name ?? c.context ?? "check";
  const raw = (c.conclusion || c.state || c.status || "").toUpperCase();
  const ok = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(raw), bad = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(raw);
  return { name, group: c.workflowName ?? null, url: c.detailsUrl ?? c.targetUrl ?? null, tone: ok ? "ok" : bad ? "bad" : "wait", raw: raw.toLowerCase().replace(/_/g, " ") || "pending" };
}
export function checksOf(pr) {
  return (pr.statusCheckRollup ?? []).map(checkOf);
}

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const open = (url) => exec("open", [url]).catch(() => {});

// ---- Start chat from PR (T3's PullRequestThreadDialog and usePullRequestDraftThread) ----

const CHAT_FIELDS = "number,title,body,url,state,isDraft,author,headRefName,baseRefName,isCrossRepository,additions,deletions,changedFiles,reviews,comments";
// A pull request's review threads: where each is (path and line), whether it was resolved, and what was said in it.
const THREADS = "query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){totalCount nodes{isResolved isOutdated path line originalLine comments(first:30){totalCount nodes{author{login} body}}}}}}}";
// The seeded message is cut to this many characters, a description to DESC_MAX and one comment to SAID_MAX.
export const PROMPT_MAX = 16000;
const DESC_MAX = 6000, SAID_MAX = 1200;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const lastLine = (text) => String(text ?? "").trim().split("\n").pop().replace(/^(fatal|error): /, "");

// "123", "#123" or a pull request's address -> { number } or { number, host, owner, repo, url }; null for anything else.
export function parsePrRef(text) {
  const s = String(text ?? "").trim();
  const url = s.match(/^(?:https?:\/\/)?([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (url) return { number: Number(url[4]), host: url[1], owner: url[2], repo: url[3], url: `https://${url[1]}/${url[2]}/${url[3]}/pull/${url[4]}` };
  const n = s.match(/^#?(\d+)$/);
  return n ? { number: Number(n[1]) } : null;
}

// The message a chat from a pull request starts with: what it is, its description, the reviews that say something, the
// review threads still open (each under its path:line; resolved ones are left out and counted), and the comments.
// `threads`: the reviewThreads of THREADS ({ totalCount, nodes }), or null when they couldn't be read.
// Never longer than `max`: long texts are shortened, what doesn't fit is left out, and a line at the end says so.
export function prPrompt(pr, threads = null, { max = PROMPT_MAX } = {}) {
  let cut = false;
  const clip = (text, n) => {
    const s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
    if (s.length <= n) return s;
    cut = true;
    return `${s.slice(0, n).trimEnd()} […]`;
  };
  const who = (a) => a?.login ?? "someone";
  const quote = (text) => text.split("\n").map((l) => `  ${l}`).join("\n").trimStart();
  const head = [`Pull request #${pr.number}: ${clip(pr.title, 300)}`, pr.url,
    `${pr.headRefName} → ${pr.baseRefName} · by ${who(pr.author)} · +${pr.additions ?? 0} −${pr.deletions ?? 0} in ${pr.changedFiles ?? 0} file${pr.changedFiles === 1 ? "" : "s"}${pr.state && pr.state !== "OPEN" ? ` · ${pr.state.toLowerCase()}` : pr.isDraft ? " · draft" : ""}`,
    "Its head is checked out in this folder, a worktree of its own."].filter(Boolean).join("\n");
  const body = clip(pr.body, Math.min(DESC_MAX, Math.floor(max / 3)));
  const reviews = (pr.reviews ?? []).filter((r) => String(r.body ?? "").trim() && r.state !== "PENDING")
    .map((r) => `- ${who(r.author)} (${String(r.state ?? "commented").toLowerCase().replace(/_/g, " ")}): ${quote(clip(r.body, SAID_MAX))}`);
  const nodes = threads?.nodes ?? [], open = nodes.filter((t) => !t.isResolved), resolved = nodes.length - open.length;
  // The threads on lines that are still in the diff come first.
  const spots = [...open.filter((t) => !t.isOutdated), ...open.filter((t) => t.isOutdated)].map((t) => {
    const said = t.comments?.nodes ?? [], more = (t.comments?.totalCount ?? said.length) - said.length;
    if (more > 0) cut = true;
    return [`### ${t.path}${t.line ?? t.originalLine ? `:${t.line ?? t.originalLine}` : ""}${t.isOutdated ? " (outdated)" : ""}`,
      ...said.map((c) => `- ${who(c.author)}: ${quote(clip(c.body, SAID_MAX))}`), ...(more > 0 ? [`- (${more} more in this thread)`] : [])].join("\n");
  });
  const comments = (pr.comments ?? []).filter((c) => String(c.body ?? "").trim()).map((c) => `- ${who(c.author)}: ${quote(clip(c.body, SAID_MAX))}`);
  const unread = (threads?.totalCount ?? nodes.length) - nodes.length;

  // Each part in its place while there is room; 240 characters are held back for the line that says what was cut.
  const room = max - 240;
  let out = head;
  if (body) out += `\n\n## Description\n${body}`;
  const fit = (title, items, gap) => {
    let n = 0, text = "";
    for (const it of items) {
      const next = `${text}${n ? gap : ""}${it}`;
      if (out.length + title.length + 4 + next.length > room) break;
      text = next;
      n += 1;
    }
    if (n) out += `\n\n${title}\n${text}`;
    if (n < items.length) cut = true;
    return n;
  };
  const shown = {
    reviews: fit("## Reviews", reviews, "\n"),
    threads: fit(`## Open review threads${resolved ? ` (${resolved} resolved left out)` : ""}`, spots, "\n\n"),
    comments: fit("## Comments", comments, "\n"),
  };
  if (threads == null) out += "\n\n(The review threads couldn't be read from GitHub.)";
  if (cut || unread > 0) {
    const left = [reviews.length > shown.reviews ? `${shown.reviews} of ${reviews.length} reviews` : null,
      spots.length > shown.threads || unread > 0 ? `${shown.threads} of ${spots.length + Math.max(0, unread)} open review threads` : null,
      comments.length > shown.comments ? `${shown.comments} of ${comments.length} comments` : null].filter(Boolean);
    out += `\n\n(Cut to fit the message box: ${left.length ? `${left.join(", ")} are here; ` : ""}long texts are shortened at […]. \`gh pr view ${pr.number} --comments\` shows the rest.)`;
  }
  return `${out.slice(0, max - 2)}\n\n`;
}

// What went wrong starting a chat from a pull request, in words; else what explain() says.
function explainChat(err, number, on) {
  const text = String(err?.message ?? err ?? "");
  if (/Could not resolve to a PullRequest|no pull requests? found/i.test(text)) return `There is no pull request #${number} in this folder's GitHub repository.`;
  if (/Could not resolve to a Repository|Repository not found|Permission denied|could not read from remote|Authentication failed|HTTP 40[34]|SAML/i.test(text) && !/gh auth login/.test(text))
    return `GitHub won't show pull request #${number} to you: the repository or the fork it comes from is private, or you have no access to it.`;
  return explain(err, null, on).text;
}

// The remote of `repo` that is the GitHub repository owner/name, by its address; null when none is.
async function remoteOf(repo, on, at) {
  const r = await exec("git", ["remote", "-v"], { cwd: repo, on: on ?? undefined, timeout: 10000 }).catch(() => null);
  const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const want = new RegExp(`[:/]${esc(at.owner)}/${esc(at.repo)}(\\.git)?/?$`, "i");
  for (const line of String(r?.stdout ?? "").split("\n")) { const [name, url] = line.split(/\s+/); if (url && want.test(url)) return name; }
  return null;
}

// The pull request's head in a worktree of its own, <repo>/.worktrees/pr-<number> on the branch pr-<number>
// (launcher.js addWorktree, which also keeps `.worktrees/` out of git). -> { dir, reused }.
// A folder that is there already is used as it is, and so is a branch pr-<number> left from an earlier time (it may
// hold work). Else `gh pr checkout` puts the head on the new branch, and where it can't (a fork, no gh), git fetches
// pull/<number>/head from `remote`, as T3 does. If neither works the new worktree and its branch are taken away again.
// A new worktree then gets the project's setup script; a cancelled setup rejects, and the worktree stays.
export async function prWorktree(repo, number, on = null, { remote = "origin", target = String(number) } = {}) {
  const branch = `pr-${number}`, dir = `${repo}/.worktrees/${branch}`, at = { cwd: repo, on: on ?? undefined, timeout: 60000 };
  if ((await exec("test", ["-d", dir], { on: on ?? undefined }).catch(() => null))?.code === 0) return { dir, reused: true };
  try { await addWorktree(repo, branch, on, { setup: false }); }
  catch (e) {
    if (!/already exists/i.test(String(e?.message ?? e))) throw new Error(`Couldn't make the worktree: ${String(e?.message ?? e)}`);
    const r = await exec("git", ["worktree", "add", dir, branch], at);
    if (r.code !== 0) throw new Error(`Couldn't make the worktree: ${lastLine(r.stderr || r.stdout)}`);
    return { dir, reused: true };
  }
  const here = { cwd: dir, on: on ?? undefined, timeout: 180000 };
  const gh = await exec("gh", ["pr", "checkout", target, "--branch", branch, "--force"], here).catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));
  // The project's setup script (launcher.js setupWorktree) runs once the pull request's files are there.
  const ready = async () => { await setupWorktree(repo, dir, on); return { dir, reused: false }; };
  if (gh.code === 0) return ready();
  const got = await exec("sh", ["-c", 'git fetch "$1" "pull/$2/head" && git reset --hard FETCH_HEAD', "sh", remote, String(number)], here).catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));
  if (got.code === 0) return ready();
  await exec("sh", ["-c", 'git worktree remove --force "$1"; git branch -D "$2"', "sh", dir, branch], at).catch(() => null);
  const why = `${got.stderr || got.stdout}`;
  if (/couldn't find remote ref|could not find remote ref/i.test(why)) throw new Error(`Pull request #${number} isn't on ${remote}: nothing to check out.`);
  if (/Repository not found|Permission denied|could not read from remote|Authentication failed/i.test(why)) throw new Error(`Couldn't fetch pull request #${number} from ${remote}: you have no access to it (a private repository or fork), or git isn't signed in.`);
  throw new Error(`Couldn't check out pull request #${number}: ${lastLine(why) || lastLine(gh.stderr) || "git failed."}`);
}

// Start chat from PR. `text`: a number or an address; `cwd`, `on`: the folder asked from and its machine.
// Asks GitHub (gh, on that machine), makes or reuses the worktree, and opens a chat tab there on the agent New chat
// comes up with (settings.js firstAgent), with the pull request in its message box (`seed`: set, not sent).
// `say(text)`: what it is doing. Resolves to { number, dir, reused, text }; rejects with what went wrong, in words.
export async function startPrChat(text, { cwd, on = null, space = focused()?.space, say = () => {} } = {}) {
  const ref = parsePrRef(text);
  if (!ref) throw new Error("Give a pull request's number (123) or its address on GitHub.");
  if (!cwd) throw new Error("No folder: focus a terminal of the project first.");
  const repo = await repoOf(cwd, on);
  if (!repo) throw new Error("This folder isn't in a Git repository.");
  const found = await detect(on);
  const agent = AGENTS.find((a) => a.id === firstAgent(found.found));
  if (!agent) throw new Error(found.error ?? "No chat agent is installed and turned on (Settings).");
  say(`Asking GitHub about #${ref.number}…`);
  const opts = { cwd: repo, on: on ?? undefined, timeout: 30000 };
  let pr;
  try {
    const r = await exec("gh", ["pr", "view", ref.url ?? String(ref.number), "--json", CHAT_FIELDS], opts);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    pr = JSON.parse(r.stdout);
  } catch (e) { throw new Error(explainChat(e, ref.number, on)); }
  const at = parsePrRef(pr.url) ?? ref;
  const remote = at.owner ? await remoteOf(repo, on, at) : null;
  if (ref.url && !remote) throw new Error(`That pull request is in ${at.owner}/${at.repo}, which is no remote of this folder's repository.`);
  // The review threads are extra: without them the chat still starts, and the message says they are missing.
  let threads = null;
  if (at.owner) {
    const r = await exec("gh", ["api", "graphql", ...(at.host && at.host !== "github.com" ? ["--hostname", at.host] : []), "-f", `query=${THREADS}`, "-F", `owner=${at.owner}`, "-F", `repo=${at.repo}`, "-F", `n=${pr.number}`], opts).catch(() => null);
    try { threads = r?.code === 0 ? JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads : null; } catch {}
  }
  say(`Checking out #${pr.number} into .worktrees/pr-${pr.number}…`);
  const wt = await prWorktree(repo, pr.number, on, { remote: remote ?? "origin", target: pr.url ?? String(pr.number) });
  run("tab.new", { mod: MOD, ...(space ? { space } : {}), name: `PR #${pr.number}`,
    props: { panel: "chat", chat: newId(), agent: [found.found[agent.argv[0]], ...agent.argv.slice(1)], cwd: wt.dir, machine: on, seed: prPrompt(pr, threads) } });
  const done = wt.reused ? `Reused the worktree .worktrees/pr-${pr.number}, as it was: #${pr.number} is in the new chat's message box.` : `#${pr.number} is checked out in .worktrees/pr-${pr.number} and written into the new chat's message box.`;
  return { number: pr.number, dir: wt.dir, reused: wt.reused, text: done };
}

// `ht3-panels.prChat`: asks for the pull request (the dialog below); `ht3-panels.prChat:<number or address>` starts at once
// and says how it went in a notification.
export function prChatCommand(ref) {
  if (!String(ref ?? "").trim()) return openOverlay({ mod: MOD, kind: "dialog", width: 512, height: 264, props: { menu: "prchat" } });
  const { cwd, on } = placeOf(activeSpace());
  startPrChat(ref, { cwd, on }).then(
    (r) => notify({ title: r.reused ? `Reused the worktree pr-${r.number}` : `Chat from pull request #${r.number}`, body: r.text, level: "success" }),
    (e) => notify({ title: "Start chat from PR", body: String(e?.message ?? e), level: "error" }));
}

// The dialog of `ht3-panels.prChat` (T3's dialog sizes, as launcher.js): a field for the number or the address, and what
// is being done or went wrong under it. It closes once the chat is open.
export class PrChatDialog {
  init(p, cx) {
    this.overlay = p.overlay;
    const { cwd, on } = placeOf(activeSpace());
    this.cwd = cwd;
    this.on = on;
    this.busy = false;
    this.note = null; // { text, bad }
    this.field = InputState.new({ placeholder: "123, or https://github.com/owner/repo/pull/123" });
    this.field.on("change", (_e, cx) => cx.notify());
    this.field.on("submit", (_e, cx) => this.go(cx));
    this.field.focus();
    cx.timer.after(300, () => this.field.focus());
  }
  close() {}
  // For scripts: pr:<number or address> (types it into the field), pr-start (the Start chat button).
  command(c, cx) {
    if (c.startsWith("pr:")) this.field.set_value(c.slice(3));
    if (c === "pr-start") this.go(cx);
    cx.notify();
  }
  go(cx) {
    const text = this.field.value().trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.note = { text: "Starting…" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await startPrChat(text, { cwd: this.cwd, on: this.on, say: (t) => { this.note = { text: t }; cx.notify(); } });
        if (r.reused) notify({ title: `Reused the worktree pr-${r.number}`, body: r.text, level: "info" });
        return closeOverlay(this.overlay);
      } catch (e) { this.note = { text: String(e?.message ?? e), bad: true }; }
      this.busy = false;
      cx.notify();
    });
  }
  render(_cx) {
    const k = tokens();
    return v_flex().id("ht3-prchat").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(v_flex().px(24).pt(24).pb(8).gap(8).flex_none()
        .child(div().text_size(20).font_semibold().child("Start chat from PR"))
        .child(div().text_size(14).text_color(k.muted).child("The pull request's head is checked out in a worktree of its own, .worktrees/pr-<number>, and a chat starts there with the pull request in its message box.")))
      .child(v_flex().flex_1().min_h(0).px(24).gap(8)
        .child(div().h(32).px(11).rounded(8).border(1).border_color(k.input).text_size(14).child(Input.new(this.field)))
        .when(!!this.note, (el) => el.child(div().text_size(12).line_height("16px").text_color(this.note.bad ? k.destructiveText : k.muted).child(this.note.text))))
      .child(h_flex().px(24).py(16).gap(8).flex_none().justify_end().border_t(1).border_color(k.border)
        .child(button(k, "cancel", "Cancel", () => closeOverlay(this.overlay), { variant: "outline", size: "default" }))
        .child(button(k, "start", this.busy ? "Starting…" : "Start chat", (cx) => this.go(cx), { variant: "default", size: "default", disabled: this.busy || !this.field.value().trim() })));
  }
}

export class PrPanel {
  constructor(linked) { this.linked = linked; }

  init(p, cx) {
    this.group = p.group ?? "a";
    this.stale = false;
    this.seen = null;
    this.cwd = null;
    this.on = null;
    this.branch = null;
    this.data = null; // a pull request, or a list
    this.problem = null;
    this.loading = false;
    this.chat = null; // Start chat from PR: { busy, text, bad }, the line under the title
    this.follow(cx);
    // Asks GitHub only while its tab shows; back in view, it asks at once.
    cx.timer.every(30000, (cx) => { if (showing(this.group, this.linked ? "prs" : "pr")) this.load(cx); else this.stale = true; });
  }
  close() {}
  command() {}

  follow(cx) {
    const sp = activeSpace(), where = placeOf(sp);
    const key = `${where.on ?? ""}|${where.cwd ?? ""}|${sp?.branch ?? ""}`;
    if (key === this.seen || !where.cwd) return;
    this.seen = key;
    this.cwd = where.cwd;
    this.on = where.on;
    this.branch = sp?.branch ?? null;
    this.data = null;
    this.problem = null;
    this.chat = null;
    this.load(cx);
  }

  // Start chat from PR: what it is doing, then what it did (a reused worktree is said) or why it couldn't.
  startChat(cx, number) {
    if (this.chat?.busy) return;
    const seen = this.seen, set = (chat) => { if (this.seen === seen) { this.chat = chat; cx.notify(); } };
    set({ busy: true, text: `Starting a chat from #${number}…` });
    cx.spawn(async () => {
      try { set({ text: (await startPrChat(String(number), { cwd: this.cwd, on: this.on, say: (text) => set({ busy: true, text }) })).text }); }
      catch (e) { set({ text: String(e?.message ?? e), bad: true }); }
    });
  }
  chatLine(k) {
    return h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6)).text_size(12).line_height("16px").text_color(this.chat.bad ? k.destructiveText : k.muted)
      .child(div().flex_1().min_w(0).child(this.chat.text))
      .when(!this.chat.busy, (el) => el.child(iconButton(k, "pr-chat-x", "x", (cx) => { this.chat = null; cx.notify(); }, { size: "micro", tip: "Dismiss" })));
  }

  load(cx) {
    if (!this.cwd || this.loading) return;
    const seen = this.seen, cwd = this.cwd, on = this.on;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const args = this.linked ? ["pr", "list", "--author", "@me", "--state", "open", "--limit", "30", "--json", LIST_FIELDS] : ["pr", "view", "--json", FIELDS];
        const r = await exec("gh", args, { cwd, on, timeout: 25000 });
        if (this.seen !== seen) return;
        if (r.code !== 0) { this.data = null; this.problem = explain(r.stderr || r.stdout, this.branch, on); }
        else {
          this.data = JSON.parse(r.stdout || "null") ?? (this.linked ? [] : null);
          this.problem = this.data ? null : { kind: "error", text: "gh answered with nothing." };
        }
      } catch (e) {
        if (this.seen !== seen) return;
        this.data = null;
        this.problem = explain(e, this.branch, on);
        // A folder that is gone fails the same way as a missing gh.
        if (this.problem.kind === "missing" && (await exec("test", ["-d", cwd], { on }).catch(() => null))?.code === 1) this.problem = { kind: "folder", text: `The folder ${cwd} is gone.` };
      // The folder or the branch changed while it asked: what came back was dropped, so it asks again (render).
      } finally { this.loading = false; if (this.seen !== seen) this.stale = true; cx.notify(); }
    });
  }

  tone(k, t) { return t === "ok" ? k.successText : t === "bad" ? k.destructiveText : k.warningText; }

  checkIcon(k, c) {
    const g = c.tone === "ok" ? "circle-check" : c.tone === "bad" ? "circle-x" : "circle-dashed";
    return icon(g).size(14).flex_none().text_color(this.tone(k, c.tone));
  }

  head(k, title) {
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
      .child(icon(this.linked ? "git-pull-request-arrow" : "git-pull-request").size(14).flex_none().text_color(k.muted))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_size(13).child(title))
      .child(iconButton(k, "pr-refresh", "refresh-cw", (cx) => this.load(cx), { tip: this.loading ? "Refreshing…" : "Refresh" }));
  }

  empty(k, text, color = k.muted) {
    return v_flex().flex_1().items_center().justify_center().px(24).gap(8).text_size(12).line_height("18px").text_center().text_color(color).child(text);
  }

  render(cx) {
    this.follow(cx);
    if (this.stale) { this.stale = false; this.load(cx); }
    const k = tokens();
    const root = v_flex().id(this.linked ? "ht3-prs" : "ht3-pr").size_full().min_h(0).bg(k.background).text_color(k.foreground).text_size(13);
    const title = this.linked ? "Linked pull requests" : "Pull request";
    if (!this.cwd) return root.child(this.head(k, title)).child(this.empty(k, "No folder: focus a terminal to see its pull requests."));
    if (this.problem) return root.child(this.head(k, title)).child(this.empty(k, this.problem.text, this.problem.kind === "error" ? k.destructiveText : k.muted));
    if (!this.data) return root.child(this.head(k, title)).child(this.empty(k, "Asking GitHub…"));
    const top = root.child(this.head(k, this.linked ? `${title} · ${this.data.length}` : title)).when(!!this.chat, (el) => el.child(this.chatLine(k)));
    return top.child(this.linked ? this.list(k) : this.one(k, this.data));
  }

  list(k) {
    if (!this.data.length) return this.empty(k, "You have no open pull requests in this repository.");
    return v_flex().id("ht3-prs-list").flex_1().min_h(0).p(8).gap(2).overflow_y_scrollbar()
      .children(this.data.map((pr) => {
        const st = prState(pr, k), checks = checksOf(pr);
        const bad = checks.some((c) => c.tone === "bad"), wait = checks.some((c) => c.tone === "wait");
        const here = pr.headRefName === this.branch;
        return h_flex().id(`pr-${pr.number}`).min_h(40).px(8).py(6).gap(8).items_center().rounded(8).cursor_pointer().bg(here ? alpha(k.foreground, 0.06) : "#00000000")
          .role("button").accessibility_label(`Open pull request ${pr.number}`).hover((s) => s.bg(alpha(k.foreground, 0.08)))
          .on_click(() => open(pr.url))
          .child(icon(st.glyph).size(16).flex_none().text_color(st.color))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(13).child(pr.title))
            .child(h_flex().gap(6).text_size(11).text_color(k.muted).items_center()
              .child(div().flex_none().child(`#${pr.number}`)).child(div().min_w(0).truncate().child(pr.headRefName)).child(div().flex_none().child(ago(pr.updatedAt)))
              .when(here, (el) => el.child(badge(k, "This branch", "info")))))
          .when(checks.length > 0, (el) => el.child(icon(bad ? "circle-x" : wait ? "circle-dashed" : "circle-check").size(14).flex_none().text_color(bad ? k.destructiveText : wait ? k.warningText : k.successText)))
          .child(iconButton(k, `pr-chat-${pr.number}`, "message-square", (cx) => this.startChat(cx, pr.number), { tip: `Start chat from PR: #${pr.number} in a worktree of its own (.worktrees/pr-${pr.number})` }))
          .child(icon("external-link").size(14).flex_none().text_color(k.dim));
      }));
  }

  one(k, pr) {
    const st = prState(pr, k), checks = checksOf(pr);
    const passing = checks.filter((c) => c.tone === "ok").length;
    const reviews = new Map();
    for (const r of pr.reviews ?? []) if (r.state !== "PENDING" && r.state !== "COMMENTED") reviews.set(r.author?.login ?? "?", r.state);
    const section = (t, right = null) => h_flex().pt(14).pb(4).gap(8).items_center().text_size(11).font_medium().text_color(k.muted)
      .child(div().flex_1().child(t.toUpperCase())).when(!!right, (el) => el.child(div().flex_none().font_normal().child(right)));
    const decision = { APPROVED: ["Approved", k.successText], CHANGES_REQUESTED: ["Changes requested", k.destructiveText], REVIEW_REQUIRED: ["Review required", k.warningText] }[pr.reviewDecision];
    return v_flex().id("ht3-pr-body").flex_1().min_h(0).px(14).pb(16).overflow_y_scrollbar()
      .child(h_flex().pt(12).gap(8).items_center()
        .child(h_flex().h(20).px(6).gap(4).flex_none().items_center().rounded(6).text_size(12).font_medium().bg(alpha(st.color, k.dark ? 0.16 : 0.1)).text_color(st.color)
          .child(icon(st.glyph).size(12).flex_none()).child(st.label))
        .child(div().flex_none().text_size(12).text_color(k.muted).child(`#${pr.number}`))
        .child(div().flex_1())
        .child(button(k, "pr-chat", "Start chat", (cx) => this.startChat(cx, pr.number), { variant: "outline", size: "xs", glyph: "message-square", disabled: this.chat?.busy === true,
          tip: `Start chat from PR: its head in a worktree of its own (.worktrees/pr-${pr.number}), the pull request in the message box` }))
        .child(button(k, "pr-open", "Open on GitHub", () => open(pr.url), { variant: "outline", size: "xs", glyph: "external-link" })))
      .child(div().pt(8).text_size(15).font_semibold().line_height("21px").child(pr.title))
      .child(h_flex().pt(6).gap(6).items_center().text_size(12).text_color(k.muted)
        .child(div().min_w(0).truncate().child(pr.headRefName)).child(icon("arrow-up-right").size(12).flex_none()).child(div().min_w(0).truncate().child(pr.baseRefName)))
      .child(h_flex().pt(6).gap(10).items_center().text_size(12).text_color(k.muted)
        .child(div().child(pr.author?.login ? `by ${pr.author.login}` : ""))
        .child(div().text_color(k.successText).child(`+${pr.additions ?? 0}`)).child(div().text_color(k.destructiveText).child(`−${pr.deletions ?? 0}`))
        .child(div().child(`${pr.changedFiles ?? 0} file${pr.changedFiles === 1 ? "" : "s"}`)).child(div().child(ago(pr.updatedAt))))
      .child(section("Checks", checks.length ? `${passing}/${checks.length} passing` : null))
      .when(!checks.length, (el) => el.child(div().text_size(12).text_color(k.muted).child("No checks reported.")))
      .children(checks.slice(0, 40).map((c, i) => h_flex().id(`chk-${i}`).h(26).px(4).gap(8).items_center().rounded(6).text_size(12)
        .when(!!c.url, (el) => el.cursor_pointer().hover((s) => s.bg(alpha(k.foreground, 0.07))).role("button").accessibility_label(`Open ${c.name}`).on_click(() => open(c.url)))
        .child(this.checkIcon(k, c))
        .child(div().min_w(0).flex_1().truncate().child(c.group ? `${c.group} / ${c.name}` : c.name))
        .child(div().flex_none().text_size(11).text_color(this.tone(k, c.tone)).child(c.raw))))
      .child(section("Reviews", decision ? decision[0] : null))
      .when(!reviews.size, (el) => el.child(div().text_size(12).text_color(k.muted).child("No reviews yet.")))
      .children([...reviews.entries()].map(([who, state]) => h_flex().h(26).px(4).gap(8).items_center().text_size(12)
        .child(icon(state === "APPROVED" ? "circle-check" : state === "CHANGES_REQUESTED" ? "circle-x" : "circle-dot").size(14).flex_none()
          .text_color(state === "APPROVED" ? k.successText : state === "CHANGES_REQUESTED" ? k.destructiveText : k.muted))
        .child(div().flex_1().truncate().child(who))
        .child(div().flex_none().text_size(11).text_color(k.muted).child(state.toLowerCase().replace(/_/g, " ")))))
      .when(!!(pr.body ?? "").trim(), (el) => el.child(section("Description")).child(TextView.markdown("ht3-pr-desc", pr.body.slice(0, 4000))));
  }
}
