// T3 Code's Pull request and Linked pull requests surfaces, through the GitHub CLI.
// - "Pull request" (props.panel "pr"): the pull request of the shown space's branch, from
//   `gh pr view` run in its folder: title, state, branches, checks, reviews, description, and a
//   button that opens it in the browser.
// - "Linked pull requests" (props.panel "prs"): the open pull requests you authored in the
//   repository (`gh pr list --author @me`), the branch's own marked; a click opens one.
// Reads only. Without `gh`, without a sign-in, a GitHub remote or a pull request, it says so.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec } from "herdr";
import { tokens, alpha, icon, button, iconButton, badge } from "./look.js";
import { activeSpace, placeOf, showing } from "./side.js";

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
    this.load(cx);
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
        else { this.data = JSON.parse(r.stdout || "null"); this.problem = null; }
      } catch (e) {
        if (this.seen !== seen) return;
        this.data = null;
        this.problem = explain(e, this.branch, on);
        // A folder that is gone fails the same way as a missing gh.
        if (this.problem.kind === "missing" && (await exec("test", ["-d", cwd], { on }).catch(() => null))?.code === 1) this.problem = { kind: "folder", text: `The folder ${cwd} is gone.` };
      } finally { this.loading = false; cx.notify(); }
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
    return this.linked ? root.child(this.head(k, `${title} · ${this.data.length}`)).child(this.list(k)) : root.child(this.head(k, title)).child(this.one(k, this.data));
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
