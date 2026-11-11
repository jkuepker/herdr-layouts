// Git stash and the merge-conflict helper of the Project popover (menus.js). Two parts:
// - the git, where the folder is (`{ cwd, on }` as in branches.js): stash list, push, apply, pop, drop; the state of a
//   merge, rebase or cherry-pick that stopped; ours, theirs, mark resolved, continue, abort; "Stash and retry" for a
//   pull that local changes stop. What git's text means is gitstate.js (no herdr there, so it is tested under Node).
// - the two steps, drawn in place of the popover's rows (it is 344 wide and full): `stashView(menu, k)` and
//   `conflictView(menu, k)`. `menu` is the ProjectMenu: they use its `run` (one git job at a time, errors shown), `note`,
//   `error`, `confirm`, `view`, `status()`.
// A cx handed to a click is used only inside that click (menu.run starts its own spawn); nothing here keeps one.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { exec, run, focused, shared, setShared, closeOverlay } from "herdr";
import { MOD, tokens, icon, button, iconButton, alpha } from "./look.js";
import { gitMessage, pullFastForward } from "./branches.js";
import {
  STASH_ARGS, parseStashList, ageOf, stashRef, stashPushArgs, classifyStashRun,
  STATE_SCRIPT, OPS, parseConflictState, sideHint, conflictPrompt, MARKER_GREP,
} from "./gitstate.js";

const opt = (o, timeout) => ({ cwd: o.cwd, on: o.on ?? undefined, ...(timeout ? { timeout } : {}) });
// Another git process (Files, Diff, an agent) holding index.lock for a moment.
const LOCKED = /index\.lock|Another git process seems to be running|could not write index/i;
const locked = (r) => r && r.code !== 0 && LOCKED.test(`${r.stderr ?? ""}${r.stdout ?? ""}`);
// exec git; a command that is safe to repeat runs once more after a short wait when the index was locked.
async function git(o, args, timeout) {
  let r = await exec("git", args, opt(o, timeout));
  if (locked(r)) { await exec("sleep", ["0.4"], opt(o, 5000)).catch(() => null); r = await exec("git", args, opt(o, timeout)); }
  return r;
}

// ---- git ----

export async function readStashes(o) {
  const r = await exec("git", ["--no-optional-locks", ...STASH_ARGS], opt(o, 15000));
  if (r.code !== 0) throw new Error(gitMessage(r, 2, "Cannot list stashes"));
  return parseStashList(r.stdout);
}

// -> { op, files, active } (gitstate.js parseConflictState)
export async function readConflicts(o) {
  const r = await exec("sh", ["-c", STATE_SCRIPT], opt(o, 15000));
  return parseConflictState(r.stdout);
}

const topStash = async (o) => {
  const r = await exec("git", ["rev-parse", "-q", "--verify", "refs/stash"], opt(o, 15000)).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : null;
};

// `git stash push [-u] [-m message]`. -> { created }: false when git found nothing to stash (it says so and exits 0).
export async function stashPush(o, { message = "", untracked = false } = {}) {
  const before = await topStash(o);
  const r = await exec("git", stashPushArgs({ message, untracked }), opt(o, 60000));
  const created = (await topStash(o)) !== before;
  // A lock clash after git saved the stash still leaves the stash made; only a stash that wasn't made is a failure.
  if (r.code !== 0 && !(created && locked(r))) throw new Error(gitMessage(r, 2, "git stash failed"));
  return { created };
}

// Apply or pop the nth stash. -> { conflict }: true when it was applied with conflicts (git keeps the stash then).
// Throws git's words when it refused (local changes in the way) or failed.
export async function stashRun(o, verb, index) {
  if (verb !== "apply" && verb !== "pop" && verb !== "drop") throw new Error("No such stash action");
  const r = await exec("git", ["stash", verb, stashRef(index)], opt(o, 60000));
  if (verb === "drop") {
    if (r.code !== 0) throw new Error(gitMessage(r, 2, "git stash drop failed"));
    return { conflict: false };
  }
  const kind = classifyStashRun(r);
  if (kind === "conflict") return { conflict: true };
  if (kind === "ok") return { conflict: false };
  const msg = gitMessage(r, 4, `git stash ${verb} failed`);
  throw new Error(kind === "blocked" ? `Local changes are in the way: ${msg}` : msg);
}

