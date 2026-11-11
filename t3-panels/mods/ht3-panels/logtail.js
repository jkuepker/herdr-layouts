// Tailing a log file (the Logs surface, logs.js), as pure logic: ANSI stripping, the line filter, the error/warning
// colouring, the offset and rotation decisions, and the text sent to a chat. No Herdr imports, so node can test it.
//
// How a file is followed: each poll runs POLL (a shell script) with the byte offset read so far and the file's inode.
// The script prints a header line "<size> <inode>" (or "missing"), and, when the file only grew, the bytes from the
// offset on. `Tailer.plan(header)` says what that means (first read, nothing new, new bytes, the file was
// truncated or replaced), and `Tailer.take(...)` folds the text in. Only complete lines are taken: the offset moves by
// the UTF-8 length of the text up to the last newline, so a line still being written is read again, whole, next time.

export const TAIL_LINES = 1000; // lines read when a file is first shown (`tail -n 1000`) and again after a rotation
export const KEEP = 5000; // lines kept
export const LINE_MAX = 4000; // characters of a line kept
export const APPEND_MAX = 1048576; // bytes read at once as new; a file that gained more is read from its end again
export const SEND_MAX = 400; // lines "Send to chat" puts into the box at most

// ---- text ----

// CSI sequences (colours, cursor moves, erase), OSC sequences (titles, links), and the two-character escapes.
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s ?? "").replace(ANSI, "");

// What a terminal would have left of the line: the text after the last carriage return (a progress bar's final frame),
// without escapes, trailing blanks and other control characters.
export const cleanLine = (line) => {
  const s = stripAnsi(String(line ?? "").replace(/\r+$/, "").split("\r").pop()).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\s+$/, "");
  return s.length > LINE_MAX ? `${s.slice(0, LINE_MAX)}…` : s;
};

// The number of bytes `s` takes in UTF-8.
export function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// Text -> { text: the complete lines (up to and with the last newline), rest: what follows it }.
export function completePart(text) {
  const s = String(text ?? ""), at = s.lastIndexOf("\n");
  return at < 0 ? { text: "", rest: s } : { text: s.slice(0, at + 1), rest: s.slice(at + 1) };
}
// Complete text -> cleaned lines (the text's closing newline makes no empty line).
export const linesOf = (text) => {
  const t = String(text ?? "");
  if (!t) return [];
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n").map(cleanLine);
};

// ---- filter and colour ----

// The filter box: "" keeps everything; a text that starts with "/" is a regular expression (`/timeout|refused/`,
// `/Error/` keeps the case, flags after a closing slash: `/error/i`; without a closing slash it is all pattern and
// ignores case); anything else is a plain substring, case ignored. -> { test(line), error: text | null, regex: bool }.
export function makeFilter(q) {
  const raw = String(q ?? "");
  if (!raw.trim()) return { test: () => true, error: null, regex: false, empty: true };
  if (raw.startsWith("/")) {
    const body = raw.slice(1), close = body.lastIndexOf("/");
    let src = body, flags = "i";
    if (close >= 0 && /^[a-z]*$/.test(body.slice(close + 1))) { src = body.slice(0, close); flags = body.slice(close + 1); }
    if (!src) return { test: () => true, error: null, regex: true, empty: true };
    try {
      const re = new RegExp(src, flags.replace(/[gy]/g, ""));
      return { test: (line) => re.test(line), error: null, regex: true, empty: false };
    } catch (e) {
      return { test: () => true, error: String(e?.message ?? e).replace(/^Invalid regular expression: /, ""), regex: true, empty: false };
    }
  }
  const needle = raw.toLowerCase();
  return { test: (line) => line.toLowerCase().includes(needle), error: null, regex: false, empty: false };
}

// "error" | "warn" | null for a line: a level word as logs print it (`ERROR`, `[error]`, `level=error`, `Error:`), a
// failure word, or a stack frame's header. Deliberately simple.
const ERR = /\b(?:error|err|fatal|fail(?:ed|ure)?|exception|panic|critical|traceback|unhandled|uncaught|segfault)\b|\bE(?:NOENT|ACCES|ADDRINUSE|CONNREFUSED|CONNRESET|PERM|PIPE|XIST|TIMEDOUT|ISDIR|NOTDIR|MFILE|INVAL)\b|^\s*at .+\(.+:\d+:\d+\)$/i;
const WARN = /warn(?:ing)?|deprecat(?:ed|ion)|\bcaution\b/i;
export function levelOf(line) {
  if (ERR.test(line)) return "error";
  if (WARN.test(line)) return "warn";
  return null;
}

// The lines the filter keeps, with their index in `lines`. -> [{ i, line, level }]
export function visible(lines, filter) {
  const out = [];
  for (let i = 0; i < lines.length; i++) if (filter.test(lines[i])) out.push({ i, line: lines[i], level: levelOf(lines[i]) });
  return out;
}

// ---- following ----

