// The outline of a file: its functions, classes, headings and the like, for Files' Outline step and Quick open's `@` mode
// (outline.js draws them, editor.js and quick.js use them). No Herdr imports, so node can test it.
//
// outline(text, lang) -> [{ name, kind, line, depth }]: `line` counts from 1, `depth` is how deep the symbol sits in
// another one (a method in a class is 1). The parsers are line-based heuristics, not grammars: they get the usual
// declarations of each language and skip what a block comment, a string or a template literal holds (a scanner blanks
// those out first, and follows the braces so a method is told from a call). At most OUTLINE_MAX symbols.
//
// `lang` is the editor's language name (editor.js LANG: "ts" is "js", "toml" is "yaml" there); langOfPath() gives it from
// a file's name, with toml kept apart (its [tables] are what an outline wants).

import { clean, match } from "./fuzzy.js";

export const OUTLINE_MAX = 2000;

// Editor.js' mapping, plus the names the extensions go by here. A file with no known extension has no outline.
const ALIAS = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", js: "js", javascript: "js", typescript: "js",
  py: "py", pyi: "py", python: "py",
  go: "go", golang: "go",
  rs: "rs", rust: "rs",
  md: "md", markdown: "md", mdx: "md",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh",
  css: "css", scss: "css", less: "css", pcss: "css",
  json: "json", jsonc: "json", json5: "json", jsonl: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
};
export const langOf = (lang) => ALIAS[String(lang ?? "").toLowerCase()] ?? null;
export function langOfPath(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  if (name === "dockerfile" || name === "makefile") return null;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : langOf(name.slice(dot + 1));
}

export function outline(text, lang) {
  const kind = langOf(lang);
  const fn = kind && PARSERS[kind];
  if (!fn || typeof text !== "string" || !text) return [];
  try {
    const out = fn(text);
    return out.length > OUTLINE_MAX ? out.slice(0, OUTLINE_MAX) : out;
  } catch { return []; }
}

// outline() of a file by its name.
export const outlineOf = (path, text) => outline(text, langOfPath(path));

const lines = (text) => text.split(/\r\n|\r|\n/);
const push = (out, name, kind, line, depth = 0) => { if (out.length < OUTLINE_MAX) out.push({ name, kind, line, depth }); return out.length < OUTLINE_MAX; };

// ---- the scanner ----------------------------------------------------------------------------------------------------
// mask(text, o): for each line { raw, code, brace, paren, clean }: `code` is the line with comments blanked and string
// contents blanked (the quotes stay), `brace` and `paren` count the open {} and ()[] at the line's start, `clean` says the
// line starts in code (not inside a block comment, a multi-line string or a template literal).
// o: { keep (string contents also in `kept`), line: ["//"], lineStart (a line comment only starts a line), block: bool, nest (block comments nest), template (JS),
//      regex (JS), rawTick (Go: `…` spans lines), rust (multi-line strings, raw strings, char literals) }

const IDENT = /[\w$]/;
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

