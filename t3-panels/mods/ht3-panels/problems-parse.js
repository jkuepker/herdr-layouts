// Problems from the output of a check command (the Checks surface, checks.js): tsc, eslint (stylish and unix),
// vitest, jest, pytest, cargo and rustc, and any other tool that prints `path:line:col: message`.
// No Herdr imports: plain text in, rows out, so node can test it.
//
// parseProblems(text) -> { problems: [{ file, line, col, message, severity, code, tool }], tools: [names] }
// A row: file as the tool printed it, line and col from 1 (0 when the tool gave none), severity "error" | "warning"
// | "info", code the rule or error code when there is one. Every specific parser claims the lines it read; the
// generic `path:line:col: message` pass reads only the lines nobody claimed, so one output with tsc and eslint in
// it (`npm run check`) is read by each in turn and no line counts twice.

export const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
// What a terminal would have left on the line: the text after the last carriage return, without colors.
export const clean = (line) => String(line ?? "").replace(/\r+$/, "").split("\r").pop().replace(ANSI, "").replace(/\s+$/, "");
export const linesOf = (text) => String(text ?? "").split("\n").map(clean);

// `at`: the index of the output line the row was read from, which puts rows from different parsers back in print order.
const row = (tool, file, line, col, message, severity = "error", code = null, at = 0) =>
  ({ tool, file: String(file), line: Number(line) || 0, col: Number(col) || 0, message: String(message).trim(), severity, code: code || null, at });

// ---- tsc ----
// `src/a.ts(12,5): error TS2322: …` (--pretty false) and `src/a.ts:12:5 - error TS2322: …` (pretty, the default in a
// terminal). The lines under the first one, indented, are the rest of the message.
const TSC_PLAIN = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;
function tsc(lines, used) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const plain = lines[i].match(TSC_PLAIN), m = plain ?? lines[i].match(TSC_PRETTY);
    if (!m) continue;
    const r = row("tsc", m[1], m[2], m[3], m[6], m[4], m[5], i);
    used.add(i);
    if (plain) {
      for (let j = i + 1; j < lines.length && j <= i + 4 && /^\s{2,}\S/.test(lines[j]); j++) { used.add(j); r.message += ` ${lines[j].trim()}`; }
    }
    out.push(r);
  }
  return out;
}

// ---- eslint stylish ----
// A file's path on a line of its own, then `  12:5  error  Message  rule` lines under it, then `✖ N problems`.
const ESL_ITEM = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([@\w/.-]+))?$/;
function eslintStylish(lines, used) {
  const out = [];
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { continue; }
    const m = l.match(ESL_ITEM);
    if (m && file) { out.push(row("eslint", file, m[1], m[2], m[4], m[3], m[5], i)); used.add(i); continue; }
    if (/^\S/.test(l) && !/^[✖✔]|^\d+ (problems?|errors?)/.test(l) && !ESL_ITEM.test(l)) {
      // A path: the item lines below it make it a header (checked below), so a header is only taken when one follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      file = j < lines.length && ESL_ITEM.test(lines[j]) ? l.trim() : null;
      if (file) used.add(i);
    }
  }
  return out;
}

