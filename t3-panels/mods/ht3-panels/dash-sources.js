// Where a Dashboard widget's data comes from (dashboard.js asks, dash-data.js shapes it).
// Every source only reads: a query, a GET, a file, a command the dashboard's author wrote.
// source: { type, … }; ctx: { prometheus: the dashboard's server, if it names one }.

import { exec, readTextFile, home, spaces } from "herdr";
import { promRows, joinBy, seconds, parse, ciOf } from "./dash-data.js";

const first = (text) => String(text ?? "").trim().split("\n")[0].slice(0, 200);
const tilde = (p) => (String(p).startsWith("~/") ? home() + String(p).slice(1) : String(p));

// "static": the data is in the file itself ({ data }). For trying a widget out.
async function fromStatic(s) {
  if (!("data" in s)) throw new Error('A "static" source needs "data"');
  return s.data;
}

// "prometheus": { query } answers rows of the labels plus `value`; with { range: "30m", step: 30 } each row has
// `points` ([[time, value], …]) as well, for a line or a sparkline. { queries: { name: query, … }, by: "host" }
// asks several and answers one row per value of that label, each query's value under its name (a query may be
// { query, range, step } to bring `<name>_points` too). url: the server (default: the dashboard's "prometheus",
// else http://localhost:9090). Asked through curl, a GET-like POST of the query only.
async function fromPrometheus(s, ctx) {
  const base = String(s.url ?? ctx.prometheus ?? "http://localhost:9090").replace(/\/+$/, "");
  const one = async (q) => {
    const query = typeof q === "string" ? q : q?.query, range = seconds((typeof q === "object" ? q.range : null) ?? s.range, 0);
    if (!query) throw new Error('A "prometheus" source needs "query" or "queries"');
    const args = ["-sS", "-m", "10", "--data-urlencode", `query=${query}`];
    if (range > 0) {
      const end = Math.floor(Date.now() / 1000), step = Math.max(1, Math.round(seconds((typeof q === "object" ? q.step : null) ?? s.step, Math.ceil(range / 60))));
      args.push("--data-urlencode", `start=${end - range}`, "--data-urlencode", `end=${end}`, "--data-urlencode", `step=${step}`);
    }
    const r = await exec("curl", [...args, `${base}${range > 0 ? "/api/v1/query_range" : "/api/v1/query"}`], { timeout: 15000 });
    if (r.code !== 0) throw new Error(`Prometheus at ${base} didn't answer: ${first(r.stderr) || `curl exited ${r.code}`}`);
    let body;
    try { body = JSON.parse(r.stdout); } catch { throw new Error(`Prometheus at ${base} answered something that isn't JSON: ${first(r.stdout)}`); }
    return promRows(body);
  };
  if (s.queries && typeof s.queries === "object") {
    const names = Object.keys(s.queries), rows = await Promise.all(names.map((n) => one(s.queries[n])));
    return joinBy(Object.fromEntries(names.map((n, i) => [n, rows[i]])), s.by ?? "instance");
  }
  return one(s);
}

// "command": { run, args: [], on (a machine, as a space's), cwd, timeout (seconds), parse }. Or { shell: "…" } for
// a line of sh. What it prints is read as `parse` says (dash-data.js parse: auto, json, lines, text, number).
// A command that exits with an error is an error, with its first line.
async function fromCommand(s) {
  const cmd = s.shell != null ? "sh" : s.run, args = s.shell != null ? ["-c", String(s.shell)] : (s.args ?? []).map(String);
  if (!cmd) throw new Error('A "command" source needs "run" or "shell"');
  const r = await exec(String(cmd), args, { on: s.on ?? null, ...(s.cwd ? { cwd: tilde(s.cwd) } : {}), timeout: Math.min(120, Math.max(1, seconds(s.timeout, 20))) * 1000 });
  if (r.code !== 0) throw new Error(`${s.shell != null ? "The command" : cmd} exited ${r.code}: ${first(r.stderr) || first(r.stdout) || "no output"}`);
  return parse(r.stdout, s.parse);
}

