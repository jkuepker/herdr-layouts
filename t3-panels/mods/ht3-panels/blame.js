// Blame and file history for the Files editor (editor.js draws them; the parsing is blame-parse.js, which has no Herdr imports).
//
// - Blame: `git blame --porcelain -- <file>` run in the folder Files shows, on the space's machine, read once per file + HEAD +
//   the file's mtime (the answer is kept, so toggling blame again, switching tabs or the editor's timers cost one cheap
//   `rev-parse` and `stat`). A file longer than BLAME_CAP lines is blamed for the first BLAME_CAP lines only, and the gutter says so.
//   The Lines view gets a narrow gutter on the left of each line: author, age and subject, muted, on the first line of a run of
//   one commit's lines only; `not committed` for lines git has no commit for. A click on a cell opens that commit in Diff.
// - History: `git log --follow` of the file (renames followed), up to LOG_MAX commits, as a step in the editor. A click opens the commit in Diff.
//   Diff's Commit scope shows the whole commit: it has no path filter.
// - Opening a commit in Diff is what `ht3-panels.commit:<hash>` does there (diff.js); this adds the Diff surface first, as search.js
//   shows a file before it picks a line.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run } from "herdr";
import { MOD, alpha, button } from "./look.js";
import { activeSpace, spaceState, GROUPS } from "./side.js";
import { parseBlame, parseLog, blameArgs, logArgs, blameLabel, blameTip, relTime, blameProblem, isHash, BLAME_CAP, LOG_MAX } from "./blame-parse.js";

export { BLAME_CAP, LOG_MAX };
export const GUTTER = 232; // px: the blame column of a line row

// ---- reading ----

const CACHE = new Map(), KEEP = 24;
// $1 the file: HEAD (nothing in a repository without commits), then the file's modification time and size, one per line.
const STAMP = 'git --no-optional-locks rev-parse HEAD 2>/dev/null; stat -c "%Y %s" "$1" 2>/dev/null || stat -f "%m %z" "$1" 2>/dev/null; true';

// Blame of `path` (relative to `root`) for a file of `total` lines: { rows, commits, capped } or { error }. Never rejects.
export async function loadBlame({ root, on }, path, total) {
  try {
    const stamp = await exec("sh", ["-c", STAMP, "blame", path], { cwd: root, on });
    const capped = total > BLAME_CAP;
    const key = `${on ?? ""}|${root}|${path}|${stamp.stdout.trim().split("\n").join("|")}|${capped ? "c" : ""}`;
    const hit = CACHE.get(key);
    if (hit) { CACHE.delete(key); CACHE.set(key, hit); return hit; }
    const r = await exec("git", blameArgs(path, capped), { cwd: root, on, timeout: 60000 });
    if (r.code !== 0) return { error: blameProblem(r.stderr) };
    const parsed = parseBlame(r.stdout);
    const data = { rows: parsed.rows, commits: parsed.commits, capped };
    CACHE.set(key, data);
    while (CACHE.size > KEEP) CACHE.delete(CACHE.keys().next().value);
    return data;
  } catch (e) { return { error: `Blame: ${String(e?.message ?? e)}` }; }
}

