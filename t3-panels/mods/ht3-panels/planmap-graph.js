// Copied unchanged below this header from xo-map/graph.js (xo repository, herdr/xo-map, commit 2217cc2 of 2026-11-06)
// for the Dashboard's Plan map widget (dash-planmap.js): a mod can't import another mod's code. Its project-map layout is a
// fork of agenttrail (https://github.com/sodiumsun/agenttrail at 5996e48, MIT: LICENSE.agenttrail beside this file).
// To update: copy the file again and keep these four lines.

// xo-map's layout, as data. The project map is a fork of agenttrail's graph.js (boardLayout, needEdge, linkEdge,
// MIT, see LICENSE.agenttrail; https://github.com/sodiumsun/agenttrail at 5996e48): columns by `needs` depth, a bezier
// from a need's right edge to the card that needs it, a softer one for `links`. The card model is xo's (components of
// `xo plan --rows`, not agenttrail's board), and the fleet view and the cross-project stubs are new.
// Copyright (c) 2026 Kelly Sun (agenttrail). No Herdr imports: node runs it in check-map.mjs.

export const CARD_W = 210;
export const CARD_HEAD = 40;
export const TASK_ROW = 19;
export const MAX_TASKS = 6; // more than this and a card says "+N more"
export const CHIP_ROW = 22; // a live worker's chip, under the tasks
export const TRAIL_ROW = 14; // one line of a card's landed trail, under the chips
export const STUB_W = 98;
export const STUB_H = 20;
const PAD = 40, GY = 26, GAP = 56, STUB_SIDE = 8;

export const MINI_W = 118, MINI_H = 30, MINI_GAP = 6, MINI_COLS = 3;
export const REGION_PAD = 14, REGION_HEAD = 44, REGION_GAP = 18;
export const REGION_W = MINI_COLS * MINI_W + (MINI_COLS - 1) * MINI_GAP + 2 * REGION_PAD;

export const ref = (project, id) => `${project}#${id}`;

export function cardHeight(c) {
  const shown = Math.min(c.tasks?.length ?? 0, MAX_TASKS);
  const more = (c.tasks?.length ?? 0) > MAX_TASKS ? 1 : 0;
  return CARD_HEAD + shown * TASK_ROW + more * TASK_ROW + (c.workers?.length ?? 0) * CHIP_ROW + Math.min(c.done?.length ?? 0, 3) * TRAIL_ROW + 10;
}

// A cross-project edge touching this project becomes a stub on the card it touches: a dependency elsewhere sits left of
// the card (the edge runs into it), a dependent elsewhere sits right of it.
export function stubsOf(project, edges) {
  const out = new Map(); // `${cardId}|${side}|${label}` -> stub
  for (const e of edges ?? []) {
    if (!e.cross_project) continue;
    const [fp, fid] = e.from.split("#"), [tp, tid] = e.to.split("#");
    const mine = fp === project ? { side: "left", card: fid, other: e.to, target: tp } : tp === project ? { side: "right", card: tid, other: e.from, target: fp } : null;
    if (!mine) continue;
    const key = `${mine.card}|${mine.side}|${mine.other}`;
    const had = out.get(key);
    if (had && (had.kind === "needs" || e.kind !== "needs")) continue; // needs beats links for the same pair
    out.set(key, { card: mine.card, side: mine.side, label: mine.other, project: mine.target, kind: e.kind });
  }
  return [...out.values()];
}

export function depthOf(comps) {
  const byId = Object.fromEntries(comps.map((c) => [c.id, c]));
  const depth = {}, visiting = new Set();
  const get = (c) => {
    if (depth[c.id] != null) return depth[c.id];
    if (visiting.has(c.id)) return 0; // a cycle in needs is a lint problem; do not hang on it
    visiting.add(c.id);
    const preds = (c.needs ?? []).filter((id) => byId[id] && id !== c.id);
    depth[c.id] = preds.length ? 1 + Math.max(...preds.map((id) => get(byId[id]))) : 0;
    visiting.delete(c.id);
    return depth[c.id];
  };
  comps.forEach(get);
  return depth;
}

const curveH = (x1, y1, x2, y2, bend) => ({ x1, y1, ax: x1 + bend, ay: y1, bx: x2 - bend, by: y2, x2, y2 });

function needEdge(a, b) {
  const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
  return { kind: "needs", arrow: true, curve: curveH(x1, y1, x2, y2, Math.max(36, (x2 - x1) / 2)) };
}

function linkEdge(A, B) {
  if (Math.abs(A.x - B.x) > 24) {
    const L = A.x < B.x ? A : B, R = A.x < B.x ? B : A;
    const x1 = L.x + L.w, y1 = L.y + L.h / 2, x2 = R.x, y2 = R.y + R.h / 2, mx = (x1 + x2) / 2;
    return { kind: "links", arrow: false, curve: { x1, y1, ax: mx, ay: y1, bx: mx, by: y2, x2, y2 } };
  }
  const T = A.y < B.y ? A : B, Bt = A.y < B.y ? B : A; // same column: from the lower edge of the upper card
  const x1 = T.x + T.w / 2, y1 = T.y + T.h, x2 = Bt.x + Bt.w / 2, y2 = Bt.y, my = (y1 + y2) / 2;
  return { kind: "links", arrow: false, curve: { x1, y1, ax: x1, ay: my, bx: x2, by: my, x2, y2 } };
}

