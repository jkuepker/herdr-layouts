// What git says about stashes and half-finished merges, as data (the Project popover's Stash and Merge conflict
// rows, stash.js; the Files editor's conflict banner, editor.js). Parsing and wording only: no `herdr`, no gpui, so a
// test can run it under Node. The commands that produce the text are here as constants; stash.js runs them.

// ---- stashes ----

// `git stash list`: ref, commit, committer time (unix), subject, one stash a line.
export const STASH_FORMAT = "%gd%x1f%H%x1f%ct%x1f%gs";
export const STASH_ARGS = ["stash", "list", `--format=${STASH_FORMAT}`];

// -> [{ index, ref ("stash@{0}"), hash, time (unix seconds, 0 when unknown), branch, message, wip }].
// git's subjects: "WIP on <branch>: <sha> <commit subject>" for a plain `git stash`, "On <branch>: <message>" for one with
// a message. The sha of a WIP stash is dropped from the message (the commit subject is what it says); `wip` marks it.
export function parseStashList(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [ref = "", hash = "", time = "", subject = ""] = line.split("\x1f");
    const at = /^stash@\{(\d+)\}$/.exec(ref.trim());
    if (!at) continue;
    const m = /^(WIP on|On) ([^:]*): ([\s\S]*)$/.exec(subject);
    const wip = m ? m[1] === "WIP on" : false;
    out.push({
      index: Number(at[1]), ref: ref.trim(), hash: hash.trim(), time: Number(time) || 0,
      branch: m ? m[2] : "", message: m ? (wip ? m[3].replace(/^[0-9a-f]{7,40}\s+/, "") : m[3]) : subject, wip,
    });
  }
  return out;
}

// "5 min ago", "3 h ago", "2 d ago": how long ago `time` (unix seconds) is from `now` (milliseconds).
export function ageOf(time, now = Date.now()) {
  if (!time) return "";
  const s = Math.max(0, Math.round(now / 1000 - time));
  if (s < 60) return "just now";
  const unit = (n, w) => `${n} ${w} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), "min");
  if (s < 86400) return unit(Math.floor(s / 3600), "h");
  if (s < 86400 * 14) return unit(Math.floor(s / 86400), "d");
  if (s < 86400 * 60) return unit(Math.floor(s / (86400 * 7)), "w");
  if (s < 86400 * 365) return unit(Math.floor(s / (86400 * 30)), "mo");
  return unit(Math.floor(s / (86400 * 365)), "y");
}

// The ref of the nth stash; anything but a whole number is refused (it ends up in a command line).
export function stashRef(index) {
  if (!/^\d{1,6}$/.test(String(index))) throw new Error("No such stash");
  return `stash@{${Number(index)}}`;
}

// `git stash push` with an optional message; -u takes the files that aren't tracked yet along.
export function stashPushArgs({ message = "", untracked = false } = {}) {
  const m = String(message ?? "").trim().replace(/\s*\n\s*/g, " ");
  return ["stash", "push", ...(untracked ? ["-u"] : []), ...(m ? ["-m", m] : [])];
}

// What came of `git stash apply|pop` (r = { code, stdout, stderr }): "ok", "conflict" (it was applied, with conflicts
// to resolve; the stash is kept), "blocked" (git refused: local changes or files in the way, nothing was applied),
// "failed".
export function classifyStashRun(r) {
  const all = `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`;
  if (r?.code === 0) return "ok";
  if (/CONFLICT|Merge conflict|needs merge|unmerged/i.test(all) && !/would be overwritten/i.test(all)) return "conflict";
  if (/would be overwritten|commit your changes or stash|Please commit or stash|already exists, no checkout|untracked working tree files/i.test(all)) return "blocked";
  return "failed";
}

// ---- a pull that local changes stop ----

// A failed `git pull --ff-only` (r = { stdout, stderr }): { kind: "diverged" | "local-changes" | "other", untracked }.
// "local-changes" is what "Stash and retry" answers; `untracked` says files that aren't tracked are the ones in the way
// (the stash then needs -u).
export function classifyPullFailure(r) {
  const all = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`;
  if (/not possible to fast-forward|diverging|divergent|non-fast-forward/i.test(all)) return { kind: "diverged", untracked: false };
  if (/conflict|would be overwritten|overwritten by merge|unmerged|commit your changes or stash/i.test(all)) return { kind: "local-changes", untracked: /untracked working tree files/i.test(all) };
  return { kind: "other", untracked: false };
}

// ---- merges, rebases and cherry-picks that stopped ----

// Run in the repository's folder with `sh -c`: the state files git keeps (found with `git rev-parse --git-path`, so a
// linked worktree's own git folder is the one looked at), a line `--`, then the unmerged files, NUL separated.
export const STATE_SCRIPT = 'g() { [ -e "$(git rev-parse --git-path "$1")" ] && echo "flag $1"; }; '
  + "g MERGE_HEAD; g CHERRY_PICK_HEAD; g REVERT_HEAD; g rebase-merge; g rebase-apply; g rebase-apply/applying; echo --; "
  + "git diff --name-only --diff-filter=U -z";

