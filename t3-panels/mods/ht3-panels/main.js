// T3 Code's chat and its right panel for the Herdr T3 layout. One mod, many faces, picked by
// how a copy is opened:
// - props.panel "chat": the chat pane, split beside a terminal (chat.js);
// - props.panel "editor" | "diff" | "dashboard" | "pr" | "prs" | "browser" | "side" | "empty": the surfaces of the
//   side panel, blocks in the layout's right column (editor.js, diff.js, pr.js, browser.js,
//   sidechat.js, empty.js), each with props.group "a" or "b";
// - props.panel "strip": a group's tab strip (strip.js);
// - props.panel "buttons": the buttons in the layout's tab bar (below);
// - as an overlay (`mod.open {"name": "ht3-panels"}`): the New chat dialog (launcher.js), or with
//   props.menu "add" / "project", the side panel's popups, "copy" / "thread" / "revert", the chat's
//   and the lists' menus (all menus.js), "settings", the Settings dialog (settings-ui.js), or
//   "usage", the Usage dialog (usage.js), or "search", the project content search (search.js), or "servers", the
//   servers started from the folder (servers.js).
// The panel's state and the code that makes the layout match it are in side.js.

import { View } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, nextCommand, run, openOverlay, shared, setShared } from "herdr";
// Also an overlay: "automations", the project's Herdr automations (automations.js).
import { MOD, tokens, iconButton } from "./look.js";
import { ChatPanel, openLauncher } from "./chat.js";
import { FilePanel } from "./editor.js";
import { Launcher } from "./launcher.js";
import { Strip, ADD_MENU } from "./strip.js";
import { AddMenu, ProjectMenu, CopyMenu, ThreadMenu, RevertMenu } from "./menus.js";
import { DiffPanel } from "./diff.js";
import { DashboardPanel } from "./dashboard.js";
import { PrPanel, PrChatDialog, prChatCommand } from "./pr.js";
import { BrowserPanel } from "./browser.js";
import { ChecksPanel, openChecks } from "./checks.js";
import { SideChat, beginChat } from "./sidechat.js";
import { Empty } from "./empty.js";
import { detect } from "./agent-acp.js";
import { announce, prune } from "./report.js";
import { Settings, SETTINGS_SIZE } from "./settings-ui.js";
import { Usage, USAGE_SIZE } from "./usage.js";
import { Search, SEARCH_SIZE, showHit, searchOpen } from "./search.js";
import { Automations, AUTOMATIONS_SIZE, automationsOpen } from "./automations.js";
import { loadPrefs, setPref, agentOn } from "./settings.js";
import { SIDE, read, sideShown, bottomShown, reconcile, keep, toggleMax, toggleBottom, toggleSplit, openSurface, openBottom, closeTab, activate, activeSpace, openScript, reopenClosed } from "./side.js";
import { pendingScript } from "./scripts.js";
import { ServersDialog, openServers, serversOpen } from "./servers.js";
import { WorktreesDialog, openWorktrees, worktreesOpen } from "./worktrees.js";

export { SIDE };

// The buttons of the tab bar, and (this copy is always there) the keeper of the side panel: it
// makes the layout match the shown space's state, and tidies up after ended terminals.
class Buttons {
  init(_p, cx) {
    this.space = null;
    // After the frame's other copies began: a chat that runs has said so by then (report.js).
    cx.timer.after(0, () => announce());
    // The settings file, now and whenever it is edited by hand (settings.js).
    cx.spawn(() => loadPrefs());
    cx.timer.every(2000, (cx) => { prune(); cx.spawn(() => loadPrefs()); });
    cx.spawn((cx) => keep(cx));
  }
  close() {}

