// The parts of xo-map/data.js the Dashboard's xo-map widget needs (xo repository, herdr/xo-map, commit 2217cc2 of
// 2026-11-06), copied: what `xo plan --rows` and `xo bearings --rows` say, made ready to draw. Left out: the `xo act`
// buttons (the widget is read-only), the done trail's helpers and readBoth. `pill` is xo-map/act.js's. No Herdr imports.

// A row's agent state as one word (xo-map/act.js pill).
export function pill(row) {
  const a = row.agent ?? "-";
  if (a === "blocked" || a === "idle" || a === "working") return a;
  if (a.startsWith("queued #") || a.startsWith("slot #")) return a.startsWith("queued") ? "queued" : "working";
  return row.session_status !== "Live" ? "gone" : a === "-" ? "none" : a;
}

// Accepts the parsed JSON of `xo plan --rows`; throws a sentence when it is not that.
export function normalize(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects)) throw new Error("not `xo plan --rows` output (no projects list)");
  const projects = raw.projects.map((p) => ({
    project: String(p.project), path: p.path ?? "", has_plan: Boolean(p.has_plan),
    components: (p.components ?? []).map((c) => ({ ...c, needs: c.needs ?? [], links: c.links ?? [], tasks: c.tasks ?? [], done: c.done ?? [] })),
  }));
  const problems = (raw.problems ?? []).map((q) => ({ project: String(q.project ?? ""), file: q.file || "PLAN.md", line: q.line ?? 0, message: String(q.message ?? "") }));
  return { projects, edges: raw.edges ?? [], problems, unplanned: raw.unplanned ?? [] };
}

export function counts(p) {
  const n = { done: 0, working: 0, planned: 0, stuck: 0 };
  for (const c of p.components) n[c.status in n ? c.status : "planned"]++;
  return n;
}

// Task checkbox: the main plan's state, and the worker's own when it differs.
export function taskMark(t) {
  const s = t.worker_state ?? t.state;
  return { mark: { done: "x", working: "~", stuck: "!" }[s] ?? " ", state: s, planned: t.worker_state != null && t.worker_state !== t.state };
}

function workerOf(key, via, row, entry) {
  return {
    key, via, agent: row ? pill(row) : "unknown", project: row?.project ?? key.split("/")[0], slug: row?.slug ?? key.split("/").slice(1).join("/"),
    harness: row ? row.harness + (row.role ? `@${row.role}` : "") : "", host: row?.host ?? "",
    needsYou: entry?.kind === "needs_you", // "needs you" in bearings: the captain has to act
  };
}

// `data` with, per component, `workers`, `needsYou` and `blocked`; per project `needsYou`, `live` and `unplanned`.
export function joinLive(data, bearings) {
  const rows = new Map((bearings?.rows ?? []).map((r) => [r.key, r]));
  const entries = new Map((bearings?.bearings ?? []).map((e) => [e.key, e]));
  const workers = {};
  const make = (key, via) => (workers[key] ??= workerOf(key, via, rows.get(key), entries.get(key)));
  for (const p of data.projects) {
    p.needsYou = 0; p.live = 0;
    for (const c of p.components) {
      c.workers = (c.live ?? []).map((l) => make(l.task_key, l.via));
      c.needsYou = c.workers.some((w) => w.needsYou);
      c.blocked = c.workers.some((w) => w.agent === "blocked");
      p.needsYou += c.workers.filter((w) => w.needsYou).length;
      p.live += c.workers.length;
    }
    p.unplanned = [];
  }
  const byName = Object.fromEntries(data.projects.map((p) => [p.project, p]));
  for (const key of data.unplanned) {
    const w = make(key, "unplanned"), p = byName[w.project];
    if (!p) continue;
    p.unplanned.push(w);
    p.needsYou += w.needsYou ? 1 : 0; p.live += 1;
  }
  data.workers = workers;
  return data;
}

// Red: a hard need whose upstream is stuck or has a blocked worker. "live": live work at both ends. Else plain.
export function edgeLook(e, comps) {
  const up = comps[e.from], down = comps[e.to];
  if (e.kind === "needs" && up && (up.status === "stuck" || up.blocked)) return "red";
  if (up?.workers?.length && down?.workers?.length) return "live";
  return "plain";
}