export const OPS = {
  merge: { word: "merge", cont: "GIT_EDITOR=true git merge --continue", abort: ["merge", "--abort"] },
  rebase: { word: "rebase", cont: "GIT_EDITOR=true git rebase --continue", abort: ["rebase", "--abort"] },
  "cherry-pick": { word: "cherry-pick", cont: "GIT_EDITOR=true git cherry-pick --continue", abort: ["cherry-pick", "--abort"] },
  revert: { word: "revert", cont: "GIT_EDITOR=true git revert --continue", abort: ["revert", "--abort"] },
  am: { word: "am", cont: "GIT_EDITOR=true git am --continue", abort: ["am", "--abort"] },
};

// STATE_SCRIPT's output -> { op: "merge" | "rebase" | "cherry-pick" | "revert" | "am" | null, files: [path], active }.
// `op` null with files: unmerged files and no operation to continue (a stash that was applied with conflicts).
// `active`: anything to show at all.
export function parseConflictState(text) {
  const s = String(text ?? ""), cut = s.indexOf("--\n"), head = cut < 0 ? s : s.slice(0, cut), rest = cut < 0 ? "" : s.slice(cut + 3);
  const flags = new Set(head.split("\n").map((l) => /^flag (.+)$/.exec(l.trim())?.[1]).filter(Boolean));
  const files = rest.split("\0").filter(Boolean);
  const op = flags.has("rebase-apply/applying") ? "am" : flags.has("rebase-merge") || flags.has("rebase-apply") ? "rebase"
    : flags.has("CHERRY_PICK_HEAD") ? "cherry-pick" : flags.has("REVERT_HEAD") ? "revert" : flags.has("MERGE_HEAD") ? "merge" : null;
  return { op, files, active: op !== null || files.length > 0 };
}

// The Project popover's warning row: its label and its detail.
export function conflictRow(state) {
  const n = state.files.length, files = `${n} file${n === 1 ? "" : "s"}`;
  if (n > 0) return { label: `Merge conflict: ${files}`, detail: state.op ? OPS[state.op].word : "unmerged" };
  return { label: state.op ? `${OPS[state.op].word[0].toUpperCase()}${OPS[state.op].word.slice(1)} in progress` : "Merge conflict", detail: "all resolved: continue" };
}

// Which side is which: a rebase replays your commits onto the other branch, so "ours" is the branch being rebased onto.
export function sideHint(op) {
  return op === "rebase" || op === "am" ? "Rebase: ours is the branch being rebased onto, theirs is your commit being replayed."
    : op === "cherry-pick" || op === "revert" ? "Ours is the branch you are on, theirs is the commit being applied."
    : op === "merge" ? "Ours is the branch you are on, theirs is the one being merged in."
    : "Ours is the checked-out version, theirs is the stash's.";
}

// What "Ask agent to resolve" puts into the message box (not sent).
export function conflictPrompt({ op, files, branch = null }) {
  const what = op ? `a ${OPS[op].word}${branch ? ` on ${branch}` : ""}` : `unmerged files${branch ? ` on ${branch}` : ""}`;
  const list = files.slice(0, 40).map((f) => `- ${f}`).join("\n") + (files.length > 40 ? `\n- … and ${files.length - 40} more` : "");
  return `The repository is in the middle of ${what}, and these ${files.length === 1 ? "file has" : `${files.length} files have`} merge conflicts:\n\n${list}\n\n`
    + "Please resolve the conflict markers (<<<<<<<, =======, >>>>>>>) in each file, keeping what both sides meant, and stage the files with `git add`. "
    + `Don't commit, continue or abort the ${op ? OPS[op].word : "operation"}; I'll do that.`;
}

// ---- conflict markers in a file ----

// git's markers, as grep finds them in a file on disk (the pattern of "Mark resolved"'s refusal).
export const MARKER_GREP = "^(<<<<<<<|>>>>>>>) ";

// The conflicts in a text: [{ start, base, mid, end }], line numbers from 1. A conflict is `<<<<<<< ` ... `=======`
// (a diff3 `||||||| ` base in between) ... `>>>>>>> `; one without its `=======` or its end is not counted. A
// second `<<<<<<< ` before the end begins again.
export function conflictBlocks(text) {
  const t = String(text ?? "");
  if (!t.includes("<<<<<<< ")) return [];
  const out = [], lines = t.split("\n");
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], no = i + 1;
    if (l.startsWith("<<<<<<< ")) cur = { start: no, base: null, mid: null, end: null };
    else if (!cur) continue;
    else if (l.startsWith("||||||| ")) { if (cur.mid == null && cur.base == null) cur.base = no; }
    else if (l === "=======" || l === "=======\r") { if (cur.mid == null) cur.mid = no; }
    else if (l.startsWith(">>>>>>> ")) {
      if (cur.mid != null) out.push({ ...cur, end: no });
      cur = null;
    }
  }
  return out;
}

// The line of the next (dir 1) or previous (dir -1) conflict from `from` (the picked line, or null), wrapping round.
// null when there is none.
export function stepConflict(blocks, from, dir) {
  if (!blocks.length) return null;
  if (from == null) return (dir > 0 ? blocks[0] : blocks.at(-1)).start;
  if (dir > 0) return (blocks.find((b) => b.start > from) ?? blocks[0]).start;
  const before = blocks.filter((b) => b.end < from);
  return (before.length ? before.at(-1) : blocks.at(-1)).start;
}
