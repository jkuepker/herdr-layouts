// What a chat tab tells the layout's lists. An agent started over ACP has no terminal, so Herdr
// never counts it as an agent (agents() lists terminals that report OSC 7501). The T3 lists
// (ht3-inbox, ht3-agents, ht3-tabs) also read what a mod pane reports of its tab:
// - shared("ht3-panels.program"): { name, icon, tint, inbox: true }, what such a pane is;
// - shared("ht3-panels.status")[tab]: the word an agent would say (working, blocked, done, idle);
// - shared("ht3-panels.titles")[tab]: its name there: the chat's first message, as a T3 thread's title, and the agent's until there is one;
// - shared("ht3-panels.programs")[tab]: { name, icon, tint, branch, machine }, that tab's agent and where it works, over the program above;
// - shared("ht3-panels.turns")[tab]: how many turns have ended (new work brings a settled chat back).
// - shared("ht3-panels.asks")[tab]: { id, title, options: [{ optionId, name, kind }] } while its agent waits for an approval,
//   and shared("ht3-panels.answers")[tab]: { ask, optionId, always } is how a list answers it (chat.js takes it);
// `keep: true` in the program tells them a chat pane is never theirs to close: Settle puts its card away and no more.
// A chat of a terminal agent (props.terminal) reports nothing: its terminal already does.

import { shared, setShared, spaces, panes, focused, window, machines } from "herdr";
import { MOD } from "./look.js";
import { agentOf } from "./agent-acp.js";

const STATUS = `${MOD}.status`, TITLES = `${MOD}.titles`, PROGRAM = `${MOD}.program`, PLACES = `${MOD}.places`, PROGRAMS = `${MOD}.programs`, TURNS = `${MOD}.turns`;
const PROGRAM_IS = { name: "Chat", icon: `mods/${MOD}/icons/message-square.svg`, tint: true, inbox: true, keep: true };
// Tabs whose chat runs in this app now. Module scope is one per source version, shared by copies.
const LIVE = new Set();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const put = (key, value) => { if (!same(shared(key) ?? null, value)) setShared(key, value); };
const tabsNow = () => new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id)));
// While a machine's spaces aren't read yet, its tabs only look gone.
const allRead = () => machines().every((m) => m.layout === "ready");

// The agent as people call it ("Pi", "Claude Code"): AGENTS' name for its program, else what it says it is.
export function agentName(argv, said) {
  return agentOf(argv)?.name ?? said ?? (String(argv?.[0] ?? "").split("/").pop() || "Agent");
}

// The keeper's part (main.js Buttons, always there): says what a chat pane is, forgets closed tabs, and
// takes back "working" and "blocked" from chats that don't run: after a restart a chat's agent starts
// again only when its tab is first shown. An unread "done" stays.
export function announce() {
  put(PROGRAM, PROGRAM_IS);
  const tabs = allRead() ? tabsNow() : null;
  const status = { ...(shared(STATUS) ?? {}) }, titles = { ...(shared(TITLES) ?? {}) }, places = { ...(shared(PLACES) ?? {}) }, programs = { ...(shared(PROGRAMS) ?? {}) };
  for (const tab of Object.keys(status)) {
    if (tabs && !tabs.has(tab)) { delete status[tab]; delete titles[tab]; delete programs[tab]; }
    else if (!LIVE.has(tab) && status[tab] !== "done") status[tab] = "idle";
  }
  for (const [chat, at] of Object.entries(places)) if (tabs && !tabs.has(at.tab)) delete places[chat];
  put(STATUS, status);
  put(TITLES, titles);
  put(PROGRAMS, programs);
  put(PLACES, places);
}

// The keeper's, every two seconds: closed tabs' entries go. A copy that ends with its space doesn't
// always get to drop its own (close() can run while the pane is still listed).
export function prune() {
  if (!allRead()) return;
  const tabs = tabsNow();
  // Nothing listed yet (the app is starting) is not everything closed.
  if (!tabs.size) return;
  for (const key of [STATUS, TITLES, PROGRAMS, TURNS, `${MOD}.asks`, `${MOD}.answers`]) {
    const all = shared(key) ?? {}, kept = Object.fromEntries(Object.entries(all).filter(([tab]) => tabs.has(tab)));
    put(key, kept);
  }
  const places = shared(PLACES) ?? {};
  put(PLACES, Object.fromEntries(Object.entries(places).filter(([, at]) => tabs.has(at.tab))));
}

// One chat's reports. `chat`: its id (props.chat).
export class Reporter {
  constructor(chat) {
    this.chat = chat;
    this.pane = null;
    this.tab = null;
    this.word = null;
    this.title = null;
    this.program = null;
    this.where = null; // { branch, machine }: where its agent works
    this.turn = null;
    this.drawnAt = 0;
  }

  // The chat was drawn just now. Only shown panes draw, so a chat that is drawn is in the shown tab.
  drawn() {
    this.drawnAt = Date.now();
  }