  // Commands for keys.json and scripts (`herdr-app do "ht3-panels.<command>"`; this copy is always
  // shown), and for the panel's other copies, which send them here (side.js): add:<kind>[:<group>]
  // (add:terminal:bottom: the bottom panel's terminal), activate:<group>:<tab id>,
  // close:<group>:<tab id>, split, max, bottom, chat:<agent id>[:<group>] (starts the group's side
  // chat with that agent), menu:add[:<group>], menu:project, pin:<folder> (the folder Files, Diff
  // and the pull request surfaces look at for the shown space; pin: with none goes back to the
  // terminal's), settings (the Settings dialog), set:<path>=<json> (one setting, e.g.
  // set:agents.pi.enabled=false; set:<path> alone goes back to its default), earlier (the earlier chats, to search and reopen).
  // The open Project popover (menus.js) takes git:pull, branches, branch:<name>, branch:new:<name>, branch:filter:<text>, key:<key>.
  command(c, cx) {
    const [name, a, b] = c.split(":");  // (pin keeps its whole path)
    const fail = (e) => console.log(`ht3-panels.${c}: ${String(e?.message ?? e)}`);
    if (name === "add") cx.spawn(async (cx) => { try { await (b === "bottom" ? openBottom() : openSurface(b ?? "a", a)); } catch (e) { fail(e); } cx.notify(); });
    else if (name === "activate") activate(a, b);
    else if (name === "close") cx.spawn(async (cx) => { try { await closeTab(a, b); } catch (e) { fail(e); } cx.notify(); });
    else if (name === "split") cx.spawn(async (cx) => { try { await toggleSplit(); } catch (e) { fail(e); } cx.notify(); });
    // chat:effort-up and the other composer keys belong to the chat (chat.js), not a side chat start.
    else if (name === "chat" && !/^(effort-up|effort-down|mode|model)$/.test(a ?? "")) cx.spawn(async (cx) => { const d = await detect(activeSpace()?.machine ?? null); if (agentOn(a)) beginChat(b ?? "a", a, d.found); cx.notify(); });
    else if (name === "settings") openSettings();
    // checks[:<a|b>]: shows the Checks surface (checks.js), in the group that has it, else the first (or the one given).
    else if (c === "checks" || (name === "checks" && (a === "a" || a === "b"))) cx.spawn(async (cx) => { try { await openChecks(a); } catch (e) { fail(e); } cx.notify(); });
    else if (name === "set") {
      const rest = c.slice(4), at = rest.indexOf("=");
      try { setPref(at < 0 ? rest : rest.slice(0, at), at < 0 ? undefined : JSON.parse(rest.slice(at + 1))); } catch (e) { fail(e); }
    }
    else if (name === "max") toggleMax();
    else if (name === "pin") {
      const sp = activeSpace(), all = { ...(shared("ht3-files.pinned") ?? {}) }, dir = c.slice(4);
      if (dir) all[sp?.id ?? ""] = { root: dir, on: sp?.machine ?? null }; else delete all[sp?.id ?? ""];
      setShared("ht3-files.pinned", all);
    }
    else if (name === "bottom") cx.spawn(async (cx) => { try { await toggleBottom(); } catch (e) { fail(e); } cx.notify(); });
    // usage: the Usage dialog (usage.js).
    else if (name === "usage") openOverlay({ mod: MOD, kind: "dialog", ...USAGE_SIZE, props: { menu: "usage" } });
    // search: the project content search dialog (search.js; T3's mod+shift+f); again while it is open closes it (the dialog
    // does that itself). search:<text> opens it with that typed. goto:<line>:<absolute path>: Files shows that file with the line picked.
    else if (name === "search") { if (!searchOpen()) openOverlay({ mod: MOD, kind: "dialog", ...SEARCH_SIZE, props: { menu: "search", query: c.slice(7) } }); }
    else if (name === "goto") showHit(c.slice(5), cx);
    // earlier: the New chat dialog as a list of the earlier chats alone, its search focused (the palette's "Earlier chats…").
    else if (name === "earlier") openOverlay({ mod: MOD, kind: "dialog", width: 512, height: 520, props: { find: true } });
    // script: runs the project script the Project popover just picked (scripts.js), if it was picked a moment ago.
    else if (name === "script") { const s = pendingScript(); if (s && Date.now() - s.at < 10000) cx.spawn(async (cx) => { try { await openScript(s); } catch (e) { fail(e); } cx.notify(); }); }
    // prChat: Start chat from PR (pr.js). Alone it asks for the number or the address; prChat:<number or address> starts at once.
    else if (name === "prChat") prChatCommand(c.slice(7));
    // automations: the project's Herdr automations (automations.js); again while it is open closes it (the dialog does that
    // itself). automations:all opens it on every automation of the machine.
    else if (name === "automations") { if (!automationsOpen()) openOverlay({ mod: MOD, kind: "dialog", ...AUTOMATIONS_SIZE, props: { menu: "automations", all: a === "all" } }); }
    // servers: the servers started from the shown space's folder, as a dialog (servers.js); servers:<folder> for that folder.
    // Again while it is open closes it (the dialog does that itself).
    else if (name === "servers") { if (!serversOpen()) openServers(c.slice(8)); }
    // worktrees: the repository's worktrees to clean up, as a dialog (worktrees.js); worktrees:<folder> for that folder's repository.
    // Again while it is open closes it (the dialog does that itself).
    else if (name === "worktrees") { if (!worktreesOpen()) openWorktrees(c.slice(10)); }
    // reopen-closed: brings back the newest closed side-panel surface, file or chat tab (side.js reopenClosed; T3's mod+shift+t).
    else if (c === "reopen-closed") cx.spawn(async (cx) => { try { await reopenClosed(cx); } catch (e) { fail(e); } cx.notify(); });
    else if (name === "menu") openOverlay({ mod: MOD, kind: "popup", at: { x: 900, y: 48 }, width: a === "project" ? 344 : ADD_MENU.w, height: a === "project" ? 724 : ADD_MENU.h, props: { menu: a, group: b ?? "a" } });
    cx.notify();
  }

