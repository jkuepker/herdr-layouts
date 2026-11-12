// Outdated dependencies of a project (the Dependencies dialog, deps.js): which package tools the folder uses, the command
// that lists what is outdated, that command's output read into rows, and the commands that update. No Herdr imports
// (deps.js reads the files and runs the commands, and hands the text here), so node can test it.
//
// detectEcosystems(files) -> [{ id, label, tool, check, update, devNames, declared, ... }]
//   files: detect.js parseBundle's answer for DEPS_READ ("package.json", "pyproject.toml", "requirements.txt", "Cargo.toml",
//   "go.mod": their text; `names`: the lock files and folders present).
//   id: "npm" | "pnpm" | "yarn" | "bun" | "uv" | "pip" | "cargo" | "go".
// parseOutdated(id, text, ctx) -> { rows, notes, error, missing }
//   text: the check command's output, stderr mixed in (the noise is skipped); ctx: the ecosystem (devNames, declared).
//   rows: [{ name, current, wanted, latest, kind: "patch" | "minor" | "major", dev, ... }]; wanted is null where the tool
//   doesn't say. `missing`: { tool, hint } when the tool isn't installed. `error`: the tool's own message when it failed.
// updateCommand(eco, rows) -> the shell command that updates those packages; askPrompt(eco, rows, where) -> the chat prompt.
import { packageManager, shq } from "./detect.js";

export const KINDS = ["major", "minor", "patch"];
export const MISSING = "HT3_MISSING:";
export const TIMEOUT_MS = 120000;

// ---- reading the folder ----

// One `sh` run (detect.js parseBundle reads it): $1 the folder; the files are printed after `\x1e<name>`, then the lock files
// and folders after `\x1enames`.
export const DEPS_FILES = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"];
export const DEPS_NAMES = ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json", ".yarnrc.yml", "uv.lock", "poetry.lock", ".venv", "Cargo.lock", "go.sum"];
export const DEPS_READ = `cd "$1" 2>/dev/null || exit 0; for f in ${DEPS_FILES.join(" ")}; do [ -f "$f" ] && { printf '\\036%s\\n' "$f"; head -c 262144 "$f"; printf '\\n'; }; done; printf '\\036names\\n'; ls -d ${DEPS_NAMES.join(" ")} 2>/dev/null; true`;

// ---- versions ----

// [major, minor, patch] of "1.2.3", "v1.2", "^1.2.3", "2024.1": null for what has no number to start with.
export function parseVersion(v) {
  const m = String(v ?? "").trim().match(/^[v=^~]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}
// What kind of step current -> latest is. What can't be read counts as major (it is not updated without a look), and so does a
// step that semver for 0.x calls breaking.
export function bump(current, latest) {
  const a = parseVersion(current), b = parseVersion(latest);
  if (!a || !b) return "major";
  if (a[0] !== b[0]) return "major";
  // Below 1.0 the caret rules of npm and Cargo (and Go's v0) treat a minor step as breaking, and below 0.1 a patch step too.
  if (a[0] === 0 && a[1] !== b[1]) return "major";
  if (a[0] === 0 && a[1] === 0 && a[2] !== b[2]) return "major";
  if (a[1] !== b[1]) return "minor";
  return "patch";
}
// Whether `latest` is ahead of `current` (unreadable or the same numbers with another text, a pre-release: yes).
export function newer(current, latest) {
  const a = parseVersion(current), b = parseVersion(latest);
  if (!a || !b) return String(current) !== String(latest);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return String(current).replace(/^v/, "") !== String(latest).replace(/^v/, "");
}

const str = (v) => (v == null || v === "" || v === "---" || v === "N/A" ? null : String(v));
// A row, or null for a package that is not behind.
function makeRow({ name, current, wanted = null, latest, dev = false, ...more }) {
  name = str(name); current = str(current); latest = str(latest); wanted = str(wanted);
  if (!name || !current || !latest || !newer(current, latest)) return null;
  return { name, current, wanted, latest, kind: bump(current, latest), dev: !!dev, ...Object.fromEntries(Object.entries(more).filter(([, v]) => v !== undefined)) };
}

// ---- reading the output ----

// The JSON values in text that start at the beginning of a line (npm's one object, yarn's one object per line, go's
// objects one after the other), the lines that aren't JSON (npm warn, pip's notices, go's downloading) skipped.
export function jsonValues(text) {
  const s = String(text ?? ""), out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== "{" && c !== "[") { const nl = s.indexOf("\n", i); if (nl < 0) break; i = nl + 1; continue; }
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { if (--depth === 0) { end = j + 1; break; } }
    }
    let v;
    if (end > 0) { try { v = JSON.parse(s.slice(i, end)); } catch { v = undefined; } }
    if (v !== undefined) { out.push(v); i = end; }
    else { const nl = s.indexOf("\n", i); if (nl < 0) break; i = nl + 1; }
  }
  return out;
}

