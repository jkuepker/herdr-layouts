// The Dashboard surface's edit mode (dashboard.js installs it; dash-edit.js is the data side, which node tests).
// The pencil in the header turns it on. Then every widget has: move left, move right, narrower, wider, settings
// (the gear) and remove (asks once more); an "Add widget" tile lists the widget types; and the header has New,
// Rename, Duplicate, Delete (asks first) and Edit JSON (the file, in the Files editor).
// Every change is written to the dashboard's file at once, after it has read back as a dashboard (dash-edit.js
// `checked`); the file as it was before the first change of a session is kept beside it as <name>.json.bak.
// A settings form with a field that can't be read shows why under the field and saves nothing.
// No dragging: a mod's drop events carry files from outside only.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, readTextFile, writeTextFile, run } from "herdr";
import { MOD, alpha, icon, button, shortPath } from "./look.js";
import { send } from "./side.js";
import { readDashboard } from "./dash-data.js";
import { WIDGETS, sourceKindsFor, NO_SOURCE, fieldsFor, fieldText, sourceKindOf, applyForm, edit, checked, fileName, blank } from "./dash-edit.js";

const CONFIRM_MS = 5000;

export const editor = {
  // ---- commands, for scripts (and the tests in QA.md) ----
  // dash-edit (the pencil), dash-add:<type>, dash-addmenu, dash-move:<i>:<-1|1>, dash-width:<i>:<n>, dash-remove:<i>
  // (twice: the second confirms), dash-gear:<i> (its settings; dash-gear: closes), dash-set:<key>=<text> (a field),
  // dash-source:<kind>, dash-apply, dash-new:<title>, dash-rename:<title>, dash-duplicate, dash-delete (twice), dash-json.
  editCommand(c, cx) {
    const cur = this.current();
    if (c === "dash-edit") this.setEditing(cx, !this.editing);
    else if (!this.editing) return false;
    else if (c === "dash-addmenu") { this.adding = !this.adding; this.closeForm(); }
    else if (c.startsWith("dash-add:")) this.addWidget(cx, c.slice(9));
    else if (c.startsWith("dash-move:")) { const [i, by] = c.slice(10).split(":").map(Number); this.change(cx, { move: i, by }); }
    else if (c.startsWith("dash-width:")) { const [i, w] = c.slice(11).split(":").map(Number); this.change(cx, { width: i, w }); }
    else if (c.startsWith("dash-remove:")) this.removeWidget(cx, Number(c.slice(12)));
    else if (c.startsWith("dash-gear:")) { if (c.length > 10) this.openForm(cx, Number(c.slice(10))); else this.closeForm(); }
    else if (c.startsWith("dash-set:") && this.form) { const at = c.indexOf("="), key = c.slice(9, at), text = c.slice(at + 1).replace(/\\n/g, "\n"); this.setField(key, text); }
    else if (c.startsWith("dash-source:") && this.form) this.setSourceKind(c.slice(12));
    else if (c === "dash-apply") this.applyForm(cx);
    else if (c.startsWith("dash-new:")) this.newDashboard(cx, c.slice(9));
    else if (c.startsWith("dash-rename:") && cur) this.change(cx, { title: c.slice(12) });
    else if (c === "dash-duplicate") this.duplicate(cx);
    else if (c === "dash-delete") this.deleteDashboard(cx);
    else if (c === "dash-json") this.editJson(cx);
    else return false;
    return true;
  },

  setEditing(cx, on) {
    this.editing = on;
    this.adding = false;
    this.naming = null;
    this.editError = null;
    this.closeForm();
    if (on) this.loadFiles(cx);
    cx.notify();
  },

  // ---- saving ----

  // Writes a dashboard's object as its file: checked first, the .bak before the first change, and only over the
  // text this surface last read (a file changed on disk meanwhile is not overwritten).
  save(cx, file, raw, then = null) {
    if (this.saving) return;
    let text;
    try { text = checked(raw, file.name, file.raw); } catch (e) { this.editError = String(e?.message ?? e); return cx.notify(); }
    this.saving = true;
    this.editError = null;
    cx.spawn(async (cx) => {
      const path = `${this.dir()}/${file.name}.json`;
      try {
        if (!this.backed.has(file.name) && file.text != null) {
          const old = await readTextFile(`${path}.bak`).catch(() => null);
          await writeTextFile(`${path}.bak`, file.text, old);
          this.backed.add(file.name);
        }
        await writeTextFile(path, text, file.text ?? null);
        file.text = text;
        file.raw = raw;
        file.dash = readDashboard(text, file.name);
        delete file.error;
        // Widget ids are places in the list: after a change every widget asks again.
        for (const id of [...this.state.keys()]) if (id.startsWith(`${file.name}:`)) this.state.delete(id);
        this.poll(cx, true);
        then?.(cx);
      } catch (e) {
        this.editError = /stale|match|changed/i.test(String(e?.message ?? e)) ? `${file.name}.json changed on disk. Refresh, then change it again.` : `Couldn't save: ${String(e?.message ?? e).slice(0, 160)}`;
      }
      this.saving = false;
      cx.notify();
    });
  },
  // One change to the shown dashboard (dash-edit.js edit), saved.
  change(cx, op, then = null) {
    const cur = this.current();
    if (!cur) return;
    this.confirm = null;
    try { this.save(cx, cur, edit(cur.raw, op), then); } catch (e) { this.editError = String(e?.message ?? e); cx.notify(); }
  },

  addWidget(cx, type) {
    const cur = this.current();
    if (!cur) return;
    this.adding = false;
    // A new widget opens its settings: it starts with made-up data, and the next step is a real source.
    this.change(cx, { add: type }, (cx) => this.openForm(cx, cur.dash.widgets.length - 1));
  },
  removeWidget(cx, i) {
    const key = `w:${i}`;
    if (this.confirm?.key === key && this.confirm.until > Date.now()) { this.closeForm(); return this.change(cx, { remove: i }); }
    this.confirm = { key, until: Date.now() + CONFIRM_MS };
    cx.timer.after(CONFIRM_MS + 50, (cx) => cx.notify());
    cx.notify();
  },

  // ---- the settings form ----

  openForm(cx, i) {
    const cur = this.current(), w = cur?.raw.widgets?.[i];
    this.closeForm();
    if (!w) return cx?.notify();
    this.adding = false;
    this.form = { i, file: cur.name, type: w.type, kind: sourceKindOf(w), inputs: new Map(), values: {}, errors: {}, top: null };
    this.fillForm(w);
    cx?.notify();
  },
  // Inputs for the fields the form shows now that it has none for yet (a source kind just chosen brings new ones).
  fillForm(w) {
    const f = this.form;
    for (const g of fieldsFor(f.type, f.kind)) for (const x of g.fields) {
      if (f.inputs.has(x.key) || x.key in f.values) continue;
      // A widget whose source was of another kind has nothing to say about this kind's fields.
      const text = x.key.startsWith("source") && sourceKindOf(w) !== f.kind ? "" : fieldText(w, x);
      if (x.kind === "bool" || x.kind === "choice" || x.kind === "pick") f.values[x.key] = text;
      else if (x.kind === "json" || x.kind === "lines") { const s = TextareaState.new({ value: text }); s.set_auto_grow(1, 8); f.inputs.set(x.key, s); }
      else f.inputs.set(x.key, InputState.new({ value: text, placeholder: x.hint ?? "" }));
    }
  },
  closeForm() {
    for (const s of this.form?.inputs.values() ?? []) s.release?.();
    this.form = null;
  },
  setField(key, text) {
    const f = this.form;
    if (!f) return;
    if (f.inputs.has(key)) f.inputs.get(key).set_value(text); else f.values[key] = text;
    delete f.errors[key];
  },
  setSourceKind(kind) {
    const f = this.form, w = this.current()?.raw.widgets?.[f?.i];
    if (!f || !w || !sourceKindsFor(f.type).includes(kind)) return;
    f.kind = kind;
    f.errors = {};
    this.fillForm(w);
  },
  applyForm(cx) {
    const f = this.form, cur = this.current(), w = cur?.raw.widgets?.[f?.i];
    if (!f || !w || cur.name !== f.file) return;
    const texts = { ...f.values };
    for (const g of fieldsFor(f.type, f.kind)) for (const x of g.fields) if (f.inputs.has(x.key)) texts[x.key] = f.inputs.get(x.key).value();
    const r = applyForm(w, f.kind, texts);
    f.errors = r.errors ?? {};
    f.top = r.errors ? "Nothing was saved: see the fields in red." : null;
    if (r.widget) this.change(cx, { replace: f.i, widget: r.widget }, () => { if (this.form === f) f.top = "Saved."; });
    cx.notify();
  },

  // ---- whole dashboards ----

  newDashboard(cx, title, from = null) {
    const t = String(title ?? "").trim();
    if (!t) { this.editError = "A dashboard needs a name"; return cx.notify(); }
    const name = fileName(t, (this.files ?? []).map((x) => x.name)), raw = from ? { ...JSON.parse(JSON.stringify(from)), title: t.slice(0, 80) } : blank(t);
    this.naming = null;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", this.dir()]).catch(() => null);
      // A file object with no text yet: save() then writes it as a new file.
      const file = { name, raw, text: null, dash: readDashboard(JSON.stringify(raw), name) };
      this.files = [...(this.files ?? []), file].sort((a, b) => a.name.localeCompare(b.name));
      this.backed.add(name);
      this.choose(cx, name);
      this.save(cx, file, raw);
    });
  },
  duplicate(cx) {
    const cur = this.current();
    if (cur) this.newDashboard(cx, `${cur.dash.title} copy`, cur.raw);
  },
  // Not gone for good: the file moves into .trash/ in the dashboards folder.
  deleteDashboard(cx) {
    const cur = this.current();
    if (!cur) return;
    if (!(this.confirm?.key === "delete" && this.confirm.until > Date.now())) {
      this.confirm = { key: "delete", until: Date.now() + CONFIRM_MS };
      cx.timer.after(CONFIRM_MS + 50, (cx) => cx.notify());
      return cx.notify();
    }
    this.confirm = null;
    this.closeForm();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'mkdir -p "$1/.trash" && mv "$1/$2.json" "$1/.trash/$2-$(date +%Y%m%d-%H%M%S).json"', "trash", this.dir(), cur.name]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) this.editError = `Couldn't delete: ${String(r.stderr).trim().split("\n")[0]}`;
      else { this.files = (this.files ?? []).filter((x) => x !== cur); this.poll(cx, true); }
      cx.notify();
    });
  },
  // The file in the Files editor of the side panel. Files moves to the dashboards folder for it; its "Back to the
  // terminal's folder" button goes back.
  editJson(cx) {
    const cur = this.current();
    if (!cur) return;
    send("add:files:a");
    cx.timer.after(500, () => run(`${MOD}.open:${this.dir()}/${cur.name}.json`));
  },

  // ---- drawing ----

  tiny(k, id, child, onClick, tip, { danger = false, on = false } = {}) {
    return h_flex().id(id).size(20).flex_none().items_center().justify_center().rounded(4).text_size(12).cursor_pointer()
      .bg(on ? (danger ? k.destructive : k.accent) : "#00000000").text_color(on && danger ? "#ffffff" : k.muted)
      .role("button").accessibility_label(tip).tooltip(tip)
      .hover((s) => s.bg(danger ? alpha(k.destructive, on ? 0.9 : 0.2) : k.accent).text_color(on && danger ? "#ffffff" : k.foreground))
      .on_click((_e, cx) => { cx.stop_propagation?.(); onClick(cx); }).child(child);
  },
  // The controls on a widget's card while editing.
  widgetTools(k, w, i, n) {
    const sure = this.confirm?.key === `w:${i}` && this.confirm.until > Date.now(), open = this.form?.i === i;
    return h_flex().flex_none().flex_wrap().gap(2).items_center()
      .child(this.tiny(k, `dw-left-${i}`, icon("chevron-left").size(12), (cx) => this.change(cx, { move: i, by: -1 }), i > 0 ? "Move earlier" : "Already first"))
      .child(this.tiny(k, `dw-right-${i}`, icon("chevron-right").size(12), (cx) => this.change(cx, { move: i, by: 1 }), i < n - 1 ? "Move later" : "Already last"))
      .child(div().w(4))
      .child(this.tiny(k, `dw-less-${i}`, "−", (cx) => this.change(cx, { width: i, w: w.w - 1 }), "Narrower"))
      .child(div().w(14).flex_none().text_center().text_size(11).text_color(k.muted).tooltip(`${w.w} of 4 columns`).child(String(w.w)))
      .child(this.tiny(k, `dw-more-${i}`, "+", (cx) => this.change(cx, { width: i, w: w.w + 1 }), "Wider"))
      .child(div().flex_1().min_w(4))
      .child(this.tiny(k, `dw-gear-${i}`, icon("settings-2").size(12), (cx) => { if (open) this.closeForm(); else this.openForm(cx, i); cx.notify(); }, "Settings", { on: open }))
      .child(sure ? h_flex().id(`dw-sure-${i}`).h(20).px(6).flex_none().items_center().rounded(4).bg(k.destructive).text_color("#ffffff").text_size(11).cursor_pointer()
        .role("button").accessibility_label("Remove this widget").on_click((_e, cx) => this.removeWidget(cx, i)).child("Remove?")
        : this.tiny(k, `dw-x-${i}`, icon("x").size(12), (cx) => this.removeWidget(cx, i), "Remove", { danger: true }));
  },
  addTile(k) {
    return v_flex().id("dash-add").flex_grow(1).flex_basis(168).min_w(150).min_h(84).p(12).gap(6).items_center().justify_center().rounded(10)
      .border(1).border_dashed().border_color(this.adding ? k.primary : k.border).text_color(k.muted).cursor_pointer()
      .role("button").accessibility_label("Add a widget").hover((s) => s.bg(alpha(k.foreground, 0.04)).text_color(k.foreground))
      .on_click((_e, cx) => { this.adding = !this.adding; this.closeForm(); cx.notify(); })
      .child(icon("plus").size(16)).child(div().text_size(12).font_medium().child("Add widget"));
  },
  // The picker of widget types: a name and one line each.
  addPicker(k) {
    return v_flex().mx(12).mt(12).p(8).gap(2).flex_none().rounded(10).border(1).border_color(k.border).bg(k.popover)
      .child(h_flex().px(6).pb(4).items_center().child(div().flex_1().font_medium().text_size(13).child("Add a widget"))
        .child(this.tiny(k, "dash-add-x", icon("x").size(12), (cx) => { this.adding = false; cx.notify(); }, "Close")))
      .child(h_flex().flex_wrap().gap(4).children(WIDGETS.map((t) => v_flex().id(`dash-add-${t.type}`).flex_grow(1).flex_basis(220).min_w(180).px(8).py(6).rounded(6).cursor_pointer()
        .role("button").accessibility_label(`Add a ${t.name ?? t.type} widget: ${t.about}`).hover((s) => s.bg(k.accent))
        .on_click((_e, cx) => this.addWidget(cx, t.type))
        .child(div().font_medium().font_family(k.mono).text_size(12).child(t.name ?? t.type))
        .child(div().text_size(11).line_height("15px").text_color(k.muted).child(t.about)))));
  },
  // The settings of one widget: its fields in groups, a wrong one in red with why, Save and Close.
  formView(k) {
    const f = this.form, cur = this.current(), w = cur?.raw.widgets?.[f.i];
    if (!w || cur.name !== f.file) return div();
    const chip = (id, label, on, click) => h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(6).text_size(11).cursor_pointer()
      .border(1).border_color(on ? k.primary : k.input).bg(on ? alpha(k.primary, 0.15) : "#00000000").text_color(on ? k.foreground : k.muted)
      .role("button").accessibility_label(label).hover((s) => s.bg(k.accent)).on_click((_e, cx) => { click(); cx.notify(); }).child(label);
    const field = (x) => {
      const err = f.errors[x.key], wide = x.kind === "json" || x.kind === "lines" || x.key === "source.query" || x.key === "source.shell";
      let control;
      if (x.kind === "bool") control = h_flex().gap(4).child(chip(`df-${x.key}-yes`, "Yes", f.values[x.key] === "yes", () => { f.values[x.key] = "yes"; })).child(chip(`df-${x.key}-no`, "No", f.values[x.key] !== "yes", () => { f.values[x.key] = ""; }));
      else if (x.kind === "pick") {
        // Chips for what the surface knows now (pickOptions), and the value in the file even when it isn't among them.
        const opts = [...new Set([...(this.pickOptions?.(x.from) ?? []), ...(f.values[x.key] ? [f.values[x.key]] : [])])];
        control = opts.length ? h_flex().flex_wrap().gap(4).children(opts.map((o) => chip(`df-${x.key}-${o}`, o, f.values[x.key] === o, () => { f.values[x.key] = f.values[x.key] === o ? "" : o; })))
          : div().text_size(11).text_color(k.dim).child(x.none ?? "Nothing to pick from yet");
      }
      else if (x.kind === "choice") control = h_flex().flex_wrap().gap(4).children(x.options.map((o) => chip(`df-${x.key}-${o}`, o, f.values[x.key] === o, () => { f.values[x.key] = f.values[x.key] === o ? "" : o; })));
      else if (x.kind === "json" || x.kind === "lines") control = div().min_h(28).px(8).py(4).rounded(6).border(1).border_color(err ? k.destructive : k.input).bg(k.background).font_family(k.mono).text_size(12).line_height("18px").child(Textarea.new(f.inputs.get(x.key)));
      else control = div().h(28).px(8).rounded(6).border(1).border_color(err ? k.destructive : k.input).bg(k.background).text_size(12).child(Input.new(f.inputs.get(x.key)));
      return v_flex().flex_grow(1).flex_basis(wide ? 480 : 200).min_w(180).gap(3)
        .child(div().text_size(11).text_color(k.muted).child(x.label))
        .child(control)
        .when(!!err, (el) => el.child(div().text_size(11).line_height("15px").text_color(k.destructiveText).child(err)))
        .when(!err && !!x.hint && (x.kind === "json" || x.kind === "bool" || x.kind === "choice" || x.kind === "lines" || x.kind === "pick"), (el) => el.child(div().text_size(10.5).line_height("14px").text_color(k.dim).child(x.hint)));
    };
    const groups = fieldsFor(f.type, f.kind);
    return v_flex().id("dash-form").mx(12).mt(12).p(12).gap(10).flex_none().rounded(10).border(1).border_color(k.primary).bg(k.popover)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.closeForm(); cx.notify(); } else if (e.keystroke === "cmd-enter" || e.keystroke === "cmd-s") this.applyForm(cx); })
      .child(h_flex().gap(8).items_center()
        .child(icon("settings-2").size(14).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_size(13).child(`${w.title || "Widget"} · ${WIDGETS.find((t) => t.type === f.type)?.name ?? f.type}`))
        .when(!!f.top, (el) => el.child(div().flex_none().text_size(11).text_color(Object.keys(f.errors).length ? k.destructiveText : k.successText).child(f.top)))
        .child(button(k, "dash-form-close", "Close", (cx) => { this.closeForm(); cx.notify(); }, { variant: "outline", size: "xs" }))
        .child(button(k, "dash-form-save", this.saving ? "Saving…" : "Save", (cx) => this.applyForm(cx), { variant: "default", size: "xs", glyph: "save", tip: "Save these settings to the file (Cmd+Enter)" })))
      .children(groups.map((g) => v_flex().gap(6)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(11).font_medium().text_color(k.muted).child(g.group.toUpperCase()))
          .when(g.group === "Source", (el) => el.child(h_flex().flex_wrap().gap(4).children(sourceKindsFor(f.type).map((s) => chip(`ds-${s}`, s, f.kind === s, () => this.setSourceKind(s)))))))
        .when(g.fields.length > 0, (el) => el.child(h_flex().flex_wrap().gap(10).items_start().children(g.fields.map(field))))
        .when(!g.fields.length && g.group === "Source", (el) => el.child(div().text_size(11).text_color(k.dim).child("This source has nothing to set.")))));
  },
  // The header's second row while editing.
  editBar(k) {
    const cur = this.current(), sure = this.confirm?.key === "delete" && this.confirm.until > Date.now();
    const ask = (what, start) => (cx) => { this.naming = this.naming?.what === what ? null : { what }; this.nameInput.set_value(start); if (this.naming) this.nameInput.focus(); cx.notify(); };
    const row = h_flex().flex_none().px(16).py(6).gap(6).flex_wrap().items_center().border_b(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.primary, 0.06))
      .child(button(k, "dash-new", "New", ask("new", ""), { glyph: "plus", tip: "A new, empty dashboard" }))
      .when(!!cur, (el) => el
        .child(button(k, "dash-rename", "Rename", ask("rename", cur.dash.title), { glyph: "pen-line" }))
        .child(button(k, "dash-dup", "Duplicate", (cx) => this.duplicate(cx), { glyph: "copy" }))
        .child(button(k, "dash-json", "Edit JSON", (cx) => this.editJson(cx), { glyph: "code-xml", tip: `Open ${cur.name}.json in the Files editor` }))
        .child(button(k, "dash-del", sure ? "Delete this dashboard?" : "Delete", (cx) => this.deleteDashboard(cx), { glyph: "trash-2", variant: sure ? "destructive" : "outline", tip: "Moves the file into .trash in the dashboards folder" }))
        .when(sure, (e) => e.child(button(k, "dash-del-no", "Keep", (cx) => { this.confirm = null; cx.notify(); }))))
      .child(div().flex_1().min_w(8))
      .child(div().flex_none().max_w(280).truncate().text_size(11).text_color(this.editError ? k.destructiveText : k.dim)
        .child(this.editError ?? (this.saving ? "Saving…" : cur ? `Changes save to ${shortPath(this.dir())}/${cur.name}.json` : "")));
    if (!this.naming) return row;
    return v_flex().flex_none().child(row).child(h_flex().flex_none().px(16).py(6).gap(8).items_center().border_b(1).border_color(alpha(k.border, 0.6))
      .on_key_down((e, cx) => { if (e.key === "escape") { this.naming = null; cx.notify(); } })
      .child(div().flex_none().text_size(12).text_color(k.muted).child(this.naming.what === "new" ? "Name of the new dashboard" : "New name"))
      .child(div().flex_1().min_w(0).h(28).px(8).rounded(6).border(1).border_color(k.input).bg(k.background).text_size(13).child(Input.new(this.nameInput)))
      .child(button(k, "dash-name-ok", this.naming.what === "new" ? "Create" : "Rename", (cx) => this.applyName(cx), { variant: "default" }))
      .child(button(k, "dash-name-no", "Cancel", (cx) => { this.naming = null; cx.notify(); })));
  },
  applyName(cx) {
    const what = this.naming?.what, t = this.nameInput.value();
    if (what === "new") this.newDashboard(cx, t);
    else if (what === "rename") { this.naming = null; this.change(cx, { title: t }); }
    cx.notify();
  },
  initEditor() {
    this.editing = false;
    this.adding = false;
    this.form = null;
    this.confirm = null; // { key: "w:<i>" | "delete", until }
    this.naming = null; // { what: "new" | "rename" }
    this.editError = null;
    this.saving = false;
    this.backed = new Set(); // dashboards whose .bak this session has written
    this.nameInput = InputState.new({ placeholder: "e.g. My fleet" });
    this.nameInput.on("submit", (_e, cx) => this.applyName(cx));
  },
};