// ---- rust ----
// `error[E0425]: cannot find value `x` in this scope` then ` --> src/main.rs:4:20`; a test's panic:
// `thread 'a::b' panicked at src/lib.rs:10:9:` and the message on the next line (older: `panicked at 'msg', src/lib.rs:10:9`).
const RS_HEAD = /^(error|warning)(?:\[(\w+)\])?: (.*)$/;
const RS_ARROW = /^\s*--> (.+?):(\d+):(\d+)\s*$/;
const RS_SKIP = /^(error: (could not compile|aborting due to|test failed)|warning: .*(warnings? emitted|generated \d+ warnings?))/;
function rust(lines, used) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], h = l.match(RS_HEAD);
    if (h && !RS_SKIP.test(l)) {
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const a = lines[j].match(RS_ARROW);
        if (a) { out.push(row("rustc", a[1], a[2], a[3], h[3], h[1], h[2], i)); used.add(i); used.add(j); break; }
        if (RS_HEAD.test(lines[j])) break;
      }
      continue;
    }
    let p = l.match(/^thread '(.*?)' panicked at (.+?):(\d+):(\d+):?$/);
    if (p) {
      const msg = lines.slice(i + 1, i + 4).find((x) => x.trim() && !/^note: /.test(x)) ?? "panicked";
      out.push(row("cargo test", p[2], p[3], p[4], `${p[1]}: ${msg.trim()}`, "error", null, i));
      used.add(i);
      continue;
    }
    p = l.match(/^thread '(.*?)' panicked at '(.*)', (.+?):(\d+):(\d+)$/);
    if (p) { out.push(row("cargo test", p[3], p[4], p[5], `${p[1]}: ${p[2]}`, "error", null, i)); used.add(i); }
  }
  return out;
}

// ---- pytest ----
// A failure's block: `____ test_add ____`, source lines, `E   assert 3 == 4`, then `tests/test_math.py:5: AssertionError`
// (the first frame in the project's own files is where it is placed). Without the block, the summary's `FAILED path::name - why`.
const PY_HEAD = /^_{3,} (.+?) _{3,}$/;
const PY_LOC = /^(\S+?\.py):(\d+): (.*)$/;
const PY_SUMMARY = /^(FAILED|ERROR) (\S+?\.py)(?:::(\S+(?: \S+)*?))?(?: - (.*))?$/;
function pytest(lines, used) {
  const out = [], seen = new Set();
  const flush = (blk) => {
    if (!blk) return;
    const loc = blk.locs.find((x) => !/site-packages|\/lib\/python/.test(x.file)) ?? blk.locs[0];
    if (!loc) return;
    const kind = loc.rest.replace(/^in .*/, "").trim();
    const why = blk.e[0] ?? kind;
    out.push(row("pytest", loc.file, loc.line, 0, `${blk.name}${why ? `: ${why}` : ""}`, "error", null, loc.i));
    seen.add(`${loc.file}::${blk.name}`);
    blk.used.forEach((n) => used.add(n));
  };
  let blk = null, inFailures = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^={3,} .*(FAILURES|ERRORS) .*={3,}$/.test(l)) { inFailures = true; continue; }
    if (/^={3,} .*short test summary info .*={3,}$/.test(l) || /^={3,} .*(passed|failed|error)/.test(l)) { flush(blk); blk = null; inFailures = false; }
    if (inFailures) {
      const h = l.match(PY_HEAD);
      if (h) { flush(blk); blk = { name: h[1].replace(/^ERROR collecting /, ""), e: [], locs: [], used: [i] }; continue; }
      if (!blk) continue;
      if (/^E\s{2,}/.test(l)) { blk.e.push(l.replace(/^E\s+/, "").trim()); blk.used.push(i); continue; }
      const loc = l.match(PY_LOC);
      if (loc) { blk.locs.push({ file: loc[1], line: loc[2], rest: loc[3], i }); blk.used.push(i); }
    }
  }
  flush(blk);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PY_SUMMARY);
    if (!m) continue;
    used.add(i);
    const name = m[3] ?? "";
    if ([...seen].some((s) => s === `${m[2]}::${name}` || (name && s.startsWith(`${m[2]}::`) && s.endsWith(name.split("::").pop())))) continue;
    if (out.some((o) => o.file === m[2] && o.line > 0 && !name)) continue;
    out.push(row("pytest", m[2], 0, 0, `${name ? `${name}: ` : ""}${m[4] ?? (m[1] === "ERROR" ? "error while collecting" : "failed")}`, "error", null, i));
  }
  return out;
}

