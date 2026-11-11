// The commands a project says it has: from package.json scripts, a Makefile, a justfile, Cargo.toml and pyproject.toml.
// No Herdr imports (scripts.js reads the files on the project's machine and hands the text here), so node can test it.
//
// detectCommands({ "package.json": text, Makefile: text, justfile: text, "Cargo.toml": text, "pyproject.toml": text, names: [file names present] })
//   -> { checks: [{ id, kind, name, command, source }], dev: { command, source } | null, scripts: [{ name, command, source }] }
// kind: "test" | "typecheck" | "lint" | "build" | "check". `scripts` is what Settings' Import scripts offers: every
// package.json script, Makefile target and justfile recipe, not only the checks.

export const FILES = ["package.json", "Makefile", "makefile", "GNUmakefile", "justfile", "Justfile", "Cargo.toml", "pyproject.toml"];
// Files that say which package manager (or Python tool) the project uses.
export const LOCKS = ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json", "uv.lock", "poetry.lock", "tsconfig.json",
  "vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs", "vitest.workspace.ts", "jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs", "jest.config.json", "pytest.ini", "go.mod"];

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
  return { checks: checks.filter((c) => !seen.has(c.id) && seen.add(c.id)), dev, scripts, tools: impactTools(files, pkg) };
}

// ---- related tests ----
// The test tools the folder uses, as detectImpact needs them: { vitest, jest, pytest, go, cargo, exec, py, any }.
// exec: what runs a package's binary with the project's manager (npx, pnpm exec, yarn, bunx); py: the Python runner in front (uv run, poetry run).
export const execPrefix = (pm) => (pm === "pnpm" ? "pnpm exec" : pm === "yarn" ? "yarn" : pm === "bun" ? "bunx" : "npx");
export function impactTools(files = {}, pkg = undefined) {
  const names = files.names ?? [];
  const has = (re) => names.some((n) => re.test(n));
  pkg = pkg === undefined ? (files["package.json"] ? packageScripts(files["package.json"]) : null) : pkg;
  const dep = (n) => !!pkg && n in pkg.deps;
  const py = files["pyproject.toml"];
  const t = {
    vitest: dep("vitest") || has(/^vitest\./),
    jest: dep("jest") || has(/^jest\.config\./),
    pytest: (py != null && /pytest/i.test(py)) || names.includes("pytest.ini"),
    go: names.includes("go.mod"),
    cargo: files["Cargo.toml"] != null,
    exec: execPrefix(packageManager(names)),
    py: names.includes("uv.lock") ? "uv run " : names.includes("poetry.lock") ? "poetry run " : "",
  };
  t.any = t.vitest || t.jest || t.pytest || t.go || t.cargo;
  return t;
}

export const IMPACT_MAX = 200; // more changed files than this: the full run

