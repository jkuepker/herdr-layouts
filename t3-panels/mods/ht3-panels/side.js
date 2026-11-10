// The right side panel's model: what is open in it, per space, and the code that makes the
// layout match. The layout holds the places (`ht3-side` with two groups, `ht3-a` and `ht3-b`,
// each a 40px strip and a stack whose children are the faces of main.js, plus one block for
// every terminal); this module decides which child each stack shows, whether the second group
// shows, how wide the panel is, and writes terminal blocks into the layout file as Shepherdr's
// mods do (a mod can't draw a terminal).
//
// State is one shared value, `ht3-side.state`, kept by Herdr across reloads:
//   { v: 1, max: false, spaces: { <space id>: { split, w (the panel's px), ha (the first group's px), a: { tabs, active }, b: { tabs, active }, bottom } } }
// A tab is { id, kind, addr? }: kind is files, diff, pr, prs, browser, chat or terminal (addr: the
// terminal's address). `bottom` is the address of the space's bottom-panel terminal, or null.

import { shared, setShared, spaces, layout, run, hc, appHome, readTextFile, writeTextFile, terminals, focused, panes, home } from "herdr";

export const SIDE = "ht3-side", CENTER = "ht3-center", BOTTOM = "ht3-bottom", BOTTOM_EMPTY = "ht3-bottom-empty", WORK_BODY = "work-body";
export const KEY = "ht3-side.state";
export const GROUPS = ["a", "b"];

// The surfaces of T3's `+` menu (RightPanelTabs.tsx), in its order, with its letters.
export const SURFACES = [
  { kind: "browser", label: "Browser", glyph: "globe", key: "b" },
  { kind: "terminal", label: "Terminal", glyph: "square-terminal", key: "t" },
  { kind: "files", label: "Files", glyph: "files", key: "f" },
  { kind: "diff", label: "Diff", glyph: "file-diff", key: "d" },
  { kind: "pr", label: "Pull request", glyph: "git-pull-request", key: "p" },
  { kind: "prs", label: "Linked pull requests", glyph: "git-pull-request-arrow", key: "l" },
  { kind: "device", label: "Device", glyph: "smartphone", key: "m", off: "Watching an iOS Simulator needs a native view, which Herdr can't host. Use Xcode's Simulator." },
  { kind: "chat", label: "Side chat", glyph: "messages-square", key: "s" },
];
export const surface = (kind) => SURFACES.find((s) => s.kind === kind);

const clone = (v) => JSON.parse(JSON.stringify(v));
const blank = () => ({ split: false, w: null, ha: null, a: { tabs: [{ id: "files", kind: "files" }], active: "files" }, b: { tabs: [], active: null }, bottom: null });

export function read() {
  const s = shared(KEY);
  return s && s.v === 1 ? s : { v: 1, max: false, spaces: {} };
}
export function spaceState(id) {
  const st = read().spaces[id ?? ""];
  return st ? { ...blank(), ...st } : blank();
}
// Applies `mut` to a copy of the space's state (and of the whole value) and shares it.
export function change(id, mut) {
  const all = clone(read());
  const st = (all.spaces[id ?? ""] = clone(spaceState(id)));
  mut(st, all);
  setShared(KEY, all);
  return st;
}
export function changeAll(mut) {
  const all = clone(read());
  mut(all);
  setShared(KEY, all);
}

export const activeSpace = () => spaces().find((s) => s.active) ?? null;
export const bodyId = (g) => `ht3-${g}-body`;
export const groupId = (g) => `ht3-${g}`;
export const emptyId = (g) => `ht3-${g}-empty`;
const safe = (addr) => String(addr).replace(/[^A-Za-z0-9_-]/g, "-");
export const termBlock = (addr) => `ht3-term-${safe(addr)}`;
export const bottomBlock = (addr) => `ht3-bterm-${safe(addr)}`;
export function childId(g, tab) {
  if (!tab) return emptyId(g);
  if (tab.kind === "terminal") return termBlock(tab.addr);
  return g === "a" && tab.kind === "files" ? "ht3-files" : `ht3-${g}-${tab.kind}`;
}
export const activeTab = (st, g) => st[g].tabs.find((t) => t.id === st[g].active) ?? null;

export function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}
export const sideShown = () => { const n = find(layout(), SIDE); return n ? !n.hidden : null; };
export const bottomShown = () => { const n = find(layout(), BOTTOM); return n ? !n.hidden : null; };

// ---- where a new terminal starts ----