function mask(text, o) {
  const raw = lines(text);
  const out = new Array(raw.length);
  let block = 0, brace = 0, paren = 0, prev = "";
  const tpl = []; // "T": in the text of a template literal; a number: the open braces in a ${ } inside it
  let multi = null; // { end, esc }: inside a string that goes on past the line's end
  for (let li = 0; li < raw.length; li++) {
    const s = raw[li], n = s.length;
    const rec = { raw: s, code: "", brace, paren, clean: block === 0 && !multi && tpl.length === 0 };
    const res = new Array(n).fill(" "), keep = o.keep ? res.slice() : null;
    const first = s.search(/\S/);
    let i = 0;
    while (i < n) {
      if (block) {
        if (o.nest && s.startsWith("/*", i)) { block++; i += 2; } else if (s.startsWith("*/", i)) { block--; i += 2; } else i++;
        continue;
      }
      if (multi) {
        if (multi.esc && s[i] === "\\") { i += 2; continue; }
        const at = s.indexOf(multi.end, i);
        if (at < 0) { i = n; continue; }
        i = at + multi.end.length;
        for (let q = at; q < i; q++) res[q] = s[q];
        multi = null;
        continue;
      }
      if (tpl.length && tpl[tpl.length - 1] === "T") {
        const c = s[i];
        if (c === "\\") i += 2;
        else if (c === "`") { tpl.pop(); res[i] = "`"; i++; prev = "`"; }
        else if (c === "$" && s[i + 1] === "{") { tpl.push(0); i += 2; } else i++;
        continue;
      }
      const c = s[i];
      if (o.line.some((l) => s.startsWith(l, i)) && (!o.lineStart || i === first)) break;
      if (o.block && s.startsWith("/*", i)) { block = 1; i += 2; continue; }
      if (o.template && c === "`") { tpl.push("T"); res[i] = "`"; i++; continue; }
      if (o.rawTick && c === "`") { res[i] = "`"; multi = { end: "`", esc: false }; i++; continue; }
      if (o.rust) {
        const r = /^b?r(#*)"/.exec(s.slice(i, i + 12));
        if (r && !(i > 0 && IDENT.test(s[i - 1]))) { i += r[0].length; multi = { end: `"${r[1]}`, esc: false }; continue; }
        if (c === '"') { res[i] = '"'; i++; multi = { end: '"', esc: true }; continue; }
        if (c === "'") {
          if (s[i + 1] === "\\") { const e = s.indexOf("'", i + 2); i = e < 0 ? n : e + 1; } else if (s[i + 2] === "'") i += 3; else { res[i] = c; i++; }
          continue;
        }
      } else if (c === '"' || c === "'") {
        res[i] = c;
        let j = i + 1;
        while (j < n && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
        if (keep) for (let q = i + 1; q < Math.min(j, n); q++) keep[q] = s[q];
        if (j < n) res[j] = c;
        i = j + 1;
        prev = c;
        continue;
      }
      if (o.regex && c === "/" && REGEX_AFTER.has(prev)) {
        let j = i + 1, cls = false, ok = false;
        while (j < n) {
          const d = s[j];
          if (d === "\\") { j += 2; continue; }
          if (cls) { if (d === "]") cls = false; } else if (d === "[") cls = true; else if (d === "/") { ok = true; break; }
          j++;
        }
        if (ok && j > i + 1) { res[i] = "/"; res[j] = "/"; i = j + 1; prev = "/"; continue; }
      }
      if (c === "{") {
        if (tpl.length) tpl[tpl.length - 1]++; else brace++;
      } else if (c === "}") {
        if (tpl.length) { if (tpl[tpl.length - 1] === 0) { tpl.pop(); i++; continue; } tpl[tpl.length - 1]--; } else brace = Math.max(0, brace - 1);
      } else if (c === "(" || c === "[") paren++;
      else if (c === ")" || c === "]") paren = Math.max(0, paren - 1);
      res[i] = c;
      if (c !== " " && c !== "\t") prev = c;
      i++;
    }
    rec.code = res.join("");
    if (keep) { for (let q = 0; q < n; q++) if (res[q] !== " ") keep[q] = res[q]; rec.kept = keep.join(""); }
    out[li] = rec;
  }
  return out;
}

// Scopes that nest declarations (a class's methods, a module's items): { base, body, depth }. `body` is the brace depth
// inside; until the first line deeper than `base` shows it, it is null.
class Scopes {
  constructor() { this.list = []; }
  // Pops the scopes the line (at brace depth `b`) is outside of.
  at(b) {
    for (;;) {
      const top = this.list[this.list.length - 1];
      if (!top) return;
      if (top.body == null) { if (b < top.base) this.list.pop(); else { if (b > top.base) top.body = b; return; } } else if (b < top.body) this.list.pop(); else return;
    }
  }
  // The brace depth a declaration must start at: the open scope's body, or the top.
  get level() { const top = this.list[this.list.length - 1]; return top ? (top.body ?? -1) : 0; }
  get depth() { return this.list.length; }
  open(rec, code) {
    if (/\{/.test(code)) this.list.push({ base: rec.brace, body: rec.brace + 1 });
    else if (!/;\s*$/.test(code)) this.list.push({ base: rec.brace, body: null });
  }
}

// ---- JavaScript and TypeScript ----------------------------------------------------------------------------------------

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "new", "typeof", "await", "super", "with", "throw", "delete", "void", "yield", "in", "of"]);
const MODS = "(?:(?:public|private|protected|static|readonly|override|abstract|declare|async|accessor)\\s+)*";
const J = {
  fn: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\b\s*\*?\s*([\w$]+)?/,
  cls: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\b\s*([\w$]+)?/,
  iface: /^(?:export\s+)?(?:declare\s+)?interface\s+([\w$]+)/,
  type: /^(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<|=)/,
  enum: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)/,
  ns: /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([\w$.]+)/,
  decl: /^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(.*)$/,
  assign: /^((?:module\.)?exports(?:\.[\w$]+)?|[\w$]+(?:\.[\w$]+)+)\s*=\s*(.*)$/,
  member: new RegExp(`^((?:(?:public|private|protected|static|readonly|override|abstract|declare|async|accessor|get|set)\\s+)*)(\\*\\s*)?(#?[\\w$]+|"[^"]*"|'[^']*'|\\[[^\\]]*\\])\\s*\\??\\s*(?:<[^>(]*>\\s*)?\\(`, "d"),
  prop: new RegExp(`^${MODS}(#?[\\w$]+)\\s*[?!]?\\s*(?::[^=]+)?=\\s*(.*)$`),
};
// Whether what follows an `=` is a function: `function`, `async function`, `(…) =>`, `x =>`, or the start of arrow
// parameters that go over several lines.
function fnValue(rest) {
  if (/^(?:async\s+)?function\b/.test(rest)) return true;
  if (/^(?:async\s+)?[\w$]+\s*=>/.test(rest)) return true;
  const m = /^(?:async\s*)?\(/.exec(rest);
  if (!m) return false;
  if (rest.includes("=>")) return true;
  let d = 0;
  for (const ch of rest) { if (ch === "(") d++; else if (ch === ")") d--; }
  return d > 0;
}

function parseJs(text) {
  const out = [], sc = new Scopes();
  const recs = mask(text, { line: ["//"], block: true, template: true, regex: true });
  for (let li = 0; li < recs.length; li++) {
    const rec = recs[li];
    sc.at(rec.brace);
    if (!rec.clean || rec.paren !== 0) continue;
    const t = rec.code.trim();
    if (!t || rec.brace !== sc.level) continue;
    const no = li + 1, d = sc.depth, inClass = sc.list.at(-1)?.isClass;
    let m;
    if (inClass) {
      if ((m = J.member.exec(t)) && !JS_KEYWORDS.has(m[3])) {
        const acc = /\b(get|set)\s+$/.exec(m[1]);
        let nm = m[3];
        if (/^["']/.test(nm)) nm = rec.raw.trim().slice(m.indices[3][0], m.indices[3][1]).replace(/^["']|["']$/g, ""); // the masked text has no string content
        if (!push(out, (acc ? `${acc[1]} ` : "") + nm, "method", no, d)) break;
      } else if ((m = J.prop.exec(t)) && fnValue(m[2])) { if (!push(out, m[1], "method", no, d)) break; }
      continue;
    }
    if ((m = J.cls.exec(t)) && (m[1] || /^export\s+default/.test(t))) {
      if (!push(out, m[1] ?? "default", "class", no, d)) break;
      sc.open(rec, t); const top = sc.list.at(-1); if (top && top.base === rec.brace) top.isClass = true;
    } else if ((m = J.fn.exec(t)) && (m[1] || /^export\s+default/.test(t))) { if (!push(out, m[1] ?? "default", "function", no, d)) break; }
    else if ((m = J.iface.exec(t))) { if (!push(out, m[1], "interface", no, d)) break; }
    else if ((m = J.type.exec(t))) { if (!push(out, m[1], "type", no, d)) break; }
    else if ((m = J.enum.exec(t))) { if (!push(out, m[1], "enum", no, d)) break; }
    else if ((m = J.ns.exec(t))) { if (!push(out, m[1], "namespace", no, d)) break; sc.open(rec, t); }
    else if ((m = J.decl.exec(t))) {
      if (fnValue(m[3])) { if (!push(out, m[2], "function", no, d)) break; }
      else if (m[1] && /^class\b/.test(m[3])) { if (!push(out, m[2], "class", no, d)) break; }
      else if (m[1]) { if (!push(out, m[2], "const", no, d)) break; }
    } else if ((m = J.assign.exec(t)) && fnValue(m[2])) { if (!push(out, m[1], "function", no, d)) break; }
    else if (/^export\b/.test(t)) {
      // export { a, b }, export * from "x", export default <expression>
      const r = rec.raw.trim().replace(/;\s*$/, "").replace(/\s*\{\s*$/, " { … }");
      if (!push(out, r.length > 70 ? `${r.slice(0, 69)}…` : r, "export", no, d)) break;
    }
  }
  return out;
}

// ---- Python ------------------------------------------------------------------------------------------------------------

function parsePy(text) {
  const out = [], stack = []; // [{ indent, kind }] of the open def and class
  const raw = lines(text);
  let tri = null, par = 0;
  for (let li = 0; li < raw.length; li++) {
    const s = raw[li];
    const startedIn = tri != null || par > 0;
    // Walk the line: triple-quoted strings span lines, # starts a comment, brackets continue a statement.
    for (let i = 0; i < s.length;) {
      if (tri) { const at = s.indexOf(tri, i); if (at < 0) { i = s.length; break; } i = at + 3; tri = null; continue; }
      const c = s[i];
      if (c === "#") break;
      if (c === '"' || c === "'") {
        if (s.startsWith(c.repeat(3), i)) { tri = c.repeat(3); i += 3; continue; }
        let j = i + 1;
        while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
        i = j + 1; continue;
      }
      if (c === "(" || c === "[" || c === "{") par++;
      else if (c === ")" || c === "]" || c === "}") par = Math.max(0, par - 1);
      i++;
    }
    if (startedIn || !/\S/.test(s) || /^\s*#/.test(s)) continue;
    // Any statement at or left of an open def's or class's own indent ends it.
    const indent = /^\s*/.exec(s)[0].replace(/\t/g, "        ").length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(s);
    if (!m) continue;
    const method = m[2] === "def" && stack.at(-1)?.kind === "class";
    if (!push(out, m[3], m[2] === "class" ? "class" : method ? "method" : "function", li + 1, stack.length)) break;
    stack.push({ indent, kind: m[2] });
  }
  return out;
}

// ---- Go ----------------------------------------------------------------------------------------------------------------

function parseGo(text) {
  const out = [];
  const recs = mask(text, { line: ["//"], block: true, rawTick: true });
  let group = false;
  for (let li = 0; li < recs.length; li++) {
    const rec = recs[li];
    if (!rec.clean) continue;
    const t = rec.code.trim();
    if (!t) continue;
    let m;
    if (group) {
      if (rec.paren === 0) group = false;
      else if (rec.paren === 1 && (m = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)?/.exec(t)) && rec.brace === 0) { if (!push(out, m[1], m[2] ?? "type", li + 1)) break; continue; }
      else continue;
    }
    if (rec.brace !== 0 || rec.paren !== 0) continue;
    if ((m = /^func\s*(?:\(\s*(?:[\w]+\s+)?\*?\s*([\w.]+)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)/.exec(t))) { if (!push(out, m[1] ? `${m[1]}.${m[2]}` : m[2], m[1] ? "method" : "function", li + 1)) break; }
    else if ((m = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*(struct|interface)?/.exec(t))) { if (!push(out, m[1], m[2] ?? "type", li + 1)) break; }
    else if (/^type\s*\(\s*$/.test(t)) group = true;
  }
  return out;
}

// ---- Rust --------------------------------------------------------------------------------------------------------------

const RS_VIS = "(?:pub(?:\\s*\\([^)]*\\))?\\s+)?";
const R = {
  fn: new RegExp(`^${RS_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+(?:"[^"]*"\\s*)?)?fn\\s+([A-Za-z_]\\w*)`),
  item: new RegExp(`^${RS_VIS}(?:unsafe\\s+)?(struct|enum|trait|mod|union|type)\\s+([A-Za-z_]\\w*)`),
  impl: /^(?:unsafe\s+)?impl\b(.*)$/,
  macro: /^macro_rules!\s*([A-Za-z_]\w*)/,
};
// "<T: Into<String>> Trait for Type<T> where …" -> "Trait for Type<T>".
function implName(rest) {
  let s = rest.trim();
  if (s.startsWith("<")) {
    let d = 0, i = 0;
    for (; i < s.length; i++) { if (s[i] === "<") d++; else if (s[i] === ">" && s[i - 1] !== "-") { d--; if (d === 0) { i++; break; } } }
    s = s.slice(i).trim();
  }
  s = s.replace(/\s*\{.*$/, "").replace(/\s+where\b.*$/, "").replace(/\s+/g, " ").trim();
  return s || "impl";
}

function parseRs(text) {
  const out = [], sc = new Scopes();
  const recs = mask(text, { line: ["//"], block: true, nest: true, rust: true });
  for (let li = 0; li < recs.length; li++) {
    const rec = recs[li];
    sc.at(rec.brace);
    if (!rec.clean || rec.paren !== 0) continue;
    const t = rec.code.trim();
    if (!t || rec.brace !== sc.level) continue;
    const no = li + 1, d = sc.depth;
    let m;
    if ((m = R.fn.exec(t))) { if (!push(out, m[1], "function", no, d)) break; }
    else if ((m = R.item.exec(t))) {
      if (!push(out, m[2], m[1] === "union" ? "struct" : m[1], no, d)) break;
      if (m[1] === "trait" || m[1] === "mod") sc.open(rec, t);
    } else if ((m = R.impl.exec(t)) && (m[1] === "" || /^[\s<]/.test(m[1]))) { if (!push(out, implName(m[1]), "impl", no, d)) break; sc.open(rec, t); }
    else if ((m = R.macro.exec(t))) { if (!push(out, m[1], "macro", no, d)) break; }
  }
  return out;
}

// ---- Markdown ----------------------------------------------------------------------------------------------------------

function parseMd(text) {
  const out = [], raw = lines(text);
  let fence = null, comment = false, i = 0;
  if (raw[0]?.trim() === "---") { // front matter
    const end = raw.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  for (; i < raw.length; i++) {
    const s = raw[i];
    if (fence) { if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(s)) fence = null; continue; }
    if (comment) { if (s.includes("-->")) comment = false; continue; }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (f) { fence = f[1]; continue; }
    if (/^ {0,3}<!--/.test(s) && !s.includes("-->")) { comment = true; continue; }
    let m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(s);
    if (m) {
      const name = (m[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+$/, "").trim();
      if (name && !push(out, name, `h${m[1].length}`, i + 1, m[1].length - 1)) break;
      continue;
    }
    // Setext: a line of text over === or ---.
    const u = /^ {0,3}(=+|-+)[ \t]*$/.exec(raw[i + 1] ?? "");
    if (u && /\S/.test(s) && !/^ {0,3}(?:[-*+>|]|\d+[.)]|#|<)/.test(s) && !/^ {4}/.test(s)) {
      const level = u[1][0] === "=" ? 1 : 2;
      if (!push(out, s.trim(), `h${level}`, i + 1, level - 1)) break;
      i++;
    }
  }
  return out;
}

// ---- shell -------------------------------------------------------------------------------------------------------------

function parseSh(text) {
  const out = [], raw = lines(text);
  let doc = null;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (doc) { if (s.trim() === doc || s === doc) doc = null; continue; }
    const t = s.trim();
    if (!t || t[0] === "#") continue;
    const h = /<<-?\s*\\?(["']?)([A-Za-z_]\w*)\1/.exec(t);
    const m = /^(?:function\s+([\w:.\-]+)\s*(?:\(\s*\))?|([\w:.\-]+)\s*\(\s*\))\s*(?:\{|\(|$|#)/.exec(t);
    if (m && !push(out, m[1] ?? m[2], "function", i + 1)) break;
    if (h) doc = h[2];
  }
  return out;
}

// ---- CSS ---------------------------------------------------------------------------------------------------------------

const CONTAINERS = /^@(?:media|supports|layer|container|document|scope|starting-style)\b/;

function parseCss(text) {
  const out = [];
  const recs = mask(text, { line: ["//"], lineStart: true, block: true, keep: true });
  const scopes = []; // "c" (an at-rule that holds rules) or "x" (anything else: its inside is not read)
  let sel = "", selLine = 0;
  outer:
  for (let li = 0; li < recs.length; li++) {
    const code = recs[li].code, kept = recs[li].kept;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      const here = scopes.every((x) => x === "c");
      if (c === "{") {
        const name = sel.replace(/\s+/g, " ").trim();
        if (here && name) {
          const at = name.startsWith("@");
          if (!push(out, name, at ? "at-rule" : "selector", selLine, scopes.length)) break outer;
          scopes.push(at && CONTAINERS.test(name) ? "c" : "x");
        } else scopes.push("x");
        sel = "";
      } else if (c === "}") { scopes.pop(); sel = ""; }
      else if (c === ";") sel = "";
      else if (here) { if (!sel.trim() && /\S/.test(kept[i])) selLine = li + 1; sel += kept[i]; }
    }
    if (sel) sel += " ";
  }
  return out;
}

// ---- JSON, YAML, TOML --------------------------------------------------------------------------------------------------

function parseJson(text) {
  const out = [];
  let line = 1, depth = 0, started = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") line++; i++; } i += 2; continue; }
    if (c === '"') {
      const start = i, at = line;
      i++;
      while (i < n && text[i] !== '"' && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      const str = text.slice(start + 1, i);
      i++;
      if (depth === 1 && started) {
        let j = i;
        while (j < n && /[ \t\r]/.test(text[j])) j++;
        if (text[j] === ":") { let name = str; try { name = JSON.parse(`"${str}"`); } catch { /* as written */ } if (!push(out, name, "key", at)) break; }
      }
      continue;
    }
    if (c === "{" || c === "[") { if (!started) { if (c === "[") return out; started = true; } depth++; } else if (c === "}" || c === "]") depth--;
    i++;
  }
  return out;
}

function parseYaml(text) {
  const out = [], raw = lines(text);
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || /^\s/.test(s)) continue;
    if (s[0] === "#" || /^(---|\.\.\.)(\s|$)/.test(s) || s[0] === "-" && /^-(\s|$)/.test(s)) continue;
    const m = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s#"'\[\]{},&*!|>%@`?-][^:#]*?|-[^\s:#][^:#]*?))\s*:(?:\s|$)/.exec(s);
    if (m && !push(out, m[1] ?? m[2] ?? m[3], "key", i + 1)) break;
  }
  return out;
}

function parseToml(text) {
  const out = [], raw = lines(text);
  let multi = null, first = true;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (multi) { if (s.includes(multi)) multi = null; continue; }
    const t = s.trim();
    if (!t || t[0] === "#") continue;
    let m = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(t);
    if (m) { first = false; if (!push(out, m[1], "table", i + 1, Math.max(0, m[1].split(".").length - 1))) break; continue; }
    if (first && (m = /^("[^"]*"|'[^']*'|[\w.-]+)\s*=/.exec(t))) { if (!push(out, m[1].replace(/^["']|["']$/g, ""), "key", i + 1)) break; }
    const ml = /("""|''')/.exec(t);
    if (ml && t.indexOf(ml[1]) === t.lastIndexOf(ml[1])) multi = ml[1];
  }
  return out;
}

const PARSERS = { js: parseJs, py: parsePy, go: parseGo, rs: parseRs, md: parseMd, sh: parseSh, css: parseCss, json: parseJson, yaml: parseYaml, toml: parseToml };

// ---- filtering ---------------------------------------------------------------------------------------------------------

// The symbols that `query` matches by fuzzy.js' rules (every letter in order, case ignored) on the name: [{ sym, at, score }]
// best first, at most `limit`. `at` are the matched positions in the name. An empty query lists them in file order.
export function rankSymbols(query, symbols, { limit = OUTLINE_MAX } = {}) {
  const q = clean(String(query ?? "").replace(/^@/, ""));
  if (!q) return symbols.slice(0, limit).map((sym) => ({ sym, at: [], score: 0 }));
  const hits = [];
  for (const sym of symbols) {
    const r = match(q, sym.name, false);
    if (r) hits.push({ sym, score: r.score });
  }
  hits.sort((a, b) => b.score - a.score || a.sym.line - b.sym.line);
  const top = hits.slice(0, limit);
  for (const h of top) h.at = match(q, h.sym.name, true)?.at ?? [];
  return top;
}

// The short label of a kind, for the badge.
const BADGE = { function: "fn", method: "fn", class: "class", interface: "iface", type: "type", enum: "enum", const: "const", export: "export", namespace: "ns", struct: "struct", trait: "trait", impl: "impl", mod: "mod", macro: "macro", key: "key", selector: "sel", "at-rule": "@", table: "tbl" };
export const badgeOf = (kind) => BADGE[kind] ?? (/^h[1-6]$/.test(kind) ? kind.toUpperCase() : String(kind ?? ""));
