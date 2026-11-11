// A unified diff parsed (parseDiff, what the Diff surface shows) and, from one hunk of one file, a minimal valid
// patch for `git apply`: Revert hunk is `git apply -R` of it on the working tree, Stage hunk `git apply --cached`.
// No Herdr imports: the tests (node) run it against real git repositories.
//
// A file is { path, old, status, add, del, binary, hunks, lines, cut, header, quoted, modeOnly }: `header` is the
// raw lines before its first hunk, a hunk { head, ctx, lines, raw, cut }: `raw` is its lines as git printed them
// (the leading " ", "+", "-" or "\" and a CR kept), so a patch is byte for byte what git wrote.

export const MAX_LINES_FILE = 1500;

export function parseDiff(text, maxLines = MAX_LINES_FILE) {
  const files = [];
  let file = null, hunk = null, o = 0, n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = { path: m ? m[2] : line.slice(11), old: m ? m[1] : null, status: "M", add: 0, del: 0, binary: false, hunks: [], lines: 0, cut: false, header: [line], quoted: !m, modeOnly: false };
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (!hunk && line.startsWith("new file")) { file.status = "A"; file.header.push(line); }
    else if (!hunk && line.startsWith("deleted file")) { file.status = "D"; file.header.push(line); }
    else if (!hunk && line.startsWith("rename from ")) { file.status = "R"; file.old = line.slice(12); file.header.push(line); }
    else if (!hunk && line.startsWith("Binary files")) { file.binary = true; file.header.push(line); }
    else if (!hunk && line.startsWith("GIT binary patch")) { file.binary = true; file.header.push(line); }
    else if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
      o = m ? Number(m[1]) : 0;
      n = m ? Number(m[2]) : 0;
      hunk = { head: line, ctx: m?.[3] ?? "", lines: [], raw: [], cut: false };
      file.hunks.push(hunk);
    } else if (hunk) {
      const c = line[0];
      if (c === "\\") { if (!hunk.cut) hunk.raw.push(line); continue; } // "\ No newline at end of file" is left out of the lines, kept in raw
      if (c !== "+" && c !== "-" && c !== " ") continue;
      if (file.lines >= maxLines) { file.cut = true; hunk.cut = true; continue; }
      hunk.raw.push(line);
      if (c === "+") { hunk.lines.push({ t: "+", text: line.slice(1), n: n++ }); file.add++; file.lines++; }
      else if (c === "-") { hunk.lines.push({ t: "-", text: line.slice(1), o: o++ }); file.del++; file.lines++; }
      else { hunk.lines.push({ t: " ", text: line.slice(1), o: o++, n: n++ }); file.lines++; }
    } else file.header.push(line);
  }
  for (const f of files) f.modeOnly = !f.hunks.length && !f.binary && f.header.some((l) => l.startsWith("old mode ") || l.startsWith("new mode "));
  return files;
}

// Whether the hunk's own lines add up to the counts its header states (a hunk that was cut, or read badly, doesn't).
function counts(h) {
  const m = h.head.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
  if (!m) return false;
  let a = 0, b = 0;
  for (const l of h.raw) { const c = l[0]; if (c === " ") { a++; b++; } else if (c === "-") a++; else if (c === "+") b++; }
  return a === (m[1] == null ? 1 : Number(m[1])) && b === (m[2] == null ? 1 : Number(m[2]));
}

// Why no patch can be made from this hunk, or null when one can.
export function hunkProblem(file, hi) {
  const h = file?.hunks?.[hi];
  if (!file) return "No such file.";
  if (file.binary) return "A binary file has no hunks to apply.";
  if (file.quoted) return "This file's name needs quoting; git's own commands can do it.";
  if (file.modeOnly) return "Only the file's mode changed.";
  if (!h) return "No such hunk.";
  if (h.cut || file.cut) return "This hunk is cut short in the panel (too many lines).";
  if (!h.raw.length || !counts(h)) return "This hunk's lines don't match its header.";
  return null;
}

const NAME = (p) => (/\s/.test(p) ? `${p}\t` : p);

// The patch of one hunk: git's own header lines minus the ones about the rest of the file (`index`, modes,
// similarity), then the hunk as printed. A renamed file's patch is a plain change of its new path (the working
// tree has only that one). The hunk keeps its header, whose old start is where it is found when applied forward
// (`--cached`) and whose new start where it is found when applied in reverse (`-R`): both are right for the
// file the diff was made from. Null when hunkProblem says no.
export function hunkPatch(file, hi) {
  if (hunkProblem(file, hi)) return null;
  const h = file.hunks[hi];
  let head;
  if (file.status === "R") head = [`diff --git a/${file.path} b/${file.path}`, `--- a/${NAME(file.path)}`, `+++ b/${NAME(file.path)}`];
  else head = file.header.filter((l) => l.startsWith("diff --git ") || l.startsWith("new file mode ") || l.startsWith("deleted file mode ") || l.startsWith("--- ") || l.startsWith("+++ "));
  if (!head.some((l) => l.startsWith("--- "))) {
    // A diff made without its ---/+++ lines (never from git diff): build them.
    head.push(file.status === "A" ? "--- /dev/null" : `--- a/${NAME(file.old ?? file.path)}`, file.status === "D" ? "+++ /dev/null" : `+++ b/${NAME(file.path)}`);
  }
  return [...head, h.head, ...h.raw].join("\n") + "\n";
}

