// The mod's popups. Two are the side panel's: the `+` menu of surfaces (RightPanelTabs.tsx's
// AddSurfaceMenu: a row per surface with its icon, its name and its letter, which opens it while
// the menu is open) and the project popover (the machine, its folder, the editor, the branch, the
// Git actions, the project's scripts). Three are the chat's and the lists': the right-click menu of
// a message (Copy, Fork), of an Inbox card (Rename, Settle, Pin, …), and the question before a revert.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { closeOverlay, exec, hc, run, appHome, shared, setShared, readTextFile, notify, spaces } from "herdr";
import { chatLike, forkChat } from "./agent-acp.js";
import { toMarkdown } from "./transcript.js";
import { agentName } from "./report.js";
import { MOD, tokens, icon, button, iconButton, badge, shortPath, alpha } from "./look.js";
import { revertTo } from "./checkpoint.js";
import { editorOn, commitStyle } from "./settings.js";
import { SURFACES, send, placeOf, activeSpace, surfaceOff, surfacesHere } from "./side.js";
import { projectOf, scriptsOf, runScript, detectProject } from "./scripts.js";
import { devCommand } from "./detect.js";
import { write, wroteLine, Cancelled, conventionalIssue } from "./gitwrite.js";
import { holdForSecrets, guardStep } from "./secretguard.js";
import { discover, startDevServer } from "./servers.js";
import { readBranches, switchRow, pullFastForward, pickerRows, rowBlocked } from "./branches.js";
import { stashView, conflictView, showStash, readStashes, readConflicts, stashPush, stashRun, stashAndPull, takeSide, markResolved, continueOp, abortOp } from "./stash.js";
import { conflictRow } from "./gitstate.js";
import { removeWorktreeFolder } from "./compare-data.js";

export class AddMenu {
  init(p, cx) {
    this.overlay = p.overlay;
    this.group = p.group ?? "a";
    this.hot = -1;
    this.where = placeOf(activeSpace());
    this.focus = cx.focus_handle();
    cx.timer.after(0, () => this.focus.focus());
  }
  close() {}
  // `ht3-panels.key:<key>` presses a key in the open menu, for scripts.
  command(c, cx) {
    if (c.startsWith("key:")) this.key(c.slice(4), cx);
  }

  // The keeper opens the surface (side.js), so the menu goes at once: work started by this copy
  // would be dropped with it.
  pick(s) {
    if (surfaceOff(s, this.where)) return;
    send(`add:${s.kind}:${this.group}`);
    closeOverlay(this.overlay);
  }

  // Esc closes; the arrows move over the surfaces that can open and Enter opens the marked one;
  // a surface's letter opens it.
  key(key, cx) {
    const can = SURFACES.map((s, i) => (surfaceOff(s, this.where) ? -1 : i)).filter((i) => i >= 0);
    const step = (by) => { const at = can.indexOf(this.hot); this.hot = can[at < 0 ? (by > 0 ? 0 : can.length - 1) : (at + by + can.length) % can.length]; cx.notify(); };
    if (key === "escape") return closeOverlay(this.overlay);
    if (key === "down") return step(1);
    if (key === "up") return step(-1);
    if (key === "enter") return this.hot >= 0 ? this.pick(SURFACES[this.hot]) : undefined;
    const s = SURFACES.find((x) => x.key === key);
    if (s) this.pick(s);
  }

  render(cx) {
    const k = tokens();
    // What doesn't apply in the folder the space works in now is greyed, with why, and the keys pass it by (side.js).
    this.where = surfacesHere(cx);
    if (this.hot >= 0 && surfaceOff(SURFACES[this.hot], this.where)) this.hot = -1;
    return v_flex().id("ht3-add-menu").size_full().p(4).bg(k.popover).text_color(k.foreground).text_size(14)
      .track_focus(this.focus)
      .on_key_down((e, cx) => {
        if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
        this.key(e.key.toLowerCase(), cx);
      })
      .children(SURFACES.map((s, i) => {
        // ui/menu.tsx MenuItem: 28 high, 4 round, a 16px icon; MenuShortcut: the bare letter, 12px medium.
        const el = h_flex().id(`add-${s.kind}`).h(28).px(8).gap(8).flex_none().items_center().rounded(4)
          .bg(this.hot === i ? k.accent : "#00000000").text_size(14)
          .child(icon(s.glyph).size(16).flex_none().text_color(k.muted))
          .child(div().flex_1().min_w(0).truncate().child(s.label))
          .child(div().flex_none().text_size(12).font_medium().text_color(k.muted).child(s.key.toUpperCase()));
        const off = surfaceOff(s, this.where);
        if (off) return el.opacity(0.64).tooltip(off);
        return el.role("button").accessibility_label(s.label).cursor_pointer()
          .hover((st) => st.bg(k.accent)).on_click(() => this.pick(s));
      }));
  }
}

// ---- the project popover ----

export const EDITORS = [
  { id: "cursor", name: "Cursor", app: "Cursor", bin: "cursor" },
  { id: "code", name: "VS Code", app: "Visual Studio Code", bin: "code" },
  { id: "codium", name: "VSCodium", app: "VSCodium", bin: "codium" },
  { id: "zed", name: "Zed", app: "Zed", bin: "zed" },
];
let editorCache = null;
// The editors installed here, in order: an app bundle or a command on the PATH.
export async function editors() {
  if (editorCache) return editorCache;
  const script = EDITORS.map((e) => `if [ -d "/Applications/${e.app}.app" ] || [ -d "$HOME/Applications/${e.app}.app" ]; then echo "${e.id} app"; elif command -v ${e.bin} >/dev/null 2>&1; then echo "${e.id} bin"; fi`).join("; ");
  const r = await exec("sh", ["-c", `${script}; true`]).catch(() => null);
  const found = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split(" "));
  editorCache = found.map(([id, how]) => ({ ...EDITORS.find((e) => e.id === id), how }));
  // Each app's own icon, as T3 shows it: taken from its bundle once (sips, 64px) and kept in the mod's data.
  const dir = `${appHome()}/data/${MOD}/editor-icons`;
  const take = editorCache.filter((e) => e.how === "app").map((e) => `a="/Applications/${e.app}.app"; [ -d "$a" ] || a="$HOME/Applications/${e.app}.app"; `
    + `f=$(defaults read "$a/Contents/Info" CFBundleIconFile 2>/dev/null); f="\${f%.icns}.icns"; `
    + `[ -s "${dir}/${e.id}.png" ] || sips -s format png -Z 64 "$a/Contents/Resources/$f" --out "${dir}/${e.id}.png" >/dev/null 2>&1; [ -s "${dir}/${e.id}.png" ] && echo ${e.id}`).join("; ");
  const got = take ? await exec("sh", ["-c", `mkdir -p "${dir}"; ${take}; true`]).catch(() => null) : null;
  const have = new Set((got?.stdout ?? "").split("\n").filter(Boolean));
  for (const e of editorCache) if (have.has(e.id)) e.icon = `data/${MOD}/editor-icons/${e.id}.png`; // read from the app's home, as its icons/ are
  return editorCache;
}
export const openIn = (ed, folder) => (ed
  ? ed.how === "app" ? exec("open", ["-a", ed.app, folder]) : exec(ed.bin, [folder])
  : exec("open", [folder]));

