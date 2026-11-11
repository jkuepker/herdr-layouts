// Checkpoints (T3's server/checkpointing/CheckpointStore.ts): a snapshot of the working tree as a
// commit that no branch points at, kept under refs/herdr/checkpoints/<chat>/<name> so git doesn't
// collect it. HEAD, the index and the branches are never touched: the snapshot is built in an index
// of its own. A chat takes one before each turn and one after it; the two give the turn's diff, and
// "Revert" puts the files back as the first had them. Runs where the chat runs (`on`).

import { exec } from "herdr";

const WHO = "-c user.name=Herdr -c user.email=herdr@localhost";
// $1: chat id, $2: the ref's name. Prints the snapshot's commit. 3: not a repository.
const SNAP = `
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
cd "$(git rev-parse --show-toplevel)" || exit 3
g=$(git rev-parse --absolute-git-dir); idx="$g/herdr-cp-index.$$"
cp "$g/index" "$idx" 2>/dev/null
GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1
tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
[ -n "$tree" ] || exit 4
if h=$(git rev-parse -q --verify HEAD); then c=$(git ${WHO} commit-tree "$tree" -p "$h" -m "herdr checkpoint $2")
else c=$(git ${WHO} commit-tree "$tree" -m "herdr checkpoint $2"); fi
git update-ref "refs/herdr/checkpoints/$1/$2" "$c" && echo "$c"`;
// $1: chat id, $2: the commit to go back to. Keeps what is there now as undo-<time> first, then makes
// the files match $2: changed ones go back, ones made since are removed (ignored files are left alone).
// The undo commit's message names $2, so an undo can tell whether the files still are as the revert left them.
const REVERT = `
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
cd "$(git rev-parse --show-toplevel)" || exit 3
git cat-file -e "$2^{tree}" 2>/dev/null || exit 5
g=$(git rev-parse --absolute-git-dir); idx="$g/herdr-cp-index.$$"
cp "$g/index" "$idx" 2>/dev/null
GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
[ -n "$tree" ] || { rm -f "$idx"; exit 4; }
if h=$(git rev-parse -q --verify HEAD); then c=$(git ${WHO} commit-tree "$tree" -p "$h" -m "herdr checkpoint before a revert to $2")
else c=$(git ${WHO} commit-tree "$tree" -m "herdr checkpoint before a revert to $2"); fi
git update-ref "refs/herdr/checkpoints/$1/undo-$(date +%s)" "$c" || { rm -f "$idx"; exit 4; }
GIT_INDEX_FILE="$idx" git read-tree -u --reset "$2^{tree}"; rc=$?
rm -f "$idx"; echo "$c"; exit $rc`;

// $1: the undo commit a revert kept. Puts the files back as they were before that revert, but only while they
// still are exactly as the revert left them: anything changed since would be lost, so it stops (6) and touches nothing.
// 5: the undo commit, or the snapshot it reverted to, is gone.
const UNDO = `
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
cd "$(git rev-parse --show-toplevel)" || exit 3
git cat-file -e "$1^{tree}" 2>/dev/null || exit 5
to=$(git log -1 --format=%s "$1" | sed -n 's/^herdr checkpoint before a revert to \\([0-9a-f]\\{40,64\\}\\)$/\\1/p')
[ -n "$to" ] || exit 5
want=$(git rev-parse -q --verify "$to^{tree}") || exit 5
g=$(git rev-parse --absolute-git-dir); idx="$g/herdr-cp-index.$$"
cp "$g/index" "$idx" 2>/dev/null
GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
[ -n "$tree" ] || { rm -f "$idx"; exit 4; }
[ "$tree" = "$want" ] || { rm -f "$idx"; exit 6; }
GIT_INDEX_FILE="$idx" git read-tree -u --reset "$1^{tree}"; rc=$?
rm -f "$idx"; exit $rc`;
// $1: the folder, $2: how many of a chat's refs to keep, the newest; $3...: the chats. 0 keeps none: a deleted chat's
// refs all go. The commits themselves go with git's next gc. The folder is entered here, not given as the working
// directory, so one that is gone (a removed worktree) answers 3 like any place without a repository.
const PRUNE = `
cd "$1" 2>/dev/null || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
keep=$2; shift 2
for chat in "$@"; do
  git for-each-ref --sort=-creatordate --format='delete %(refname)' "refs/herdr/checkpoints/$chat/" | tail -n +$((keep + 1))
done | git update-ref --stdin`;
// Prints the chats that have checkpoints in this repository, one a line.
const CHATS = `
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
git for-each-ref --format='%(refname)' refs/herdr/checkpoints/ | cut -d/ -f4 | sort -u`;

