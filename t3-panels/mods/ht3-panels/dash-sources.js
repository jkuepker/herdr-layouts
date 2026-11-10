// Where a Dashboard widget's data comes from (dashboard.js asks, dash-data.js shapes it).
// Every source only reads: a query, a GET, a file, a command the dashboard's author wrote.
// source: { type, … }; ctx: { prometheus: the dashboard's server, if it names one }.

import { exec, readTextFile, home } from "herdr";
import { promRows, joinBy, seconds, parse } from "./dash-data.js";

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
// `gpu_pct`, `spark`, `up` and `down` (services), `running_n`, `queued_n`, `state` ("online" | "offline"); and at
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
      up: list.filter((s) => s.status === "up").length, down: list.filter((s) => s.status !== "up" && s.status !== "held").length,
      running_n: (h.running ?? []).length, queued_n: (h.queued ?? []).length, state: h.online ? "online" : "offline" };
  });
  return { ...d, hosts, services, jobs: [...jobs.values()], probe_age_s: d.last_probe ? Math.max(0, now - d.last_probe) : null };
}

const SOURCES = { static: fromStatic, prometheus: fromPrometheus, command: fromCommand, http: fromHttp, file: fromFile, fleetq: fromFleetq };
export const SOURCE_TYPES = Object.keys(SOURCES);

export async function fetchSource(source, ctx = {}) {
  const get = SOURCES[source?.type];
  if (!get) throw new Error(source?.type ? `No source type "${source.type}" (there are: ${SOURCE_TYPES.join(", ")})` : "This widget has no source");
  return get(source, ctx);
}
