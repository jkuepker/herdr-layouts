// A failed check's log, made readable (no Herdr imports, so node tests it): the run and job a check belongs to, from its
// details URL, and the output of `gh run view <run> --log-failed` cleaned up: ANSI colors, the byte order mark and the
// timestamp GitHub puts in front of every line are gone, the job and step names become headers, and only the end is kept.
//
// `gh run view --log-failed` prints one line per log line as `<job>\t<step>\t<timestamp> <text>`; a job whose steps GitHub
// can't tell apart (or a log fetched as a whole) has the step "UNKNOWN STEP".

export const LOG_LINES = 300; // what the Log step shows
export const PROMPT_LINES = 150; // what "Fix with agent" puts into the message box
const LINE_MAX = 400; // a longer log line is cut here
const PROMPT_CHARS = 14000;

// The run, job and repository of a check, from its details URL: .../actions/runs/<run>/job/<job>. Null for checks that aren't a
// GitHub Actions job (external CI, commit statuses): they have no run to ask about.
export function runIdOf(url) {
  const m = String(url ?? "").match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/i);
  // `repo` is what gh's -R takes: OWNER/REPO, or HOST/OWNER/REPO on a GitHub Enterprise server.
  return m ? { run: m[4], job: m[5] ?? null, repo: m[1].toLowerCase() === "github.com" ? `${m[2]}/${m[3]}` : `${m[1]}/${m[2]}/${m[3]}` } : null;
}

// The distinct runs among checks (a run holds many jobs; one `gh run rerun --failed` covers them all).
export function failedRuns(checks) {
  const seen = new Map();
  for (const c of checks) {
    if (c.tone !== "bad") continue;
    const id = runIdOf(c.url);
    if (id && !seen.has(`${id.repo}#${id.run}`)) seen.set(`${id.repo}#${id.run}`, { run: id.run, repo: id.repo, name: c.group ?? c.name });
  }
  return [...seen.values()];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

// One line of text with colors, timestamp and byte order mark removed.
export function cleanText(s) {
  return String(s ?? "").replace(/^\uFEFF+/, "").replace(STAMP, "").replace(ANSI, "").replace(/\uFEFF/g, "").replace(/\r+$/, "").replace(/\x1b/g, "");
}

// A runner's own markup: ##[group]Run tests -> "▸ Run tests", ##[error]x -> "error: x", ##[command]x -> "$ x";
// ##[endgroup] and ##[debug] lines are dropped (null).
function markup(text) {
  const m = text.match(/^##\[(\w+)\]\s?(.*)$/);
  if (!m) return text;
  switch (m[1]) {
    case "group": return `▸ ${m[2]}`;
    case "error": return `error: ${m[2]}`;
    case "warning": return `warning: ${m[2]}`;
    case "notice": return `notice: ${m[2]}`;
    case "command": return `$ ${m[2]}`;
    case "endgroup": case "debug": return null;
    default: return text;
  }
}

// gh's raw output -> [{ job, step, text }]. A line without the job and step columns belongs to the one before it.
export function parseLog(raw) {
  const out = [];
  let job = "", step = "";
  for (const line of String(raw ?? "").split("\n")) {
    const a = line.indexOf("\t"), b = a < 0 ? -1 : line.indexOf("\t", a + 1);
    let body = line;
    if (b > 0) { job = line.slice(0, a); step = line.slice(a + 1, b); body = line.slice(b + 1); }
    out.push({ job, step, text: cleanText(body) });
  }
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  return out;
}

const headOf = (job, step) => [job, step && step !== "UNKNOWN STEP" ? step : ""].filter(Boolean).join(" › ");

// The rows to show: { kind: "head" | "line" | "error", text }. Job and step names are headers (a new one whenever they
// change); blank runs shrink to one blank line; the last `max` rows are kept, headed by the header they belong to.
// -> { rows, total (log lines in all), hidden (log lines cut off at the start), empty }
export function logRows(raw, { max = LOG_LINES } = {}) {
  const rows = [];
  let at = null, total = 0;
  for (const e of parseLog(raw)) {
    const text = markup(e.text);
    if (text == null) continue;
    const key = `${e.job}\t${e.step}`;
    if (key !== at && (e.job || e.step)) { at = key; const h = headOf(e.job, e.step); if (h) rows.push({ kind: "head", text: h }); }
    const blank = !text.trim();
    if (blank && (!rows.length || rows[rows.length - 1].kind === "head" || !rows[rows.length - 1].text.trim())) continue;
    total += 1;
    const shown = text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)} […]` : text.replace(/\s+$/, "");
    rows.push({ kind: /^error: /.test(text) ? "error" : "line", text: shown });
  }
  while (rows.length && !rows[rows.length - 1].text.trim() && rows[rows.length - 1].kind !== "head") rows.pop();
  if (rows.length <= max) return { rows, total, hidden: 0, empty: total === 0 };
  let kept = rows.slice(rows.length - max);
  if (kept[0].kind !== "head") {
    // The header of the section the cut falls in goes first, so the tail still says whose it is.
    let h = null;
    for (let i = rows.length - max - 1; i >= 0 && !h; i--) if (rows[i].kind === "head") h = rows[i];
    kept = h ? [h, ...kept.slice(1)] : kept;
  }
  const hidden = total - kept.filter((r) => r.kind !== "head").length;
  return { rows: kept, total, hidden, empty: false };
}

// "Fix with agent": the short prompt for the message box, with the failure log trimmed to `lines` rows (not sent).
// `info`: { name, branch, number, url }.
export function fixPrompt(info, raw, { lines = PROMPT_LINES } = {}) {
  const r = logRows(raw, { max: lines });
  let body = r.rows.map((x) => (x.kind === "head" ? `--- ${x.text} ---` : x.text)).join("\n");
  if (body.length > PROMPT_CHARS) body = `[…]\n${body.slice(body.length - PROMPT_CHARS).replace(/^[^\n]*\n/, "")}`;
  const where = [info.number ? `PR #${info.number}` : null, info.branch ? `branch ${info.branch}` : null].filter(Boolean).join(", ");
  return [`The CI check "${info.name}" failed${where ? ` (${where})` : ""}. Find the cause in the log below and fix it in this folder; don't push.`,
    "",
    `Log of the failed check, ${r.hidden > 0 ? `last ${lines} lines of ${r.total}` : "all of it"}:`,
    "```", body, "```"].join("\n");
}

// What `gh run view` / `gh run rerun` said when it failed, in words.
export function explainRun(err, { on = null } = {}) {
  const text = String(err?.message ?? err ?? "").trim();
  if (/(?:cannot run|cannot start|can't start|failed to spawn) gh\b|ENOENT/i.test(text))
    return `The GitHub CLI (gh) isn't installed ${on ? `on ${on}` : "here"}. Install it from cli.github.com, then sign in with gh auth login.`;
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401/i.test(text)) return "gh isn't signed in. Run gh auth login in a terminal.";
  if (/still in progress|in progress/i.test(text)) return "That run is still going: GitHub has no log until it finishes.";
  if (/log not found|logs? (?:have|has) (?:been )?expired|HTTP 410/i.test(text)) return "GitHub has no log for this run (it expired or wasn't kept).";
  if (/cannot be rerun|can't be rerun|HTTP 403|Must have admin|resource not accessible/i.test(text)) return `GitHub won't let you re-run it: ${text.split("\n")[0].replace(/^.*?:\s*/, "") || "no permission"}.`;
  if (/HTTP 404|Not Found|Could not resolve/i.test(text)) return "GitHub doesn't know that run (any more).";
  return text.split("\n")[0] || "gh failed.";
}