// The right-click menu of a chat message (ui/menu.tsx): Copy puts `props.text` on the clipboard.
// Enter or C copies, F forks (with `props.fork`), Esc closes; `ht3-panels.key:<enter|f|escape>` presses for scripts.
export class CopyMenu {
  init(p, cx) {
    this.overlay = p.overlay;
    this.text = String(p.text ?? "");
    this.fork = p.fork ?? null; // { chat, upto }: adds "Fork from here"
    this.focus = cx.focus_handle();
    cx.timer.after(0, () => this.focus.focus());
  }
  close() {}
  command(c, cx) {
    if (c.startsWith("key:")) this.key(c.slice(4), cx);
  }
  key(key, cx) {
    if (key === "enter" || key === "c") cx.write_to_clipboard(this.text);
    // The menu stays until the fork is written: closing it ends what it had begun.
    if (key === "f" && this.fork) forkChat(this.fork.chat, this.fork.upto).catch(() => null).then(() => closeOverlay(this.overlay));
    if (key === "enter" || key === "c" || key === "escape") closeOverlay(this.overlay);
  }
  render() {
    const k = tokens();
    return v_flex().id("ht3-copy-menu").size_full().p(4).bg(k.popover).text_color(k.foreground).text_size(14)
      .track_focus(this.focus)
      .on_key_down((e, cx) => { if (!(e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt)) this.key(e.key.toLowerCase(), cx); })
      .child(h_flex().id("copy-row").h(28).px(8).gap(8).items_center().rounded(4).cursor_pointer().role("button").accessibility_label("Copy")
        .hover((s) => s.bg(k.accent)).on_click((_e, cx) => this.key("enter", cx))
        .child(icon("copy").size(16).flex_none().text_color(k.muted)).child(div().flex_1().child("Copy")))
      .when(!!this.fork, (el) => el.child(h_flex().id("fork-row").h(28).px(8).gap(8).items_center().rounded(4).cursor_pointer().role("button").accessibility_label("Fork from here")
        .hover((s) => s.bg(k.accent)).on_click((_e, cx) => this.key("f", cx))
        .child(icon("git-branch").size(16).flex_none().text_color(k.muted)).child(div().flex_1().child("Fork from here"))));
  }
}

// The right-click menu of an Inbox card (threadActionMenu.logic.ts): Rename thread, and Settle (T3's
// Archive). props: { address, tab, title, chat (a chat's id, else null), settled }. A chat's name is kept
// in shared("ht3-panels.named"); a terminal agent's is its tab's. Keys: R, S, Esc; in the field Enter.
// `ht3-panels.key:<r|s|escape>` and `ht3-panels.name:<text>` (types and takes it) for scripts.
export class ThreadMenu {
  init(p, cx) {
    this.overlay = p.overlay;
    this.p = p;
    this.field = InputState.new({ placeholder: "Thread name", value: String(p.title ?? "") });
    this.field.on("submit", () => this.apply(this.field.value()));
    this.naming = false;
    this.focus = cx.focus_handle();
    cx.timer.after(0, () => this.focus.focus());
  }
  close() {}
  command(c, cx) {
    if (c.startsWith("key:")) this.key(c.slice(4), cx);
    if (c.startsWith("name:")) this.apply(c.slice(5));
  }
  apply(name) {
    const to = String(name ?? "").trim().slice(0, 120), p = this.p;
    if (p.chat) {
      const all = { ...(shared(`${MOD}.named`) ?? {}) };
      if (to) all[p.chat] = to; else delete all[p.chat];
      setShared(`${MOD}.named`, all);
    } else if (p.tab) run("tab.rename", { id: p.tab, name: to });
    closeOverlay(this.overlay);
  }
  key(key, cx) {
    if (key === "escape") return closeOverlay(this.overlay);
    if (this.naming) return;
    if (key === "r") { this.naming = true; this.field.focus(); cx.notify(); }
    if (key === "s") { run(`ht3-inbox.settle-card:${this.p.address}`); closeOverlay(this.overlay); }
    // Regenerate title: the chat itself asks its agent (chat.js retitle), so the menu only leaves the request.
    if (key === "g" && this.p.chat) { setShared(`${MOD}.retitle`, { chat: this.p.chat, at: Date.now() }); closeOverlay(this.overlay); }
    // New chat on this branch: the same agent, in this chat's folder, as a tab beside it.
    if (key === "n" && this.p.chat && /^[\w-]+$/.test(this.p.chat)) cx.spawn(async () => {
      try {
        const s = JSON.parse(await readTextFile(`${appHome()}/data/${MOD}/chats/${this.p.chat}/state.json`));
        chatLike(s, spaces().find((x) => x.tabs.some((c) => c.id === this.p.tab))?.id);
      } catch (e) { notify({ title: "Couldn't start the chat", body: String(e?.message ?? e), level: "error" }); }
      closeOverlay(this.overlay);
    });
    // Pin (T3's thread menu): the lists keep one set of pins by address (shared "agents.pins"); a pinned card
    // stands in the Inbox's Pinned section and on top of the Agents list.
    if (key === "i" && this.p.address) {
      const pins = shared("agents.pins") ?? [], a = this.p.address;
      setShared("agents.pins", pins.includes(a) ? pins.filter((x) => x !== a) : [...pins, a]);
      // A pin ends a snooze, as pinning in the Agents list does: a chat's is in the Inbox's shared labels, a terminal's is its label.
      if (!pins.includes(a)) {
        const cards = shared("ht3-inbox.cards") ?? {}, pane = a.replace(/^pane:/, "");
        if (cards[pane]?.snoozed) {
          const { snoozed: _woken, ...own } = cards[pane], next = { ...cards };
          if (Object.keys(own).length) next[pane] = own; else delete next[pane];
          setShared("ht3-inbox.cards", next);
        } else if (!this.p.chat) hc(["label", a, "snoozed="]).catch(() => null);
      }
      closeOverlay(this.overlay);
    }
    // Compare with another chat: Compare chats (compare.js) with this chat on side A and a picker for B.
    if (key === "c" && this.p.chat && /^[\w-]+$/.test(this.p.chat)) { closeOverlay(this.overlay); run(`${MOD}.compare:${this.p.chat}`); }
    // Mark unread: the chat takes the mark and says "done" again (report.js `marked`).
    if (key === "u" && this.p.chat && this.p.tab) { setShared(`${MOD}.unread`, { ...(shared(`${MOD}.unread`) ?? {}), [this.p.tab]: Date.now() }); closeOverlay(this.overlay); }
    // A chat's Copy group (T3's thread menu: Copy > Path, Branch; the whole thread as Markdown is ours).
    const at = this.p.chat ? shared(`${MOD}.programs`)?.[this.p.tab] ?? {} : null;
    if (key === "p" && at?.cwd) { cx.write_to_clipboard(at.cwd); closeOverlay(this.overlay); }
    if (key === "b" && at?.branch) { cx.write_to_clipboard(at.branch); closeOverlay(this.overlay); }
    if (key === "m" && this.p.chat && /^[\w-]+$/.test(this.p.chat)) cx.spawn(async (cx) => {
      try {
        const s = JSON.parse(await readTextFile(`${appHome()}/data/${MOD}/chats/${this.p.chat}/state.json`));
        const md = toMarkdown({ title: this.p.title, agent: agentName(s.agentArgv, s.agentInfo?.title ?? s.agentInfo?.name), cwd: s.cwd, machine: s.machine, branch: at?.branch, items: s.transcript?.items });
        cx.write_to_clipboard(md);
        notify({ title: "Thread copied as Markdown", body: `${md.split("\n").length} lines`, level: "success", timeout: 2500 });
      } catch (e) { notify({ title: "Couldn't copy the thread", body: String(e?.message ?? e), level: "error" }); }
      closeOverlay(this.overlay);
    });
  }
  render() {
    const k = tokens();
    const row = (id, glyph, label, key) => h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(4).cursor_pointer().role("button").accessibility_label(label)
      .hover((s) => s.bg(k.accent)).on_click((_e, cx) => this.key(key, cx))
      .child(icon(glyph).size(16).flex_none().text_color(k.muted)).child(div().flex_1().child(label));
    return v_flex().id("ht3-thread-menu").size_full().p(4).bg(k.popover).text_color(k.foreground).text_size(14)
      .track_focus(this.focus)
      // A chord (Cmd+S, Cmd+N) is not a row's letter, as in the `+` menu.
      .on_key_down((e, cx) => { if (!(e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt)) this.key(e.key.toLowerCase(), cx); })
      .when(this.naming, (el) => el.child(div().h(28).mt(14).mx(4).px(8).rounded(6).border(1).border_color(k.input).child(Input.new(this.field))))
      .when(!this.naming, (el) => el
        .child(row("thread-rename", "pen-line", "Rename thread", "r"))
        .when(!!this.p.chat, (e) => e.child(row("thread-title", "sparkles", "Regenerate title", "g")))
        .child(row("thread-settle", "check", this.p.settled ? "Bring back" : "Settle", "s"))
        .when(!!this.p.address, (e) => e.child(row("thread-pin", (shared("agents.pins") ?? []).includes(this.p.address) ? "pin-off" : "pin", (shared("agents.pins") ?? []).includes(this.p.address) ? "Unpin" : "Pin", "i")))
        .when(!!this.p.chat, (e) => e.child(row("thread-compare", "columns-2", "Compare with…", "c")))
        .when(!!this.p.chat, (e) => e.child(row("thread-unread", "circle-dot", "Mark unread", "u"))
          .child(row("thread-new", "git-branch", (shared(`${MOD}.programs`)?.[this.p.tab] ?? {}).branch ? "New chat on this branch" : "New chat in this folder", "n")))
        .when(!!this.p.chat, (e) => {
          const at = shared(`${MOD}.programs`)?.[this.p.tab] ?? {};
          return e.child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
            .child(row("thread-copy-md", "copy", "Copy as Markdown", "m"))
            .when(!!at.cwd, (x) => x.child(row("thread-copy-path", "folder", "Copy path", "p")))
            .when(!!at.branch, (x) => x.child(row("thread-copy-branch", "git-branch", "Copy branch", "b")));
        }));
  }
}