  // Its pane and tab. props() doesn't name them: the place it was last seen at, else, right after it was
  // drawn, the one chat pane of the shown tab that no chat has. A chat in a hidden tab never takes a place
  // (it could only take another chat's), and two unplaced chats in one tab wait. False until known.
  place() {
    const ps = panes();
    const here = this.pane && ps.find((p) => p.pane === this.pane && p.mod === MOD);
    if (here) { this.move(here.tab); return true; }
    const places = shared(PLACES) ?? {}, taken = new Set(Object.entries(places).filter(([c]) => c !== this.chat).map(([, at]) => at.pane));
    const f = focused();
    const p = ps.find((x) => x.pane === places[this.chat]?.pane && x.mod === MOD)
      ?? (Date.now() - this.drawnAt < 1000 ? ps.find((x) => x.mod === MOD && x.tab === f?.tab && !taken.has(x.pane)
        && ps.filter((y) => y.mod === MOD && y.tab === x.tab && !taken.has(y.pane)).length === 1) : null);
    if (!p) return false;
    this.pane = p.pane;
    this.move(p.tab);
    if (!same(places[this.chat], { pane: p.pane, tab: p.tab })) setShared(PLACES, { ...places, [this.chat]: { pane: p.pane, tab: p.tab } });
    return true;
  }

  // A pane keeps its tab today; should it ever change, the old tab's word goes with it.
  move(tab) {
    if (tab === this.tab) return;
    if (this.tab) { LIVE.delete(this.tab); this.drop(this.tab); }
    this.tab = tab;
    LIVE.add(tab);
    // An unread "done" from before a reload stays unread.
    if (this.word == null && shared(STATUS)?.[tab] === "done") this.word = "done";
    this.turn = shared(TURNS)?.[tab] ?? 0;
  }

  drop(tab) {
    for (const key of [STATUS, TITLES, PROGRAMS, TURNS, `${MOD}.asks`, `${MOD}.answers`]) {
      const all = { ...(shared(key) ?? {}) };
      delete all[tab];
      put(key, all);
    }
  }

  // The person has it in front of them: its tab is the shown one, in this window.
  looking() {
    return window().active && focused()?.tab === this.tab;
  }

  // `status`: the chat's (starting, working, blocked, ready, exited, stopped). `argv`: what started its agent;
  // `said`: what the agent calls itself. Done is a turn that ended, or an agent that stopped, while nobody
  // looked; it is idle once they look.
  // `thread`: the chat's first message, its title in the lists as in T3; until there is one, the agent's name.
  // `more`: { cwd, machine, crumb }: its folder (the side panel follows it) and its header, which the pane header draws.
  update(status, argv, said, thread, more = {}) {
    const name = agentName(argv, said), a = agentOf(argv);
    this.program = { name, ...(a?.icon ? { icon: a.icon, tint: a.tint } : {}), ...(this.where?.branch ? { branch: this.where.branch } : {}), ...(more.machine ? { machine: more.machine } : {}),
      ...(more.cwd ? { cwd: more.cwd } : {}), ...(more.crumb ? { crumb: more.crumb } : {}) };
    if (!this.place()) return;
    const busy = status === "working" || status === "blocked";
    const was = this.word;
    if (!busy && (was === "working" || was === "blocked")) this.turn = (this.turn ?? 0) + 1;
    this.word = busy ? status
      : was === "working" || was === "blocked" ? (this.looking() ? "idle" : "done")
      : was === "done" && !this.looking() ? "done" : "idle";
    // With the tab named after something else, both: "Pi · fix login".
    const tab = spaces().flatMap((s) => s.tabs).find((c) => c.id === this.tab);
    const line = String(thread ?? "").trim().split("\n")[0];
    this.title = line ? (line.length > 80 ? line.slice(0, 80) + "…" : line)
      : tab?.named && tab.name && tab.name.toLowerCase() !== name.toLowerCase() ? `${name} · ${tab.name}` : name;
    this.publish();
  }

  // From the view's timer and its drawing: a "done" that is looked at.
  seen() {
    if (this.word !== "done" || !this.looking()) return;
    this.word = "idle";
    this.publish();
  }

  publish() {
    put(STATUS, { ...(shared(STATUS) ?? {}), [this.tab]: this.word });
    put(TITLES, { ...(shared(TITLES) ?? {}), [this.tab]: this.title });
    put(PROGRAMS, { ...(shared(PROGRAMS) ?? {}), [this.tab]: this.program });
    put(TURNS, { ...(shared(TURNS) ?? {}), [this.tab]: this.turn ?? 0 });
    // Closed tabs' words go when any chat speaks.
    if (allRead()) {
      const tabs = tabsNow(), status = shared(STATUS) ?? {};
      if (Object.keys(status).some((t) => !tabs.has(t))) announce();
    }
  }

  // The copy ends: its pane or tab closed, or the app quits. A closed pane's word goes; on a quit the pane
  // is still there, and its word stays for the next start (announce() takes "working" back).
  close() {
    if (!this.tab) return;
    LIVE.delete(this.tab);
    if (!panes().some((p) => p.pane === this.pane)) {
      this.drop(this.tab);
      const places = { ...(shared(PLACES) ?? {}) };
      delete places[this.chat];
      put(PLACES, places);
    }
  }
}
