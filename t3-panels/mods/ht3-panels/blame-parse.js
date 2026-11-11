// What `git blame --porcelain` and `git log --follow` print, parsed (no Herdr imports: the Files editor's blame gutter and its
// History step, blame.js, draw what comes out of here; the tests run it on real output).
//
// Porcelain: for each line of the file, a header `<40 hex> <line in the original> <line in the file> [<lines in this group>]`,
// then, only the first time a commit shows up, its facts (`author`, `author-time`, `summary`, `boundary`, `previous`,
// `filename`, ...), then the line's text behind a tab. Later lines of a known commit have the header and the text alone.

// Lines blamed at most (a bigger file is asked for with -L 1,<CAP>), and log entries kept.
export const BLAME_CAP = 5000;
export const LOG_MAX = 100;

const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/;
const NOT_COMMITTED = /^0+$/;

// The arguments after `git` that blame `path` (relative to the folder git runs in); `capped` asks for the first BLAME_CAP lines only.
export const blameArgs = (path, capped = false) => ["--no-optional-locks", "blame", "--porcelain", ...(capped ? ["-L", `1,${BLAME_CAP}`] : []), "--", path];

// `git log --follow` of one file: hash, short hash, author, author time (seconds), subject; fields parted by the unit separator.
export const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s";
export const logArgs = (path, n = LOG_MAX) => ["--no-optional-locks", "log", "--follow", "-n", String(n), LOG_FORMAT, "--", path];

// -> { lines: [{ hash, orig, final }] in the order git printed them (the file's order), commits: { <hash>: { hash, author, mail, time,
//      tz, summary, boundary, uncommitted, previous, filename } } }
export function parseBlame(text) {
  const lines = [], commits = Object.create(null);
  let cur = null;
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.startsWith("\t")) {
      if (cur) lines.push({ hash: cur.hash, orig: cur.orig, final: cur.final });
      cur = null;
      continue;
    }
    const h = HEADER.exec(raw);
    if (h) {
      cur = { hash: h[1], orig: Number(h[2]), final: Number(h[3]) };
      if (!commits[cur.hash]) commits[cur.hash] = { hash: cur.hash, author: "", mail: "", time: 0, tz: "", summary: "", boundary: false, uncommitted: NOT_COMMITTED.test(cur.hash), previous: null, filename: "" };
      cur.info = commits[cur.hash];
      continue;
    }
    if (!cur || !raw) continue;
    const at = raw.indexOf(" "), key = at < 0 ? raw : raw.slice(0, at), val = at < 0 ? "" : raw.slice(at + 1), c = cur.info;
    if (key === "author") c.author = val;
    else if (key === "author-mail") c.mail = val.replace(/^<|>$/g, "");
    else if (key === "author-time") c.time = Number(val) || 0;
    else if (key === "author-tz") c.tz = val;
    else if (key === "summary") c.summary = val;
    else if (key === "boundary") c.boundary = true;
    else if (key === "previous") c.previous = val;
    else if (key === "filename") c.filename = val;
  }
  lines.sort((a, b) => a.final - b.final);
  // Where each commit's run of lines begins: the gutter shows a commit's text on the first line of a run only.
  const rows = lines.map((l, i) => ({ hash: l.hash, line: l.final, first: i === 0 || lines[i - 1].hash !== l.hash || lines[i - 1].final + 1 !== l.final }));
  return { lines, rows, commits };
}

// "3 d ago": the age of `seconds` (a unix time) at `now` (seconds).
export function relTime(seconds, now = Date.now() / 1000) {
  if (!seconds) return "";
  const s = Math.max(0, Math.round(now - seconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} d ago`;
  if (d < 60) return `${Math.floor(d / 7)} w ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} y ago`;
}

// "Josef Kuepker" -> "Josef K."; a single word stays; cut to `max` characters.
export function shortAuthor(name, max = 14) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  let s = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] ?? "";
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

// What the gutter says of a commit: author and age, or "not committed".
export function blameLabel(c, now = Date.now() / 1000) {
  if (!c) return { who: "", when: "", subject: "" };
  if (c.uncommitted) return { who: "", when: "", subject: "not committed" };
  return { who: shortAuthor(c.author), when: relTime(c.time, now), subject: c.summary };
}

// The hover text of a commit: hash, author, date and the whole subject.
export function blameTip(c) {
  if (!c) return "";
  if (c.uncommitted) return "Not committed yet";
  const date = c.time ? new Date(c.time * 1000).toISOString().slice(0, 10) : "";
  return `${c.hash.slice(0, 8)} · ${c.author}${date ? ` · ${date}` : ""}${c.boundary ? " · boundary commit" : ""}\n${c.summary}\nClick to open this commit in Diff.`;
}

// A commit's hash is something a click may pass on to Diff: hex and nothing else (never a ref that starts with -).
export const isHash = (s) => /^[0-9a-f]{7,64}$/.test(String(s ?? ""));

// The `git log --follow` output -> [{ hash, short, author, time, subject }], at most `max`.
export function parseLog(text, max = LOG_MAX) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    const f = line.split("\x1f");
    if (f.length < 5 || !isHash(f[0])) continue;
    out.push({ hash: f[0], short: f[1], author: f[2], time: Number(f[3]) || 0, subject: f.slice(4).join("\x1f") });
    if (out.length >= max) break;
  }
  return out;
}

// The first line git says when blame can't run, in words for the gutter.
export function blameProblem(stderr) {
  const s = String(stderr ?? "").trim().split("\n")[0] ?? "";
  if (/no such path|not tracked|cannot stat|no such file/i.test(s)) return "Blame: this file isn't tracked by git yet.";
  if (/not a git repository/i.test(s)) return "Blame: this folder isn't in a git repository.";
  if (/no such ref|bad revision|does not have any commits|unknown revision/i.test(s)) return "Blame: this repository has no commits yet.";
  return s ? `Blame: ${s}` : "Blame failed.";
}
