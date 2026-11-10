// The Dashboard surface's data steps (dashboard.js draws, dash-sources.js fetches). No Herdr calls here, so the
// whole file runs under Node too (t3-panels/dashboards/test.mjs).
//
// A widget's data goes: source -> pick -> the widget's own fields (value, label, columns…), each a path or a template.
//
// Paths are a small part of jq: `.a.b`, `.a[0]`, `.a[]` (every item), `."a key"`, and `.` (the value itself).
// With a `[]` in it a path answers a list, else one value (undefined when it isn't there).
// A template is text with paths in braces: "{.name} on {.machine}". A string that starts with "." and has no brace
// is a path.

const STEP = /\.(?:"([^"]+)"|([A-Za-z_$][\w$-]*))?|\[(\d+)?\]/g;

export function pick(value, path) {
  if (path == null || path === "" || path === ".") return value;
  let many = false, now = [value];
  STEP.lastIndex = 0;
  let at = 0;
  for (let m; (m = STEP.exec(path)) !== null;) {
    if (m.index !== at) break;
    at = STEP.lastIndex;
    if (m[0] === ".") continue;
    const key = m[1] ?? m[2];
    if (key != null) now = now.map((v) => (v == null ? undefined : v[key]));
    else if (m[3] != null) now = now.map((v) => (Array.isArray(v) ? v[Number(m[3])] : undefined));
    else { many = true; now = now.flatMap((v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [])); }
  }
  if (at !== path.length) throw new Error(`Can't read the path ${path}`);
  return many ? now : now[0];
}

export const isPath = (s) => typeof s === "string" && s.startsWith(".") && !s.includes("{");

// A field of a widget for one row: a path, a template, or a plain value.
export function field(row, spec) {
  if (spec == null) return undefined;
  if (typeof spec !== "string") return spec;
  if (isPath(spec)) return pick(row, spec);
  if (!spec.includes("{")) return spec;
  return spec.replace(/\{([^{}]+)\}/g, (_all, p) => { const v = pick(row, p.trim()); return v == null ? "" : String(v); });
}

