// The right side panel's model: what is open in it, per space, and the code that makes the
// layout match. The layout holds the places (`ht3-side` with two groups, `ht3-a` and `ht3-b`,
// each a 40px strip and a stack whose children are the faces of main.js, plus one block for
// every terminal); this module decides which child each stack shows, whether the second group
// shows, how wide the panel is, and writes terminal blocks into the layout file as Shepherdr's
// mods do (a mod can't draw a terminal).
//
// State is one shared value, `ht3-side.state`, kept by Herdr across reloads:
//   { v: 1, max: false, spaces: { <space id>: { split, w (the panel's px), ha (the first group's px), a: { tabs, active }, b: { tabs, active }, bottom } } }
// A tab is { id, kind, addr?, n?, at?, chat? }: kind is files, diff, pr, prs, browser, dashboard, chat or terminal
// (addr: the terminal's address, n: its number, at: when it started). `bottom` is the address of the
// space's bottom-panel terminal, or null.
//
// The state is the truth and the layout file follows it: a terminal tab is written to the state,
// and syncBlocks() gives every terminal tab its block and removes the blocks no tab holds.

import { MOD } from "./look.js";
import { shared, setShared, spaces, machines, layout, run, notify, hc, exec, appHome, readTextFile, writeTextFile, terminals, focused, panes, home } from "herdr";
import { enabledAgents, sideStartsHidden } from "./settings.js";

export const SIDE = "ht3-side", CENTER = "ht3-center", BOTTOM = "ht3-bottom", BOTTOM_EMPTY = "ht3-bottom-empty";
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
  // Not in T3 Code: this layout's own surface (dashboard.js).
  { kind: "dashboard", label: "Dashboard", glyph: "layout-dashboard", key: "g" },
];
export const surface = (kind) => SURFACES.find((s) => s.kind === kind);

// ---- surfaces that don't apply here ----

// What a folder allows, asked of the machine it is on: { git: in a repository, github: a remote on
// GitHub, gh: the GitHub CLI is installed }. Kept a few seconds, so a menu opened again asks again.
const FACTS_FOR_MS = 5000;
const facts = new Map(); // "<machine>|<folder>" -> { at, value, asking }
const factsKey = (where) => `${where?.on ?? ""}|${where?.cwd ?? ""}`;
export const knownFacts = (where) => facts.get(factsKey(where))?.value ?? null;
// Asks when it isn't known or is old. -> a promise when it asked (redraw after it), else null.
export function askFacts(where) {
  const key = factsKey(where), had = facts.get(key);
  if (had?.asking || (had && Date.now() - had.at < FACTS_FOR_MS)) return null;
  const entry = { at: had?.at ?? 0, value: had?.value ?? null, asking: true };
  facts.set(key, entry);
  const script = `git rev-parse --is-inside-work-tree 2>/dev/null | grep -q true && echo git; git remote -v 2>/dev/null | grep -qi 'github' && echo github; command -v gh >/dev/null 2>&1 && echo gh; true`;
  return (where?.cwd ? exec("sh", ["-c", script], { cwd: where.cwd, on: where.on ?? null, timeout: 10000 }) : Promise.reject(new Error("no folder")))
    .then((r) => r.stdout.split("\n").map((l) => l.trim()), () => null)
    .then((said) => {
      // A folder that can't be asked (gone, the machine away) is taken as it reads: no repository there.
      facts.set(key, { at: Date.now(), asking: false, value: said ? { git: said.includes("git"), github: said.includes("github"), gh: said.includes("gh") } : { git: false, github: false, gh: true } });
      if (facts.size > 50) facts.delete(facts.keys().next().value);
    });
}
// Why a surface can't open where the space works now, or null. Until the folder has answered,
// only what is always known counts.
export function surfaceOff(s, where) {
  if (s.off) return s.off;
  if (s.kind === "chat") return enabledAgents().length ? null : "No agent is enabled in Settings.";
  const f = knownFacts(where);
  if (!f) return null;
  if (s.kind === "diff") return f.git ? null : "This folder isn't in a git repository.";
  if (s.kind === "pr" || s.kind === "prs") {
    return !f.git ? "This folder isn't in a git repository." : !f.gh ? "The GitHub CLI (gh) isn't installed." : !f.github ? "This repository has no remote on GitHub." : null;
  }
  return null;
}
// For a face that lists the surfaces: the place now, and its facts asked for when they are due.
// Call it while drawing; the copy redraws when the answer is in.
export function surfacesHere(cx) {
  const where = placeOf(activeSpace());
  const asked = askFacts(where);
  if (asked) cx.timer.after(0, (cx) => { cx.spawn(async (cx) => { await asked; cx.notify(); }); });
  return where;
}

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
// `mut` may return false to say it changed nothing.
export function changeAll(mut) {
  const all = clone(read());
  if (mut(all) !== false) setShared(KEY, all);
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
// Whether a group shows this kind of surface now: the faces stay alive behind other tabs, and
// ask before they poll.
export function showing(group, kind) {
  const st = spaceState(activeSpace()?.id);
  return sideShown() === true && (group === "a" || st.split) && activeTab(st, group)?.kind === kind;
}

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
// The folder of the chat the person is on, or null: a chat pane has no folder of its own to Herdr, its agent
// works where the chat says (report.js: `cwd` and `machine` in its tab's program). With the focus on a
// terminal, that terminal's folder counts instead.
export function chatPlace() {
  const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && pane.mod !== MOD) return null;
  const own = f?.tab ? shared(`${MOD}.programs`)?.[f.tab] : null;
  return own?.cwd ? { on: own.machine ?? null, cwd: own.cwd } : null;
}