const lines = (text) => String(text ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
const tail = (text) => lines(text).map((l) => l.trim()).filter(Boolean).slice(-4).join("\n");

// npm and pnpm: { "<name>": { current, wanted, latest, type | dependencyType, isDeprecated } } (npm: an array when the package
// is in several places).
function readNpmLike(text, ctx) {
  const values = jsonValues(text).filter((v) => v && typeof v === "object" && !Array.isArray(v));
  const err = values.find((v) => v.error && typeof v.error === "object");
  if (err) return { rows: [], notes: [], error: String(err.error.summary || err.error.detail || err.error.code || "The command failed.") };
  const rows = [], seen = new Set();
  let missing = 0;
  for (const obj of values) {
    for (const [name, v] of Object.entries(obj)) {
      const list = Array.isArray(v) ? v : [v];
      const info = list.find((x) => x?.current) ?? list[0];
      if (!info || typeof info !== "object" || !("latest" in info) || seen.has(name)) continue;
      if (!info.current) { missing++; continue; }
      const type = String(info.type ?? info.dependencyType ?? "");
      const r = makeRow({ name, current: info.current, wanted: info.wanted, latest: info.latest, dev: type === "devDependencies" || !!ctx?.devNames?.includes(name), deprecated: !!info.isDeprecated || undefined });
      if (r) { seen.add(name); rows.push(r); }
    }
  }
  return { rows, notes: missing ? [`${missing} package${missing === 1 ? " isn't" : "s aren't"} installed here, so there is nothing to compare: install first.`] : [] };
}

// yarn 1: ndjson, the table is { type: "table", data: { head: [...], body: [[...]] } }.
function readYarn(text, ctx) {
  const rows = [], notes = [];
  let error = null;
  for (const v of jsonValues(text)) {
    if (v?.type === "error" && typeof v.data === "string") error = v.data;
    if (v?.type !== "table" || !Array.isArray(v.data?.body)) continue;
    const head = (v.data.head ?? []).map((h) => String(h).toLowerCase());
    const at = (n) => head.indexOf(n);
    for (const row of v.data.body) {
      const r = makeRow({ name: row[at("package")], current: row[at("current")], wanted: row[at("wanted")], latest: row[at("latest")], dev: String(row[at("package type")] ?? "") === "devDependencies" || !!ctx?.devNames?.includes(row[at("package")]) });
      if (r && !rows.some((x) => x.name === r.name)) rows.push(r);
    }
  }
  return { rows, notes, error: rows.length ? null : error };
}

// bun's table (plain `|` and `-` when not on a terminal, box characters on one): Package | Current | Update | Latest; "(dev)"
// after the name for a dev dependency (also "(peer)", "(optional)"); a Workspace column in a workspace.
function readBun(text) {
  const rows = [];
  let cols = null;
  for (const raw of lines(text)) {
    const l = raw.trim();
    if (!/^[|│]/.test(l)) continue;
    const cells = l.replace(/^[|│]\s*/, "").replace(/\s*[|│]$/, "").split(/\s*[|│]\s*/).map((c) => c.trim());
    if (cells.length < 4 || cells.some((c) => /^[-─]+$/.test(c))) continue;
    if (/^package$/i.test(cells[0])) { cols = cells.map((c) => c.toLowerCase()); continue; }
    if (!cols) continue;
    const at = (n) => cols.indexOf(n);
    const m = /^(.*?)\s*\((dev|peer|optional)\)$/.exec(cells[0]);
    const r = makeRow({ name: m ? m[1] : cells[0], current: cells[at("current")], wanted: cells[at("update")], latest: cells[at("latest")], dev: m?.[2] === "dev" });
    if (r && !rows.some((x) => x.name === r.name)) rows.push(r);
  }
  return { rows, notes: [] };
}

// `uv tree --outdated --depth 1`: the project's own requirements, "├── name v1.2.3 (group: dev) (latest: v2.0.0)".
function readUvTree(text) {
  const rows = [];
  for (const l of lines(text)) {
    const m = /^[├└]── (\S+) v?(\S+)((?: \([^)]*\))*)\s*$/.exec(l);
    if (!m) continue;
    const latest = /\(latest: v?([^)]+)\)/.exec(m[3])?.[1];
    if (!latest) continue;
    const group = /\(group: ([^)]+)\)/.exec(m[3])?.[1] ?? null, extra = /\(extra: ([^)]+)\)/.exec(m[3])?.[1] ?? null;
    const r = makeRow({ name: m[1].replace(/\[.*\]$/, ""), current: m[2], latest, dev: group === "dev", group: group ?? undefined, extra: extra ?? undefined });
    if (r && !rows.some((x) => x.name === r.name)) rows.push(r);
  }
  return { rows, notes: [] };
}

