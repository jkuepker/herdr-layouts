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
const REVERT = `
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
cd "$(git rev-parse --show-toplevel)" || exit 3
git cat-file -e "$2^{tree}" 2>/dev/null || exit 5
g=$(git rev-parse --absolute-git-dir); idx="$g/herdr-cp-index.$$"
cp "$g/index" "$idx" 2>/dev/null
GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
[ -n "$tree" ] || { rm -f "$idx"; exit 4; }
if h=$(git rev-parse -q --verify HEAD); then c=$(git ${WHO} commit-tree "$tree" -p "$h" -m "herdr checkpoint before a revert")
else c=$(git ${WHO} commit-tree "$tree" -m "herdr checkpoint before a revert"); fi
git update-ref "refs/herdr/checkpoints/$1/undo-$(date +%s)" "$c" || { rm -f "$idx"; exit 4; }
GIT_INDEX_FILE="$idx" git read-tree -u --reset "$2^{tree}"; rc=$?
rm -f "$idx"; echo "$c"; exit $rc`;

const safe = (s) => String(s).replace(/[^\w.-]/g, "_");

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