// The question before a revert (chat/ChatOverlayHosts.tsx): props { chat, sha, cwd, on, label }.
// Enter or the button reverts, Esc or Cancel closes; `ht3-panels.key:<enter|escape>` for scripts. The
// outcome goes to shared("ht3-panels.reverted") for the chat to say.
export class RevertMenu {
  init(p, cx) {
    this.overlay = p.overlay;
    this.p = p;
    this.busy = false;
    this.focus = cx.focus_handle();
    cx.timer.after(0, () => this.focus.focus());
  }
  close() {}
  command(c, cx) {
    if (c.startsWith("key:")) this.key(c.slice(4), cx);
  }
  key(key, cx) {
    if (this.busy) return;
    if (key === "escape") return closeOverlay(this.overlay);
    if (key !== "enter") return;
    this.busy = true;
    cx.notify();
    const p = this.p;
    // The dialog stays until git is done: closing it would end the revert half way.
    revertTo({ cwd: p.cwd, on: p.on ?? undefined }, p.chat ?? "chat", p.sha)
      .then((r) => setShared(`${MOD}.reverted`, { chat: p.chat, at: Date.now(), label: p.label, ...r }))
      .finally(() => closeOverlay(this.overlay));
  }
  render() {
    const k = tokens();
    return v_flex().id("ht3-revert").size_full().p(14).gap(8).bg(k.popover).text_color(k.foreground).text_size(13)
      .track_focus(this.focus)
      .on_key_down((e, cx) => this.key(e.key.toLowerCase(), cx))
      .child(div().font_medium().text_size(14).child("Revert the files?"))
      .child(div().flex_1().text_color(k.muted).line_height("18px").child(`Every file goes back to how it was before "${this.p.label}". What is there now is kept as a checkpoint. The agent's memory is not rewound.`))
      .child(h_flex().gap(8).justify_end()
        .child(button(k, "revert-no", "Cancel", (cx) => this.key("escape", cx), { variant: "outline" }))
        .child(button(k, "revert-yes", this.busy ? "Reverting…" : "Revert", (cx) => this.key("enter", cx), { variant: "destructive" })));
  }
}