// "Stash and retry": stash (untracked files too when they are what is in the way), `git pull --ff-only`, pop. A pull that
// fails puts the changes back and throws its error. -> { note, conflict }: `conflict` when the pop left conflicts.
export async function stashAndPull(o, { untracked = false } = {}) {
  const made = await stashPush(o, { message: "Herdr: before pull", untracked });
  let pulled;
  try { pulled = await pullFastForward(o); } catch (e) {
    if (made.created) {
      const back = await stashRun(o, "pop", 0).catch(() => ({ failed: true }));
      e.message = `${e.message} ${back.failed ? "Your changes are still in the stash." : back.conflict ? "Putting your changes back conflicted: see the conflicts." : "Your changes were put back."}`;
    }
    throw e;
  }
  if (!made.created) return { note: `${pulled}. Nothing needed stashing.`, conflict: false };
  let back;
  try { back = await stashRun(o, "pop", 0); } catch (e) { throw new Error(`${pulled}, but your changes could not be put back (${e.message}). They are in the stash.`); }
  return back.conflict
    ? { note: `${pulled}, but putting your changes back conflicts. The stash is kept until you drop it.`, conflict: true }
    : { note: `${pulled}; your changes are back`, conflict: false };
}

// ---- conflicts ----

// `git checkout --ours|--theirs -- file && git add -- file`.
export async function takeSide(o, file, side) {
  if (side !== "ours" && side !== "theirs") throw new Error("No such side");
  const c = await git(o, ["checkout", `--${side}`, "--", file], 30000);
  if (c.code !== 0) throw new Error(gitMessage(c, 2, `git checkout --${side} failed`));
  const a = await git(o, ["add", "--", file], 30000);
  if (a.code !== 0) throw new Error(gitMessage(a, 2, "git add failed"));
}

// `git add -- file`, refused while the file on disk still has conflict markers.
export async function markResolved(o, file) {
  const g = await exec("grep", ["-qE", MARKER_GREP, "--", file], opt(o, 30000)).catch(() => null);
  if (g?.code === 0) throw new Error(`${file} still has conflict markers (<<<<<<< or >>>>>>>). Remove them and save the file first.`);
  const a = await git(o, ["add", "--", file], 30000);
  if (a.code !== 0) throw new Error(gitMessage(a, 2, "git add failed"));
}

// `<op> --continue` with GIT_EDITOR=true (the message git proposes is kept). -> { more }: a rebase or cherry-pick
// series that stopped at the next conflict.
export async function continueOp(o, op) {
  const def = OPS[op];
  if (!def) throw new Error("Nothing to continue");
  const r = await exec("sh", ["-c", def.cont], opt(o, 120000));
  if (r.code === 0) return { more: false };
  // A rebase or a series of picks that stopped at the next conflict is not an error; a merge that can't be continued is.
  if (op !== "merge" && /CONFLICT|Resolve all conflicts|could not apply|needs merge|unmerged/i.test(`${r.stdout}\n${r.stderr}`)) return { more: true, message: gitMessage(r, 3) };
  throw new Error(gitMessage(r, 3, `git ${op} --continue failed`));
}

export async function abortOp(o, op) {
  const def = OPS[op];
  if (!def) throw new Error("Nothing to abort");
  const r = await exec("git", def.abort, opt(o, 60000));
  if (r.code !== 0) throw new Error(gitMessage(r, 3, `git ${op} --abort failed`));
}

// ---- the steps ----

const cnt = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// A step's head: back to the popover's rows, its title, refresh.
function head(m, k, title, detail) {
  return h_flex().h(36).flex_none().px(4).gap(4).items_center()
    .child(iconButton(k, "step-back", "chevron-left", (cx) => { m.view = null; m.confirm = null; cx.notify(); }, { tip: "Back" }))
    .child(div().flex_none().font_medium().text_size(14).child(title))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(detail ?? ""))
    .child(iconButton(k, "step-refresh", "refresh-cw", (cx) => m.run(cx, () => m.refreshAll()), { tip: "Read it again" }));
}

const tail = (m, k) => v_flex().flex_none().gap(2)
  .when(!!m.note, (e) => e.child(div().px(8).py(4).text_size(12).line_height("16px").text_color(k.successText).child(m.note)))
  .when(!!m.error, (e) => e.child(div().px(8).py(4).text_size(12).line_height("16px").text_color(k.destructiveText).child(m.error)));

// Opens Diff on the stash's commit (its tracked changes against where it was made from): the surface first, then the
// commit once it is there. The popover stays until then, a timer's callback needs no cx.
export function showStash(m, cx, s) {
  m.note = "Opening the diff…";
  cx.notify();
  run(`${MOD}.add:diff:a`);
  cx.timer.after(500, () => run(`${MOD}.commit:${s.hash}`));
  cx.timer.after(1200, () => { run(`${MOD}.commit:${s.hash}`); closeOverlay(m.overlay); });
}