// A chat's id as its refs spell it.
export const safe = (s) => String(s).replace(/[^\w.-]/g, "_");

// -> the snapshot's commit, or null (no repository, or git failed).
export async function snapshot(where, chat, name) {
  if (!where?.cwd) return null;
  const r = await exec("sh", ["-c", SNAP, "sh", safe(chat), safe(name)], { cwd: where.cwd, on: where.on ?? undefined, timeout: 30000 }).catch(() => null);
  const sha = r?.code === 0 ? r.stdout.trim().split("\n").pop() : "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

// What changed between two snapshots. -> { files, add, del }
export async function turnStat(where, a, b) {
  const r = await exec("git", ["diff", "--shortstat", a, b], { cwd: where.cwd, on: where.on ?? undefined }).catch(() => null);
  const s = r?.stdout ?? "", n = (re) => Number(re.exec(s)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), add: n(/(\d+) insertions?/), del: n(/(\d+) deletions?/) };
}

// -> { ok, undo (the commit that keeps what was there), error }
export async function revertTo(where, chat, sha) {
  const r = await exec("sh", ["-c", REVERT, "sh", safe(chat), String(sha)], { cwd: where.cwd, on: where.on ?? undefined, timeout: 60000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
  const undo = r.stdout.trim().split("\n").pop() || null;
  return { ok: r.code === 0, undo, error: r.code === 0 ? null : r.code === 3 ? "This folder is not a Git repository." : r.code === 5 ? "That checkpoint is gone." : r.stderr.trim().split("\n").pop() || `git exited with code ${r.code}` };
}

// Undoes a revert: `undo` is the commit revertTo kept. -> { ok, changed (files changed since the revert: nothing was touched), gone, error }
export async function undoRevert(where, undo) {
  if (!/^[0-9a-f]{40,64}$/.test(String(undo))) return { ok: false, gone: true, error: "That checkpoint is gone." };
  const r = await exec("sh", ["-c", UNDO, "sh", String(undo)], { cwd: where.cwd, on: where.on ?? undefined, timeout: 60000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
  return { ok: r.code === 0, changed: r.code === 6, gone: r.code === 5,
    error: r.code === 0 ? null : r.code === 3 ? "This folder is not a Git repository." : r.code === 5 ? "That checkpoint is gone." : r.code === 6 ? "Files changed since the revert." : r.stderr.trim().split("\n").pop() || `git exited with code ${r.code}` };
}

// A chat keeps its newest KEEP checkpoint refs (two a turn, and one per revert): about the last 50 turns.
export const KEEP = 100;

// Drops all but the newest `keep` refs of each of `chats` (0: all of them). -> whether git did it; "none": no repository there any more.
export async function prune(where, chats, keep = KEEP) {
  const ids = [].concat(chats).map(safe).filter(Boolean);
  if (!where?.cwd || !ids.length) return false;
  const r = await exec("sh", ["-c", PRUNE, "sh", where.cwd, String(Math.max(0, Math.floor(keep))), ...ids], { on: where.on ?? undefined, timeout: 30000 }).catch(() => null);
  return r?.code === 0 ? true : r?.code === 3 ? "none" : false;
}

// The chats with checkpoints in the repository at `where`, or null when git couldn't say.
export async function chatsWithRefs(where) {
  const r = await exec("sh", ["-c", CHATS], { cwd: where.cwd, on: where.on ?? undefined, timeout: 30000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : null;
}
