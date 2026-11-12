// Compare two chats (not in T3 Code): the same task run in two chats, usually each in its own worktree from New chat's
// "New worktree", side by side to pick one. For each chat: its folder and branch, whether it has uncommitted changes,
// its commits since the merge base with the main checkout's HEAD, the last thing its agent said (first line), and
// every file changed against that base with its +/- counts. A click on a file shows the folder in the Diff surface
// (pins the folder for the shown space, as `ht3-panels.pin:<folder>`, then Diff's Changes) and closes the dialog.
// "Keep this one" asks (No / Merge), then merges that chat's branch into the main checkout's branch; it is refused,
// with the reason, when the main checkout has uncommitted changes or the chat's worktree has (a merge would leave them
// behind), and a conflicting merge is aborted at once. Then it asks again whether to remove the other chat's worktree
// (the Project popover's Remove worktree: `git worktree remove`, never --force). Branches are never deleted.
// All the git is in compare-data.js (tested with node against real repositories); this file reads the chats' saved
// state and draws.
//
// Opened by `ht3-panels.compare` (the last pair, or a picker), `compare:<chat>` (that chat, then a picker for the other)
// and `compare:<chatA>:<chatB>`; the Project popover's "Compare chats" row and a chat's menu "Compare with another chat".
// While it is open, for scripts: `cmp:pick:<a|b>` (the picker for that side), `cmp:use:<a|b>:<chat>`, `cmp:refresh`,
// `cmp:file:<a|b>:<n>` (the nth file of a side, from 0), `cmp:keep:<a|b>` asks, `cmp:yes`, `cmp:no`, `ui:close`.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, closeOverlay, openOverlay, run, appHome, readTextFile, shared, setShared } from "herdr";
import { MOD, tokens, alpha, icon, button, iconButton, badge, shortPath } from "./look.js";
import { activeSpace, spaceState, GROUPS, send } from "./side.js";
import { agentName } from "./report.js";
import { compareSides, keepCheck, keepSide, removeWorktreeFolder, lastReply, plural } from "./compare-data.js";

export const COMPARE_SIZE = { width: 1040, height: 700 };
const OPEN = `${MOD}.compare-open`, LAST = `${MOD}.compare-last`;
export const compareOpen = () => Date.now() - (shared(OPEN) ?? 0) < 2500;
const ID = /^[\w-]+$/;

export function openCompare(a = "", b = "") {
  openOverlay({ mod: MOD, kind: "dialog", ...COMPARE_SIZE, props: { menu: "compare", a: ID.test(a) ? a : "", b: ID.test(b) ? b : "" } });
}

const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const firstLine = (t) => String(t ?? "").trim().split("\n")[0];

// One saved chat: { id, title, agent, folder, on, reply }. Throws a sentence when it can't be read.
async function chatInfo(id) {
  if (!ID.test(id)) throw new Error(`"${id}" is not a chat id.`);
  let s;
  try { s = JSON.parse(await readTextFile(`${appHome()}/data/${MOD}/chats/${id}/state.json`)); } catch { throw new Error(`There is no saved chat ${id}.`); }
  if (!s.cwd) throw new Error(`Chat ${id} has no folder.`);
  const items = s.transcript?.items ?? [], first = firstLine(items.find((m) => m.kind === "user")?.text), named = shared(`${MOD}.named`) ?? {};
  const title = named[id] || (first.length > 80 ? `${first.slice(0, 80)}…` : first) || "Chat";
  return { id, title, agent: agentName(s.agentArgv ?? [], s.agentInfo?.title ?? s.agentInfo?.name), folder: s.cwd, on: s.machine ?? null, reply: lastReply(items) };
}

// The saved chats, newest first, at most 60: { id, at, title, agent, cwd, on }.
async function readChats() {
  const dir = `${appHome()}/data/${MOD}/chats`, named = shared(`${MOD}.named`) ?? {};
  const r = await exec("/bin/sh", ["-c", "cd \"$1\" 2>/dev/null && stat -f '%m %N' */state.json 2>/dev/null", "sh", dir]).catch(() => null);
  const stats = String(r?.stdout ?? "").split("\n").filter(Boolean).map((l) => ({ at: Number(l.slice(0, l.indexOf(" "))) * 1000, id: l.slice(l.indexOf(" ") + 1).split("/")[0] }))
    .filter((x) => x.at && ID.test(x.id)).sort((a, b) => b.at - a.at).slice(0, 60);
  const out = [];
  for (const { id, at } of stats) {
    try {
      const s = JSON.parse(await readTextFile(`${dir}/${id}/state.json`));
      const first = firstLine((s.transcript?.items ?? []).find((m) => m.kind === "user")?.text);
      if (!first || !s.cwd) continue;
      out.push({ id, at, title: named[id] || (first.length > 80 ? `${first.slice(0, 80)}…` : first), agent: agentName(s.agentArgv ?? [], s.agentInfo?.title ?? s.agentInfo?.name), cwd: s.cwd, on: s.machine ?? null });
    } catch {}
  }
  return out;
}