// Python's normal form of a package name.
export const pyName = (n) => String(n).toLowerCase().replace(/[-_.]+/g, "-");

// `pip list --outdated --format json` (uv pip's too): [{ name, version, latest_version }]; every installed package, so
// only the ones the project declares when it says (requirements.txt, pyproject.toml).
function readPip(text, ctx) {
  const list = jsonValues(text).find((v) => Array.isArray(v)) ?? [];
  const want = ctx?.declared?.length ? new Set(ctx.declared.map(pyName)) : null;
  const rows = [];
  for (const p of list) {
    if (want && !want.has(pyName(p?.name))) continue;
    const r = makeRow({ name: p?.name, current: p?.version, latest: p?.latest_version });
    if (r) rows.push(r);
  }
  return { rows, notes: want ? ["Only the packages the project declares are listed."] : [] };
}

// cargo-outdated: { crate_name, dependencies: [{ name, project, compat, latest, kind: "Normal" | "Development" | "Build" }] }, one
// object per crate of a workspace; "---" for what there is none of.
function readCargo(text) {
  const rows = [];
  for (const v of jsonValues(text)) {
    for (const d of Array.isArray(v?.dependencies) ? v.dependencies : []) {
      const r = makeRow({ name: d?.name, current: d?.project, wanted: d?.compat, latest: str(d?.latest) ?? d?.compat, dev: d?.kind === "Development" });
      if (r && !rows.some((x) => x.name === r.name)) rows.push(r);
    }
  }
  return { rows, notes: [] };
}

// `go list -u -m -json all`: objects one after the other; { Path, Version, Update: { Version }, Main, Indirect }.
function readGo(text) {
  const rows = [];
  let indirect = 0;
  for (const m of jsonValues(text)) {
    if (!m || typeof m !== "object" || m.Main || !m.Update?.Version) continue;
    if (m.Indirect) { indirect++; continue; }
    const r = makeRow({ name: m.Path, current: m.Version, latest: m.Update.Version });
    if (r) rows.push(r);
  }
  return { rows, notes: indirect ? [`${indirect} indirect module${indirect === 1 ? "" : "s"} not listed: go get names the ones the project asks for.`] : [] };
}

const MISSING_HINT = {
  "cargo-outdated": "cargo-outdated isn't installed. Install it with: cargo install cargo-outdated --locked",
  cargo: "cargo isn't installed (or isn't on the PATH of a login shell).",
  python3: "python3 isn't installed here, and the project has no .venv.",
};
export function parseOutdated(id, text, ctx = {}) {
  const m = String(text ?? "").match(new RegExp(`${MISSING}(\\S+)`));
  if (m) return { rows: [], notes: [], error: null, missing: { tool: m[1], hint: MISSING_HINT[m[1]] ?? `${m[1]} isn't installed here (or isn't on the PATH of a login shell).` } };
  let r;
  if (id === "npm" || id === "pnpm") r = readNpmLike(text, ctx);
  else if (id === "yarn") r = readYarn(text, ctx);
  else if (id === "bun") r = readBun(text);
  else if (id === "uv") r = readUvTree(text);
  else if (id === "pip") r = readPip(text, ctx);
  else if (id === "cargo") r = readCargo(text);
  else if (id === "go") r = readGo(text);
  else r = { rows: [], notes: [], error: `Unknown package tool: ${id}` };
  return { rows: r.rows.sort((a, b) => a.name.localeCompare(b.name)), notes: r.notes ?? [], error: r.error ?? null, missing: null };
}
// When the output has no rows and the command said something that isn't a table or JSON: its last lines, as the reason.
export const failureText = (text) => tail(text).slice(0, 600);

// ---- what a folder uses ----