// The file's history, newest first, renames followed: { entries } or { error }. Never rejects.
export async function loadHistory({ root, on }, path) {
  try {
    const r = await exec("git", logArgs(path, LOG_MAX), { cwd: root, on, timeout: 60000 });
    if (r.code !== 0) return { error: r.stderr.trim().split("\n")[0] || "git log failed" };
    return { entries: parseLog(r.stdout, LOG_MAX) };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

// ---- Diff ----

// Shows `hash` in the Diff surface: the group that has Diff, else the other group of a split panel, else this one. Diff
// reads commands as the shown copy; a Diff that was not open yet is started first and told a moment later (the second
// time is for a slow start; asking Diff for the same commit twice shows it once).
export function openCommit(cx, hash, from = "a") {
  if (!isHash(hash)) return;
  const st = spaceState(activeSpace()?.id);
  const group = GROUPS.find((g) => st[g].tabs.some((t) => t.kind === "diff")) ?? (st.split ? GROUPS.find((g) => g !== from) : null) ?? from;
  run(`${MOD}.add:diff:${group}`);
  for (const ms of [500, 1500]) cx.timer.after(ms, () => run(`${MOD}.commit:${hash}`));
}

// ---- drawing ----

// What the footer under the Lines view says about blame (null: nothing).
export function blameNote(tab) {
  const b = tab.blame;
  if (!tab.blameOn) return null;
  if (!b || b.loading && !b.data) return "Reading blame…";
  if (b.error) return b.error;
  const out = [];
  if (b.data?.capped) out.push(`Blame covers the first ${BLAME_CAP.toLocaleString("en-US")} lines only.`);
  if (tab.dirty) out.push("Blame is for the saved file: unsaved edits are not in it.");
  return out.join(" ") || null;
}

// The blame cell of line index `i` (0-based) in the Lines view: `open(hash)` is what a click does.
export function blameCell(k, tab, i, open) {
  const data = tab.blame?.data, r = data?.rows[i];
  let el = h_flex().id(`bl-${i}`).w(GUTTER).h(20).flex_none().pl(8).pr(6).gap(6).items_center().overflow_hidden().text_size(11).line_height("20px")
    .text_color(alpha(k.muted, 0.85));
  if (!r) return el;
  const c = data.commits[r.hash];
  el = el.cursor_pointer().role("button").accessibility_label(`Line ${i + 1}: open this line's commit in Diff`)
    .hover((s) => s.text_color(k.foreground));
  if (!c?.uncommitted) el = el.on_click((_e, cx) => open(cx, r.hash));
  if (!r.first) return el;
  const t = blameLabel(c);
  return el.tooltip(blameTip(c))
    .when(!!t.who, (e) => e.child(div().flex_none().max_w(72).truncate().text_color(k.foreground).opacity(0.75).child(t.who)))
    .when(!!t.when, (e) => e.child(div().flex_none().child(t.when)))
    .child(div().flex_1().min_w(0).truncate().text_color(c?.uncommitted ? k.warningText : alpha(k.muted, 0.7)).child(t.subject));
}

// The History step: replaces the file's view. tab.history is { loading, entries, error }.
export function historyView(k, tab, { close, open }) {
  const h = tab.history ?? {}, list = h.entries ?? [], now = Date.now() / 1000;
  const note = h.error ?? (h.loading ? "Reading the history…" : !list.length ? "No commits touch this file yet." : null);
  const rows = list.map((e, i) => v_flex().id(`hist-${i}`).h(44).flex_none().mx(8).px(8).justify_center().rounded(6).cursor_pointer()
    .role("button").accessibility_label(`${e.short} ${e.subject}`).tooltip(`${e.hash}\nOpen this commit in Diff`)
    .hover((s) => s.bg(alpha(k.foreground, 0.07))).on_click((_e, cx) => open(cx, e.hash))
    .child(div().min_w(0).truncate().text_size(13).text_color(k.foreground).child(e.subject || "(no subject)"))
    .child(h_flex().gap(6).min_w(0).text_size(11).text_color(k.muted)
      .child(div().flex_none().font_family(k.mono).child(e.short))
      .child(div().min_w(0).truncate().child(`${e.author} · ${relTime(e.time, now)}`))));
  return v_flex().flex_1().min_h(0)
    .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6)).text_size(12).text_color(k.muted)
      .child(div().flex_1().min_w(0).truncate().child(h.loading && !list.length ? `History of ${tab.path}` : `History of ${tab.path} · ${list.length}${list.length >= LOG_MAX ? "+" : ""} commit${list.length === 1 ? "" : "s"}`))
      .child(div().flex_none().text_size(11).child("A click opens the commit in Diff"))
      .child(button(k, "hist-close", "Close", (cx) => close(cx), { variant: "ghost-muted" })))
    .child(v_flex().id("ht3-file-history").flex_1().min_h(0).overflow_y_scrollbar().py(4).children(rows)
      .when(!!note, (el) => el.child(div().px(12).py(8).text_size(12).text_color(h.error ? k.destructiveText : k.muted).child(note))));
}