// One project's map. Returns pos (id -> {x,y,w,h,col}), stubs (with x,y,w,h), edges, and the size of the whole.
export function projectLayout(project, edges) {
  const comps = project.components ?? [];
  const byId = Object.fromEntries(comps.map((c) => [c.id, c]));
  const depth = depthOf(comps);
  const stubs = stubsOf(project.project, edges).filter((s) => byId[s.card]);
  const stubsAt = (id, side) => stubs.filter((s) => s.card === id && s.side === side);
  const cols = [];
  comps.forEach((c) => (cols[depth[c.id]] ??= []).push(c));
  const count = cols.length;
  const row = {}; // id -> index in its column, to order the next column by where its needs sit
  const hasStub = (col, side) => (cols[col] ?? []).some((c) => stubsAt(c.id, side).length);
  const colX = [];
  let x = PAD + (hasStub(0, "left") ? STUB_W + STUB_SIDE : 0);
  const gaps = [];
  for (let i = 0; i < count; i++) {
    colX[i] = x;
    const gap = GAP + (hasStub(i, "right") ? STUB_W + STUB_SIDE : 0) + (i + 1 < count && hasStub(i + 1, "left") ? STUB_W + STUB_SIDE : 0);
    gaps[i] = gap;
    x += CARD_W + gap;
  }
  const pos = {};
  let bottom = PAD;
  for (let i = 0; i < count; i++) {
    const list = cols[i] ?? [];
    const key = (c) => {
      const rs = (c.needs ?? []).filter((id) => byId[id] && depth[id] < i).map((id) => row[id]);
      return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Infinity;
    };
    list.sort((a, b) => key(a) - key(b) || comps.indexOf(a) - comps.indexOf(b)); // stable: plan order breaks ties
    let y = PAD;
    list.forEach((c, r) => {
      row[c.id] = r;
      const stubRoom = 6 + Math.max(stubsAt(c.id, "left").length, stubsAt(c.id, "right").length) * (STUB_H + 4);
      const h = Math.max(cardHeight(c), stubRoom);
      pos[c.id] = { x: colX[i], y, w: CARD_W, h, col: i };
      y += h + GY;
    });
    bottom = Math.max(bottom, y - GY + PAD);
  }
  const placed = [];
  for (const c of comps) for (const side of ["left", "right"]) {
    stubsAt(c.id, side).forEach((s, i) => {
      const p = pos[c.id];
      placed.push({ ...s, x: side === "left" ? p.x - STUB_SIDE - STUB_W : p.x + p.w + STUB_SIDE, y: p.y + 6 + i * (STUB_H + 4), w: STUB_W, h: STUB_H });
    });
  }
  const out = [];
  const seen = new Set();
  for (const c of comps) {
    for (const n of c.needs ?? []) if (byId[n] && n !== c.id) out.push({ ...needEdge(pos[n], pos[c.id]), from: n, to: c.id });
    for (const l of c.links ?? []) {
      if (!byId[l] || l === c.id) continue;
      const k = [c.id, l].sort().join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...linkEdge(pos[l], pos[c.id]), from: l, to: c.id });
    }
  }
  for (const s of placed) {
    const p = pos[s.card];
    const y = s.y + s.h / 2;
    if (s.side === "left") out.push({ kind: s.kind, arrow: s.kind === "needs", stub: s, curve: { x1: s.x + s.w, y1: y, ax: s.x + s.w + 8, ay: y, bx: p.x - 8, by: y, x2: p.x, y2: y } });
    else out.push({ kind: s.kind, arrow: false, stub: s, curve: { x1: p.x + p.w, y1: y, ax: p.x + p.w + 8, ay: y, bx: s.x - 8, by: y, x2: s.x, y2: y } });
  }
  return { pos, stubs: placed, edges: out, depth, width: Math.max(colX.length ? x - gaps[count - 1] + PAD + (hasStub(count - 1, "right") ? STUB_W + STUB_SIDE : 0) : 0, 320), height: Math.max(bottom, 160) };
}

// The fleet: one region per project, in rows that fill `width`. A project with no plan is an empty region.
export function fleetLayout(projects, width) {
  const perRow = Math.max(1, Math.floor((width - 2 * PAD + REGION_GAP) / (REGION_W + REGION_GAP)));
  const regions = [];
  let y = PAD, rowH = 0;
  projects.forEach((p, i) => {
    const col = i % perRow;
    if (i && col === 0) { y += rowH + REGION_GAP; rowH = 0; }
    const comps = p.components ?? [];
    const rows = Math.ceil(comps.length / MINI_COLS);
    const empty = !p.has_plan || !comps.length;
    const h = REGION_HEAD + (empty ? 56 : rows * (MINI_H + MINI_GAP) - MINI_GAP) + REGION_PAD;
    const x = PAD + col * (REGION_W + REGION_GAP);
    const minis = comps.map((c, j) => ({ id: c.id, x: x + REGION_PAD + (j % MINI_COLS) * (MINI_W + MINI_GAP), y: y + REGION_HEAD + Math.floor(j / MINI_COLS) * (MINI_H + MINI_GAP), w: MINI_W, h: MINI_H }));
    regions.push({ project: p.project, empty, x, y, w: REGION_W, h, minis });
    rowH = Math.max(rowH, h);
  });
  return { regions, width: PAD * 2 + Math.min(perRow, Math.max(projects.length, 1)) * (REGION_W + REGION_GAP) - REGION_GAP, height: y + rowH + PAD };
}
