// The commands a project says it has: from package.json scripts, a Makefile, a justfile, Cargo.toml and pyproject.toml.
// No Herdr imports (scripts.js reads the files on the project's machine and hands the text here), so node can test it.
//
// detectCommands({ "package.json": text, Makefile: text, justfile: text, "Cargo.toml": text, "pyproject.toml": text, names: [file names present] })
//   -> { checks: [{ id, kind, name, command, source }], dev: { command, source } | null, scripts: [{ name, command, source }] }
// kind: "test" | "typecheck" | "lint" | "build" | "check". `scripts` is what Settings' Import scripts offers: every
// package.json script, Makefile target and justfile recipe, not only the checks.

export const FILES = ["package.json", "Makefile", "makefile", "GNUmakefile", "justfile", "Justfile", "Cargo.toml", "pyproject.toml"];
// Files that say which package manager (or Python tool) the project uses.
export const LOCKS = ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json", "uv.lock", "poetry.lock", "tsconfig.json"];

const KIND = { test: "test", tests: "test", typecheck: "typecheck", "type-check": "typecheck", "check-types": "typecheck", "types": "typecheck", tsc: "typecheck", lint: "lint", build: "build", check: "check" };
const ORDER = ["test", "typecheck", "lint", "build", "check"];
const DEV = ["dev", "start", "serve", "run"];

export function packageManager(names = []) {
  const has = (n) => names.includes(n);
  return has("pnpm-lock.yaml") ? "pnpm" : has("bun.lock") || has("bun.lockb") ? "bun" : has("yarn.lock") ? "yarn" : "npm";
}
const runScript = (pm, name) => (pm === "npm" || pm === "bun" || pm === "pnpm" || pm === "yarn" ? `${pm} run ${name}` : `${pm} ${name}`);

export function packageScripts(text) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const scripts = json && typeof json.scripts === "object" ? json.scripts : {};
  return { scripts: Object.fromEntries(Object.entries(scripts).filter(([, v]) => typeof v === "string")), deps: { ...(json?.dependencies ?? {}), ...(json?.devDependencies ?? {}) } };
}

// Makefile targets: `name:` at the start of a line, not a variable (`:=`), not a special `.PHONY`, not a pattern rule.
export function makeTargets(text) {
  const out = [];
  for (const l of String(text ?? "").split("\n")) {
    const m = l.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=:])/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