export function placeOf(space) {
  const held = (shared("ht3-files.pinned") ?? {})[space?.id ?? ""];
  if (held?.root) return { on: held.on ?? null, cwd: held.root };
  const chat = chatPlace();
  if (chat) return chat;
  const f = focused(), all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const other = all.find((p) => p.tab === f?.tab && p.cwd);
  return { on: space?.machine ?? null, cwd: pane?.cwd || f?.cwd || other?.cwd || space?.folder || (space?.machine ? null : home()) };
}

// ---- the keeper's jobs ----

// Everything here that takes time (starting or ending a terminal, writing the layout file) runs in
// the keeper: the buttons block of main.js, which is always there, one job after the other.
// Another copy must not start such work, nor hand the keeper a function to run: what a copy
// started is dropped when it closes (the `+` menu closes itself), and a keeper waiting on it would
// wait for ever. So the other copies send() the keeper a command, the same ones scripts use
// (main.js: add, close, split, bottom), and only the keeper calls the functions below that ask().
export const send = (command) => { run(`${MOD}.${command}`); };

const jobs = [];
let wake = null;
function ask(job) {
  return new Promise((resolve, reject) => { jobs.push({ job, resolve, reject }); wake?.(); });
}
const sleep = (cx, ms) => new Promise((r) => cx.timer.after(ms, () => r()));

// The keeper's loop: the jobs asked for, then the layout made to match the state, once a second
// and at once when a job arrives. A failed job says so in a toast.
export async function keep(cx) {
  for (let tick = 0; ; tick++) {
    while (jobs.length) {
      const j = jobs.shift();
      try { j.resolve(await j.job(cx)); } catch (e) { notify({ title: "Side panel", body: String(e?.message ?? e), level: "error" }); j.reject(e); }
    }
    try {
      reconcile();
      await syncBlocks();
      if (tick % 4 === 0) await sweep();
    } catch (e) { console.log(`ht3-panels: ${String(e?.message ?? e)}`); }
    if (!jobs.length) await new Promise((r) => { wake = r; cx.timer.after(1000, () => r()); });
  }
}

// ---- the layout file ----

const layoutPath = () => `${appHome()}/layouts/${shared("layout")}.json`;
const OURS = /^ht3-b?term-/;

// The terminal blocks the state asks for: block id -> { stack, addr }.
function wantedBlocks() {
  const want = new Map();
  for (const st of Object.values(read().spaces)) {
    for (const g of GROUPS) for (const t of st[g]?.tabs ?? []) if (t.kind === "terminal") want.set(termBlock(t.addr), { stack: bodyId(g), addr: t.addr });
    if (st.bottom) want.set(bottomBlock(st.bottom), { stack: BOTTOM, addr: st.bottom });
  }
  return want;
}