// Where the space works, for the panel's surfaces: the folder pinned in Files (shared state
// `ht3-files.pinned`, see editor.js) if the person picked one, else the focused terminal's folder,
// the first one in its tab, the space's own.
export function placeOf(space) {
  const held = (shared("ht3-files.pinned") ?? {})[space?.id ?? ""];
  if (held?.root) return { on: held.on ?? null, cwd: held.root };
  const f = focused(), all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const other = all.find((p) => p.tab === f?.tab && p.cwd);
  return { on: space?.machine ?? null, cwd: pane?.cwd || f?.cwd || other?.cwd || space?.folder || (space?.machine ? null : home()) };
}

// ---- the layout file ----

const layoutPath = () => `${appHome()}/layouts/${shared("layout")}.json`;

// One edit of the layout file, written only if it is unchanged since read (else read again).
async function editLayout(mutate) {
  for (let i = 0; ; i++) {
    const text = await readTextFile(layoutPath());
    const tree = JSON.parse(text ?? "null");
    if (!tree) throw new Error("The layout file is unreadable.");
    if (mutate(tree) === false) return;
    try { await writeTextFile(layoutPath(), JSON.stringify(tree, null, 2), text); return; }
    catch (e) { if (i >= 2) throw e; }
  }
}
async function waitFor(test, cx) {
  for (let i = 0; i < 40 && !test(); i++) await new Promise((r) => cx.timer.after(100, () => r()));
  return test();
}

async function startTerminal(space, cwd, on) {
  const args = ["run", "--bg", "--json", "--no-parent", "--keep", "--label", `ht3.side=${space.id.replace(/^.*\//, "")}`];
  if (on) args.push("--on", on);
  if (cwd) args.push("--cwd", cwd);
  const r = await hc(args);
  const addr = JSON.parse(r.stdout || "{}")?.address;
  if (r.code !== 0 || !addr) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || "The terminal didn't start.");
  return addr;
}
async function endTerminal(addr) {
  await hc(["kill", addr]).catch(() => {});
  await hc(["rm", addr]).catch(() => {});
}
async function addBlock(stack, id, addr, cx) {
  await editLayout((tree) => {
    const body = find(tree, stack);
    if (!body) throw new Error("This layout has no side panel.");
    if (body.children.some((c) => c.id === id)) return false;
    body.children.push({ id, type: "block", content: { terminal: addr } });
  });
  await waitFor(() => find(layout(), id), cx);
}
async function dropBlocks(ids) {
  if (!ids.length) return;
  await editLayout((tree) => {
    let did = false;
    for (const id of ids) {
      const parent = (function up(n) { for (const c of n.children ?? []) { if (c.id === id) return n; const r = up(c); if (r) return r; } return null; })(tree);
      if (parent) { parent.children = parent.children.filter((c) => c.id !== id); did = true; }
    }
    return did;
  });
}

// ---- tabs ----

// Opens a surface in a group of the shown space: an open one of the same kind is shown instead.
export async function openSurface(cx, group, kind, extra = {}) {
  const space = activeSpace();
  if (!space) return;
  if (kind === "terminal") return openTerminal(cx, group, space);
  const id = kind;
  change(space.id, (st) => {
    const g = st[group];
    if (!g.tabs.some((t) => t.id === id)) g.tabs.push({ id, kind, ...extra });
    g.active = id;
  });
  ensureShown();
  reconcile();
}

async function openTerminal(cx, group, space) {
  const { on, cwd } = placeOf(space);
  try {
    const addr = await startTerminal(space, cwd, on);
    await addBlock(bodyId(group), termBlock(addr), addr, cx);
    change(space.id, (st) => {
      const n = 1 + Math.max(0, ...GROUPS.flatMap((g) => st[g].tabs.map((t) => t.n ?? 0)));
      st[group].tabs.push({ id: addr, kind: "terminal", addr, n });
      st[group].active = addr;
    });
    ensureShown();
    reconcile();
    run("pane.focus", { terminal: addr });
  } catch (e) {
    run("layout.show", { id: SIDE });
    throw e;
  }
}

export function ensureShown() {
  if (sideShown() === false) run("layout.show", { id: SIDE });
}

export function activate(group, id) {
  const space = activeSpace();
  change(space?.id, (st) => { if (st[group].tabs.some((t) => t.id === id)) st[group].active = id; });
  reconcile();
}

// Closes a tab. A terminal tab ends its terminal.
export async function closeTab(cx, group, id) {
  const space = activeSpace();
  let gone = null;
  change(space?.id, (st) => {
    const g = st[group], at = g.tabs.findIndex((t) => t.id === id);
    if (at < 0) return;
    gone = g.tabs[at];
    g.tabs.splice(at, 1);
    if (g.active === id) g.active = (g.tabs[Math.min(at, g.tabs.length - 1)] ?? null)?.id ?? null;
    tidy(st);
  });
  reconcile();
  if (gone?.kind === "terminal") {
    await endTerminal(gone.addr);
    await dropBlocks([termBlock(gone.addr)]).catch(() => {});
  }
}