  render(cx) {
    const k = tokens();
    const id = activeSpace()?.id ?? null;
    if (id !== this.space) { this.space = id; cx.timer.after(0, () => reconcile()); }
    const shown = sideShown() === true, maxed = read().max === true;
    return h_flex().id("ht3-panel-buttons").size_full().gap(4).items_center().justify_end().pr(4)
      .child(iconButton(k, "open-chat", "message-square", () => openLauncher(), { size: "sm", tip: "New chat (Cmd+Shift+O)" }))
      .child(iconButton(k, "side-max", maxed ? "minimize-2" : "maximize-2", () => toggleMax(), { size: "sm", on: maxed && shown, tip: maxed ? "Restore the panel" : "Maximize the panel" }))
      .child(iconButton(k, "side-bottom", "panel-bottom", (cx) => { cx.spawn(async (cx) => { try { await toggleBottom(); } catch (e) { console.log(String(e?.message ?? e)); } cx.notify(); }); }, { size: "sm", on: bottomShown() === true, ring: true, tip: "Toggle the bottom panel" }))
      .child(iconButton(k, "open-files", "panel-right", () => run("layout.toggle", { id: SIDE }), { size: "sm", on: shown, ring: true, tip: "Right panel (Cmd+Shift+E)" }));
  }
}

export function openSettings() {
  openOverlay({ mod: MOD, kind: "dialog", ...SETTINGS_SIZE, props: { menu: "settings" } });
}

const FACES = {
  editor: () => new FilePanel(),
  strip: () => new Strip(),
  diff: () => new DiffPanel(),
  dashboard: () => new DashboardPanel(),
  pr: () => new PrPanel(false),
  prs: () => new PrPanel(true),
  browser: () => new BrowserPanel(),
  checks: () => new ChecksPanel(),
  side: () => new SideChat(),
  empty: () => new Empty(),
  buttons: () => new Buttons(),
};

export default class T3Panels extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.face = p.overlay
      ? p.menu === "add" ? new AddMenu() : p.menu === "project" ? new ProjectMenu() : p.menu === "settings" ? new Settings() : p.menu === "usage" ? new Usage() : p.menu === "search" ? new Search() : p.menu === "servers" ? new ServersDialog() : p.menu === "worktrees" ? new WorktreesDialog() : p.menu === "copy" ? new CopyMenu() : p.menu === "thread" ? new ThreadMenu() : p.menu === "revert" ? new RevertMenu() : p.menu === "prchat" ? new PrChatDialog() : p.menu === "automations" ? new Automations() : new Launcher()
      : (FACES[p.panel] ?? (() => new ChatPanel()))();
    this.face.init(p, cx);
    // Key commands from keys.json's "mod:ht3-panels" section (save), and "focus" from pane.go.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.face.command(c, cx);
      }
    });
  }

  async close(cx) {
    await this.face.close(cx);
  }

  render(cx) {
    return this.face.render(cx);
  }
}