// Makes a layout tree's terminal blocks match: a block per terminal tab in its group's stack (it
// follows its tab when the groups merge), none without a tab. Says whether anything changed.
function settle(tree, want) {
  let changed = false;
  const have = new Set();
  for (const id of [bodyId("a"), bodyId("b"), BOTTOM]) {
    const stack = find(tree, id);
    if (!stack?.children) continue;
    const keep = stack.children.filter((c) => {
      if (!OURS.test(c.id ?? "")) return true;
      const w = want.get(c.id);
      if (!w || w.stack !== id || have.has(c.id)) return false;
      have.add(c.id);
      return true;
    });
    if (keep.length !== stack.children.length) { stack.children = keep; changed = true; }
  }
  for (const [id, w] of want) {
    const stack = have.has(id) ? null : find(tree, w.stack);
    if (!stack?.children) continue;
    stack.children.push({ id, type: "block", content: { terminal: w.addr } });
    changed = true;
  }
  return changed;
}

// The only writer of the layout file here. It writes what the state says, whatever was there:
// read, change, and write only if the file is still as read (else read again), so an edit by
// another mod (ht3-chrome moves the window buttons on zoom) or by hand in between is kept. Run
// twice, the second run changes nothing. Herdr's own clicks (sizes, shown, a stack's child) go to
// layouts/.state/, not to this file.
async function syncBlocks() {
  if (shared(KEY)?.v !== 1 || !find(layout(), SIDE)) return;
  if (!settle(clone(layout()), wantedBlocks())) return;
  for (let i = 0; i < 5; i++) {
    const text = await readTextFile(layoutPath());
    const tree = JSON.parse(text ?? "null");
    if (!tree) throw new Error("The layout file is unreadable.");
    if (!settle(tree, wantedBlocks())) return;
    try { await writeTextFile(layoutPath(), JSON.stringify(tree, null, 2), text); return; } catch (e) { if (i === 4) throw e; }
  }
}
async function waitFor(test, cx) {
  for (let i = 0; i < 40 && !test(); i++) await sleep(cx, 100);
  return test();
}