export class CompareDialog {
  init(p, cx) {
    this.overlay = p.overlay;
    const last = shared(LAST) ?? {};
    this.ids = p.a || p.b ? { a: p.a || "", b: p.b || "" } : { a: ID.test(last.a ?? "") ? last.a : "", b: ID.test(last.b ?? "") ? last.b : "" };
    this.info = { a: null, b: null }; // chatInfo of each side
    this.data = null; // compareSides' answer
    this.error = null;
    this.note = null; // { level, text }
    this.ask = null; // { kind: "keep", side } | { kind: "remove", side }
    this.busy = false;
    this.loading = false;
    this.picking = null; // "a" | "b": the list of chats to pick that side from
    this.chats = null;
    this.pendingRemove = null; // after a merge: the side whose worktree is offered for removal
    this.seq = 0;
    setShared(OPEN, Date.now());
    cx.timer.every(1000, () => setShared(OPEN, Date.now()));
    cx.timer.every(10000, (cx) => { if (!this.busy && !this.ask && !this.picking && this.ids.a && this.ids.b) this.load(cx, true); });
    this.load(cx);
  }
  close() {}

  // Reads both chats and compares them. `quiet`: a refresh on the timer, which keeps what is shown meanwhile.
  load(cx, quiet = false) {
    if (!this.ids.a || !this.ids.b) {
      this.data = null;
      this.picking = this.ids.a ? "b" : "a";
      this.loadChats(cx);
      return cx.notify();
    }
    const seq = ++this.seq, ids = { ...this.ids };
    if (!quiet) { this.loading = true; this.data = null; this.error = null; }
    cx.notify();
    cx.spawn(async (acx) => {
      let info, data, error = null;
      try {
        info = { a: await chatInfo(ids.a), b: await chatInfo(ids.b) };
        data = await compareSides(exec, [{ folder: info.a.folder, on: info.a.on }, { folder: info.b.folder, on: info.b.on }]);
        if (!data.ok) { error = data.error; data = null; }
      } catch (e) { error = String(e?.message ?? e).slice(0, 300); }
      if (seq !== this.seq) return;
      this.loading = false;
      if (info) this.info = info;
      if (quiet && error) return;
      this.data = data;
      this.error = error;
      if (data) setShared(LAST, ids);
      // A question about a side that changed under it goes.
      if (this.ask && this.ask.kind === "keep" && !this.data) this.ask = null;
      acx.notify();
    });
  }

  loadChats(cx) {
    cx.spawn(async (acx) => { try { this.chats = await readChats(); } catch { this.chats = []; } acx.notify(); });
  }

  pick(side, cx) {
    if (this.busy) return;
    this.picking = side;
    this.ask = null;
    if (!this.chats) this.loadChats(cx);
    cx.notify();
  }
  use(side, id, cx) {
    if (!ID.test(id)) return;
    this.ids = { ...this.ids, [side]: id };
    this.picking = null;
    this.note = null;
    this.ask = null;
    this.load(cx);
  }

  sideOf(key) { return this.data?.sides[key === "a" ? 0 : 1] ?? null; }
  other(key) { return key === "a" ? "b" : "a"; }
  name(key) { return this.info[key]?.title ?? `chat ${key.toUpperCase()}`; }

