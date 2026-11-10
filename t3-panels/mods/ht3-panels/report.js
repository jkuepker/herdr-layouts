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
// - shared("ht3-panels.unread")[tab]: set by the card's menu ("Mark unread"); the chat takes it and says "done" again
//   until the person has gone elsewhere and come back to it.
// `keep: true` in the program tells them a chat pane is never theirs to close: Settle puts its card away and no more.
// A chat of a terminal agent (props.terminal) reports nothing: its terminal already does.

import { shared, setShared, spaces, panes, focused, window, machines, notify, playSound, settings } from "herdr";
import { MOD } from "./look.js";
import { agentOf } from "./agent-acp.js";
import { toastsOn, soundsOn } from "./settings.js";

const STATUS = `${MOD}.status`, TITLES = `${MOD}.titles`, PROGRAM = `${MOD}.program`, PLACES = `${MOD}.places`, PROGRAMS = `${MOD}.programs`, TURNS = `${MOD}.turns`;
const UNREAD = `${MOD}.unread`;
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
  for (const key of [STATUS, TITLES, PROGRAMS, TURNS, `${MOD}.asks`, `${MOD}.answers`, UNREAD]) {
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
    this.agent = a ?? null;
    this.program = { name, ...(a?.icon ? { icon: a.icon, tint: a.tint } : {}), ...(this.where?.branch ? { branch: this.where.branch } : {}), ...(more.machine ? { machine: more.machine } : {}),
      ...(more.cwd ? { cwd: more.cwd } : {}), ...(more.crumb ? { crumb: more.crumb } : {}) };
    if (!this.place()) return;
    const busy = status === "working" || status === "blocked";
    const was = this.word;
    if (!busy && (was === "working" || was === "blocked")) this.turn = (this.turn ?? 0) + 1;
    this.word = busy ? status
      : was === "working" || was === "blocked" ? (this.looking() ? "idle" : "done")
      : was === "done" && (this.held || !this.looking()) ? "done" : "idle";
    if (busy) this.held = false;
    // With the tab named after something else, both: "Pi · fix login".
    const tab = spaces().flatMap((s) => s.tabs).find((c) => c.id === this.tab);
    const line = String(thread ?? "").trim().split("\n")[0];
    this.title = line ? (line.length > 80 ? line.slice(0, 80) + "…" : line)
      : tab?.named && tab.name && tab.name.toLowerCase() !== name.toLowerCase() ? `${name} · ${tab.name}` : name;
    // Herdr toasts a terminal agent that ends or asks while it isn't looked at; a chat's agent has no terminal,
    // so the chat does: once per turn that ended unseen, once per approval. A click on the toast shows the chat.
    // Which chats get one: see `tell`.
    const told = this.word === "done" && was !== "done" ? "done" : this.word === "blocked" && was !== "blocked" && !this.looking() ? "blocked" : null;
    if (told) this.tell(told, name, more.ask);
    this.publish();
  }

  // The toast's picture: the agent's own mark, as its tab's (Pi, Claude Code, Codex, OpenCode, Gemini). The toast mod
  // draws a picture as it is and can't tint it, so the one-colour marks have a light and a dark copy (icons/toast).
  // An agent with no mark of its own (a typed command) gets the state's: a green check or an amber "!".
  toastIcon(what) {
    const a = this.agent;
    if (a?.icon && !a.tint) return a.icon;
    if (a?.icon && ["pi", "opencode", "gemini"].includes(a.id)) return `mods/${MOD}/icons/toast/${a.id}-${settings()?.dark !== false ? "dark" : "light"}.svg`;
    return `mods/${MOD}/icons/toast/${what === "done" ? "done" : "blocked"}.svg`;
  }

  // A chat in a hidden tab posts Herdr's toast. The chat of the shown tab posts none while Herdr is in front (you
  // are looking at it); with Herdr behind another app it posts the toast too, to be found on coming back. The
  // system's own notification is not used: mods have no call for one, and posted through osascript it carried
  // Script Editor's icon and a click on it did not open Herdr.
  tell(what, name, ask) {
    const space = spaces().find((x) => x.tabs.some((c) => c.id === this.tab));
    const title = what === "done" ? `${name} finished` : `${name} needs you`, body = [what === "blocked" && ask ? ask : this.title, space?.name].filter(Boolean).join(" · ");
    if (toastsOn() && !(focused()?.tab === this.tab && window().active)) {
      notify({ title, body, level: what === "done" ? "success" : "warning", icon: this.toastIcon(what), action: { name: "pane.focus", args: { pane: this.pane } } });
    }
    if (soundsOn()) playSound(what);
  }

  // "Mark unread" (T3's thread menu): the card's menu leaves a mark, and the chat is unread ("done") again. Marked
  // while it is being looked at, it stays unread until the person has looked away once and come back.
  marked() {
    const all = shared(UNREAD) ?? {};
    if (!this.tab || !all[this.tab]) return;
    const rest = { ...all };
    delete rest[this.tab];
    setShared(UNREAD, rest);
    if (this.word === "working" || this.word === "blocked") return;
    this.word = "done";
    this.held = this.looking();
    this.publish();
  }

  // From the view's timer and its drawing: a "done" that is looked at.
  seen() {
    this.marked();
    if (this.held) { if (!this.looking()) this.held = false; return; }
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
