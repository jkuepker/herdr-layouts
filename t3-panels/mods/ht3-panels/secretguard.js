// The commit guard (Project popover, menus.js Commit): before a commit the changes it would commit are read through
// a throwaway index (`git add -A` there, `git diff --cached` of it, so the real index is untouched and Cancel leaves
// everything as it was) and checked with secrets.js: paths such as `.env` or `*.pem`, and the added lines for tokens,
// keys and `password = "..."`. Found something -> the Commit step shows a warning (masked previews) with "Commit
// anyway" and "Cancel". Nothing here commits; Commit anyway calls the owner's `commit` again.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec } from "herdr";
import { alpha, icon, button } from "./look.js";
import { isSecretPath, scanDiff } from "./secrets.js";

const MAX_DIFF = 4000000; // bytes of the staged diff read
const SHOW = 8; // findings listed
const mark = () => `@@ht3-${Math.random().toString(36).slice(2)}@@`;

// The findings in the output of `git diff --cached --name-only` and `git diff --cached -U0`.
// -> [{ file, line?, kind, preview? }]: a secret path first, then what the added lines hold.
export function findingsOf(names, diff) {
  const out = [];
  for (const file of String(names ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) if (isSecretPath(file)) out.push({ file, kind: "secret file" });
  out.push(...scanDiff(diff));
  return out;
}

// What Commit would commit, checked. -> [] when nothing was found (and when git couldn't say: the guard doesn't stop a commit it can't read).
export async function stagedFindings({ cwd, on = null }) {
  const sep = mark();
  const script = 'i=$(mktemp) || exit 1; cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null || rm -f "$i"; '
    + 'export GIT_INDEX_FILE="$i"; git add -A >/dev/null 2>&1; '
    + 'git -c core.quotepath=off diff --cached --no-color --no-ext-diff --name-only; printf \'%s\\n\' "$1"; '
    + `git -c core.quotepath=off diff --cached --no-color --no-ext-diff -U0 | head -c ${MAX_DIFF}; rm -f "$i"`;
  const r = await exec("sh", ["-c", script, "sh", sep], { cwd, on, timeout: 30000 }).catch(() => null);
  if (!r || typeof r.stdout !== "string") return [];
  const at = r.stdout.indexOf(`${sep}\n`);
  if (at < 0) return [];
  return findingsOf(r.stdout.slice(0, at), r.stdout.slice(at + sep.length + 1));
}

// The one hook in the commit: `if (await holdForSecrets(this, opt)) return;` at the start of what runs the commit.
// `owner.guard` is { findings, ok }: set when the commit is held, `ok` once Commit anyway was pressed. -> true when
// the commit must not go on (the warning shows in its place).
export async function holdForSecrets(owner, opt) {
  if (owner.guard?.ok) { owner.guard = null; return false; }
  const findings = await stagedFindings(opt);
  owner.guard = findings.length ? { findings, ok: false } : null;
  return findings.length > 0;
}

// The warning step, shown under the Commit row while owner.guard is set.
export function guardStep(k, owner) {
  const g = owner.guard;
  if (!g) return null;
  const files = new Set(g.findings.map((f) => f.file)).size;
  const row = (f, i) => h_flex().gap(6).items_center().min_w(0).text_size(11).line_height("16px")
    .child(icon(f.kind === "secret file" ? "lock" : "triangle-alert").size(12).flex_none().text_color(k.warningText))
    .child(div().flex_1().min_w(0).truncate().font_family(k.mono).text_color(k.foreground).child(f.line ? `${f.file}:${f.line}` : f.file))
    .child(div().flex_none().text_color(k.muted).child(f.preview ? `${f.kind} ${f.preview}` : f.kind));
  return v_flex().id("secret-guard").mx(8).my(4).p(8).gap(6).rounded(6).bg(alpha(k.warning, k.dark ? 0.16 : 0.08)).border(1).border_color(alpha(k.warning, 0.4))
    .child(div().text_size(12).line_height("16px").font_medium().text_color(k.warningText).child(`This commit may include secrets: ${g.findings.length} found in ${files} file${files === 1 ? "" : "s"}.`))
    .children(g.findings.slice(0, SHOW).map(row))
    .when(g.findings.length > SHOW, (e) => e.child(div().text_size(11).text_color(k.muted).child(`and ${g.findings.length - SHOW} more`)))
    .child(div().text_size(11).line_height("15px").text_color(k.muted).child("Nothing is committed yet."))
    .child(h_flex().gap(6).justify_end()
      .child(button(k, "secret-cancel", "Cancel", (cx) => { owner.guard = null; cx.notify(); }, { variant: "outline" }))
      .child(button(k, "secret-anyway", "Commit anyway", (cx) => { g.ok = true; owner.commit(cx); }, { variant: "destructive", disabled: !!owner.busy })));
}