export class ProjectMenu {
  init(p, cx) {
    this.overlay = p.overlay;
    const space = activeSpace(), at = placeOf(space);
    this.space = space;
    // The folder's own machine: a pinned folder or a chat's may be on another one than the space.
    this.on = at.on ?? null;
    this.folder = at.cwd;
    this.root = null;
    this.machine = this.on ?? "This computer";
    this.editors = null;
    this.pick = null; // "editor" | "branch" | "scripts": the list that is open
    // The branch picker (BranchPicker.tsx): a filter over the local branches, then the remote-only ones, and a
    // "Create branch" row for what matches none (branches.js). `at` is the marked row.
    this.refs = null; // parseRefs
    this.worktrees = [];
    this.at = 0;
    this.listed = false;
    this.rowsNow = [];
    this.scroll = VirtualListScrollHandle.new();
    this.filter = InputState.new({ placeholder: "Search or create a branch…" });
    this.filter.on("change", (_e, cx) => { this.at = 0; this.scroll.scroll_to_item(0, "top"); cx.notify(); });
    this.branch = space?.branch ?? null;
    this.dirty = null;
    this.changes = null; // { add, del }: lines changed since the last commit
    this.github = false;
    this.error = null;
    this.busy = false;
    // Git actions (GitActionsControl.tsx): what the working tree and the branch are up to, and the step that is open.
    this.git = null; // { changed, ahead, behind, upstream, remote, base }
    this.step = null; // "commit" | "pr"
    this.note = null; // what the last action did
    // Stash and the merge-conflict helper (stash.js): each is a step that replaces the popover's rows (`view`).
    this.view = null; // "stash" | "conflict"
    this.stashes = null; // parseStashList, read with the status
    this.conflicts = null; // { op, files, active }: a merge, rebase or cherry-pick that stopped, or unmerged files
    this.confirm = null; // { kind: "drop", index } | { kind: "abort" }: the question that is open in a step
    this.offer = null; // { untracked }: a pull that local changes stopped, and "Stash and retry" answers it
    this.untracked = false;
    this.stashMsg = InputState.new({ placeholder: "Message (optional)" });
    // The message field takes a subject and a body (an agent writes both, gitwrite.js). Enter commits a message of
    // one line, as it did; in one with more lines Enter is a new line and only the Commit button commits.
    this.message = TextareaState.new({ placeholder: "Commit message (empty: one is made up)" });
    this.message.set_auto_grow(1, 8);
    this.message.on("change", (_e, cx) => cx.notify()); // the style warning under it follows what is typed
    this.message.on("submit", (e, cx) => { if (!e?.shift && !this.message.value().trim().includes("\n")) this.commit(cx); });
    // Create PR's text: typed, or written by an agent; left empty, gh makes both from the commits (--fill).
    this.prTitle = InputState.new({ placeholder: "Title (empty: from the commits)" });
    this.prBody = TextareaState.new({ placeholder: "Description (empty: from the commits)" });
    this.prBody.set_auto_grow(3, 6);
    this.writing = null; // { kind: "commit" | "pr", stop, was }: an agent is writing that text
    this.wrote = null; // { kind, text }: who wrote what is in the field, from what
    this.writeError = null; // { kind, text }: why nothing was written
    // The servers started from the folder (servers.js): counted once, for the Servers row.
    this.servers = null;
    this.detected = null; // { checks, dev, scripts } from the folder's package.json, Makefile, …
    if (this.folder) cx.spawn(async (cx) => { this.servers = await discover({ cwd: this.folder, on: this.on }).catch(() => null); cx.notify(); });
    cx.spawn(async (cx) => {
      if (!this.on) {
        const n = await exec("scutil", ["--get", "ComputerName"]).catch(() => null);
        if (n?.code === 0 && n.stdout.trim()) this.machine = n.stdout.trim();
        this.editors = await editors();
      } else this.editors = [];
      cx.notify();
      this.project = await projectOf(space).catch(() => null);
      cx.notify();
      // What the folder says it has (detect.js): the Run dev row's command.
      if (this.folder) { this.detected = await detectProject(this.folder, this.on).catch(() => null); cx.notify(); }
      if (this.folder) {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.folder, on: this.on }).catch(() => null);
        this.root = top?.code === 0 ? top.stdout.trim() : null;
        if (this.root) {
          const b = await exec("git", ["branch", "--show-current"], { cwd: this.root, on: this.on }).catch(() => null);
          this.branch = b?.stdout.trim() || this.branch;
          await this.loadChanges();
          const r = await exec("git", ["remote", "-v"], { cwd: this.root, on: this.on }).catch(() => null);
          this.github = /github/i.test(r?.stdout ?? "");
          await this.status();
          // A worktree made for a chat (<repo>/.worktrees/<branch>): its main checkout, for Remove worktree.
          const m = await exec("sh", ["-c", 'g=$(git rev-parse --path-format=absolute --git-dir) && c=$(git rev-parse --path-format=absolute --git-common-dir) && [ "$g" != "$c" ] && printf %s "${c%/.git}"'], { cwd: this.root, on: this.on }).catch(() => null);
          const main = m?.code === 0 ? m.stdout.trim() : "";
          this.main = main && this.root.startsWith(`${main}/.worktrees/`) ? main : null;
        }
      }
      cx.notify();
    });
  }

  // The lines changed since the branch left the default one, as the Changes row shows them (also after a pull or a switch).
  async loadChanges() {
    // As T3 counts them (GitVcsDriverCore readBranchChangeTotals): lines against the merge base with the default
    // branch, new files that aren't tracked yet included, through a throwaway index so the real one isn't touched.
    const count = 'b=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); m=; for c in "$b" origin/main origin/master main master; do [ -n "$c" ] && m=$(git merge-base HEAD "$c" 2>/dev/null) && [ -n "$m" ] && break; done; [ -n "$m" ] || m=HEAD; '
      + 'i=$(mktemp); cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null; GIT_INDEX_FILE="$i" git add -N . 2>/dev/null; GIT_INDEX_FILE="$i" git diff --numstat "$m" 2>/dev/null | awk \'{a+=$1;d+=$2} END{print a+0, d+0}\'; rm -f "$i"';
    const d = await exec("sh", ["-c", count], { cwd: this.root, on: this.on, timeout: 15000 }).catch(() => null);
    const [add, del] = (d?.stdout ?? "").trim().split(" ").map(Number);
    if (d?.code === 0 && Number.isFinite(add) && Number.isFinite(del)) this.changes = { add, del };
  }

  // Run dev: the project's dev command (a script named Dev, else package.json's dev or start, a Makefile or justfile's dev)
  // as a server (servers.js startDevServer). null while the folder is still being read, or says none.
  devNow() { return this.detected ? devCommand(scriptsOf(this.project?.key), this.detected.dev) : null; }
  runDev() {
    const dev = this.devNow();
    if (!dev || !this.project) return;
    closeOverlay(this.overlay);
    startDevServer(this.project, dev);
  }

  script(s) {
    if (!s) return;
    closeOverlay(this.overlay);
    runScript(this.project, s);
  }

  // Remove worktree, after its question: `git worktree remove` without --force, so one with changes that aren't
  // committed stays and git's reason shows. The branch is kept.
  removeWorktree(cx) {
    if (!this.main || !this.root) return;
    this.run(cx, async () => {
      const gone = this.root;
      await removeWorktreeFolder(exec, { main: this.main, folder: gone, on: this.on });
      this.note = `Removed the worktree ${shortPath(gone)}. Its branch${this.branch ? ` ${this.branch}` : ""} is kept.`;
      this.step = null;
      this.root = null;
      this.main = null;
      this.git = null;
      this.changes = null;
    });
  }
  close() { this.stopWriting(); }

  // "Write message" and "Write title and body": an agent writes the text of the open step from the changes
  // (gitwrite.js: the shown chat's agent on its model, else the default one from Settings; one question in a session
  // of its own, 60 seconds at most). The popover stays usable meanwhile and Cancel stops it. The text only goes into
  // the fields: Commit and Create stay the person's click. An error shows as one line and the fields keep what they had.
  write(cx, kind) {
    if (this.writing || !this.root) return;
    const fields = kind === "pr" ? [this.prTitle, this.prBody] : [this.message];
    let stop;
    const cancel = new Promise((ok) => { stop = ok; });
    const job = this.writing = { kind, stop, was: fields.map((f) => f.value()) };
    this.wrote = null;
    this.writeError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await write(kind, { cwd: this.root, on: this.on, branch: this.branch, base: this.git?.base ?? null },
          { cancel, after: (ms) => new Promise((ok) => cx.timer.after(ms, () => ok())) });
        if (this.writing !== job) return;
        // Typed into while the agent wrote: what the person typed stays.
        if (fields.some((f, i) => f.value() !== job.was[i])) this.writeError = { kind, text: "You changed the text while the agent wrote, so yours was kept. Write again to replace it." };
        else {
          (kind === "pr" ? [r.title, r.body] : [r.message]).forEach((text, i) => fields[i].set_value(text));
          this.wrote = { kind, text: wroteLine(kind, r, this.on) };
        }
      } catch (e) {
        if (this.writing !== job) return;
        if (!(e instanceof Cancelled)) this.writeError = { kind, text: String(e?.message ?? e).slice(0, 260) };
      }
      this.writing = null;
      cx.notify();
    });
  }

  stopWriting(cx = null) {
    const w = this.writing;
    if (!w) return;
    this.writing = null;
    w.stop();
    cx?.notify();
  }

  // `ht3-panels.open:<editor id>` opens the folder in that editor, as its row does, for scripts.
  // `git:commit` (opens the message field), `git:commit:<message>` (commits with it), `git:push`, `git:pr` (shows the
  // command Create PR would run; only its button runs it). `git:write:commit` and `git:write:pr` open that step and
  // have an agent write its text, `git:write:stop` cancels it; `git:title:<text>` and `git:body:<text>` fill Create
  // PR's fields.
  command(c, cx) {
    if (c === "git:write:stop") return this.stopWriting(cx);
    if (c === "git:write:commit" || c === "git:write:pr") { this.step = c.slice(10); return this.write(cx, this.step) ?? cx.notify(); }
    if (c.startsWith("git:title:")) { this.prTitle.set_value(c.slice(10)); return cx.notify(); }
    if (c.startsWith("git:body:")) { this.prBody.set_value(c.slice(9)); return cx.notify(); }
    if (c === "git:commit") { this.step = this.step === "commit" ? null : "commit"; this.message.focus(); return cx.notify(); }
    if (c.startsWith("git:commit:")) { this.message.set_value(c.slice(11)); return this.commit(cx); }
    if (c === "git:push") return this.push(cx);
    // git:pull pulls (`git pull --ff-only`). branches opens the branch picker (again: closes it), branch:filter:<text>
    // types in its filter, branch:<name> switches to that branch (a remote-only one tracked), branch:new:<name> creates
    // it, key:<up|down|enter|escape> presses a key in the picker.
    if (c === "git:pull") return this.pull(cx);
    // stash opens the Stash step (again: back), stash:push[:<message>] stashes (stash:push-u: untracked files too),
    // stash:apply:<n>, stash:pop:<n>, stash:drop:<n> (drops at once), stash:show:<n>; conflicts opens the conflict helper;
    // conflict:ours:<file>, conflict:theirs:<file>, conflict:resolved:<file>, conflict:continue, conflict:abort (asks, then
    // conflict:abort again does it); retry stashes, pulls and pops (the "Stash and retry" button).
    if (c === "stash" || c === "conflicts") { const v = c === "stash" ? "stash" : "conflict"; this.view = this.view === v ? null : v; this.confirm = null; return cx.notify(); }
    if (c.startsWith("stash:push")) { this.view = "stash"; this.untracked = c.startsWith("stash:push-u"); this.stashMsg.set_value(c.replace(/^stash:push(-u)?:?/, "")); return this.run(cx, () => this.stashAct("push")); }
    if (/^stash:(apply|pop|drop|show):\d+$/.test(c)) {
      const [, verb, n] = c.split(":"), s = (this.stashes ?? []).find((x) => x.index === Number(n));
      this.view = "stash";
      if (!s) return cx.notify();
      return verb === "show" ? showStash(this, cx, s) : this.run(cx, () => this.stashAct(verb, s));
    }
    if (c.startsWith("conflict:")) {
      this.view = "conflict";
      const [, how, ...rest] = c.split(":"), file = rest.join(":");
      if (how === "ours" || how === "theirs" || how === "resolved") return this.run(cx, () => this.conflictAct(how, file));
      if (how === "continue") return this.run(cx, () => this.continueAct());
      if (how === "abort") { if (this.confirm?.kind === "abort") return this.run(cx, () => this.abortAct()); this.confirm = { kind: "abort" }; return cx.notify(); }
    }
    if (c === "retry") return this.offer ? this.stashAndRetry(cx) : undefined;
    if (c === "branches") return this.toggleBranches(cx);
    if (c.startsWith("branch:filter:")) { if (this.pick !== "branch") this.toggleBranches(cx); this.filter.set_value(c.slice(14)); this.at = 0; return cx.notify(); }
    if (c.startsWith("branch:new:")) return this.choose(cx, { kind: "create", name: c.slice(11), current: false, elsewhere: null });
    if (c.startsWith("branch:") && this.root) {
      const name = c.slice(7), pickIt = (cx) => this.choose(cx, pickerRows({ refs: this.refs, worktrees: this.worktrees, root: this.root, query: name }).find((r) => r.kind !== "create" && (r.name === name || r.ref === name)));
      if (this.refs) return pickIt(cx);
      return cx.spawn(async (cx) => {
        try { const r = await readBranches({ cwd: this.root, on: this.on }); this.refs = r.refs; this.worktrees = r.worktrees; pickIt(cx); } catch (e) { this.error = String(e?.message ?? e); cx.notify(); }
      });
    }
    if (c.startsWith("key:") && this.pick === "branch") return this.branchKey(c.slice(4), cx);
    if (c === "git:pr") { this.step = this.step === "pr" ? null : "pr"; return cx.notify(); }
    // scripts opens the project's scripts, script:<n> runs the nth (from 0).
    // dev runs the dev command as a server (the Run dev row).
    if (c === "dev") return this.runDev();
    if (c === "scripts") { this.pick = this.pick === "scripts" ? null : "scripts"; return cx.notify(); }
    if (c.startsWith("script:")) return this.script(scriptsOf(this.project?.key)[Number(c.slice(7))]);
    // wt:remove asks (the Remove worktree row), wt:yes removes it, wt:no takes the question away.
    if (c === "wt:remove") { if (this.main) this.step = this.step === "wt" ? null : "wt"; return cx.notify(); }
    if (c === "wt:no") { this.step = null; return cx.notify(); }
    if (c === "wt:yes") return this.step === "wt" ? this.removeWorktree(cx) : null;
    if (!c.startsWith("open:") || this.on || !this.folder) return;
    const ed = (this.editors ?? []).find((e) => e.id === c.slice(5) && editorOn(e.id));
    if (!ed) return;
    closeOverlay(this.overlay);
    openIn(ed, this.folder).catch(() => {});
  }

  run(cx, fn) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.offer = null;
    cx.spawn(async (cx) => {
      try { await fn(); } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      cx.notify();
    });
  }

  // What Commit, Push and Create PR go by: `git status --porcelain=v2 --branch`, the first remote, the default branch.
  async status() {
    const opt = { cwd: this.root, on: this.on };
    const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], opt).catch(() => null);
    if (r?.code !== 0) { this.git = null; await this.repoState(); return; }
    const lines = r.stdout.split("\n"), head = (key) => lines.find((l) => l.startsWith(`# branch.${key} `))?.slice(10 + key.length) ?? null;
    const ab = /\+(\d+) -(\d+)/.exec(head("ab") ?? "");
    const remotes = (await exec("git", ["remote"], opt).catch(() => null))?.stdout.split("\n").filter(Boolean) ?? [];
    const base = (await exec("sh", ["-c", "git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||'; true"], opt).catch(() => null))?.stdout.trim() || null;
    const files = lines.filter((l) => l && !l.startsWith("#"));
    const upstream = head("upstream");
    // Without an upstream every commit not on a remote yet counts as ahead.
    let ahead = ab ? Number(ab[1]) : 0;
    if (!upstream && remotes.length) ahead = Number((await exec("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], opt).catch(() => null))?.stdout.trim() || 0);
    this.git = { changed: files.length, names: files.slice(0, 3).map((l) => l.split(/\s+/).pop().split("/").pop()), ahead, behind: ab ? Number(ab[2]) : 0, upstream, remote: remotes.includes("origin") ? "origin" : remotes[0] ?? null, base, detached: head("head") === "(detached)" };
    await this.repoState();
  }

  // The stashes and whether a merge, rebase or cherry-pick stopped (stash.js), read with the status.
  async repoState() {
    const o = { cwd: this.root, on: this.on };
    const [s, c] = await Promise.all([readStashes(o).catch(() => null), readConflicts(o).catch(() => null)]);
    if (s) this.stashes = s;
    if (c) this.conflicts = c;
    if (this.view === "conflict" && !this.conflicts?.active) this.view = null;
  }

  // Everything the popover shows about the repository, read again (a step's refresh).
  async refreshAll() {
    await this.status();
    await this.loadChanges();
  }

  // Stash changes (the step's field and -u toggle), and Apply, Pop and Drop of one stash. A pop or apply that leaves
  // conflicts goes to the conflict helper.
  async stashAct(verb, s) {
    const o = { cwd: this.root, on: this.on };
    this.note = null;
    if (verb === "push") {
      const r = await stashPush(o, { message: this.stashMsg.value(), untracked: this.untracked });
      this.note = r.created ? "Stashed the changes" : "Nothing to stash";
      this.stashMsg.set_value("");
    } else {
      const r = await stashRun(o, verb, s.index);
      this.confirm = null;
      this.note = verb === "drop" ? `Dropped ${s.ref}` : r.conflict ? `Applied ${s.ref} with conflicts. The stash is kept.` : verb === "pop" ? `Popped ${s.ref}` : `Applied ${s.ref}`;
      if (r.conflict) this.view = "conflict";
    }
    await this.refreshAll();
    if (this.view === "conflict" && !this.conflicts?.active) this.view = "stash";
  }

  // Take ours, Take theirs and Mark resolved of one file.
  async conflictAct(how, file) {
    const o = { cwd: this.root, on: this.on };
    this.note = null;
    if (how === "resolved") await markResolved(o, file); else await takeSide(o, file, how);
    this.note = how === "resolved" ? `Marked ${file} resolved` : `Took ${how} for ${file}`;
    await this.refreshAll();
  }

  // Continue and Abort (Abort after its question).
  async continueAct() {
    const op = this.conflicts?.op;
    const r = await continueOp({ cwd: this.root, on: this.on }, op);
    this.note = r.more ? `Stopped again: ${r.message}` : `${op} continued`;
    await this.refreshAll();
    if (!this.conflicts?.active) this.view = null;
  }
  async abortAct() {
    const op = this.conflicts?.op;
    await abortOp({ cwd: this.root, on: this.on }, op);
    this.note = `Aborted the ${op}`;
    this.confirm = null;
    this.changes = null;
    await this.refreshAll();
    if (!this.conflicts?.active) this.view = null;
  }

  // Open: the Files editor shows the file (the keeper's goto:, as a Search hit does), and the popover goes.
  openConflict(file) {
    if (!this.root || this.on) return;
    closeOverlay(this.overlay);
    run(`${MOD}.goto:0:${this.root}/${file}`);
  }

  // "Stash and retry" under a pull that local changes stopped: stash, pull, pop. A pop that conflicts opens the helper.
  stashAndRetry(cx) {
    const untracked = !!this.offer?.untracked;
    this.run(cx, async () => {
      const r = await stashAndPull({ cwd: this.root, on: this.on }, { untracked });
      this.note = r.note;
      this.changes = null;
      await this.refreshAll();
      if (r.conflict && this.conflicts?.active) this.view = "conflict";
    });
  }

  // Commit: everything that changed (`git add -A`), with the message typed or one made from the file names.
  commit(cx) {
    const g = this.git;
    if (!g?.changed) return;
    const typed = this.message.value().trim();
    const message = typed || (g.changed === 1 ? `Update ${g.names[0]}` : `Update ${g.changed} files`);
    if (this.writing?.kind === "commit") this.stopWriting();
    this.run(cx, async () => {
      const opt = { cwd: this.root, on: this.on };
      if (await holdForSecrets(this, opt)) return; // secretguard.js: the warning shows, Commit anyway comes back here
      const a = await exec("git", ["add", "-A"], opt);
      if (a.code !== 0) throw new Error(a.stderr.trim().split("\n").pop() || "git add failed");
      const r = await exec("git", ["commit", "-m", message], opt);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "git commit failed");
      const sha = (await exec("git", ["rev-parse", "--short", "HEAD"], opt)).stdout.trim();
      this.note = `Committed ${sha}: ${message.split("\n")[0]}`;
      this.step = null;
      this.message.set_value("");
      this.wrote = this.writeError = null;
      this.changes = null;
      await this.status();
    });
  }

  // The push Push runs: to the branch's upstream, or, without one, `-u <remote> <branch>`.
  pushArgs() {
    const g = this.git;
    return g?.upstream ? ["push"] : ["push", "-u", g?.remote ?? "origin", this.branch];
  }

  push(cx) {
    const g = this.git;
    if (!g?.remote || !this.branch || g.detached || g.behind > 0 || !(g.ahead > 0 || !g.upstream)) return;
    this.run(cx, async () => {
      const opt = { cwd: this.root, on: this.on, timeout: 120000 };
      const r = await exec("git", this.pushArgs(), opt);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "git push failed");
      this.note = `Pushed ${this.branch} to ${g.upstream ? g.upstream.split("/")[0] : g.remote}`;
      await this.status();
    });
  }

  // The text Create PR passes to gh: the title and description in the fields; an empty title (or both empty)
  // leaves it to `--fill`, which makes them from the branch's commits.
  prText() {
    const title = this.prTitle.value().trim().split("\n")[0], body = this.prBody.value().trim();
    return title ? ["--title", title, "--body", body] : body ? ["--fill", "--body", body] : ["--fill"];
  }

  // What Create PR runs, shown before it does: the branch is pushed first if it has no upstream, then
  // `gh pr create` makes the pull request with the text above it (the description is named, not repeated).
  prCommand() {
    const g = this.git, push = !g?.upstream || g.ahead > 0 ? `git ${this.pushArgs().join(" ")} && ` : "";
    const q = (t) => `'${t.replace(/'/g, `'\\''`)}'`, lines = this.prBody.value().trim().split("\n").length;
    const text = this.prText().map((a, i, all) => (all[i - 1] === "--title" ? q(a) : all[i - 1] === "--body" ? (a ? `<the description, ${lines} line${lines === 1 ? "" : "s"}>` : "''") : a)).join(" ");
    return `${push}gh pr create ${text} --head ${this.branch}${g?.base ? ` --base ${g.base}` : ""}`;
  }

  createPr(cx) {
    const g = this.git;
    if (!g || !this.github || !this.branch || this.branch === g.base) return;
    if (this.writing?.kind === "pr") this.stopWriting();
    const text = this.prText();
    this.run(cx, async () => {
      const opt = { cwd: this.root, on: this.on, timeout: 120000 };
      if (!g.upstream || g.ahead > 0) {
        const p = await exec("git", this.pushArgs(), opt);
        if (p.code !== 0) throw new Error((p.stderr || p.stdout).trim().split("\n").slice(-2).join(" ") || "git push failed");
      }
      const r = await exec("gh", ["pr", "create", ...text, "--head", this.branch, ...(g.base ? ["--base", g.base] : [])], opt);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "gh pr create failed");
      this.note = `Pull request created: ${r.stdout.trim().split("\n").pop()}`;
      this.step = null;
      this.prTitle.set_value("");
      this.prBody.set_value("");
      this.wrote = this.writeError = null;
      await this.status();
    });
  }

  // Pull (GitActionsControl.tsx): `git pull --ff-only`, where the folder is. Never a merge or a rebase: a branch that has
  // moved on as well says so with git's message, and nothing changes. What it did shows in plain words.
  pull(cx) {
    const g = this.git;
    if (!g?.upstream || g.detached) return;
    this.note = null;
    this.run(cx, async () => {
      try { this.note = await pullFastForward({ cwd: this.root, on: this.on }); } catch (e) {
        if (e?.localChanges) this.offer = { untracked: !!e.untracked };
        throw e;
      }
      this.changes = null;
      await this.status();
      await this.loadChanges();
    });
  }

  // The branch picker: its step opens under the branch row with the filter focused, and reads the branches again each time.
  toggleBranches(cx) {
    this.pick = this.pick === "branch" ? null : "branch";
    if (this.pick !== "branch") return cx.notify();
    this.filter.set_value("");
    this.at = 0;
    this.note = null;
    this.error = null;
    this.filter.focus();
    if (!this.root) return cx.notify();
    this.run(cx, async () => {
      const r = await readBranches({ cwd: this.root, on: this.on });
      this.refs = r.refs;
      this.worktrees = r.worktrees;
      this.listed = true;
    });
  }

  // The rows the filter leaves.
  branchRows() {
    return this.refs ? pickerRows({ refs: this.refs, worktrees: this.worktrees, root: this.root, query: this.filter.value() }) : [];
  }

  // A chat's tab working in a worktree folder: where the "Open chat" of a branch checked out there goes.
  chatAt(folder) {
    const progs = shared(`${MOD}.programs`) ?? {}, tabs = new Set(spaces().flatMap((sp) => sp.tabs.map((t) => t.id)));
    const tab = Object.keys(progs).find((t) => tabs.has(t) && progs[t]?.cwd === folder && (progs[t].machine ?? null) === (this.on ?? null));
    return tab ?? null;
  }

  // Enter or a click on a row: the current branch just closes the step; one checked out in another worktree can't be
  // switched to (git refuses), so the reason shows; the rest switch, remote ones tracked, a new name created.
  choose(cx, row) {
    if (!row || this.busy) return;
    if (row.current) { this.pick = null; return cx.notify(); }
    const why = rowBlocked(row);
    if (why) { this.error = `${row.name} is ${why}. Open a chat there, or switch that worktree away first.`; return cx.notify(); }
    this.note = null;
    this.run(cx, async () => {
      this.note = await switchRow({ cwd: this.root, on: this.on }, row);
      this.branch = row.name;
      this.pick = null;
      // Commit, Push, Pull and Create PR go by the branch that is checked out now.
      this.changes = null;
      await this.status();
      await this.loadChanges();
      this.refs = null;
    });
  }

  // Keys in the step: up, down, Enter, Esc. `ht3-panels.key:<up|down|enter|escape>` for scripts.
  branchKey(key, cx) {
    const rows = this.rowsNow = this.branchRows();
    if (key === "escape") { this.pick = null; return cx.notify(); }
    if (key === "enter") return this.choose(cx, rows[this.at]);
    if (key === "up" || key === "down") {
      if (!rows.length) return;
      this.at = (this.at + (key === "down" ? 1 : -1) + rows.length) % rows.length;
      this.scroll.scroll_to_item(this.at, "center");
      cx.notify();
    }
  }

  // The branch picker's step (BranchPicker.tsx): the filter, then the list: local branches (the current one marked, the
  // newest commit first), the remote-only ones, and "Create branch <name>" first when what is typed matches none.
  branchStep(k) {
    const rows = this.rowsNow = this.branchRows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const ROW = 28, shown = rows.slice(0, 300);
    const keyOf = (r) => `${r.kind}:${r.ref ?? r.name}`;
    const item = (r, i) => {
      const why = rowBlocked(r), chat = r.elsewhere ? this.chatAt(r.elsewhere) : null, on = this.at === i;
      const glyph = r.kind === "create" ? "git-branch-plus" : r.kind === "remote" ? "globe" : "git-branch";
      const dim = (e) => (why ? e.opacity(0.5) : e);
      let el = h_flex().id(`br-${keyOf(r)}`).h(ROW).px(8).gap(8).items_center().rounded(6).text_size(13).bg(on ? k.accent : "#00000000").cursor_pointer()
        .child(dim(icon(glyph).size(14).flex_none().text_color(k.muted)))
        .child(dim(div().flex_1().min_w(0).truncate().child(r.kind === "create" ? `Create branch ${r.name}` : r.kind === "remote" ? r.ref : r.name)));
      if (r.current) el = el.child(icon("check").size(14).flex_none().text_color(k.muted));
      else if (r.kind === "remote") el = el.child(div().flex_none().text_size(11).text_color(k.muted).child("remote"));
      else if (r.elsewhere) {
        el = el.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(k.muted).child(`worktree ${shortPath(r.elsewhere)}`));
        if (chat) el = el.child(button(k, `br-chat-${r.name}`, "Open chat", () => { closeOverlay(this.overlay); run("tab.select", { id: chat }); }, { variant: "ghost-muted" }));
      }
      return why ? el.tooltip(`${r.name} is ${why}`) : el;
    };
    return v_flex().id("ht3-branch-step").mx(4).mb(4).gap(4)
      .child(div().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(13).child(Input.new(this.filter)))
      .child(!this.refs && !this.error ? div().px(8).py(6).text_size(12).text_color(k.muted).child("Loading branches…")
        : !rows.length ? div().px(8).py(6).text_size(12).text_color(k.muted).child(this.root ? "No branches match." : "Not a git repository.")
        : v_flex().relative().h(Math.min(rows.length, 8) * ROW).flex_none()
          .child(v_virtual_list("ht3-branch-list", shown.length, ROW, (i) => keyOf(shown[i]),
            (range) => shown.slice(range.start, range.end).map((r, j) => item(r, range.start + j)))
            .track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => { const i = shown.findIndex((r) => keyOf(r) === key); if (i >= 0) { this.at = i; this.choose(cx, shown[i]); } }))
          .child(Scrollbar.vertical("ht3-branch-list").absolute().inset_0()))
      .when(!!this.error, (e) => e.child(div().px(8).text_size(12).line_height("16px").text_color(k.destructiveText).child(this.error)));
  }

  render(_cx) {
    const k = tokens();
    // Stash and the conflict helper replace the rows (stash.js).
    if (this.view === "stash") return stashView(this, k);
    if (this.view === "conflict") return conflictView(this, k);
    const row = (id, glyph, label, { detail = null, onClick = null, trail = null, on = false, picture = null } = {}) => {
      let el = h_flex().id(id).h(32).px(8).gap(8).flex_none().items_center().rounded(8).text_size(14).bg(on ? k.accent : "#00000000")
        .child(picture ? image(picture).w(16).h(16).flex_none() : icon(glyph).size(16).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(!!detail, (e) => e.child(div().flex_none().max_w(140).truncate().text_size(12).text_color(k.muted).child(detail)));
      if (trail) el = el.child(trail);
      return onClick ? el.role("button").accessibility_label(label).cursor_pointer().hover((s) => s.bg(k.accent)).on_click((_e, cx) => onClick(cx)) : el;
    };
    const local = !this.on;
    // Settings chooses which of the installed editors are listed (settings.js).
    const eds = this.editors ? this.editors.filter((e) => editorOn(e.id)) : null;
    const first = eds?.[0] ?? null;
    const list = (items) => v_flex().id(`ht3-list-${this.pick}`).max_h(180).overflow_y_scrollbar().pl(8).children(items);
    const sub = (id, label, active, onClick, picture = null) => h_flex().id(id).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
      .role("button").accessibility_label(label).hover((s) => s.bg(k.accent)).on_click((_e, cx) => onClick(cx))
      .when(!!picture, (e) => e.child(image(picture).w(16).h(16).flex_none()))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(active, (e) => e.child(icon("check").size(14).flex_none().text_color(k.muted)));
    return v_flex().id("ht3-project").size_full().p(4).bg(k.popover).text_color(k.foreground).text_size(14).overflow_hidden()
      // In the branch picker the arrows, Enter and Esc go to its list while the filter keeps the typing.
      .on_key_down((e, cx) => {
        if (this.pick !== "branch" || e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
        const key = String(e.key ?? "").toLowerCase();
        if (["up", "down", "enter", "escape"].includes(key)) { this.branchKey(key, cx); cx.stop_propagation?.(); }
      })
      .child(row("proj-machine", "monitor", this.machine, {
        detail: this.folder ? shortPath(this.folder) : null,
        trail: local && this.folder ? iconButton(k, "proj-folder", "folder-open", (cx) => { closeOverlay(this.overlay); exec("open", [this.folder]).catch(() => {}); }, { tip: "Show the folder in Finder" }) : null,
      }))
      .when(local && !!this.folder, (el) => el
        .child(row("proj-editor", first ? "code-xml" : "folder-open", first ? `Open in ${first.name}` : "Open in Finder", {
          picture: first?.icon ?? null,
          onClick: (cx) => { closeOverlay(this.overlay); openIn(first, this.folder).catch(() => {}); },
          trail: eds && eds.length > 0 ? iconButton(k, "proj-editor-more", this.pick === "editor" ? "chevron-up" : "chevron-down", (cx) => { this.pick = this.pick === "editor" ? null : "editor"; cx.notify(); }, { tip: "Other editors" }) : null,
        }))
        .when(this.pick === "editor", (e) => e.child(list([...(eds ?? []).map((ed) => sub(`ed-${ed.id}`, ed.name, false, () => { closeOverlay(this.overlay); openIn(ed, this.folder).catch(() => {}); }, ed.icon ?? null)),
          sub("ed-finder", "Finder", false, () => { closeOverlay(this.overlay); openIn(null, this.folder).catch(() => {}); })]))))
      .when(!local, (el) => el.child(div().px(8).py(4).text_size(12).text_color(k.muted).child("Editors open folders on this computer only; this space lives on " + this.on + ".")))
      .child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
      .child(this.root || this.branch
        ? row("proj-branch", "git-branch", this.branch ?? "No branch", {
          onClick: (cx) => this.toggleBranches(cx),
          on: this.pick === "branch",
          trail: icon(this.pick === "branch" ? "chevron-up" : "chevron-down").size(14).flex_none().text_color(k.muted),
        })
        : row("proj-nobranch", "git-branch", "Not a git repository"))
      .when(this.pick === "branch", (el) => el.child(this.branchStep(k)))
      // A merge, rebase or cherry-pick that stopped, or unmerged files: the row opens the conflict helper.
      .when(!!this.root && !!this.conflicts?.active, (el) => {
        const cr = conflictRow(this.conflicts);
        return el.child(row("proj-conflict", "triangle-alert", cr.label, { detail: cr.detail, onClick: (cx) => { this.view = "conflict"; this.confirm = null; this.note = null; this.error = null; cx.notify(); },
          trail: icon("chevron-right").size(14).flex_none().text_color(k.muted) }).bg(alpha(k.warning, k.dark ? 0.16 : 0.1)).text_color(k.warningText));
      })
      // T3's card ends with the pull request and the changes; here they open the panel's surfaces.
      .when(!!this.root && this.github, (el) => el.child(row("proj-pr", "git-pull-request", "Pull request", {
        onClick: () => { closeOverlay(this.overlay); send("add:pr:a"); },
        trail: icon("chevron-right").size(14).flex_none().text_color(k.muted),
      })))
      .when(!!this.root && !!this.changes, (el) => el.child(row("proj-changes", "file-diff", "Changes", {
        onClick: () => { closeOverlay(this.overlay); send("add:diff:a"); send("scope:branch"); },
        trail: h_flex().gap(6).flex_none().text_size(12).font_family(k.mono)
          .child(div().text_color(k.successText).child(`+${this.changes.add}`)).child(div().text_color(k.destructiveText).child(`\u2212${this.changes.del}`)),
      })))
      // GitActionsControl.tsx: Commit, Push, Create PR, each greyed while it has nothing to do.
      .when(!!this.root && !!this.git, (el) => {
        const g = this.git, n = (c, w) => `${c} ${w}${c === 1 ? "" : "s"}`;
        const canPush = !!g.remote && !!this.branch && !g.detached && g.behind === 0 && (g.ahead > 0 || !g.upstream);
        const canPr = this.github && !!this.branch && !g.detached && this.branch !== g.base && g.behind === 0;
        const act = (id, glyph, label, can, detail, onClick, on, trail = null) => {
          const r = row(id, glyph, label, { detail, on, onClick: can && !this.busy ? onClick : null, trail });
          return can ? r : r.opacity(0.5);
        };
        const canPull = !!g.upstream && !g.detached;
        // The agent's part of a step: its button, or "Writing…" with Cancel while it runs, and under it who wrote
        // the text or why none was written.
        const writer = (kind, label) => (this.writing?.kind === kind
          ? h_flex().gap(6).items_center().child(icon("sparkles").size(14).flex_none().text_color(k.muted)).child(div().text_size(12).text_color(k.muted).child("Writing…"))
            .child(button(k, "git-write-stop", "Cancel", (cx) => this.stopWriting(cx), { variant: "ghost-muted" }))
          : button(k, `git-write-${kind}`, label, (cx) => this.write(cx, kind), { glyph: "sparkles", disabled: !!this.writing, tip: "An agent writes it from the changes. Nothing is committed or sent." }));
        const wrote = (kind) => (e) => e
          .when(this.wrote?.kind === kind, (x) => x.child(div().text_size(11).line_height("15px").text_color(k.muted).child(this.wrote.text)))
          .when(this.writeError?.kind === kind, (x) => x.child(div().text_size(11).line_height("15px").text_color(k.destructiveText).child(this.writeError.text)));
        const field = (el) => div().min_w(0).px(8).py(3).rounded(6).border(1).border_color(k.input).text_size(13).child(el);
        return el.child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
          .child(act("git-commit", "check", "Commit", g.changed > 0, g.changed ? n(g.changed, "file") : "nothing to commit", (cx) => { this.step = this.step === "commit" ? null : "commit"; this.message.focus(); cx.notify(); }, this.step === "commit"))
          .when(this.step === "commit" && g.changed > 0, (e) => e.child(wrote("commit")(v_flex().mx(8).my(4).gap(6)
            .child(field(Textarea.new(this.message)))
            // Style "conventional": a first line that isn't type(scope): subject is warned about, not stopped.
            .when(commitStyle() === "conventional" && !!conventionalIssue(this.message.value()), (x) => x.child(div().text_size(11).line_height("15px").text_color(k.warningText).child(conventionalIssue(this.message.value()))))
            .child(h_flex().gap(6).items_center()
              .child(writer("commit", "Write message"))
              .child(div().flex_1())
              .child(button(k, "git-commit-go", this.busy ? "…" : "Commit", (cx) => this.commit(cx)))))))
          .when(this.step === "commit" && !!this.guard, (e) => e.child(guardStep(k, this)))
          // Pull is there while the branch has an upstream; when Push says it is behind, Pull is offered right in its row too.
          .when(canPull, (e) => e.child(act("git-pull", "arrow-down", "Pull", !this.busy, g.behind > 0 ? `${g.behind} behind` : "fast-forward only", (cx) => this.pull(cx), false)))
          .child(act("git-push", "arrow-up", "Push", canPush, g.behind > 0 ? `${g.behind} behind: pull first` : !g.remote ? "no remote" : g.ahead > 0 ? `${n(g.ahead, "commit")} ahead` : !g.upstream ? "no upstream yet" : "up to date", (cx) => this.push(cx), false,
            g.behind > 0 && canPull ? button(k, "git-push-pull", "Pull", (cx) => this.pull(cx), { variant: "outline", disabled: this.busy }) : null))
          .child(act("git-stash", "archive", "Stash", true, this.stashes?.length ? n(this.stashes.length, "stash") : g.changed > 0 ? "put changes away" : "none", (cx) => { this.view = "stash"; this.confirm = null; this.note = null; this.error = null; cx.notify(); }, false,
            icon("chevron-right").size(14).flex_none().text_color(k.muted)))
          .child(act("git-pr", "git-pull-request-arrow", "Create PR", canPr, !this.github ? "no GitHub remote" : this.branch === g.base ? `on ${g.base}` : null, (cx) => { this.step = this.step === "pr" ? null : "pr"; cx.notify(); }, this.step === "pr"))
          .when(this.step === "pr" && canPr, (e) => e.child(v_flex().mx(8).my(4).gap(6)
            .child(div().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(13).child(Input.new(this.prTitle)))
            .child(field(Textarea.new(this.prBody)))
            .child(wrote("pr")(v_flex().gap(6).child(h_flex().child(writer("pr", "Write title and body")))))
            .child(div().p(8).rounded(6).bg(k.background).border(1).border_color(k.border).font_family(k.mono).text_size(11).line_height("16px").text_color(k.muted).child(this.prCommand()))
            .child(h_flex().justify_end().gap(6)
              .child(button(k, "git-pr-no", "Cancel", (cx) => { this.step = null; cx.notify(); }, { variant: "outline" }))
              .child(button(k, "git-pr-go", this.busy ? "…" : "Create", (cx) => this.createPr(cx))))));
      })
      // The project's scripts (scripts.js): each runs in a new side terminal. Greyed while the project has none.
      .when(!!this.project, (el) => {
        const list = scriptsOf(this.project.key);
        const head = row("proj-scripts", "square-terminal", "Scripts", { on: this.pick === "scripts", detail: list.length ? `${list.length} for ${this.project.name}` : "none yet: add them in Settings",
          onClick: list.length ? (cx) => { this.pick = this.pick === "scripts" ? null : "scripts"; cx.notify(); } : null,
          trail: list.length ? icon(this.pick === "scripts" ? "chevron-up" : "chevron-down").size(14).flex_none().text_color(k.muted) : null });
        return el.child(div().mx(4).my(4).h(1).flex_none().bg(k.border)).child(list.length ? head : head.opacity(0.5))
          .when(this.pick === "scripts" && list.length > 0, (e) => e.child(list.map((s, i) => h_flex().id(`script-${i}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
            .role("button").accessibility_label(`Run ${s.name}`).hover((st) => st.bg(k.accent)).on_click(() => this.script(s))
            .child(icon("play").size(12).flex_none().text_color(k.muted))
            .child(div().flex_none().max_w(120).truncate().child(s.name))
            .when(!!s.setup, (e) => e.child(badge(k, "setup", "info")))
            .child(div().flex_1().min_w(0).truncate().text_size(11).font_family(k.mono).text_color(k.muted).child(s.command))).reduce((box, r) => box.child(r), v_flex().id("ht3-list-scripts").max_h(180).overflow_y_scrollbar().pl(8))));
      })
      // A chat's worktree: removed only from here, and only after its question.
      .when(!!this.main, (el) => el
        .child(row("wt-remove", "trash-2", "Remove worktree…", { detail: shortPath(this.root), on: this.step === "wt", onClick: this.busy ? null : (cx) => { this.step = this.step === "wt" ? null : "wt"; cx.notify(); } }))
        .when(this.step === "wt", (e) => e.child(v_flex().mx(8).my(4).gap(6)
          .child(div().text_size(12).line_height("16px").text_color(k.muted).child(`Remove the folder ${shortPath(this.root)}? Its branch${this.branch ? ` ${this.branch}` : ""} is kept; a chat working there loses its folder. Changes that aren't committed stop it.`))
          .child(h_flex().justify_end().gap(6)
            .child(button(k, "wt-no", "Cancel", (cx) => { this.step = null; cx.notify(); }, { variant: "outline" }))
            .child(button(k, "wt-yes", this.busy ? "…" : "Remove", (cx) => this.removeWorktree(cx), { variant: "destructive" }))))))
      .when(!!this.note, (el) => el.child(div().px(8).py(6).text_size(12).line_height("16px").text_color(k.successText).child(this.note)))
      .when(!!this.error && this.pick !== "branch", (el) => el.child(div().px(8).py(6).text_size(12).line_height("16px").text_color(k.destructiveText).child(this.error)))
      // A pull that local changes stopped: stash them, pull, pop (stash.js stashAndPull).
      .when(!!this.offer, (el) => el.child(h_flex().px(8).pb(4).child(button(k, "git-stash-retry", "Stash and retry", (cx) => this.stashAndRetry(cx),
        { variant: "default", glyph: "archive", disabled: this.busy, tip: "Stash your changes, pull, then pop them back" }))))
      .child(div().flex_1())
      .child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
      // Run dev (servers.js startDevServer) and the Checks surface (checks.js).
      .when(!!this.project, (el) => {
        const dev = this.devNow();
        const r = row("proj-dev", "play", "Run dev", { detail: this.detected == null ? null : dev ? dev.command : "no dev script found: name a script Dev in Settings", onClick: dev ? () => this.runDev() : null });
        return el.child(dev ? r : r.opacity(0.5));
      })
      .when(!!this.folder, (el) => el.child(row("proj-checks", "list-checks", "Checks", { detail: this.detected == null ? null : this.detected.checks.length ? `${this.detected.checks.length} found` : "tests, types, lint, build",
        onClick: () => { closeOverlay(this.overlay); run(`${MOD}.checks`); } })))
      // The servers started from this folder (servers.js): the row opens their dialog.
      .when(!!this.folder, (el) => el.child(row("proj-servers", "server", "Servers", { detail: this.servers == null ? null : this.servers.length ? this.servers.map((s) => `:${s.port}`).join(" ") : "none running",
        onClick: () => { closeOverlay(this.overlay); run(`${MOD}.servers`); } })))
      // Compare chats (compare.js): two chats' work side by side, to keep one.
      .child(row("proj-compare", "columns-2", "Compare chats", { detail: "two worktrees, pick one", onClick: () => { closeOverlay(this.overlay); run(`${MOD}.compare`); } }))
      .child(row("proj-settings", "settings-2", "Settings", { detail: "Agents, models, editors", onClick: () => { closeOverlay(this.overlay); run(`${MOD}.settings`); } }));
  }
}