// A path as one shell word: plain ones as they are, others in single quotes. A leading "-" gets "./" so it isn't an option.
export function shq(path) {
  const p = String(path).startsWith("-") ? `./${path}` : String(path);
  return /^[A-Za-z0-9_.\/@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

const JS_SOURCE = /\.(?:[mc]?[jt]sx?|vue|svelte)$/i;
const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// The test files of a Python project that go with the changed files. `all`: the project's .py files (relative paths).
// A changed test file stands for itself; pkg/foo.py takes test_foo.py (beside it, or in a tests/ or test/ folder) and foo_test.py (anywhere).
export function pytestTargets(changed, all) {
  const isTest = (b) => /^test_.+\.py$/.test(b) || /^.+_test\.py$/.test(b);
  const out = new Set();
  const inTests = (p) => p.split("/").slice(0, -1).some((s) => s === "tests" || s === "test");
  for (const f of changed) {
    const b = base(f);
    if (!b.endsWith(".py")) continue;
    if (isTest(b)) { out.add(f); continue; }
    const stem = b.slice(0, -3);
    for (const t of all) {
      const tb = base(t);
      if ((tb === `test_${stem}.py` && (dir(t) === dir(f) || inTests(t))) || tb === `${stem}_test.py`) out.add(t);
    }
  }
  return [...out].sort();
}

// The command that runs only the tests related to the changed files, or null when the project has no way to.
// changed: paths relative to the folder, or { path, deleted }; all: the project's .py files (pytest only).
// -> { tool, mode: "related" | "full", command, name, files: how many changed, used: how many the command names } | null
export function detectImpact(tools, changed = [], { all = [], max = IMPACT_MAX } = {}) {
  if (!tools?.any) return null;
  const list = changed.map((c) => (typeof c === "string" ? { path: c, deleted: false } : c)).filter((c) => c?.path);
  if (!list.length) return null;
  const live = [...new Set(list.filter((c) => !c.deleted).map((c) => c.path))].sort();
  const mk = (tool, command, mode, used, why = "") => ({ tool, mode, command, name: "Related tests", files: list.length, used, why });
  const over = list.length > max, cap = `more than ${max} changed files: the full run`;
  const ex = tools.exec ?? "npx", py = tools.py ?? "";

  if (tools.vitest || tools.jest) {
    const js = live.filter((f) => JS_SOURCE.test(f));
    const tool = tools.vitest ? "vitest" : "jest";
    if (!js.length) return null;
    if (over) return mk(tool, tool === "vitest" ? `${ex} vitest run` : `${ex} jest`, "full", 0, cap);
    return mk(tool, tool === "vitest" ? `${ex} vitest related --run ${js.map(shq).join(" ")}` : `${ex} jest --findRelatedTests ${js.map(shq).join(" ")}`, "related", js.length);
  }
  if (tools.pytest) {
    if (!live.some((f) => f.endsWith(".py"))) return null;
    if (over) return mk("pytest", `${py}pytest`, "full", 0, cap);
    const gone = new Set(list.filter((c) => c.deleted).map((c) => c.path)); // ls-files lists a deleted tracked file too
    const t = pytestTargets(live, all.filter((f) => !gone.has(f)));
    return t.length ? mk("pytest", `${py}pytest ${t.map(shq).join(" ")}`, "related", t.length) : mk("pytest", `${py}pytest`, "full", 0, "no test file found for the changed files: the full run");
  }
  if (tools.go) {
    const dirs = [...new Set(live.filter((f) => f.endsWith(".go")).map((f) => (dir(f) ? `./${dir(f)}` : ".")))].sort();
    if (!dirs.length) return null;
    return over ? mk("go", "go test ./...", "full", 0, cap) : mk("go", `go test ${dirs.map(shq).join(" ")}`, "related", dirs.length);
  }
  if (tools.cargo) return mk("cargo", "cargo test", "full", 0, "cargo can't pick tests by file: the full run");
  return null;
}

// What `git status --porcelain -z` says ("XY path" entries, a rename or copy followed by its old path), as the
// changed files below `prefix` (git's --show-prefix: "" at the top, else "sub/dir/"), paths relative to the folder.
// stdout has the entries cut by "\x1f" (the script turns the NULs into that).
export function parseStatus(text, prefix = "") {
  const parts = String(text ?? "").split("\x1f");
  const out = [], seen = new Set();
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4 || e[2] !== " ") continue;
    const x = e[0], y = e[1];
    let path = e.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    if (prefix) { if (!path.startsWith(prefix)) continue; path = path.slice(prefix.length); }
    if (!path || path.endsWith("/") || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, deleted: x === "D" || y === "D" });
  }
  return out;
}

// One `sh` run: $1 the folder, $2 "1" when the project's .py files are wanted. Prints "\x1eprefix", "\x1estatus", "\x1epy" sections.
export const IMPACT_READ = `cd "$1" 2>/dev/null || exit 0; printf '\\036prefix\\n'; git rev-parse --show-prefix 2>/dev/null; `
  + `printf '\\036status\\n'; git status --porcelain -z --untracked-files=all -- . 2>/dev/null | tr '\\0' '\\037'; `
  + `printf '\\036py\\n'; [ "$2" = 1 ] && git ls-files -z -co --exclude-standard -- '*.py' 2>/dev/null | tr '\\0' '\\037'; true`;
// -> { changed: [{ path, deleted }], all: [.py paths] }
export function parseImpact(stdout) {
  const sec = {};
  for (const part of String(stdout ?? "").split("\x1e").slice(1)) {
    const nl = part.indexOf("\n");
    sec[(nl < 0 ? part : part.slice(0, nl)).trim()] = nl < 0 ? "" : part.slice(nl + 1);
  }
  const prefix = (sec.prefix ?? "").trim();
  return { changed: parseStatus((sec.status ?? "").replace(/\n$/, ""), prefix), all: (sec.py ?? "").split("\x1f").map((l) => l.replace(/\n$/, "")).filter(Boolean) };
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