// What a file's hunks may be sent through `git apply`: Revert hunk needs the working tree to be what the diff was
// made against (HEAD), Stage hunk also a file the index holds as HEAD does (no staged change) and not a rename.
export function hunkActions(file, hi, { worktree = false, staged = false } = {}) {
  const why = hunkProblem(file, hi);
  if (why || !worktree) return { revert: false, stage: false, why: why ?? "Only the uncommitted changes can be reverted or staged." };
  return { revert: true, stage: !staged && file.status !== "R", why: null };
}

// ---- running them (`run` is herdr's exec, or any function with its shape: run(cmd, args, { cwd, on }) -> { code, stdout, stderr }) ----

export const MAX_PATCH = 400000; // characters: a patch goes through the command line (exec has no stdin)

const GITQ = ["--no-optional-locks", "-c", "core.quotePath=false"];
// The first lines of what git said, for the Diff's note line.
export const gitSaid = (r) => String(r?.stderr || r?.stdout || "git failed").trim().split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 300);

// `git apply <flags>` of a patch that is written to a file in the repository's git directory first (exec has no
// stdin) and removed after. Flags: ["-R"] (undo it in the working tree), ["--cached"] (into the index), ["--index"],
// [] (the working tree), plus "--ignore-whitespace" when the diff was made with -w.
export async function applyPatch(run, ctx, patch, flags = []) {
  if (patch.length > MAX_PATCH) return { ok: false, err: "That patch is too big to apply from here." };
  const script = 'p=$(git rev-parse --git-path ht3-hunk.patch) || exit 1; printf "%s" "$1" > "$p" || exit 1; shift; git apply "$@" "$p"; rc=$?; rm -f "$p"; exit $rc';
  const r = await run("sh", ["-c", script, "sh", patch, ...flags], { cwd: ctx.cwd, on: ctx.on });
  return r.code === 0 ? { ok: true } : { ok: false, err: gitSaid(r) };
}

// One hunk through `git apply`: kind "revert" (-R on the working tree) or "stage" (--cached). `ws`: the diff hid
// whitespace, so the hunk's context may differ from the file in whitespace. { ok, err, undo } where undo is the
// steps that put it back ([{ patch, flags }]): the same patch applied forward, or unstaged.
export async function applyHunk(run, ctx, file, hi, kind, ws = false) {
  const patch = hunkPatch(file, hi);
  if (!patch) return { ok: false, err: hunkProblem(file, hi) ?? "No patch for this hunk." };
  const w = ws ? ["--ignore-whitespace"] : [];
  const r = await applyPatch(run, ctx, patch, kind === "stage" ? ["--cached", ...w] : ["-R", ...w]);
  if (!r.ok) return r;
  return { ok: true, undo: kind === "stage" ? [{ patch, flags: ["-R", "--cached", ...w] }] : [{ patch, flags: w }] };
}

// Put a file back as HEAD has it (staged and unstaged changes both): git restore for one HEAD has, `git rm -f` for
// one it doesn't (a new file), `rm` for an untracked one. { ok, err, untracked, undo }: the undo steps are the file's
// changes as binary-safe patches taken before: the staged ones applied with --index, the unstaged ones after.
export async function revertFile(run, ctx, file) {
  const g = (args) => run("git", [...GITQ, ...args], { cwd: ctx.cwd, on: ctx.on });
  if (file.quoted || !file.path || file.path.startsWith("-")) return { ok: false, err: "This file's name needs quoting; use git itself." };
  const paths = [...new Set([file.path, file.status === "R" ? file.old : null].filter(Boolean))];
  // Tracked: in the index, or in HEAD (a file whose deletion is staged is in neither the index nor the tree).
  const tracked = (await g(["ls-files", "--error-unmatch", "--", file.path])).code === 0 || (await g(["cat-file", "-e", `HEAD:${file.path}`])).code === 0;
  if (!tracked) {
    const snap = await run("git", [...GITQ, "diff", "--no-index", "--binary", "--no-color", "--", "/dev/null", file.path], { cwd: ctx.cwd, on: ctx.on });
    if (!snap.stdout) return { ok: false, err: `Couldn't read ${file.path} to keep a copy for Undo.` };
    const rm = await run("rm", ["-f", "--", file.path], { cwd: ctx.cwd, on: ctx.on });
    return rm.code === 0 ? { ok: true, untracked: true, undo: [{ patch: snap.stdout, flags: [] }] } : { ok: false, err: gitSaid(rm) };
  }
  const staged = await g(["diff", "--cached", "--binary", "--find-renames", "--no-color", "--no-ext-diff", "--", ...paths]);
  const unstaged = await g(["diff", "--binary", "--no-color", "--no-ext-diff", "--", ...paths]);
  if (staged.code !== 0 || unstaged.code !== 0) return { ok: false, err: gitSaid(staged.code !== 0 ? staged : unstaged) };
  for (const p of paths) {
    const inHead = (await g(["cat-file", "-e", `HEAD:${p}`])).code === 0;
    const r = inHead ? await g(["restore", "--source=HEAD", "--staged", "--worktree", "--", p]) : await g(["rm", "-f", "-q", "--", p]);
    if (r.code !== 0) return { ok: false, err: gitSaid(r) };
  }
  const undo = [];
  if (staged.stdout.trim()) undo.push({ patch: staged.stdout, flags: ["--index"] });
  if (unstaged.stdout.trim()) undo.push({ patch: unstaged.stdout, flags: [] });
  return { ok: true, untracked: false, undo };
}

// Undo: the saved steps in order; stops at the first that fails.
export async function redo(run, ctx, steps) {
  for (const s of steps) { const r = await applyPatch(run, ctx, s.patch, s.flags); if (!r.ok) return r; }
  return { ok: true };
}