// Stash's step: "Stash changes" (a message, -u), then the stashes, each with Apply, Pop, Drop and Show.
export function stashView(m, k) {
  const list = m.stashes ?? [], g = m.git;
  const ask = m.confirm?.kind === "drop" ? m.confirm.index : null;
  const row = (s) => {
    const sure = ask === s.index;
    return v_flex().id(`stash-${s.index}`).flex_none().mx(4).px(8).py(6).gap(4).rounded(8).border(1).border_color(alpha(k.border, 0.8))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().px(4).rounded(4).bg(k.accent).text_size(11).font_family(k.mono).text_color(k.muted).child(String(s.index)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).tooltip(s.message || s.ref).child(s.message || "(no message)")))
      .child(div().truncate().text_size(11).text_color(k.muted).child([s.branch && `on ${s.branch}`, ageOf(s.time), s.ref].filter(Boolean).join(" · ")))
      .child(sure
        ? v_flex().gap(4)
          .child(div().text_size(12).line_height("16px").text_color(k.muted).child(`Drop ${s.ref}? Its changes are gone for good.`))
          .child(h_flex().justify_end().gap(6)
            .child(button(k, `stash-drop-no-${s.index}`, "Cancel", (cx) => { m.confirm = null; cx.notify(); }))
            .child(button(k, `stash-drop-yes-${s.index}`, m.busy ? "…" : "Drop", (cx) => m.run(cx, () => m.stashAct("drop", s)), { variant: "destructive", disabled: m.busy })))
        : h_flex().gap(4).items_center()
          .child(button(k, `stash-apply-${s.index}`, "Apply", (cx) => m.run(cx, () => m.stashAct("apply", s)), { disabled: m.busy, tip: "Apply the changes and keep the stash" }))
          .child(button(k, `stash-pop-${s.index}`, "Pop", (cx) => m.run(cx, () => m.stashAct("pop", s)), { disabled: m.busy, tip: "Apply the changes and drop the stash" }))
          .child(button(k, `stash-show-${s.index}`, "Show", (cx) => showStash(m, cx, s), { disabled: m.busy || !s.hash, tip: "Open the stash in the Diff surface (its tracked files)" }))
          .child(div().flex_1())
          .child(button(k, `stash-drop-${s.index}`, "Drop", (cx) => { m.confirm = { kind: "drop", index: s.index }; cx.notify(); }, { variant: "ghost-muted", disabled: m.busy })));
  };
  const nothing = !g || g.changed === 0;
  const make = v_flex().flex_none().mx(4).mb(6).p(8).gap(6).rounded(8).border(1).border_color(alpha(k.border, 0.8))
    .child(div().h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(13).child(Input.new(m.stashMsg)))
    .child(h_flex().gap(6).items_center()
      .child(h_flex().id("stash-untracked").h(24).px(4).gap(6).items_center().rounded(6).cursor_pointer().role("check_box").accessibility_label("Include untracked files")
        .hover((s) => s.bg(k.accent)).on_click((_e, cx) => { m.untracked = !m.untracked; cx.notify(); })
        .child(h_flex().size(14).flex_none().rounded(4).border(1).border_color(k.input).items_center().justify_center().bg(m.untracked ? k.primary : "#00000000")
          .when(m.untracked, (e) => e.child(icon("check").size(10).text_color(k.primaryText))))
        .child(div().text_size(12).text_color(k.muted).child("Include untracked files (-u)")))
      .child(div().flex_1())
      .child(button(k, "stash-go", m.busy ? "…" : "Stash changes", (cx) => m.run(cx, () => m.stashAct("push")), { variant: "default", disabled: m.busy || nothing, tip: nothing ? "Nothing to stash" : g?.changed ? cnt(g.changed, "changed file") : null })));
  return v_flex().id("ht3-stash").size_full().p(4).bg(k.popover).text_color(k.foreground).text_size(14).overflow_hidden()
    .child(head(m, k, "Stash", m.stashes ? cnt(list.length, "stash") : "Reading…"))
    .child(make)
    .child(list.length
      ? (list.length > 4 ? v_flex().id("ht3-stash-list").flex_none().h(380).gap(6).overflow_y_scrollbar() : v_flex().id("ht3-stash-list").flex_none().gap(6)).children(list.map(row))
      : div().px(12).py(8).text_size(12).text_color(k.muted).child(m.stashes ? "No stashes yet. Stash changes puts the working changes away and leaves a clean tree." : "Reading the stashes…"))
    .child(div().flex_none().h(4))
    .child(tail(m, k));
}