async function startTerminal(space, cwd, on) {
  const args = ["run", "--bg", "--json", "--no-parent", "--keep", "--label", `ht3.side=${space.id.replace(/^.*\//, "")}`, "--label", `ht3.home=${appHome()}`];
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

// ---- tabs ----

// Opens a surface in a group of the shown space: an open one of the same kind is shown instead.
// A terminal takes a moment: the promise settles when it shows (or says why it didn't start).
// The keeper's: other copies send(`add:<kind>:<group>`).
export function openSurface(group, kind) {
  const space = activeSpace();
  if (!space || !GROUPS.includes(group) || !surface(kind) || surfaceOff(surface(kind), placeOf(space))) return Promise.resolve();
  if (kind === "terminal") { const where = placeOf(space); return ask((cx) => openTerminal(cx, group, space, where)); }
  change(space.id, (st) => {
    const g = st[group];
    if (!g.tabs.some((t) => t.id === kind)) g.tabs.push({ id: kind, kind });
    g.active = kind;
  });
  ensureShown();
  reconcile();
  return Promise.resolve();
}

// The state first, the block second: the tab is there at once and its body follows when Herdr
// has read the layout file. Stopped halfway, the keeper finishes it (a tab without a block gets
// one; a terminal without a tab is ended by sweep()).
async function openTerminal(cx, group, space, { on, cwd }) {
  const addr = await startTerminal(space, cwd, on);
  change(space.id, (st) => {
    const n = 1 + Math.max(0, ...GROUPS.flatMap((g) => st[g].tabs.map((t) => t.n ?? 0)));
    st[group].tabs.push({ id: addr, kind: "terminal", addr, n, at: Date.now() });
    st[group].active = addr;
  });
  if (activeSpace()?.id === space.id) ensureShown();
  await syncBlocks();
  await waitFor(() => find(layout(), termBlock(addr)), cx);
  reconcile();
  if (activeSpace()?.id === space.id) run("pane.focus", { terminal: addr });
  return addr;
}

// A project script (scripts.js): a new terminal tab in the first group, in that folder, with the command
// typed into its shell and entered. The keeper's.
export function openScript({ command, on, cwd }) {
  const space = activeSpace();
  if (!space || !command) return Promise.resolve();
  return ask(async (cx) => {
    const addr = await openTerminal(cx, "a", space, { on: on ?? null, cwd });
    await sleep(cx, 600);
    const r = await hc(["send", addr, command]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || "The script wasn't typed.");
    return addr;
  });
}

export function ensureShown() {
  if (sideShown() === false) run("layout.show", { id: SIDE });
}

export function activate(group, id) {
  const space = activeSpace();
  if (!space || !GROUPS.includes(group)) return;
  change(space.id, (st) => { if (st[group].tabs.some((t) => t.id === id)) st[group].active = id; });
  reconcile();
}

// Closes a tab. A terminal tab ends its terminal (its block goes with the tab). The keeper's:
// other copies send(`close:<group>:<tab id>`).
export function closeTab(group, id) {
  const space = activeSpace();
  if (!space || !GROUPS.includes(group)) return Promise.resolve();
  let gone = null;
  change(space.id, (st) => {
    const g = st[group], at = g?.tabs.findIndex((t) => t.id === id) ?? -1;
    if (at < 0) return;
    gone = g.tabs[at];
    g.tabs.splice(at, 1);
    if (g.active === id) g.active = (g.tabs[Math.min(at, g.tabs.length - 1)] ?? null)?.id ?? null;
    tidy(st);
  });
  reconcile();
  return gone?.kind === "terminal" ? ask(() => endTerminal(gone.addr)) : Promise.resolve();
}

// The second group goes when empty; an empty first group takes the second one's tabs.
function tidy(st) {
  if (!st.a.tabs.length && st.b.tabs.length) { st.a = st.b; st.b = { tabs: [], active: null }; }
  if (!st.b.tabs.length) st.split = false;
}

// Shows the second group, with a terminal in it when it has no tabs yet; again merges its tabs
// into the first. The keeper's: other copies send("split").
export function toggleSplit() {
  const space = activeSpace();
  if (!space) return Promise.resolve();
  const st = spaceState(space.id);
  change(space.id, (s) => {
    if (st.split) {
      for (const t of s.b.tabs) if (!s.a.tabs.some((x) => x.id === t.id)) s.a.tabs.push(t);
      s.b = { tabs: [], active: null };
    }
    s.split = !st.split;
  });
  ensureShown();
  reconcile();
  if (st.split || st.b.tabs.length) return Promise.resolve();
  const where = placeOf(space);
  return ask(async (cx) => {
    // A terminal that didn't start leaves no empty second group behind.
    try { await openTerminal(cx, "b", space, where); } catch (e) { change(space.id, tidy); reconcile(); throw e; }
  });
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

export function toggleBottom() {
  const space = activeSpace();
  if (!space) return Promise.resolve();
  if (bottomShown()) { run("layout.hide", { id: BOTTOM }); return Promise.resolve(); }
  run("layout.show", { id: BOTTOM });
  if (!spaceState(space.id).bottom) return openBottom();
  reconcile();
  return Promise.resolve();
}
export function openBottom() {
  const space = activeSpace();
  if (!space) return Promise.resolve();
  const { on, cwd } = placeOf(space);
  return ask(async (cx) => {
    if (spaceState(space.id).bottom) return;
    const addr = await startTerminal(space, cwd, on);
    change(space.id, (st) => { st.bottom = addr; st.bottomAt = Date.now(); });
    await syncBlocks();
    await waitFor(() => find(layout(), bottomBlock(addr)), cx);
    reconcile();
    if (activeSpace()?.id === space.id) run("pane.focus", { terminal: addr });
  });
}

// ---- making the layout match ----

let lastSpace = null, lastApplied = null, lastSplit = false, lastHa = null;

// Idempotent and instant (commands only): shows what the shown space's state says. Called by the
// keeper every second, and by whatever changes the state.
export function reconcile() {
  const space = activeSpace();
  const tree = layout();
  if (!space || !tree) return;
  const all = read(), st = spaceState(space.id);
  const side = find(tree, SIDE);
  if (!side) return;
  const switched = lastSpace !== space.id;
  lastSpace = space.id;
  // Settings: a space shown for the first time starts without the panel. Its state is written so it
  // is new only once.
  if (switched && sideStartsHidden() && !all.spaces[space.id]) {
    change(space.id, () => {});
    if (!side.hidden) run("layout.hide", { id: SIDE });
  }

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

// Housekeeping, every few seconds, in the keeper: a tab whose terminal ended goes; a closed
// space's terminals end and its state goes; a terminal of ours that no tab holds ends (a start cut
// short: the app quit, or the mod was saved, between `hc run` and the tab).
const GRACE = 20000;
const lost = new Set(); // other machines' terminals `hc get` no longer knows
let sweeps = 0;
async function sweep() {
  const live = terminals(), sp = spaces();
  if (!live.length || !sp.length || shared(KEY)?.v !== 1) return;
  const now = Date.now();
  const known = new Map(live.map((t) => [t.address, t]));
  // terminals() lists this computer's only: another machine's is asked for by address.
  const dead = (addr, at) => {
    const t = known.get(addr);
    if (t) return t.state !== "live";
    if (now - (at ?? 0) < GRACE) return false;
    return String(addr).includes("/") ? lost.has(addr) : true;
  };
  // A space is gone when its machine's spaces are known and it isn't among them.
  const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? ""));
  const ids = new Set(sp.map((s) => s.id));
  const gone = (sid) => !!sid && !ids.has(sid) && ready.has(sid.includes("/") ? sid.split("/")[0] : "");
  const owned = new Set(), ending = [], remote = [];
  let changed = false;
  changeAll((all) => {
    for (const [sid, st] of Object.entries(all.spaces)) {
      const off = gone(sid), before = ending.length;
      for (const g of GROUPS) {
        if (!st[g]) continue;
        st[g].tabs = st[g].tabs.filter((t) => {
          if (t.kind !== "terminal") return true;
          if (!off && !dead(t.addr, t.at)) { owned.add(t.addr); return true; }
          ending.push(t.addr);
          return false;
        });
        if (!st[g].tabs.some((t) => t.id === st[g].active)) st[g].active = st[g].tabs[0]?.id ?? null;
      }
      if (st.bottom) {
        if (off || dead(st.bottom, st.bottomAt)) { ending.push(st.bottom); st.bottom = null; } else owned.add(st.bottom);
      }
      if (off) { delete all.spaces[sid]; changed = true; }
      else if (ending.length > before) { tidy(st); changed = true; }
    }
    return changed;
  });
  // A closed space's pinned folder goes with it.
  const pins = shared("ht3-files.pinned") ?? {};
  if (Object.keys(pins).some(gone)) setShared("ht3-files.pinned", Object.fromEntries(Object.entries(pins).filter(([sid]) => !gone(sid))));
  for (const addr of owned) if (addr.includes("/") && !known.has(addr)) remote.push(addr);
  // Ours, here, and held by no tab.
  const mine = appHome();
  for (const t of live) {
    const l = t.labels ?? {};
    if (l["ht3.side"] == null || (l["ht3.home"] ?? mine) !== mine || owned.has(t.address) || ending.includes(t.address)) continue;
    if (t.state !== "live" || now - (t.created_ms ?? 0) > GRACE) ending.push(t.address);
  }
  if (ending.length) reconcile();
  for (const addr of ending) { lost.delete(addr); await endTerminal(addr); }
  // Asked now and then only: each is a round trip to its machine.
  if (sweeps++ % 5 !== 0) return;
  for (const addr of remote) {
    const r = await hc(["get", addr, "--json"]).catch(() => null);
    if (!r) continue;
    let got = null;
    try { got = JSON.parse(r.stdout || r.stderr || "null"); } catch { /* not JSON: unknown */ }
    if (got?.error?.kind === "not_found" || (got?.state && got.state !== "live")) lost.add(addr);
  }
}