  // Keep this one: the question first, unless it is refused already (the reason is the answer).
  askKeep(key, cx) {
    const s = this.sideOf(key);
    if (this.busy || !this.data || !s) return;
    const c = keepCheck(s, this.data.main);
    if (!c.ok) { this.ask = null; this.note = { level: "error", text: c.why }; return cx.notify(); }
    this.note = null;
    this.ask = { kind: "keep", side: key };
    cx.notify();
  }
  question() {
    const a = this.ask, s = a && this.sideOf(a.side), m = this.data?.main;
    if (!a || !s || !m) return null;
    if (a.kind === "keep") return { text: `Merge ${s.branch} into ${m.branch} in ${shortPath(m.folder)}? ${plural(s.ahead, "commit")} of ${this.name(a.side)} come in. The other chat's work stays where it is.`, label: "Merge", no: "Cancel", danger: false };
    return { text: `Remove the other worktree ${shortPath(s.folder)} (${this.name(a.side)})? Its branch ${s.branch ?? "(detached)"} is kept; a chat working there loses its folder. Changes that aren't committed stop it.`, label: "Remove", no: "Keep it", danger: true };
  }
  no(cx) { this.ask = null; cx.notify(); }
  // Yes runs what was asked about at once (asking again would only ask).
  yes(cx) {
    const a = this.ask, s = a && this.sideOf(a.side);
    if (!a || !s || this.busy) return;
    this.ask = null;
    this.busy = true;
    this.note = null;
    cx.notify();
    const m = this.data.main, key = a.side;
    cx.spawn(async (acx) => {
      try {
        if (a.kind === "keep") {
          const on = this.info[key]?.on ?? null;
          const r = await keepSide(exec, { main: m.folder, folder: s.folder, on });
          if (r.ok) {
            this.note = { level: "success", text: r.upToDate ? `${s.branch} is already in ${m.branch}: nothing was merged.` : `Merged ${s.branch} into ${m.branch} (now ${r.head}). Nothing was pushed.` };
            const o = this.other(key), os = this.sideOf(o);
            if (os?.linked && !os.error) this.pendingRemove = o;
          } else if (r.conflict) {
            this.note = { level: "error", text: `${s.branch} conflicts with ${m.branch} in ${r.files.length ? r.files.join(", ") : "some files"}. ${r.aborted ? "The merge was aborted: the main checkout is as it was." : `The merge could not be aborted: ${r.error}. Run git merge --abort in ${shortPath(m.folder)}.`}` };
          } else this.note = { level: "error", text: r.error };
        } else {
          await removeWorktreeFolder(exec, { main: m.folder, folder: s.folder, on: this.info[key]?.on ?? null });
          this.note = { level: "success", text: `Removed the worktree ${shortPath(s.folder)}. Its branch ${s.branch ?? ""} is kept.` };
        }
      } catch (e) { this.note = { level: "error", text: String(e?.message ?? e).slice(0, 300) }; }
      this.busy = false;
      // Read both again; after a merge, offer the removal of the other worktree.
      const seq = ++this.seq;
      try {
        const info = this.info, d = await compareSides(exec, [{ folder: info.a.folder, on: info.a.on }, { folder: info.b.folder, on: info.b.on }]);
        if (seq === this.seq) { this.data = d.ok ? d : this.data; this.error = d.ok ? null : d.error; }
      } catch (e) { this.error = String(e?.message ?? e).slice(0, 300); }
      if (this.pendingRemove && this.data) { this.ask = { kind: "remove", side: this.pendingRemove }; }
      this.pendingRemove = null;
      acx.notify();
    });
  }

  // A file: the folder in the Diff surface, through the keeper (it holds the pin and the panel's tabs).
  openFile(key, cx) {
    const s = this.sideOf(key);
    if (!s || s.error) return;
    const st = spaceState(activeSpace()?.id), group = GROUPS.find((g) => st[g].tabs.some((t) => t.kind === "diff")) ?? "a";
    run(`${MOD}.pin:${s.folder}`);
    send(`add:diff:${group}`);
    send("scope:branch");
    closeOverlay(this.overlay);
  }

  command(c, cx) {
    if (c === "ui:close") return void closeOverlay(this.overlay);
    if (c.startsWith("compare:") || c === "compare") {
      const [, a, b] = c.split(":");
      if (a && ID.test(a)) this.ids = { a, b: b && ID.test(b) ? b : "" };
      else return;
      this.picking = null; this.ask = null; this.note = null;
      return this.load(cx);
    }
    if (!c.startsWith("cmp:")) return;
    const [, verb, x, y] = c.split(":");
    if (verb === "refresh") this.load(cx);
    else if (verb === "pick" && (x === "a" || x === "b")) this.pick(x, cx);
    else if (verb === "use" && (x === "a" || x === "b")) this.use(x, y ?? "", cx);
    else if (verb === "keep" && (x === "a" || x === "b")) this.askKeep(x, cx);
    else if (verb === "yes") this.yes(cx);
    else if (verb === "no") this.no(cx);
    else if (verb === "file" && (x === "a" || x === "b")) {
      const f = this.sideOf(x)?.changes?.files?.[Number(y)];
      if (f) this.openFile(x, cx);
    }
    cx.notify();
  }

  // ---- drawing ----