const guard = (tool, cmd) => `command -v ${tool} >/dev/null 2>&1 || { echo ${MISSING}${tool}; exit 127; }; ${cmd}`;
const PY = 'PY=python3; [ -x .venv/bin/python ] && PY=.venv/bin/python; ';
const names = (rows) => rows.map((r) => shq(r.name));
const at = (rows, sep = "@") => rows.map((r) => shq(`${r.name}${sep}${r.latest}`));

function declaredPython(files) {
  const out = new Set();
  for (const l of String(files["requirements.txt"] ?? "").split("\n")) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l);
    if (m && !/^(-|#)/.test(l.trim())) out.add(m[1]);
  }
  if (!out.size) {
    const py = String(files["pyproject.toml"] ?? "");
    for (const m of py.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@,]|["'])/g)) out.add(m[1]);
  }
  return [...out];
}

// The ecosystems the folder has, the JavaScript one first. Each: { id, label, tool, check: the command that lists, update(rows): the command
// that updates, ... }. `devNames`: package.json's devDependencies (npm doesn't say), `declared`: Python names the project asks for.
export function detectEcosystems(files = {}) {
  const have = files.names ?? [], out = [];
  let pkg = null;
  try { pkg = files["package.json"] ? JSON.parse(files["package.json"]) : null; } catch { pkg = null; }
  if (pkg && typeof pkg === "object") {
    const declaredBy = typeof pkg.packageManager === "string" ? /^(pnpm|yarn|bun|npm)@/.exec(pkg.packageManager)?.[1] : null;
    const locked = ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json"].some((n) => have.includes(n));
    const pm = locked ? packageManager(have) : declaredBy ?? "npm";
    const berry = pm === "yarn" && have.includes(".yarnrc.yml");
    const devNames = Object.keys(pkg.devDependencies ?? {});
    const any = Object.keys(pkg.dependencies ?? {}).length + devNames.length + Object.keys(pkg.optionalDependencies ?? {}).length > 0;
    if (any) {
      const base = { devNames, berry };
      if (pm === "pnpm") out.push({ id: "pnpm", label: "pnpm", tool: "pnpm", check: guard("pnpm", "pnpm outdated --format json"), ...base, update: (rows) => `pnpm update ${names(rows).join(" ")} --latest` });
      else if (pm === "bun") out.push({ id: "bun", label: "bun", tool: "bun", check: guard("bun", "bun outdated"), ...base, update: (rows) => `bun update --latest ${names(rows).join(" ")}` });
      else if (pm === "yarn" && !berry) out.push({ id: "yarn", label: "yarn", tool: "yarn", check: guard("yarn", "yarn outdated --json"), ...base, update: (rows) => `yarn upgrade ${at(rows).join(" ")}` });
      // yarn 2+ has no `outdated`: npm reads package.json and node_modules (a Plug'n'Play project has none: it says so).
      else if (berry) out.push({ id: "npm", label: "yarn (read with npm)", tool: "npm", check: guard("npm", "npm outdated --json"), ...base, update: (rows) => `yarn up ${at(rows).join(" ")}` });
      else out.push({ id: "npm", label: "npm", tool: "npm", check: guard("npm", "npm outdated --json"), ...base, update: (rows) => `npm install ${at(rows).join(" ")}` });
    }
  }
  const py = files["pyproject.toml"];
  if (py != null && have.includes("uv.lock")) {
    out.push({ id: "uv", label: "uv", tool: "uv", check: guard("uv", "uv tree --outdated --depth 1"), devNames: [], berry: false,
      update: (rows) => {
        const key = (r) => (r.extra ? `--optional ${shq(r.extra)}` : r.group === "dev" || (!r.group && r.dev) ? "--dev" : r.group ? `--group ${shq(r.group)}` : "");
        const by = new Map();
        for (const r of rows) by.set(key(r), [...(by.get(key(r)) ?? []), r]);
        return [...by].map(([flag, rs]) => `uv add ${flag ? `${flag} ` : ""}${rs.map((r) => shq(`${r.name}>=${r.latest}`)).join(" ")}`).join(" && ");
      } });
  } else if (files["requirements.txt"] != null || (py != null && !have.includes("poetry.lock"))) {
    out.push({ id: "pip", label: "pip", tool: "python3", declared: declaredPython(files), devNames: [], berry: false,
      check: `command -v python3 >/dev/null 2>&1 || [ -x .venv/bin/python ] || { echo ${MISSING}python3; exit 127; }; ${PY}"$PY" -m pip list --outdated --format json --disable-pip-version-check`,
      update: (rows) => `${PY}"$PY" -m pip install --upgrade ${names(rows).join(" ")}` });
  }
  if (files["Cargo.toml"] != null) {
    out.push({ id: "cargo", label: "Cargo", tool: "cargo", devNames: [], berry: false,
      check: `command -v cargo >/dev/null 2>&1 || { echo ${MISSING}cargo; exit 127; }; cargo outdated --version >/dev/null 2>&1 || { echo ${MISSING}cargo-outdated; exit 127; }; cargo outdated --format json --root-deps-only`,
      // A step inside the version the Cargo.toml allows is a lockfile update; a major one asks Cargo.toml for the new version.
      update: (rows) => {
        const lock = rows.filter((r) => r.kind !== "major"), bigs = rows.filter((r) => r.kind === "major");
        return [lock.length ? `cargo update ${lock.map((r) => `-p ${shq(r.name)}`).join(" ")}` : null, ...bigs.map((r) => `cargo add ${shq(`${r.name}@${r.latest}`)}${r.dev ? " --dev" : ""}`)].filter(Boolean).join(" && ");
      } });
  }
  if (files["go.mod"] != null) {
    out.push({ id: "go", label: "Go modules", tool: "go", devNames: [], berry: false, check: guard("go", "go list -u -m -json all"),
      update: (rows) => `go get ${at(rows).join(" ")} && go mod tidy` });
  }
  return out;
}

// What a result needs for the command to update packages: `rows` of one ecosystem.
export const updateCommand = (eco, rows) => (rows.length ? eco.update(rows) : "");

// ---- grouping and asking ----

// Rows for a filter: the text in the name, or the word of the kind ("major"), or "dev".
export function filterRows(rows, q) {
  const t = String(q ?? "").trim().toLowerCase();
  if (!t) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(t) || r.kind === t || (t === "dev" && r.dev));
}
// [{ kind, count, rows }] in the order major, minor, patch; kinds with none are left out.
export function groupRows(rows) {
  return KINDS.map((kind) => ({ kind, rows: rows.filter((r) => r.kind === kind) })).filter((g) => g.rows.length).map((g) => ({ ...g, count: g.rows.length }));
}
export const counts = (rows) => ({ major: rows.filter((r) => r.kind === "major").length, minor: rows.filter((r) => r.kind === "minor").length, patch: rows.filter((r) => r.kind === "patch").length, total: rows.length });
// The rows "Update all patch+minor" updates.
export const safeRows = (rows) => rows.filter((r) => r.kind !== "major");
// The packages "Ask agent" is about: the ticked ones, else the major ones (the ones to take care with), else all.
export function askRows(rows, selected = []) {
  const sel = rows.filter((r) => selected.includes(r.name));
  if (sel.length) return sel;
  const big = rows.filter((r) => r.kind === "major");
  return big.length ? big : rows;
}