// justfile recipes: `name args:` (a `:=` is a variable); `@name` and `[private]` forms count, `_name` ones are private.
export function justRecipes(text) {
  const out = [];
  for (const l of String(text ?? "").split("\n")) {
    const m = l.match(/^@?([A-Za-z][A-Za-z0-9_-]*)(?:\s+[^:]*?)?\s*:(?!=)/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const add = (list, c) => { if (!list.some((x) => x.command === c.command)) list.push(c); };

export function detectCommands(files = {}) {
  const names = files.names ?? [];
  const checks = [], scripts = [];
  let dev = null;
  const pm = packageManager(names), uv = names.includes("uv.lock");

  const pkg = files["package.json"] ? packageScripts(files["package.json"]) : null;
  if (pkg) {
    const entries = Object.entries(pkg.scripts);
    for (const [name] of entries) scripts.push({ name, command: runScript(pm, name), source: "package.json" });
    for (const [name] of entries) {
      const kind = KIND[name];
      if (kind) add(checks, { kind, name, command: runScript(pm, name), source: "package.json" });
    }
    // TypeScript with no script that checks types: tsc itself.
    if (!checks.some((c) => c.kind === "typecheck") && ("typescript" in pkg.deps) && names.includes("tsconfig.json")) {
      add(checks, { kind: "typecheck", name: "tsc", command: pm === "npm" ? "npx tsc --noEmit" : `${pm === "bun" ? "bunx" : pm === "pnpm" ? "pnpm exec" : "yarn"} tsc --noEmit`, source: "tsconfig.json" });
    }
    const d = DEV.find((n) => n in pkg.scripts && (n !== "run"));
    if (d) dev = { command: runScript(pm, d), source: `package.json "${d}"` };
  }

  const make = files.Makefile ?? files.makefile ?? files.GNUmakefile;
  if (make) {
    const targets = makeTargets(make);
    for (const t of targets) scripts.push({ name: t, command: `make ${t}`, source: "Makefile" });
    for (const t of targets) if (KIND[t] && t !== "tsc") add(checks, { kind: KIND[t], name: t, command: `make ${t}`, source: "Makefile" });
    if (!dev) { const d = DEV.find((n) => targets.includes(n)); if (d) dev = { command: `make ${d}`, source: `Makefile "${d}"` }; }
  }

  const just = files.justfile ?? files.Justfile;
  if (just) {
    const recipes = justRecipes(just);
    for (const t of recipes) scripts.push({ name: t, command: `just ${t}`, source: "justfile" });
    for (const t of recipes) if (KIND[t] && t !== "tsc") add(checks, { kind: KIND[t], name: t, command: `just ${t}`, source: "justfile" });
    if (!dev) { const d = DEV.find((n) => recipes.includes(n)); if (d) dev = { command: `just ${d}`, source: `justfile "${d}"` }; }
  }

  if (files["Cargo.toml"] != null) {
    add(checks, { kind: "test", name: "cargo test", command: "cargo test", source: "Cargo.toml" });
    add(checks, { kind: "check", name: "cargo check", command: "cargo check", source: "Cargo.toml" });
    add(checks, { kind: "lint", name: "cargo clippy", command: "cargo clippy --all-targets", source: "Cargo.toml" });
    add(checks, { kind: "build", name: "cargo build", command: "cargo build", source: "Cargo.toml" });
  }

  const py = files["pyproject.toml"];
  if (py != null) {
    const pre = uv ? "uv run " : names.includes("poetry.lock") ? "poetry run " : "";
    if (/pytest/i.test(py)) add(checks, { kind: "test", name: "pytest", command: `${pre}pytest`, source: "pyproject.toml" });
    if (/\[tool\.ruff|\bruff\b/.test(py)) add(checks, { kind: "lint", name: "ruff", command: `${pre}ruff check .`, source: "pyproject.toml" });
    if (/\[tool\.mypy|\bmypy\b/.test(py)) add(checks, { kind: "typecheck", name: "mypy", command: `${pre}mypy .`, source: "pyproject.toml" });
  }

  checks.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const seen = new Set();
  for (const c of checks) { c.id = `d:${c.command}`; }
  return { checks: checks.filter((c) => !seen.has(c.id) && seen.add(c.id)), dev, scripts };
}

// Detected scripts a project doesn't have yet (same command, or same name, counts as having it), each with a name
// that is free: a name two sources share gets its source's name in front (`make:test`).
export function importable(found, have = []) {
  const cmds = new Set(have.map((s) => s.command)), names = new Set(have.map((s) => s.name.toLowerCase()));
  const dup = new Set();
  const count = new Map();
  for (const s of found) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  for (const [n, c] of count) if (c > 1) dup.add(n);
  const out = [];
  for (const s of found) {
    if (cmds.has(s.command)) continue;
    const name = dup.has(s.name) ? `${{ "package.json": "package", Makefile: "make", justfile: "just" }[s.source] ?? s.source}:${s.name}` : s.name;
    if (names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    out.push({ name, command: s.command, source: s.source });
  }
  return out;
}

// The dev command to run: a project script named Dev (any case), else the detected one.
export function devCommand(scripts = [], dev = null) {
  const s = scripts.find((x) => /^(dev|run dev|dev server)$/i.test(x.name.trim()));
  return s ? { command: s.command, source: `script "${s.name}"` } : dev;
}

// ---- reading the files ----

// One `sh` run prints each file that exists after a line `\x1e<name>`, and the lockfiles present after `\x1enames`.
// $1: the folder. Files are cut at 256 KB.
export const READ = `cd "$1" 2>/dev/null || exit 0; for f in ${FILES.join(" ")}; do [ -f "$f" ] && { printf '\\036%s\\n' "$f"; head -c 262144 "$f"; printf '\\n'; }; done; printf '\\036names\\n'; ls -d ${LOCKS.join(" ")} 2>/dev/null; true`;
export function parseBundle(stdout) {
  const files = { names: [] };
  for (const part of String(stdout ?? "").split("\x1e").slice(1)) {
    const nl = part.indexOf("\n"), name = (nl < 0 ? part : part.slice(0, nl)).trim(), body = nl < 0 ? "" : part.slice(nl + 1);
    if (name === "names") files.names = body.split("\n").map((l) => l.trim()).filter(Boolean);
    else if (name) files[name] = body;
  }
  return files;
}
