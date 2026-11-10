// The two popups of the side panel: the `+` menu of surfaces (RightPanelTabs.tsx's
// AddSurfaceMenu: a row per surface with its icon, its name and its letter, which opens it while
// the menu is open) and the project popover (the machine, its folder, the editor, the branch).

import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, exec, run, appHome } from "herdr";
import { MOD, tokens, icon, iconButton, shortPath } from "./look.js";
import { editorOn } from "./settings.js";
import { SURFACES, send, placeOf, activeSpace, surfaceOff, surfacesHere } from "./side.js";

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
    cx.spawn(async (cx) => {
      if (!this.on) {
        const n = await exec("scutil", ["--get", "ComputerName"]).catch(() => null);
        if (n?.code === 0 && n.stdout.trim()) this.machine = n.stdout.trim();
        this.editors = await editors();
      } else this.editors = [];
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
        }
      }
      cx.notify();
    });
  }
  close() {}
  // `ht3-panels.open:<editor id>` opens the folder in that editor, as its row does, for scripts.
  command(c) {
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
        onClick: () => { closeOverlay(this.overlay); send("add:diff:a"); },
        trail: h_flex().gap(6).flex_none().text_size(12).font_family(k.mono)
          .child(div().text_color(k.successText).child(`+${this.changes.add}`)).child(div().text_color(k.destructiveText).child(`\u2212${this.changes.del}`)),
      })))
      .when(!!this.error, (el) => el.child(div().px(8).py(6).text_size(12).line_height("16px").text_color(k.destructiveText).child(this.error)))
      .child(div().flex_1())
      .child(div().mx(4).my(4).h(1).flex_none().bg(k.border))
      .child(row("proj-settings", "settings-2", "Settings", { detail: "Agents, models, editors", onClick: () => { closeOverlay(this.overlay); run(`${MOD}.settings`); } }));
  }
}
