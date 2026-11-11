// Secret and .env awareness (a pure module: no Herdr imports, so a test runs it under Node).
// - isSecretPath(path): a file that usually holds a secret (.env, keys, certificates, credentials).
// - scanText(text): known token shapes and `password = "..."` assignments in text -> [{ line, kind, preview }].
//   The preview never shows the secret: its first four characters, then an ellipsis.
// - scanDiff(diff): the same for the added lines of a unified diff (`git diff -U0`) -> [{ file, line, kind, preview }].
// Used by the Files explorer (lock mark), the commit guard (secretguard.js) and the chat's tool rows.

const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;
// `secrets.js` and friends are code that handles secrets, not a secrets file.
const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|cs|php|lua|sh|md|mdx|txt|html|css)$/i;

// A path (or a bare file name) that holds a secret by its name. `.env.example`, `.env.sample` and `.env.template`
// are the committed templates and are not secrets; neither is a public key (`id_rsa.pub`).
export function isSecretPath(path) {
  if (typeof path !== "string" || !path) return false;
  const name = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop().toLowerCase();
  if (!name) return false;
  if (name === ".env" || name.startsWith(".env.")) return !TEMPLATE_SUFFIX.test(name);
  if (/\.pub$/.test(name)) return false;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(name)) return true;
  if (/^id_(rsa|ed25519)/.test(name)) return true;
  if (name === ".npmrc" || name === ".pypirc" || name === ".netrc" || name === "credentials.json") return true;
  if (name.startsWith("secrets.")) return !CODE_EXT.test(name);
  return false;
}

// Lines that are plainly placeholders are not findings.
const PLACEHOLDER = /xxx|your[-_ ]|<[A-Za-z0-9_ -]{0,40}(?:key|token|secret|password|your|here|value|id)[A-Za-z0-9_ -]{0,40}>|<\.\.\.>|changeme|example/i;

// Ordered: when two kinds match the same text the earlier one wins (an Anthropic key is not also an OpenAI key).
// `group`: the capture group holding the secret itself, for the preview.
const RULES = [
  { kind: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI key", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}/g },
  { kind: "OpenAI key", re: /\bsk-[A-Za-z0-9]{32,}/g },
  { kind: "Slack token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "Stripe key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { kind: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
  // password = "...", "api_key": '...', DB_SECRET: "...": a quoted value of 8 or more characters with no space, and
  // not a reference to something else (${X}, $X, {{ x }}, %x%).
  { kind: "hard-coded secret", re: /(?:password|secret|token|api[_-]?key)['"]?\s*[:=]\s*['"]((?![$%{])[^'"\s]{8,})['"]/gi, group: 1 },
];

const mask = (s) => `${s.slice(0, 4)}…`;

// -> [{ line (from 1), kind, preview }], in order of line. A line gives each text span at most one finding.
export function scanText(text) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 8 || line.length > 5000 || PLACEHOLDER.test(line)) continue;
    const taken = [];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (let m; (m = rule.re.exec(line)); ) {
        const start = m.index, end = start + m[0].length;
        if (m[0].length === 0) { rule.re.lastIndex++; continue; }
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        taken.push([start, end]);
        out.push({ line: i + 1, kind: rule.kind, preview: mask(rule.group ? m[rule.group] : m[0]) });
      }
    }
  }
  return out;
}

// The added lines of a unified diff, with the file and the line they have in the new file.
// -> [{ file, line, text }]
export function addedLines(diff) {
  const out = [];
  let file = null, at = 0, inHunk = false;
  for (const raw of String(diff ?? "").split("\n")) {
    if (raw.startsWith("diff --git ")) { inHunk = false; file = null; continue; }
    if (!inHunk) {
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4).replace(/\t.*$/, "").replace(/^"|"$/g, "");
        file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      }
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { inHunk = true; at = Number(h[1]); continue; }
    if (!inHunk || !file) continue;
    if (raw.startsWith("+")) out.push({ file, line: at++, text: raw.slice(1) });
    else if (raw.startsWith(" ")) at++;
  }
  return out;
}

// -> [{ file, line, kind, preview }] for what a diff adds.
export function scanDiff(diff) {
  const out = [];
  for (const a of addedLines(diff)) for (const f of scanText(a.text)) out.push({ file: a.file, line: a.line, kind: f.kind, preview: f.preview });
  return out;
}

// The file paths a tool call (an ACP tool_call or tool_call_update) names: its locations, the files of its diffs and
// the path in its input (`file_path`, `path`, ...). -> [string], without repeats.
export function toolPaths(u) {
  const out = new Set();
  const add = (p) => { if (typeof p === "string" && p) out.add(p); };
  for (const l of Array.isArray(u?.locations) ? u.locations : []) add(l?.path);
  for (const c of Array.isArray(u?.content) ? u.content : []) if (c?.type === "diff") add(c.path);
  const input = u?.rawInput;
  if (input && typeof input === "object") for (const key of ["file_path", "filePath", "path", "notebook_path", "abs_path"]) add(input[key]);
  return [...out];
}

// A tool row (an item with `paths`, transcript.js) that reads, changes or writes a secret file. A command or a web
// fetch isn't judged by its paths.
export const touchesSecret = (item) => !["execute", "fetch", "think"].includes(item?.toolKind) && (item?.paths ?? []).some(isSecretPath);