// ---- jest ----
// `FAIL src/sum.test.js`, then `  ● sum › adds` with the message under it and `at Object.<anonymous> (src/sum.test.js:5:23)`.
const J_AT = /^\s+at (?:.*? \()?(?:file:\/\/)?(.+?):(\d+):(\d+)\)?$/;
function jest(lines, used) {
  const out = [];
  let file = null, cur = null;
  const flush = () => {
    if (cur?.loc) out.push(row("jest", cur.loc.file, cur.loc.line, cur.loc.col, `${cur.name}${cur.msg ? `: ${cur.msg}` : ""}`, "error", null, cur.loc.i));
    else if (cur && file) out.push(row("jest", file, 0, 0, `${cur.name}${cur.msg ? `: ${cur.msg}` : ""}`, "error", null, cur.i));
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(?:FAIL|PASS)\s+(?:\S+ )?(\S+\.\w+)(?:\s+\(.*\))?\s*$/);
    if (f) { flush(); file = /^\s*FAIL/.test(l) ? f[1] : null; continue; }
    if (/^(Test Suites|Tests|Snapshots|Time|Ran all test suites):/.test(l)) { flush(); file = null; continue; }
    const b = l.match(/^\s*● (.+)$/);
    if (b && file) { flush(); cur = { name: b[1].trim(), msg: "", loc: null, i }; used.add(i); continue; }
    if (!cur) continue;
    if (!cur.msg && l.trim() && !/^\s*● /.test(l)) { cur.msg = l.trim().replace(/ \/\/ Object\.is equality$/, ""); used.add(i); continue; }
    const at = l.match(J_AT);
    if (at && !cur.loc && !/node_modules|node:internal/.test(at[1])) { cur.loc = { file: at[1], line: at[2], col: at[3], i }; used.add(i); }
  }
  flush();
  return out;
}

// ---- vitest ----
// ` FAIL  src/a.test.ts > suite > name` (printed twice, as it fails and in the summary), `AssertionError: expected 1 to be 2`,
// ` ❯ src/a.test.ts:10:15`. Suites that fail to load: ` FAIL  src/a.test.ts [ src/a.test.ts ]`.
function vitest(lines, used) {
  const out = [], seen = new Set();
  let cur = null;
  const flush = () => {
    if (cur?.loc) {
      const msg = `${cur.name ? `${cur.name}: ` : ""}${cur.msg || "failed"}`, key = `${cur.loc.file}:${cur.loc.line}:${cur.loc.col}:${msg}`;
      if (!seen.has(key)) { seen.add(key); out.push(row("vitest", cur.loc.file, cur.loc.line, cur.loc.col, msg, "error", null, cur.loc.i)); }
    }
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*FAIL\s+(\S+\.\w+)(?:\s+>\s+(.*?))?(?:\s+\[ .* \])?\s*$/);
    if (f) { flush(); cur = { file: f[1], name: f[2] ?? "", msg: "", loc: null }; used.add(i); continue; }
    if (!cur) continue;
    if (/^\s*[⎯-]{3,}/.test(l) || /^\s*(Test Files|Tests)\s/.test(l)) { flush(); continue; }
    const at = l.match(/^\s*❯\s+(.+?):(\d+):(\d+)\s*$/);
    if (at) { if (!cur.loc && !/node_modules/.test(at[1])) cur.loc = { file: at[1], line: at[2], col: at[3], i }; used.add(i); continue; }
    if (!cur.msg && /^\s*\S/.test(l) && /^\s*(\w*Error|Error|AssertionError)\b/.test(l)) { cur.msg = l.trim(); used.add(i); }
  }
  flush();
  return out;
}