// The conflict helper's step: the unmerged files with Open, Take ours, Take theirs and Mark resolved; then Ask agent,
// Continue and Abort.
export function conflictView(m, k) {
  const c = m.conflicts ?? { op: null, files: [], active: false }, op = c.op, def = op ? OPS[op] : null;
  const row = (f, i) => {
    const name = f.split("/").pop(), dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    return v_flex().id(`cf-${i}`).flex_none().mx(4).px(8).py(6).gap(4).rounded(8).border(1).border_color(alpha(k.border, 0.8))
      .child(h_flex().gap(6).items_center().tooltip(f)
        .child(icon("file").size(14).flex_none().text_color(k.warningText))
        .child(div().flex_none().max_w(170).truncate().text_size(13).font_medium().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.muted).child(dir)))
      .child(h_flex().gap(4).items_center()
        .child(button(k, `cf-open-${i}`, "Open", () => m.openConflict(f), { disabled: !!m.on, tip: m.on ? "Files opens folders on this computer only" : "Open in the Files editor" }))
        .child(button(k, `cf-ours-${i}`, "Take ours", (cx) => m.run(cx, () => m.conflictAct("ours", f)), { disabled: m.busy, tip: "Keep this branch's version and stage it" }))
        .child(button(k, `cf-theirs-${i}`, "Take theirs", (cx) => m.run(cx, () => m.conflictAct("theirs", f)), { disabled: m.busy, tip: "Take the other side's version and stage it" }))
        .child(div().flex_1())
        .child(button(k, `cf-done-${i}`, "Resolved", (cx) => m.run(cx, () => m.conflictAct("resolved", f)), { variant: "default", disabled: m.busy, tip: "Stage the file as it is now; refused while conflict markers remain" })));
  };
  const abort = m.confirm?.kind === "abort";
  const word = def?.word ?? "operation";
  const left = c.files.length;
  return v_flex().id("ht3-conflicts").size_full().p(4).bg(k.popover).text_color(k.foreground).text_size(14).overflow_hidden()
    .child(head(m, k, "Merge conflict", def ? `${def.word}${m.branch ? ` on ${m.branch}` : ""}` : "unmerged files"))
    .child(div().px(12).pb(6).text_size(11).line_height("15px").text_color(k.muted).child(sideHint(op)))
    .child(left
      ? (left > 5 ? v_flex().id("ht3-conflict-list").flex_none().h(380).gap(6).overflow_y_scrollbar() : v_flex().id("ht3-conflict-list").flex_none().gap(6)).children(c.files.map(row))
      : div().flex_none().px(12).py(8).text_size(12).text_color(k.muted).child(op ? `Every file is resolved. Continue the ${word}, or abort it.` : "No unmerged files are left."))
    .child(div().flex_none().h(4))
    .child(tail(m, k))
    .child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
    .child(abort
      ? v_flex().flex_none().mx(4).mb(4).gap(6)
        .child(div().px(4).text_size(12).line_height("16px").text_color(k.muted).child(`Abort the ${word}? Everything it changed, and your resolutions so far, is undone.`))
        .child(h_flex().justify_end().gap(6)
          .child(button(k, "cf-abort-no", "Cancel", (cx) => { m.confirm = null; cx.notify(); }, { variant: "outline" }))
          .child(button(k, "cf-abort-yes", m.busy ? "…" : `Abort ${word}`, (cx) => m.run(cx, () => m.abortAct()), { variant: "destructive", disabled: m.busy })))
      : v_flex().flex_none().mx(4).mb(4).gap(6)
        .child(h_flex().gap(6).items_center()
          .child(button(k, "cf-agent", "Ask agent to resolve", (cx) => askAgent(m, cx), { glyph: "sparkles", disabled: !left, tip: "Puts a prompt naming the files into the chat's message box; nothing is sent" }))
          .child(div().flex_1())
          .when(!!op, (e) => e
            .child(button(k, "cf-continue", m.busy ? "…" : "Continue", (cx) => m.run(cx, () => m.continueAct()), { variant: "default", disabled: m.busy || left > 0, tip: left > 0 ? `Resolve ${cnt(left, "file")} first` : `${def.cont.replace("GIT_EDITOR=true ", "")}` }))
            .child(button(k, "cf-abort", "Abort", (cx) => { m.confirm = { kind: "abort" }; cx.notify(); }, { variant: "outline", disabled: m.busy }))))
    );
}

// "Ask agent to resolve": the prompt goes into the message box of the shown tab's chat, not sent (chat.js takes
// shared "ht3-panels.quote", as Diff's Add to chat does).
function askAgent(m, cx) {
  const c = m.conflicts;
  if (!c?.files.length) return;
  const tab = focused()?.tab, places = shared(`${MOD}.places`) ?? {};
  if (!Object.values(places).some((p) => p.tab === tab)) { m.error = "The shown tab isn't a chat: show the chat this is for, then ask."; m.note = null; return cx.notify(); }
  setShared(`${MOD}.quote`, { tab, text: conflictPrompt({ op: c.op, files: c.files, branch: m.branch }), at: Date.now() });
  m.error = null;
  m.note = `Put into the chat's message box: ${cnt(c.files.length, "file")}, not sent.`;
  cx.notify();
}