  pickerBody(k) {
    const key = this.picking, otherId = this.ids[this.other(key)], main = this.data?.main?.folder;
    const quiet = (t) => div().px(12).py(8).text_size(12).line_height("16px").text_color(k.muted).child(t);
    const list = (this.chats ?? []).filter((c) => c.id !== otherId);
    // The ones that work inside the main checkout we already know of (its worktrees) first.
    const inRepo = (c) => !!main && (c.cwd === main || c.cwd.startsWith(`${main}/`));
    const rows = [...list.filter(inRepo), ...list.filter((c) => !inRepo(c))];
    return v_flex().id("ht3-cmp-pick").flex_1().min_h(0).px(8).py(8).overflow_y_scrollbar()
      .child(div().px(12).pb(6).text_size(13).font_medium().child(`Pick the chat for side ${key.toUpperCase()}${this.ids[this.other(key)] ? ` (the other is ${this.name(this.other(key))})` : ""}`))
      .when(!this.chats, (el) => el.child(quiet("Looking…")))
      .when(!!this.chats && !rows.length, (el) => el.child(quiet("There is no other saved chat.")))
      .children(rows.map((c, i) => h_flex().id(`cmp-chat-${i}`).flex_none().px(12).py(6).gap(10).items_center().rounded(8).cursor_pointer().role("button").accessibility_label(`Compare ${c.title}`)
        .hover((s) => s.bg(k.accent)).on_click((_e, cx) => this.use(key, c.id, cx))
        .child(icon("message-square").size(16).flex_none().text_color(k.muted))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(14).font_medium().child(c.title))
          .child(div().truncate().text_size(12).text_color(k.muted).child(`${c.agent} · ${c.on ? `${c.on}:` : ""}${shortPath(c.cwd)} · ${ago(c.at)}`)))
        .when(inRepo(c), (el) => el.child(badge(k, "this repository", "info")))));
  }

  fileRow(k, key, f, i) {
    const tone = { A: k.successText, D: k.destructiveText, M: k.warningText }[f.status] ?? k.muted;
    const slash = f.path.lastIndexOf("/");
    return h_flex().id(`cmp-${key}-file-${i}`).flex_none().h(24).px(8).gap(8).items_center().rounded(6).cursor_pointer().role("button").accessibility_label(`Show ${f.path} in the Diff`)
      .hover((s) => s.bg(k.accent)).on_click((_e, cx) => this.openFile(key, cx))
      .child(div().w(12).flex_none().text_size(11).font_family(k.mono).text_color(tone).child(f.status))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12)
        .child(div().flex_none().max_w(260).truncate().child(slash < 0 ? f.path : f.path.slice(slash + 1)))
        .when(slash > 0, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.muted).child(f.path.slice(0, slash)))))
      .when(f.binary, (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child("binary")))
      .when(!f.binary, (el) => el.child(h_flex().flex_none().gap(6).text_size(11).font_family(k.mono)
        .child(div().text_color(k.successText).child(`+${f.add}`)).child(div().text_color(k.destructiveText).child(`−${f.del}`))));
  }

  column(k, key) {
    const s = this.sideOf(key), info = this.info[key], more = (s?.changes?.total ?? 0) - (s?.changes?.files?.length ?? 0);
    const quiet = (t, c = k.muted) => div().px(12).py(8).text_size(12).line_height("16px").text_color(c).child(t);
    const refused = s && !s.error ? keepCheck(s, this.data.main) : { ok: false };
    return v_flex().id(`ht3-cmp-${key}`).flex_1().min_w(0).min_h(0).border_1().border_color(this.ask?.side === key ? k.primary : k.border).rounded(10).overflow_hidden()
      .child(v_flex().flex_none().px(12).py(10).gap(4).border_b(1).border_color(k.border).bg(alpha(k.card, 0.5))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(11).font_semibold().text_color(k.muted).child(key.toUpperCase()))
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(info?.title ?? "…"))
          .child(button(k, `cmp-change-${key}`, "Change", (cx) => this.pick(key, cx), { variant: "ghost-muted", disabled: this.busy })))
        .child(div().truncate().text_size(12).text_color(k.muted).child(info ? `${info.agent} · ${info.on ? `${info.on}:` : ""}${shortPath(s?.folder ?? info.folder)}` : ""))
        .when(!!s && !s.error, (el) => el.child(h_flex().gap(6).items_center().flex_wrap()
          .child(badge(k, s.branch ?? "detached HEAD", "secondary"))
          .child(badge(k, s.linked ? plural(s.ahead, "commit") : "main checkout", s.ahead > 0 ? "info" : "secondary"))
          .when(s.dirty > 0, (e) => e.child(badge(k, `${s.dirty} uncommitted`, "warning")))
          .when(s.dirty === 0, (e) => e.child(badge(k, "clean", "success")))))
        .when(!!info?.reply, (el) => el.child(div().truncate().text_size(12).text_color(alpha(k.foreground, 0.8)).child(`“${info.reply}”`))))
      .child(v_flex().id(`ht3-cmp-${key}-files`).flex_1().min_h(0).px(4).py(4).overflow_y_scrollbar()
        .when(this.loading, (el) => el.child(quiet("Looking…")))
        .when(!!s?.error, (el) => el.child(quiet(s.error, k.destructiveText)))
        .when(!!s && !s.error && !s.changes.total, (el) => el.child(quiet("Nothing changed against the base.")))
        .children(s && !s.error ? s.changes.files.map((f, i) => this.fileRow(k, key, f, i)) : [])
        .when(more > 0, (el) => el.child(quiet(`and ${plural(more, "more file")}: see them in the Diff.`))))
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_t(1).border_color(k.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(k.mono).text_color(k.muted)
          .child(s && !s.error ? `${plural(s.changes.total, "file")}  ` : ""))
        .when(!!s && !s.error, (el) => el.child(h_flex().gap(6).flex_none().text_size(12).font_family(k.mono)
          .child(div().text_color(k.successText).child(`+${s.changes.add}`)).child(div().text_color(k.destructiveText).child(`−${s.changes.del}`))))
        .child(button(k, `cmp-keep-${key}`, "Keep this one", (cx) => this.askKeep(key, cx), { size: "sm", variant: "default", glyph: "git-merge", disabled: this.busy || !s || !!s.error,
          tip: refused.ok === false && refused.why ? refused.why : `Merge ${s?.branch ?? "its branch"} into the main checkout's branch` })));
  }

  render(_cx) {
    const k = tokens(), d = this.data;
    const tone = { error: k.destructiveText, warning: k.warningText, success: k.successText }[this.note?.level] ?? k.muted;
    const q = this.question();
    const sub = d ? `Against the merge base with ${d.main.branch ?? "HEAD"} in ${shortPath(d.main.folder)}${d.main.dirty ? ` (${plural(d.main.dirty, "uncommitted file")})` : ""}` : "Two chats, side by side";
    return v_flex().id("ht3-compare").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(h_flex().px(20).pt(16).pb(12).gap(8).flex_none().items_center().border_b(1).border_color(k.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(18).font_semibold().child("Compare chats"))
          .child(div().truncate().text_size(12).text_color(k.muted).child(sub)))
        .child(iconButton(k, "cmp-refresh", "refresh-cw", (cx) => this.load(cx), { tip: "Look again" }))
        .child(iconButton(k, "cmp-close", "x", () => closeOverlay(this.overlay), { tip: "Close" })))
      .when(!!this.picking, (el) => el.child(this.pickerBody(k)))
      .when(!this.picking, (el) => el.child(h_flex().id("ht3-cmp-body").flex_1().min_h(0).px(12).py(12).gap(12)
        .when(!!this.error && !d, (e) => e.child(div().flex_1().px(12).py(8).text_size(13).line_height("18px").text_color(k.destructiveText).child(this.error)))
        .when(!this.error || !!d, (e) => e.child(this.column(k, "a")).child(this.column(k, "b")))))
      .children(q ? [v_flex().id("ht3-cmp-ask").flex_none().px(20).py(10).gap(8).border_t(1).border_color(alpha(q.danger ? k.destructive : k.border, q.danger ? 0.6 : 1)).bg(q.danger ? alpha(k.destructive, 0.06) : alpha(k.card, 0.5))
        .child(div().text_size(13).line_height("18px").text_color(q.danger ? k.destructiveText : k.foreground).child(q.text))
        .child(h_flex().gap(8).justify_end()
          .child(button(k, "cmp-no", q.no, (cx) => this.no(cx), { size: "sm" }))
          .child(button(k, "cmp-yes", q.label, (cx) => this.yes(cx), { size: "sm", variant: q.danger ? "destructive" : "default" })))] : [])
      .child(h_flex().px(20).py(10).gap(10).flex_none().items_center().border_t(1).border_color(k.border)
        .child(div().flex_1().min_w(0).text_size(12).line_height("16px").text_color(tone).child(this.busy ? "Working…" : this.note?.text ?? "Keep merges a chat's branch into the main checkout's branch. It never pushes, never forces and never deletes a branch.")));
  }
}