// The second group goes when empty; an empty first group takes the second one's tabs.
function tidy(st) {
  if (!st.a.tabs.length && st.b.tabs.length) { st.a = st.b; st.b = { tabs: [], active: null }; }
  if (!st.b.tabs.length) st.split = false;
}

// Shows the second group, with a terminal in it when it has no tabs yet.
export async function toggleSplit(cx) {
  const space = activeSpace();
  if (!space) return;
  const st = spaceState(space.id);
  if (st.split) {
    // Merges the second group's tabs into the first.
    change(space.id, (s) => {
      for (const t of s.b.tabs) if (!s.a.tabs.some((x) => x.id === t.id)) s.a.tabs.push(t);
      s.b = { tabs: [], active: null };
      s.split = false;
    });
    return reconcile();
  }
  change(space.id, (s) => { s.split = true; });
  ensureShown();
  reconcile();
  if (!st.b.tabs.length) await openTerminal(cx, "b", space);
}

export function toggleMax() {
  // The width to come back to.
  const px = find(layout(), SIDE)?.size?.px, sp = activeSpace();
  if (!read().max && px && sp) change(sp.id, (st) => { st.w = Math.round(px); });
  changeAll((all) => { all.max = !all.max; });
  ensureShown();
  reconcile();
}

// ---- the bottom panel ----

export async function toggleBottom(cx) {
  const space = activeSpace();
  if (!space) return;
  if (bottomShown()) return void run("layout.hide", { id: BOTTOM });
  run("layout.show", { id: BOTTOM });
  if (!spaceState(space.id).bottom) await openBottom(cx);
  else reconcile();
}
export async function openBottom(cx) {
  const space = activeSpace();
  if (!space) return;
  const { on, cwd } = placeOf(space);
  const addr = await startTerminal(space, cwd, on);
  await addBlock(BOTTOM, bottomBlock(addr), addr, cx);
  change(space.id, (st) => { st.bottom = addr; });
  reconcile();
  run("pane.focus", { terminal: addr });
}

// ---- making the layout match ----

// A terminal's block lives in the stack of the group that holds its tab; when a tab changes group
// (the groups merge, or the first one empties) the block moves with it, in the layout file.
let moving = false;
function relocate() {
  if (moving) return;
  const tree = layout(), all = read();
  const moves = [];
  for (const st of Object.values(all.spaces)) for (const g of GROUPS) for (const t of st[g].tabs) {
    if (t.kind !== "terminal") continue;
    const id = termBlock(t.addr);
    if (!find(find(tree, bodyId(g)), id) && find(tree, id)) moves.push({ id, stack: bodyId(g) });
  }
  if (!moves.length) return;
  moving = true;
  editLayout((tree) => {
    for (const m of moves) {
      const from = (function up(n) { for (const c of n.children ?? []) { if (c.id === m.id) return n; const r = up(c); if (r) return r; } return null; })(tree);
      const to = find(tree, m.stack);
      if (!from || !to || from === to) continue;
      const block = from.children.find((c) => c.id === m.id);
      from.children = from.children.filter((c) => c !== block);
      to.children.push(block);
    }
  }).catch(() => {}).finally(() => { moving = false; });
}

let lastSpace = null, lastApplied = null, lastSplit = false, lastHa = null;