const MAX_ASK = 60;
// The message for the chat's box (not sent): what to update, and how to check it afterwards.
export function askPrompt(eco, rows, { root = "", verify = "" } = {}) {
  const big = rows.filter((r) => r.kind === "major"), rest = rows.filter((r) => r.kind !== "major");
  const one = (r) => `- ${r.name} ${r.current} -> ${r.latest}${r.dev ? " (dev)" : ""}${r.kind === "major" ? " (major)" : ""}`;
  const shown = [...big, ...rest].slice(0, MAX_ASK);
  const body = [
    `Please update these outdated ${eco.label} dependencies${root ? ` in ${root}` : ""}${rows.length === 1 ? "" : ", one package at a time"}.`,
    big.length ? "For the major ones, read the changelog or migration guide first and change the code the update breaks." : null,
    "",
    ...shown.map(one),
    rows.length > shown.length ? `- and ${rows.length - shown.length} more` : null,
    "",
    `The command for them: ${updateCommand(eco, rows.slice(0, MAX_ASK))}`,
    verify ? `Afterwards run ${verify} and fix what fails.` : "Afterwards run the project's tests and type check, and fix what fails.",
  ];
  return body.filter((l) => l != null).join("\n");
}

export const ago = (ms) => (ms < 60000 ? "just now" : ms < 3600000 ? `${Math.floor(ms / 60000)} min ago` : ms < 86400000 ? `${Math.floor(ms / 3600000)} h ago` : `${Math.floor(ms / 86400000)} d ago`);