// "http": { url, headers: { name: value }, timeout, parse }: a GET through curl (which also works where a mod
// has no network call of its own). An HTTP error status is an error.
async function fromHttp(s) {
  if (!/^https?:\/\//i.test(String(s.url ?? ""))) throw new Error('An "http" source needs a "url" that starts with http:// or https://');
  const t = Math.min(60, Math.max(1, seconds(s.timeout, 10)));
  const heads = Object.entries(s.headers ?? {}).flatMap(([k, v]) => ["-H", `${k}: ${v}`]);
  const r = await exec("curl", ["-sS", "-f", "-L", "-m", String(t), ...heads, String(s.url)], { timeout: (t + 5) * 1000 });
  if (r.code !== 0) throw new Error(`${s.url}: ${first(r.stderr) || `curl exited ${r.code}`}`);
  return parse(r.stdout, s.parse);
}

// "file": { path (~/ is the home folder), on, parse }. Up to 1 MiB.
async function fromFile(s) {
  if (!s.path) throw new Error('A "file" source needs "path"');
  const text = await readTextFile(tilde(s.path), { on: s.on ?? null });
  if (text == null) throw new Error(`${s.path}: no such file (or over 1 MiB)`);
  return parse(text, s.parse);
}

// "fleetq": `fleetq status --json`, as the `fleet` mod reads it, with what a widget would otherwise have to work
// out added: per host `free` (the measured free memory when the box reports it, else fleetq's sum), `used`,
// `gpu_pct`, `spark`, `services_n`, `up` and `down` (services), `running_n`, `queued_n`, `state` ("online" | "offline"); and at
// the top `services` and `jobs`, every host's in one list (a job on several boxes once, with `on`).
const fleetqPaths = () => ["fleetq", `${home()}/.local/bin/fleetq`];
async function fromFleetq() {
  let r = null, missing = 0;
  for (const bin of fleetqPaths()) {
    try { r = await exec(bin, ["status", "--json"], { timeout: 20000 }); } catch { missing++; continue; }
    if (r.code === 127) { missing++; r = null; continue; }
    break;
  }
  if (!r) throw new Error(missing ? "fleetq isn't installed (looked on PATH and in ~/.local/bin)" : "fleetq didn't start");
  if (r.code !== 0) throw new Error(`fleetq: ${first(r.stderr) || first(r.stdout) || `exited ${r.code}`}`);
  const d = JSON.parse(r.stdout), now = d.now ?? Date.now() / 1000;
  const jobs = new Map(), services = [];
  const hosts = (d.hosts ?? []).map((h) => {
    const free = h.actual_free_gb ?? h.free_gb ?? null, list = h.services ?? [];
    for (const s of list) services.push({ ...s, host: h.name, state: s.warn ? "warn" : s.status });
    for (const j of [...(h.running ?? []), ...(h.queued ?? [])]) {
      const left = j.state === "running" ? (j.deadline_in_s ?? (j.started_at && j.expect_s ? j.started_at + j.expect_s - now : null)) : j.start_in_s ?? null;
      const had = jobs.get(j.id);
      if (had) had.on = `${had.on}, ${h.name}`;
      else jobs.set(j.id, { ...j, on: h.name, left_s: left, when: j.state === "running" ? (left == null ? "running" : left < 0 ? "over its time" : "running") : "queued" });
    }
    return { ...h, free, used: h.capacity_gb != null && free != null ? Math.max(0, h.capacity_gb - free) : null,
      gpu_pct: h.gpu_util != null ? Math.round(h.gpu_util * 100) : null, spark: /spark/i.test(`${h.name} ${h.machine ?? ""}`),
      services_n: list.length, up: list.filter((s) => s.status === "up").length, down: list.filter((s) => s.status !== "up" && s.status !== "held").length,
      running_n: (h.running ?? []).length, queued_n: (h.queued ?? []).length, state: h.online ? "online" : "offline" };
  });
  return { ...d, hosts, services, jobs: [...jobs.values()], probe_age_s: d.last_probe ? Math.max(0, now - d.last_probe) : null };
}

// "projects": a row per project folder: the folder of every Herdr space (each on its own machine), then `extra`
// ([{ name, path, on }]). Per row: name, space (its id, for a click), path, on, where, git, branch, dirty (changed
// and untracked files), ahead and behind its upstream (null without one), commit (the last one's Unix time),
// subject, github (a remote there), pr ("#12" for the branch's open pull request), pr_title, pr_state, ci
// ("passing" | "failing" | "pending" | null), note (why something is missing). gh: false leaves GitHub out.
// Reads only: git status with no optional locks, and `gh pr view` where the remote is on GitHub.
const PROJECT = `cd "$1" 2>/dev/null || { echo "gone=1"; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "git=0"; exit 0; }
echo "git=1"
echo "branch=$(git symbolic-ref --short -q HEAD || git rev-parse --short HEAD 2>/dev/null)"
echo "dirty=$(git --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
ab=$(git rev-list --left-right --count '@{u}...HEAD' 2>/dev/null) && echo "ab=$ab"
echo "commit=$(git log -1 --format=%ct 2>/dev/null)"
echo "subject=$(git log -1 --format=%s 2>/dev/null | cut -c1-100)"
git remote -v 2>/dev/null | grep -qi 'github' && echo "github=1"
command -v gh >/dev/null 2>&1 && echo "gh=1"
true`;
async function oneProject(p, useGh) {
  const row = { name: p.name, space: p.space ?? null, path: p.path, on: p.on ?? null, where: p.on ? `${p.on}:${p.path}` : p.path,
    git: false, branch: null, dirty: null, ahead: null, behind: null, commit: null, subject: null, github: false, pr: null, pr_title: null, pr_state: null, ci: null, note: null };
  let r;
  try { r = await exec("sh", ["-c", PROJECT, "project", p.path], { on: p.on ?? null, timeout: 15000 }); }
  catch (e) { row.note = p.on ? `${p.on} can't be reached` : first(e?.message ?? e); return row; }
  const said = Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (said.gone) { row.note = "The folder is gone"; return row; }
  if (said.git !== "1") { row.note = "Not a git repository"; return row; }
  const [behind, ahead] = String(said.ab ?? "").trim().split(/\s+/).map(Number);
  Object.assign(row, { git: true, branch: said.branch || null, dirty: Number(said.dirty) || 0, ahead: said.ab ? ahead : null, behind: said.ab ? behind : null,
    commit: Number(said.commit) || null, subject: said.subject || null, github: said.github === "1" });
  if (!row.github) { row.note = "No remote on GitHub"; return row; }
  if (!useGh) return row;
  if (said.gh !== "1") { row.note = "The GitHub CLI (gh) isn't installed there"; return row; }
  try {
    const g = await exec("gh", ["pr", "view", "--json", "number,state,title,isDraft,statusCheckRollup"], { cwd: p.path, on: p.on ?? null, timeout: 20000 });
    if (g.code === 0) {
      const pr = JSON.parse(g.stdout);
      if (pr.state === "OPEN") Object.assign(row, { pr: `#${pr.number}`, pr_title: pr.title ?? null, pr_state: pr.isDraft ? "draft" : "open", ci: ciOf(pr.statusCheckRollup) });
    } else if (!/no pull requests found|no open pull requests/i.test(g.stderr)) row.note = first(g.stderr);
  } catch (e) { row.note = `gh: ${first(e?.message ?? e)}`; }
  return row;
}
async function fromProjects(s) {
  const all = new Map();
  const add = (p) => { const key = `${p.on ?? ""}|${p.path}`; if (p.path && !all.has(key) && all.size < 40) all.set(key, p); };
  if (s.spaces !== false) for (const sp of spaces()) add({ name: sp.name, space: sp.id, path: String(sp.folder || "").replace(/\/+$/, ""), on: sp.machine ?? null });
  for (const e of s.extra ?? []) if (e?.path) { const path = tilde(e.path).replace(/\/+$/, ""); add({ name: e.name ?? path.split("/").pop(), space: null, path, on: e.on ?? null }); }
  return Promise.all([...all.values()].map((p) => oneProject(p, s.gh !== false)));
}

const SOURCES = { projects: fromProjects, static: fromStatic, prometheus: fromPrometheus, command: fromCommand, http: fromHttp, file: fromFile, fleetq: fromFleetq };
export const SOURCE_TYPES = Object.keys(SOURCES);

export async function fetchSource(source, ctx = {}) {
  const get = SOURCES[source?.type];
  if (!get) throw new Error(source?.type ? `No source type "${source.type}" (there are: ${SOURCE_TYPES.join(", ")})` : "This widget has no source");
  return get(source, ctx);
}