// Idempotent: shows what the shown space's state says. Called by the always-present buttons block
// every second, and by whatever changes the state.
export function reconcile() {
  const space = activeSpace();
  const tree = layout();
  if (!space || !tree) return;
  const all = read(), st = spaceState(space.id);
  const side = find(tree, SIDE);
  if (!side) return;
  const switched = lastSpace !== space.id;
  lastSpace = space.id;
  relocate();

  // Each group shows its active tab (or its empty face); the second only when split.
  for (const g of GROUPS) {
    const want = childId(g, activeTab(st, g));
    const stack = find(tree, bodyId(g));
    if (stack && stack.active !== want && find(stack, want)) run("layout.select", { stack: bodyId(g), child: want });
    const grp = find(tree, groupId(g));
    const hide = g === "b" && !st.split;
    if (grp && g === "b" && !!grp.hidden !== hide) run(hide ? "layout.hide" : "layout.show", { id: groupId(g) });
  }

  // The bottom panel's terminal for this space.
  const bstack = find(tree, BOTTOM);
  if (bstack) {
    const want = st.bottom && find(bstack, bottomBlock(st.bottom)) ? bottomBlock(st.bottom) : BOTTOM_EMPTY;
    if (bstack.active !== want) run("layout.select", { stack: BOTTOM, child: want });
  }

  // Maximized: the panel takes the whole work area.
  const center = find(tree, CENTER);
  const maxed = all.max && !side.hidden;
  if (center && !!center.hidden !== maxed) run(maxed ? "layout.hide" : "layout.show", { id: CENTER });
  if (maxed) {
    if (side.size?.weight == null) run("layout.resize", { id: SIDE, weight: 1 });
    lastApplied = null;
    return;
  }
  // The split line: the first group's height, kept per space like the width.
  const a = find(tree, groupId("a")), pxA = a?.size?.px ?? null;
  if (st.split && a && !maxed) {
    if (switched || !lastSplit) {
      if (st.ha && pxA !== st.ha) run("layout.resize", { id: groupId("a"), px: st.ha });
      else if (!st.ha && pxA != null) run("layout.resize", { id: groupId("a"), weight: 1 });
      lastHa = st.ha ?? null;
    } else if (pxA != null && (lastHa == null || Math.abs(pxA - lastHa) > 2)) {
      lastHa = pxA;
      change(space.id, (s) => { s.ha = Math.round(pxA); });
    }
  }
  lastSplit = st.split;
  // Width: the space's own on a switch (a new space keeps the one shown); else what the person
  // dragged is kept for the space.
  const px = side.size?.px;
  if (side.size?.weight != null) {
    run("layout.resize", { id: SIDE, px: st.w ?? 540 });
    return;
  }
  if (switched || lastApplied == null) {
    if (st.w && Math.abs(st.w - px) > 1) { run("layout.resize", { id: SIDE, px: st.w }); lastApplied = st.w; return; }
    lastApplied = px;
  }
  if (!side.hidden && px && Math.abs(px - lastApplied) > 2) {
    lastApplied = px;
    change(space.id, (s) => { s.w = Math.round(px); });
  }
}

// Housekeeping, now and then: tabs whose terminal ended go; a closed space's terminals end; blocks
// no tab owns go.
let tick = 0;
export function sweep(cx) {
  if (++tick % 4 !== 0) return;
  const live = terminals();
  const sp = spaces();
  if (!live.length || !sp.length) return;
  const all = read();
  const known = new Map(live.map((t) => [t.address, t]));
  const dead = (addr) => { const t = known.get(addr); return t ? t.state !== "live" : !String(addr).includes("/"); };
  const ids = new Set(sp.map((s) => s.id));
  const owned = new Set();
  let closing = [];
  for (const [sid, st] of Object.entries(all.spaces)) {
    const gone = sid && !ids.has(sid);
    for (const g of GROUPS) for (const t of st[g].tabs) if (t.kind === "terminal") {
      if (gone || dead(t.addr)) closing.push({ sid, g, t, gone }); else owned.add(termBlock(t.addr));
    }
    if (st.bottom) {
      if (gone || dead(st.bottom)) closing.push({ sid, bottom: st.bottom, gone }); else owned.add(bottomBlock(st.bottom));
    }
    if (gone && !closing.some((c) => c.sid === sid)) closing.push({ sid, gone });
  }
  if (!closing.length) {
    // Blocks nobody owns (a crash between writing the layout and the state).
    const orphans = [];
    const tree = layout();
    for (const stack of [bodyId("a"), bodyId("b"), BOTTOM]) for (const c of find(tree, stack)?.children ?? []) if (/^ht3-b?term-/.test(c.id) && !owned.has(c.id)) orphans.push(c.id);
    if (orphans.length) dropBlocks(orphans).catch(() => {});
    return;
  }
  const dropIds = [];
  changeAll((a) => {
    for (const c of closing) {
      const st = a.spaces[c.sid];
      if (!st) continue;
      if (c.t) { st[c.g].tabs = st[c.g].tabs.filter((x) => x.id !== c.t.id); if (st[c.g].active === c.t.id) st[c.g].active = st[c.g].tabs[0]?.id ?? null; dropIds.push(termBlock(c.t.addr)); tidy(st); }
      if (c.bottom) { st.bottom = null; dropIds.push(bottomBlock(c.bottom)); }
    }
    for (const c of closing) if (c.gone) delete a.spaces[c.sid];
  });
  for (const c of closing) {
    const addr = c.t?.addr ?? c.bottom;
    if (addr && c.gone) endTerminal(addr);
  }
  reconcile();
  dropBlocks(dropIds).catch(() => {});
}