export const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const thousands = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function age(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

// How a value reads. `o`: { format, unit, decimals, scale }.
// format: "number" (the default for numbers), "percent" (0.42 -> 42%; with scale 1, 42 -> 42%), "bytes", "age"
// (seconds), "since" (a Unix time -> how long ago), "text".
export function show(v, o = {}, now = Date.now() / 1000) {
  if (v == null || v === "") return "–";
  const n = num(v), f = o.format ?? (typeof v === "number" ? "number" : "text");
  if (f === "text" || n == null) return String(v) + (o.unit && n != null ? ` ${o.unit}` : "");
  const x = n * (o.scale ?? 1);
  if (f === "percent") return `${(x * (o.scale == null ? 100 : 1)).toFixed(o.decimals ?? 0)}%`;
  if (f === "age") return age(x);
  if (f === "since") return age(now - x);
  if (f === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, b = x;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(o.decimals ?? (b < 10 && i > 0 ? 1 : 0))} ${units[i]}`;
  }
  const d = o.decimals ?? (Number.isInteger(x) ? 0 : Math.abs(x) < 10 ? 2 : 1);
  const [whole, frac] = x.toFixed(d).split(".");
  return thousands(whole) + (frac ? `.${frac}` : "") + (o.unit ? `${o.unit === "%" ? "" : " "}${o.unit}` : "");
}

// "ok" | "warn" | "bad" | null (no thresholds, or not a number, or `when` doesn't match the row).
// t: { warn, bad } for "high is bad"; { below: true, warn, bad } for "low is bad";
//    { ok: [values] , warn: [values] } for states (anything else is bad);
//    when: { path, match } limits it to rows whose field matches the pattern (a Spark's free memory).
// A list of thresholds takes the first whose `when` matches.
export function level(v, t, row) {
  if (!t) return null;
  if (Array.isArray(t)) { for (const one of t) { const l = level(v, one, row); if (l) return l; } return null; }
  if (t.when && !new RegExp(t.when.match ?? "", "i").test(String(field(row, t.when.path) ?? ""))) return null;
  if (Array.isArray(t.ok)) {
    const s = String(v).toLowerCase(), has = (list) => (list ?? []).some((x) => String(x).toLowerCase() === s);
    return has(t.ok) ? "ok" : has(t.warn) ? "warn" : "bad";
  }
  const n = num(v);
  if (n == null) return null;
  if (t.below) return t.bad != null && n < t.bad ? "bad" : t.warn != null && n < t.warn ? "warn" : "ok";
  return t.bad != null && n >= t.bad ? "bad" : t.warn != null && n >= t.warn ? "warn" : "ok";
}

// Up or not, for the status widget, when it has no thresholds of its own.
const UP = new Set(["1", "true", "up", "ok", "ready", "running", "online", "healthy", "success", "passing"]);
const MID = new Set(["starting", "loading", "pending", "queued", "degraded", "warn", "warning", "unknown"]);
export function stateLevel(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  return UP.has(s) ? "ok" : MID.has(s) ? "warn" : "bad";
}

// Rows kept: f is { path, match } (a pattern), { path, eq }, { path, ne } or { path } (truthy).
export function keep(rows, f) {
  if (!f || !Array.isArray(rows)) return rows;
  const re = f.match != null ? new RegExp(f.match, "i") : null;
  return rows.filter((r) => {
    const v = field(r, f.path);
    if (re) return re.test(String(v ?? ""));
    if ("eq" in f) return v === f.eq;
    if ("ne" in f) return v !== f.ne;
    return !!v;
  });
}

export function sortRows(rows, by) {
  if (!by || !Array.isArray(rows)) return rows;
  const desc = by.startsWith("-"), path = desc ? by.slice(1) : by;
  return [...rows].sort((a, b) => {
    const x = field(a, path), y = field(b, path), nx = num(x), ny = num(y);
    const c = nx != null && ny != null ? nx - ny : String(x ?? "").localeCompare(String(y ?? ""));
    return desc ? -c : c;
  });
}

// ---- Prometheus answers, made flat ----

// An instant query's answer -> rows: the labels, plus `value` (a number) and `time`.
export function promRows(body) {
  if (body?.status !== "success") throw new Error(body?.error ?? "Prometheus didn't answer the query");
  const d = body.data;
  if (d.resultType === "scalar") return [{ value: num(d.result[1]), time: d.result[0] }];
  return (d.result ?? []).map((r) => {
    const { __name__, ...labels } = r.metric ?? {};
    return r.values ? { ...labels, metric: __name__ ?? null, points: r.values.map(([t, v]) => [t, num(v)]), value: num(r.values.at(-1)?.[1]) }
      : { ...labels, metric: __name__ ?? null, value: num(r.value?.[1]), time: r.value?.[0] };
  });
}

// Several queries' rows as one table: a row per value of the label `by`, each query's value under its name
// (and its points under `<name>_points` for a range). The labels are the first query's that has the row.
export function joinBy(named, by) {
  const out = new Map();
  for (const [name, rows] of Object.entries(named)) for (const r of rows ?? []) {
    const key = String(r[by] ?? "");
    const { value, time, points, metric, ...labels } = r;
    const row = out.get(key) ?? out.set(key, { ...labels }).get(key);
    // Two series of one query for one row (a model per series): they add up.
    row[name] = row[name] != null && value != null ? row[name] + value : value ?? row[name] ?? null;
    if (points) row[`${name}_points`] = points;
  }
  return [...out.values()];
}

// "30m", "2h", "90s", "1d" or a number of seconds -> seconds.
export function seconds(v, otherwise = 0) {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])?$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? "s"] : otherwise;
}

// Text a command or a file gave, read as `parse` says: "json", "lines" (a list of non-empty lines), "text",
// "number", or "auto" (JSON when it parses, else a number when it is one, else text).
export function parse(text, how = "auto") {
  const t = String(text ?? "");
  if (how === "text") return t.trim();
  if (how === "lines") return t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (how === "number") { const n = num(t.trim()); if (n == null) throw new Error("Not a number"); return n; }
  if (how === "json") return JSON.parse(t);
  try { return JSON.parse(t); } catch { /* not JSON */ }
  return num(t.trim()) ?? t.trim();
}

// A pull request's checks (gh's statusCheckRollup) as one word: "failing" | "pending" | "passing", or null with none.
const BAD = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const WAIT = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", "REQUESTED"]);
export function ciOf(checks) {
  const states = (checks ?? []).map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase()).filter(Boolean);
  if (!states.length) return null;
  return states.some((x) => BAD.has(x)) ? "failing" : states.some((x) => WAIT.has(x)) ? "pending" : "passing";
}

// A dashboard file's text -> { title, widgets, … } with what is missing filled in; throws with a reason a person can act on.
export const TYPES = ["stat", "table", "list", "bars", "line", "status"];
export function readDashboard(text, name) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error(`${name}: not valid JSON (${String(e?.message ?? e)})`); }
  if (!d || typeof d !== "object" || !Array.isArray(d.widgets)) throw new Error(`${name}: needs a "widgets" list`);
  return { title: String(d.title ?? name), refresh: Math.max(5, seconds(d.refresh, 30)), prometheus: d.prometheus ?? null,
    // A source used by several widgets is written once, under "sources", and named: "source": "fleet".
    widgets: d.widgets.map((w, i) => ({ ...w, source: typeof w?.source === "string" ? d.sources?.[w.source] ?? { type: `(no source named "${w.source}")` } : w?.source, id: `${name}:${i}`, type: TYPES.includes(w?.type) ? w.type : null, typeName: String(w?.type ?? ""),
      title: String(w?.title ?? ""), w: Math.max(1, Math.min(4, Math.round(Number(w?.w) || 1))), refresh: w?.refresh != null ? Math.max(5, seconds(w.refresh, 30)) : null })) };
}
