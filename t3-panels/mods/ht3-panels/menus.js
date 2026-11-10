// The two popups of the side panel: the `+` menu of surfaces (RightPanelTabs.tsx's
// AddSurfaceMenu: a row per surface with its icon, its name and its letter, which opens it while
// the menu is open) and the project popover (the machine, its folder, the editor, the branch).

import { div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, exec, run, appHome, shared, setShared, readTextFile, notify } from "herdr";
import { toMarkdown } from "./transcript.js";
import { agentName } from "./report.js";
import { MOD, tokens, icon, iconButton, shortPath } from "./look.js";
import { forkChat } from "./agent-acp.js";
import { revertTo } from "./checkpoint.js";
import { button } from "./look.js";
import { editorOn } from "./settings.js";
import { SURFACES, send, placeOf, activeSpace, surfaceOff, surfacesHere } from "./side.js";
import { projectOf, scriptsOf, runScript } from "./scripts.js";

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
      .on_key_down((e, cx) => this.key(e.key.toLowerCase(), cx))
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
      .on_key_down((e, cx) => this.key(e.key.toLowerCase(), cx))
      .when(this.naming, (el) => el.child(div().h(28).mt(14).mx(4).px(8).rounded(6).border(1).border_color(k.input).child(Input.new(this.field))))
      .when(!this.naming, (el) => el
        .child(row("thread-rename", "pen-line", "Rename thread", "r"))
        .child(row("thread-settle", "check", this.p.settled ? "Bring back" : "Settle", "s"))
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
    const space = activeSpace();
    this.space = space;
    this.on = space?.machine ?? null;
    this.folder = placeOf(space).cwd;
    this.root = null;
    this.machine = this.on ?? "This computer";
    this.editors = null;
    this.pick = null; // "editor" | "branch": the list that is open
    this.branches = null;
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
    this.message = InputState.new({ placeholder: "Commit message (empty: one is made up)" });
    this.message.on("submit", (_e, cx) => this.commit(cx));
    cx.spawn(async (cx) => {
      if (!this.on) {
        const n = await exec("scutil", ["--get", "ComputerName"]).catch(() => null);
        if (n?.code === 0 && n.stdout.trim()) this.machine = n.stdout.trim();
        this.editors = await editors();
      } else this.editors = [];
      cx.notify();
      this.project = await projectOf(space).catch(() => null);
      cx.notify();
      if (this.folder) {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.folder, on: this.on }).catch(() => null);
        this.root = top?.code === 0 ? top.stdout.trim() : null;
        if (this.root) {
          const b = await exec("git", ["branch", "--show-current"], { cwd: this.root, on: this.on }).catch(() => null);
          this.branch = b?.stdout.trim() || this.branch;
          // As T3 counts them (GitVcsDriverCore readBranchChangeTotals): lines against the merge base with the default
          // branch, new files that aren't tracked yet included, through a throwaway index so the real one isn't touched.
          const count = 'b=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); m=; for c in "$b" origin/main origin/master main master; do [ -n "$c" ] && m=$(git merge-base HEAD "$c" 2>/dev/null) && [ -n "$m" ] && break; done; [ -n "$m" ] || m=HEAD; '
            + 'i=$(mktemp); cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null; GIT_INDEX_FILE="$i" git add -N . 2>/dev/null; GIT_INDEX_FILE="$i" git diff --numstat "$m" 2>/dev/null | awk \'{a+=$1;d+=$2} END{print a+0, d+0}\'; rm -f "$i"';
          const d = await exec("sh", ["-c", count], { cwd: this.root, on: this.on, timeout: 15000 }).catch(() => null);
          const [add, del] = (d?.stdout ?? "").trim().split(" ").map(Number);
          if (d?.code === 0 && Number.isFinite(add) && Number.isFinite(del)) this.changes = { add, del };
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
      const r = await exec("git", ["worktree", "remove", gone], { cwd: this.main, on: this.on, timeout: 60000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop().replace(/^fatal: /, "") || "git worktree remove failed");
      this.note = `Removed the worktree ${shortPath(gone)}. Its branch${this.branch ? ` ${this.branch}` : ""} is kept.`;
      this.step = null;
      this.root = null;
      this.main = null;
      this.git = null;
      this.changes = null;
    });
  }
  close() {}
  // `ht3-panels.open:<editor id>` opens the folder in that editor, as its row does, for scripts.
  // `git:commit` (opens the message field), `git:commit:<message>` (commits with it), `git:push`, `git:pr` (shows the
  // command Create PR would run; only its button runs it).
  command(c, cx) {
    if (c === "git:commit") { this.step = this.step === "commit" ? null : "commit"; this.message.focus(); return cx.notify(); }
    if (c.startsWith("git:commit:")) { this.message.set_value(c.slice(11)); return this.commit(cx); }
    if (c === "git:push") return this.push(cx);
    if (c === "git:pr") { this.step = this.step === "pr" ? null : "pr"; return cx.notify(); }
    // scripts opens the project's scripts, script:<n> runs the nth (from 0).
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
    if (r?.code !== 0) { this.git = null; return; }
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
  }

  // Commit: everything that changed (`git add -A`), with the message typed or one made from the file names.
  commit(cx) {
    const g = this.git;
    if (!g?.changed) return;
    const typed = this.message.value().trim();
    const message = typed || (g.changed === 1 ? `Update ${g.names[0]}` : `Update ${g.changed} files`);
    this.run(cx, async () => {
      const opt = { cwd: this.root, on: this.on };
      const a = await exec("git", ["add", "-A"], opt);
      if (a.code !== 0) throw new Error(a.stderr.trim().split("\n").pop() || "git add failed");
      const r = await exec("git", ["commit", "-m", message], opt);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "git commit failed");
      const sha = (await exec("git", ["rev-parse", "--short", "HEAD"], opt)).stdout.trim();
      this.note = `Committed ${sha}: ${message}`;
      this.step = null;
      this.message.set_value("");
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

  // What Create PR runs, shown before it does: the branch is pushed first if it has no upstream, then
  // `gh pr create --fill` makes the pull request from the branch's commits.
  prCommand() {
    const g = this.git, push = !g?.upstream || g.ahead > 0 ? `git ${this.pushArgs().join(" ")} && ` : "";
    return `${push}gh pr create --fill --head ${this.branch}${g?.base ? ` --base ${g.base}` : ""}`;
  }

  createPr(cx) {
    const g = this.git;
    if (!g || !this.github || !this.branch || this.branch === g.base) return;
    this.run(cx, async () => {
      const opt = { cwd: this.root, on: this.on, timeout: 120000 };
      if (!g.upstream || g.ahead > 0) {
        const p = await exec("git", this.pushArgs(), opt);
        if (p.code !== 0) throw new Error((p.stderr || p.stdout).trim().split("\n").slice(-2).join(" ") || "git push failed");
      }
      const r = await exec("gh", ["pr", "create", "--fill", "--head", this.branch, ...(g.base ? ["--base", g.base] : [])], opt);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "gh pr create failed");
      this.note = `Pull request created: ${r.stdout.trim().split("\n").pop()}`;
      this.step = null;
      await this.status();
    });
  }

  loadBranches(cx) {
    this.pick = this.pick === "branch" ? null : "branch";
    if (this.pick !== "branch" || this.branches || !this.root) return cx.notify();
    this.run(cx, async () => {
      const r = await exec("git", ["branch", "--format=%(refname:short)", "--sort=-committerdate"], { cwd: this.root, on: this.on });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot list branches");
      this.branches = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 200);
    });
  }

  switchTo(cx, name) {
    this.run(cx, async () => {
      const r = await exec("git", ["switch", name], { cwd: this.root, on: this.on });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(0, 3).join(" "));
      this.branch = name;
      this.pick = null;
    });
  }

  render(_cx) {
    const k = tokens();
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
          onClick: (cx) => this.loadBranches(cx),
          on: this.pick === "branch",
          trail: icon(this.pick === "branch" ? "chevron-up" : "chevron-down").size(14).flex_none().text_color(k.muted),
        })
        : row("proj-nobranch", "git-branch", "Not a git repository"))
      .when(this.pick === "branch", (el) => el.child(this.branches ? list(this.branches.map((b) => sub(`br-${b}`, b, b === this.branch, (cx) => b === this.branch ? (this.pick = null, cx.notify()) : this.switchTo(cx, b)))) : div().px(8).py(6).text_size(12).text_color(k.muted).child(this.busy ? "Loading branches…" : "No branches.")))
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
        const act = (id, glyph, label, can, detail, onClick, on) => {
          const r = row(id, glyph, label, { detail, on, onClick: can && !this.busy ? onClick : null });
          return can ? r : r.opacity(0.5);
        };
        return el.child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
          .child(act("git-commit", "check", "Commit", g.changed > 0, g.changed ? n(g.changed, "file") : "nothing to commit", (cx) => { this.step = this.step === "commit" ? null : "commit"; this.message.focus(); cx.notify(); }, this.step === "commit"))
          .when(this.step === "commit" && g.changed > 0, (e) => e.child(h_flex().mx(8).my(4).gap(6).items_center()
            .child(div().flex_1().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).text_size(13).child(Input.new(this.message)))
            .child(button(k, "git-commit-go", this.busy ? "…" : "Commit", (cx) => this.commit(cx)))))
          .child(act("git-push", "arrow-up", "Push", canPush, g.behind > 0 ? `${g.behind} behind: pull first` : !g.remote ? "no remote" : g.ahead > 0 ? `${n(g.ahead, "commit")} ahead` : !g.upstream ? "no upstream yet" : "up to date", (cx) => this.push(cx), false))
          .child(act("git-pr", "git-pull-request-arrow", "Create PR", canPr, !this.github ? "no GitHub remote" : this.branch === g.base ? `on ${g.base}` : null, (cx) => { this.step = this.step === "pr" ? null : "pr"; cx.notify(); }, this.step === "pr"))
          .when(this.step === "pr" && canPr, (e) => e.child(v_flex().mx(8).my(4).gap(6)
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
      .when(!!this.error, (el) => el.child(div().px(8).py(6).text_size(12).line_height("16px").text_color(k.destructiveText).child(this.error)))
      .child(div().flex_1())
      .child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
      .child(row("proj-settings", "settings-2", "Settings", { detail: "Agents, models, editors", onClick: () => { closeOverlay(this.overlay); run(`${MOD}.settings`); } }));
  }
}