// The shell script of one poll. $1 the file, $2 the offset read so far (-1: none yet), $3 its inode, $4 the most
// bytes to read as new. Prints "<size> <inode>", or "missing", then:
//  - offset -1: the last 1000 lines of what the file held at that size (`tail -n 1000`), so the size and the text agree;
//  - the same file and it grew by at most $4 bytes: the new bytes only (`tail -c +<offset+1>`);
//  - otherwise nothing: the caller decides from the header (truncated, replaced, nothing new, grew by more than $4).
export const POLL = 'f="$1"; [ -f "$f" ] || { echo missing; exit 0; }\n'
  + 's=$(wc -c < "$f" | tr -d " "); i=$(stat -c %i "$f" 2>/dev/null || stat -f %i "$f" 2>/dev/null)\n'
  + 'echo "$s $i"\n'
  + `if [ "$2" -lt 0 ]; then head -c "$s" "$f" | tail -n ${TAIL_LINES}\n`
  + 'elif [ "$i" = "$3" ] && [ "$s" -gt "$2" ] && [ $((s - $2)) -le "$4" ]; then tail -c +$(($2 + 1)) "$f" | head -c $((s - $2)); fi';

export const pollArgs = (path, t) => [path, String(t.offset ?? -1), t.ino ?? "", String(APPEND_MAX)];

// The script's stdout -> { missing } or { size, ino, body }.
export function parseReply(stdout) {
  const s = String(stdout ?? ""), at = s.indexOf("\n"), head = (at < 0 ? s : s.slice(0, at)).trim();
  if (head === "missing") return { missing: true, size: 0, ino: null, body: "" };
  const m = head.match(/^(\d+)(?: (\S+))?$/);
  if (!m) return null;
  return { missing: false, size: Number(m[1]), ino: m[2] ?? "", body: at < 0 ? "" : s.slice(at + 1) };
}

export class Tailer {
  constructor({ keep = KEEP } = {}) {
    this.keep = keep;
    this.reset();
  }
  reset() {
    this.lines = [];
    this.offset = null; // bytes read so far (up to the last complete line); null: nothing read yet
    this.ino = null;
    this.size = 0;
    this.dropped = 0; // lines let go past `keep`
    this.rotations = 0;
    this.missing = false;
  }

  // What a header means: "init" (nothing read yet), "missing", "idle" (nothing new), "append" (new bytes follow the
  // header), "again" (truncated, replaced or grown too much: ask again from the end, with offset -1).
  plan(r) {
    if (!r) return "idle";
    if (r.missing) return "missing";
    if (this.offset == null) return "init";
    if ((this.ino && r.ino && r.ino !== this.ino) || r.size < this.offset) return "again";
    if (r.size === this.offset) return "idle";
    return r.size - this.offset > APPEND_MAX ? "again" : "append";
  }

  // Folds a reply in after plan() said "init", "append" or (on the second ask) "again". `mode` is what plan() said.
  // -> { added: lines appended, replaced: the list was rebuilt }.
  take(mode, r) {
    this.missing = false;
    if (mode === "missing") { this.missing = true; return { added: 0, replaced: false }; }
    if (mode === "idle") { this.size = r.size; return { added: 0, replaced: false }; }
    const part = completePart(r.body), got = linesOf(part.text);
    this.size = r.size;
    this.ino = r.ino || this.ino;
    if (mode === "append") {
      this.offset += utf8Len(part.text);
      this.push(got);
      return { added: got.length, replaced: false };
    }
    // The first read, or a read again after a truncation or a replacement: the lines are the file's last ones. A
    // partial last line stays unread (it is read whole when it is finished).
    if (mode === "again") this.rotations++;
    this.lines = [];
    this.dropped = 0;
    this.offset = Math.max(0, r.size - utf8Len(part.rest));
    this.push(got);
    return { added: got.length, replaced: true };
  }

  push(got) {
    for (const l of got) this.lines.push(l);
    if (this.lines.length > this.keep) {
      const cut = this.lines.length - this.keep;
      this.lines.splice(0, cut);
      this.dropped += cut;
    }
  }
  clear() { this.dropped += this.lines.length; this.lines = []; }
}

// ---- send to chat ----

// How many lines "Send to chat" puts in: n a number, or "all" (the visible ones); never more than SEND_MAX.
export const sendCount = (n, total) => Math.max(0, Math.min(SEND_MAX, n === "all" ? total : Math.min(Number(n) || 0, total)));

// The message: the last `count` of the visible lines, in a code block under a line saying where they are from.
export function sendText(path, rows, count, { filter = "" } = {}) {
  const lines = rows.slice(-count).map((r) => (typeof r === "string" ? r : r.line));
  if (!lines.length) return "";
  const fence = lines.some((l) => l.includes("```")) ? "````" : "```";
  const head = `The last ${lines.length} line${lines.length === 1 ? "" : "s"} of ${path}${String(filter).trim() ? ` (filtered by ${String(filter).trim()})` : ""}:`;
  return `${head}\n\n${fence}\n${lines.join("\n")}\n${fence}\n`;
}