// ---- the rest: path:line:col: message ----
// Also gcc and clang (`file.c:3:5: error: …`), eslint's unix format (`… [Error/no-unused-vars]`), flake8 and mypy (`file.py:3: error: …`).
const GENERIC = /^\s*((?:[A-Za-z]:)?[^\s:()]*[./][^\s:()]*):(\d+)(?::(\d+))?:\s*(?:(fatal error|error|warning|warn|note|info)\b:?\s*)?(.+)$/i;
function generic(lines, used) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const m = lines[i].match(GENERIC);
    if (!m) continue;
    const file = m[1];
    if (/^https?$/i.test(file) || /^\d+$/.test(file)) continue;
    let message = m[5].trim(), code = null, sev = (m[4] ?? "").toLowerCase();
    const tag = message.match(/\s*\[(Error|Warning|Info)(?:\/([^\]]+))?\]$/);
    if (tag) { message = message.slice(0, tag.index); sev = sev || tag[1].toLowerCase(); code = tag[2] ?? null; }
    const sevs = sev === "warn" || sev === "warning" ? "warning" : sev === "note" || sev === "info" ? "info" : "error";
    out.push(row(tag ? "eslint" : "output", file, m[2], m[3], message, sevs, code, i));
    used.add(i);
  }
  return out;
}

const PARSERS = [tsc, eslintStylish, rust, pytest, jest, vitest, generic];

export function parseProblems(text) {
  const lines = linesOf(text), used = new Set(), all = [];
  for (const p of PARSERS) all.push(...p(lines, used));
  const seen = new Set(), problems = [];
  for (const r of all) {
    const key = `${r.file}|${r.line}|${r.col}|${r.message}`;
    if (!seen.has(key)) { seen.add(key); problems.push(r); }
  }
  // The parsers ran one after the other; the rows go back in the order their lines were printed.
  problems.sort((x, y) => x.at - y.at);
  return { problems, tools: [...new Set(problems.map((r) => r.tool))] };
}

// ---- paths ----

// The row's file as an absolute path under `cwd` (a file tools printed relative to where they ran), "./" removed.
export function resolveFile(file, cwd) {
  const f = String(file ?? "").replace(/^file:\/\//, "");
  if (f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f)) return f;
  const parts = [...String(cwd ?? "").split("/"), ...f.split("/")], out = [];
  for (const p of parts) { if (p === "." || (p === "" && out.length)) continue; if (p === "..") out.pop(); else out.push(p); }
  return out.join("/") || "/";
}
// The same relative to `cwd` when it is inside it, else as given.
export function shortFile(file, cwd) {
  const f = String(file ?? ""), base = String(cwd ?? "").replace(/\/+$/, "");
  return base && f.startsWith(`${base}/`) ? f.slice(base.length + 1) : f.replace(/^\.\//, "");
}

// ---- Send to chat ----

export const SEND_MAX = 40;
// A compact message for the chat's message box: the command and how it ended, then up to `max` rows as
// `- path:line:col severity: message`. With no rows, the last lines of output stand in for them.
export function summarize({ command, code, problems = [], cwd = "", tail = [], max = SEND_MAX }) {
  const errors = problems.filter((p) => p.severity === "error").length, warns = problems.filter((p) => p.severity === "warning").length;
  const head = `\`${command}\` ${code === 0 ? "passed" : code == null ? "was stopped" : `failed (exit ${code})`}${problems.length ? `: ${errors} error${errors === 1 ? "" : "s"}${warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}` : ""}${cwd ? ` in ${cwd}` : ""}`;
  // Errors first, since the cap cuts the end off.
  const ranked = [...problems.filter((p) => p.severity === "error"), ...problems.filter((p) => p.severity !== "error")];
  const rows = ranked.slice(0, max).map((p) => `- ${shortFile(p.file, cwd)}${p.line ? `:${p.line}${p.col ? `:${p.col}` : ""}` : ""} ${p.severity}${p.code ? ` ${p.code}` : ""}: ${p.message.replace(/\s+/g, " ").slice(0, 300)}`);
  const more = problems.length - rows.length;
  const body = rows.length ? rows.join("\n") + (more > 0 ? `\n… and ${more} more` : "") : tail.length ? `Last lines of output:\n${tail.map((l) => `    ${l}`).join("\n")}` : "";
  return `${head}\n${body ? `\n${body}\n` : ""}\nPlease fix these.`;
}
