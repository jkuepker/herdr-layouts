// The Settings dialog of the T3 mods (`ht3-panels.settings`, the Project popover's Settings row, the
// New chat dialog's button), drawn as T3 Code's settings pages (components/settings: SettingsSection's
// 16px semibold title over a SettingsGroup, a 12-round card at 40% whose rows are parted by hairlines,
// each a title and a muted line with its control at the end). Every change is written at once to
// ~/.config/herdr-app/data/ht3-settings.json (settings.js) and applies at once.
//
// For scripts and keys, while the dialog is open: `ht3-panels.ui:agent:<id>` flips an agent,
// `ui:default:<id>` makes it the default, `ui:models:<id>` opens its models, `ui:model:<id>=<model>`
// flips one model, `ui:allmodels:<id>` goes back to all, `ui:editor:<id>` flips an editor,
// `ui:side` flips the side panel's start, `ui:diffws` flips Hide whitespace in Diff, `ui:mdpreview` flips Markdown
// files opening as a preview, `ui:budget:<tokens>` sets the chat token budget (0 off; `ui:budget` alone takes the next choice),
// `ui:taskagent:<id>` and `ui:coordagent:<id>` set the tasks' and the coordinator's agent (with no id: the next choice; `default`:
// unset), `ui:taskmodel:<model>` and `ui:coordmodel:<model>` their models (with none: the agent's own), `ui:coordnotify` flips
// the coordinator's task notices, `ui:taskcap:<n>` sets how many tasks run at once (0: no cap; alone: the next choice), `ui:awake` flips Keep the Mac awake, `ui:close` closes.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay } from "herdr";
import { activeSpace } from "./side.js";
import { projectOf, scriptsOf, setScripts, toggleSetup, detectProject } from "./scripts.js";
import { importable } from "./detect.js";
import { tokens, alpha, icon, agentMark, button, iconButton, shortPath, badge } from "./look.js";
import { AGENTS, detect } from "./agent-acp.js";
import { EDITORS, editors } from "./menus.js";
import { enabledAgents, coordinatorNotify, prefs, agentOn, modelsOf, knownModels, editorOn, sideStartsHidden, firstAgent, setPref, settingsFile, followUp, checkpointsOn, toastsOn, soundsOn, keepAwakeOn, diffHidesWhitespace, commitStyle, COMMIT_STYLES, mdPreviewDefault, chatTokenBudget, taskMaxRunning } from "./settings.js";
import { cleanCap, capLabel, nextCap } from "./taskqueue.js";
import { BUDGETS, budgetLabel, nextBudget } from "./token-budget.js";

// Auto-settle's idle choices, as ht3-inbox autosettle.js AUTO_DAYS (a mod doesn't import another's files); 0 = off.
const AUTO_DAYS = [0, 1, 3, 7, 14];
const autoDays = () => { const n = Math.floor(Number(prefs().autoSettleDays)); return n > 0 ? n : 0; };
const autoDaysLabel = (n) => (!n ? "Off" : n === 1 ? "1 day" : `${n} days`);

export const SETTINGS_SIZE = { width: 640, height: 680 };

export class Settings {
  init(p, cx) {
    this.overlay = p.overlay;
    this.found = null;
    this.open = null; // the agent whose models show
    this.add = {};
    for (const a of AGENTS) {
      this.add[a.id] = InputState.new({ placeholder: "Filter models, or add one by its id" });
      this.add[a.id].on("change", (_e, cx) => cx.notify());
    }
    // Project scripts: the shown space's project, and the two fields a new one is typed into.
    this.project = null;
    this.editing = null; // the script whose pen was pressed
    this.importing = false; // Import scripts: the list of detected commands is open
    this.detected = null; // { scripts } the folder's package.json, Makefile and justfile say it has (detect.js)
    this.scriptName = InputState.new({ placeholder: "Name, e.g. Dev" });
    this.scriptCommand = InputState.new({ placeholder: "Command, e.g. npm run dev" });
    for (const f of [this.scriptName, this.scriptCommand]) { f.on("change", (_e, cx) => cx.notify()); f.on("submit", (_e, cx) => { this.addScript(); cx.notify(); }); }
    // Tasks and coordinator: the two model fields, saved with Enter or Save.
    this.roleModel = {};
    for (const role of ["task", "coordinator"]) {
      const f = this.roleModel[role] = InputState.new({ placeholder: "The agent's own model" });
      f.set_value(typeof prefs()[`${role}Model`] === "string" ? prefs()[`${role}Model`] : "");
      f.on("change", (_e, cx) => cx.notify());
      f.on("submit", (_e, cx) => { this.saveRoleModel(role); cx.notify(); });
    }
    cx.spawn(async (cx) => { this.project = await projectOf(activeSpace()).catch(() => null); cx.notify(); });
    cx.spawn(async (cx) => {
      this.found = (await detect(null)).found;
      // Each installed editor's own icon (menus.js).
      this.editorIcons = Object.fromEntries((await editors()).filter((e) => e.icon).map((e) => [e.id, e.icon]));
      cx.notify();
    });
  }
  close() {}

  command(c, cx) {
    if (!c.startsWith("ui:")) return;
    const [, what] = c.split(":"), rest = c.slice(4 + what.length);
    if (what === "agent") this.flipAgent(rest);
    else if (what === "default") this.setDefault(rest);
    else if (what === "models") this.open = this.open === rest ? null : rest;
    else if (what === "model") { const at = rest.indexOf("="); if (at > 0) this.flipModel(rest.slice(0, at), rest.slice(at + 1)); }
    else if (what === "allmodels") setPref(`agents.${rest}.models`, undefined);
    else if (what === "editor") setPref(`editors.${rest}`, editorOn(rest) ? false : undefined);
    else if (what === "side") this.flipSide();
    else if (what === "steer") setPref("followUp", followUp() === "steer" ? undefined : "steer");
    else if (what === "diffws") setPref("diffIgnoreWhitespace", diffHidesWhitespace() ? false : undefined);
    else if (what === "mdpreview") setPref("mdPreviewDefault", mdPreviewDefault() ? false : undefined);
    else if (what === "budget") { const n = rest === "" ? nextBudget(chatTokenBudget()) : BUDGETS.find((b) => String(b) === rest); if (n != null) setPref("chatTokenBudget", n ? n : undefined); }
    else if (what === "checkpoints") setPref("checkpoints", checkpointsOn() ? false : undefined);
    else if (what === "notifications") setPref("notifications", toastsOn() ? false : undefined);
    else if (what === "taskagent" || what === "coordagent") this.setRoleAgent(what === "taskagent" ? "task" : "coordinator", rest);
    else if (what === "taskmodel" || what === "coordmodel") { const role = what === "taskmodel" ? "task" : "coordinator"; this.roleModel[role].set_value(rest); this.saveRoleModel(role); }
    else if (what === "taskcap") setPref("taskMaxRunning", (rest === "" ? nextCap(taskMaxRunning()) : cleanCap(rest)) || undefined);
    else if (what === "coordnotify") setPref("coordinatorNotify", coordinatorNotify() ? false : undefined);
    else if (what === "awake") setPref("keepAwake", keepAwakeOn() ? undefined : true);
    // Auto-settle (ht3-inbox autosettle.js): ui:autosettle:<days> (0 off; alone: the next choice), ui:autosettle-merge and ui:autosettle-keep flip the two switches.
    else if (what === "autosettle") { const n = rest === "" ? AUTO_DAYS[(AUTO_DAYS.indexOf(autoDays()) + 1) % AUTO_DAYS.length] : AUTO_DAYS.find((d) => String(d) === rest); if (n != null) setPref("autoSettleDays", n || undefined); }
    else if (what === "autosettle-merge") setPref("autoSettleOnMerge", prefs().autoSettleOnMerge === true ? undefined : true);
    else if (what === "autosettle-keep") setPref("autoSettleKeepOpenPr", prefs().autoSettleKeepOpenPr === true ? undefined : true);
    else if (what === "sounds") setPref("sounds", soundsOn() ? undefined : true);
    // ui:script:<name>=<command> adds a project script (same name: replaces it), ui:unscript:<n> removes the nth.
    else if (what === "script") { const at = rest.indexOf("="); if (at > 0) { this.scriptName.set_value(rest.slice(0, at)); this.scriptCommand.set_value(rest.slice(at + 1)); this.addScript(); } }
    else if (what === "unscript") this.dropScript(Number(rest));
    // ui:setup:<n> marks the nth script as the setup script New worktree runs first (again: unmarks it).
    else if (what === "setup") { const s = scriptsOf(this.project?.key)[Number(rest)]; if (s) toggleSetup(this.project.key, s.name); }
    // ui:edit:<n> puts the nth script into the fields to change it (ui:script: then saves it in its place; ui:edit: alone gives up),
    // ui:move:<n>:<up|down> moves it one place.
    else if (what === "edit") this.editScript(rest === "" ? null : Number(rest));
    else if (what === "move") { const [n, way] = rest.split(":"); this.moveScript(Number(n), way === "up" ? -1 : 1); }
    // ui:import opens (again: closes) the list of commands the folder's package.json, Makefile and justfile have that
    // the project doesn't have as scripts yet; ui:import:<n> adds the nth (from 0), ui:import:all adds them all.
    else if (what === "import") this.importScripts(rest, cx);
    // ui:skip folds Agents and Editors away (and back), so a script's picture shows the sections under them.
    else if (what === "skip") this.skip = !this.skip;
    else if (what === "close") closeOverlay(this.overlay);
    cx.notify();
  }

  flipAgent(id) {
    setPref(`agents.${id}.enabled`, agentOn(id) ? false : undefined);
  }
  setDefault(id) {
    setPref("defaultAgent", prefs().defaultAgent === id ? undefined : id);
  }
  flipSide() {
    setPref("sidePanelHiddenInNewSpaces", sideStartsHidden() ? undefined : true);
  }
  // A role's agent ("task", "coordinator": settings.js roleAgent): `id` an agent's, "default" for unset, "" for the next of
  // Default and the agents that are on.
  setRoleAgent(role, id) {
    const key = `${role}Agent`, ids = [null, ...enabledAgents().map((a) => a.id)];
    const next = id === "" ? ids[(ids.indexOf(prefs()[key] ?? null) + 1) % ids.length] : id === "default" ? null : AGENTS.find((a) => a.id === id)?.id;
    if (next !== undefined) setPref(key, next ?? undefined);
  }
  // A role's model as its field holds it; an empty field is the agent's own.
  saveRoleModel(role) {
    setPref(`${role}Model`, this.roleModel[role].value().trim() || undefined);
  }
  // The two rows of a role: its agent, a button that goes through Default and the agents that are on, and its model.
  roleRows(k, role, name, unset) {
    const id = prefs()[`${role}Agent`] ?? null, a = AGENTS.find((x) => x.id === id), saved = typeof prefs()[`${role}Model`] === "string" ? prefs()[`${role}Model`].trim() : "";
    const typed = this.roleModel[role].value().trim();
    return [
      this.row(icon("bot").size(16).flex_none().text_color(k.muted), `${name} agent`, a ? (agentOn(a.id) ? `${a.name}. If it isn't installed: ${unset}.` : `${a.name} is turned off: ${unset} is used.`) : `Default: ${unset}.`,
        [button(k, `set-${role}-agent`, a?.name ?? (id ? String(id) : "Default"), (cx) => { this.setRoleAgent(role, ""); cx.notify(); }, { size: "sm", variant: "outline", tip: "Click to change: Default, then each agent that is on" })]),
      this.row(icon("brain").size(16).flex_none().text_color(k.muted), `${name} model`, saved ? `Set before the first message, when the chat starts on the agent above. Empty: the agent's own model.` : "The agent's own model. A model id here is set before the first message, when the chat starts on the agent above.",
        [div().w(220).flex_none().h(30).px(8).rounded(8).border(1).border_color(k.input).text_size(13).font_family(k.mono).child(Input.new(this.roleModel[role])),
          button(k, `set-${role}-model`, "Save", (cx) => { this.saveRoleModel(role); cx.notify(); }, { size: "sm", variant: typed !== saved ? "default" : "outline", disabled: typed === saved })]),
    ];
  }

  // The models an agent's list can hold: what it has offered, then ids added by hand.
  models(id) {
    const known = knownModels(id), only = modelsOf(id) ?? [];
    const all = [...known, ...only.filter((v) => !known.some((k) => k.value === v)).map((v) => ({ value: v, name: v, byHand: true }))];
    // With a list, what is on it comes first: it may be three of a hundred.
    return only.length ? [...all.filter((m) => only.includes(m.value)), ...all.filter((m) => !only.includes(m.value))] : all;
  }
  // With no list every model shows; the first one unticked starts the list from all of them.
  flipModel(id, value) {
    const all = this.models(id).map((m) => m.value);
    const only = modelsOf(id) ?? all;
    const next = only.includes(value) ? only.filter((v) => v !== value) : [...only, value];
    const whole = all.length > 0 && all.every((v) => next.includes(v)) && next.every((v) => all.includes(v));
    setPref(`agents.${id}.models`, whole || !next.length ? undefined : next);
  }
  addModel(id) {
    const value = this.add[id].value().trim();
    if (!value) return;
    const only = modelsOf(id) ?? this.models(id).map((m) => m.value);
    if (!only.includes(value)) setPref(`agents.${id}.models`, [...only, value]);
    this.add[id].set_value("");
  }

  // Add, or, while one is being edited, Save: the changed script stays in its place.
  addScript() {
    const name = this.scriptName.value().trim(), command = this.scriptCommand.value().trim();
    if (!this.project || !name || !command) return;
    const list = scriptsOf(this.project.key), at = this.editing;
    if (at != null && list[at]) setScripts(this.project.key, list.map((s, i) => (i === at ? { name, command } : s)).filter((s, i) => i === at || s.name !== name));
    else setScripts(this.project.key, [...list.filter((s) => s.name !== name), { name, command }]);
    this.editScript(null);
  }

  // Import scripts: reads the folder (package.json scripts, Makefile targets, justfile recipes) and offers what the
  // project doesn't have yet. `which`: "" opens or closes the list, "all" or a number adds from it.
  offers() { return this.detected && this.project ? importable(this.detected.scripts, scriptsOf(this.project.key)) : []; }
  importScripts(which, cx) {
    if (!this.project) return;
    if (which === "") {
      this.importing = !this.importing;
      if (this.importing) {
        this.detected = null;
        cx.spawn(async (cx) => { this.detected = await detectProject(this.project.cwd, this.project.on).catch(() => ({ scripts: [] })); cx.notify(); });
      }
      return;
    }
    const offers = this.offers(), pick = which === "all" ? offers : [offers[Number(which)]].filter(Boolean);
    if (pick.length) setScripts(this.project.key, [...scriptsOf(this.project.key), ...pick.map((s) => ({ name: s.name, command: s.command }))]);
  }

  // The pen: the script goes into the two fields; null leaves them empty again.
  editScript(i) {
    const s = i == null || !this.project ? null : scriptsOf(this.project.key)[i];
    this.editing = s ? i : null;
    this.scriptName.set_value(s?.name ?? "");
    this.scriptCommand.set_value(s?.command ?? "");
    if (s) this.scriptCommand.focus();
  }

  moveScript(i, by) {
    if (!this.project) return;
    const list = [...scriptsOf(this.project.key)], to = i + by;
    if (!list[i] || to < 0 || to >= list.length) return;
    [list[i], list[to]] = [list[to], list[i]];
    setScripts(this.project.key, list);
    if (this.editing === i) this.editing = to; else if (this.editing === to) this.editing = i;
  }

  dropScript(i) {
    if (!this.project) return;
    setScripts(this.project.key, scriptsOf(this.project.key).filter((_s, n) => n !== i));
    if (this.editing != null) this.editScript(null);
  }

  // ui/switch.tsx: 28 by 16, a 12px thumb.
  toggle(k, id, on, label, onClick) {
    return h_flex().id(id).w(28).h(16).p(2).flex_none().items_center().rounded_full().cursor_pointer()
      .bg(on ? k.primary : k.input).role("switch").accessibility_label(`${label}: ${on ? "on" : "off"}`)
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .child(div().size(12).rounded_full().bg(on ? k.primaryText : k.foreground).ml(on ? 12 : 0));
  }

  section(k, title, about, rows) {
    return v_flex().gap(10)
      .child(v_flex().px(12).gap(2)
        .child(div().text_size(16).font_semibold().child(title))
        .child(div().text_size(12).line_height("16px").text_color(k.muted).child(about)))
      .child(v_flex().rounded(12).border(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.card, 0.4)).overflow_hidden()
        .children(rows.map((r, i) => (i ? v_flex().border_t(1).border_color(alpha(k.border, 0.5)).child(r) : r))));
  }

  row(lead, title, about, trail) {
    const k = tokens();
    return h_flex().min_h(52).px(12).py(8).gap(12).items_center()
      .when(!!lead, (el) => el.child(lead))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(14).font_medium().truncate().child(title))
        .when(!!about, (el) => el.child(div().text_size(12).line_height("16px").text_color(k.muted).truncate().child(about))))
      .children(trail);
  }

  agentRow(k, a) {
    const on = agentOn(a.id), path = this.found?.[a.argv[0]], only = modelsOf(a.id), all = this.models(a.id);
    const isDefault = firstAgent(this.found) === a.id, chosen = prefs().defaultAgent === a.id, open = this.open === a.id;
    const mark = h_flex().size(20).flex_none().items_center().justify_center().opacity(on ? 1 : 0.5)
      .child(agentMark(a, 16, k.foreground) ?? icon("bot").size(16).text_color(k.muted));
    const about = this.found == null ? a.argv.join(" ") : path ? a.argv.join(" ") : `not installed${a.hint ? ` · ${a.hint}` : ""}`;
    const count = only ? `${only.length} of ${Math.max(all.length, only.length)} models` : all.length ? `All ${all.length} models` : "All models";
    const head = this.row(mark, a.name, about, [
      on && path ? (isDefault
        ? h_flex().id(`set-default-${a.id}`).h(18).px(4).flex_none().items_center().rounded(4).text_size(12).font_medium().bg(k.accent).cursor_pointer()
          .tooltip(chosen ? "The default agent. Click to go back to the first installed one." : "Comes up first: the first installed agent.")
          .on_click((_e, cx) => { this.setDefault(a.id); cx.notify(); }).child("Default")
        : button(k, `set-default-${a.id}`, "Make default", (cx) => { this.setDefault(a.id); cx.notify(); }, { variant: "ghost-muted" })) : null,
      h_flex().id(`set-models-${a.id}`).h(24).px(6).gap(4).flex_none().items_center().rounded(6).text_size(12).text_color(k.muted).cursor_pointer()
        .role("button").accessibility_label(`${a.name} models`).hover((s) => s.bg(k.accent).text_color(k.foreground))
        .on_click((_e, cx) => { this.open = open ? null : a.id; cx.notify(); })
        .child(count).child(icon(open ? "chevron-up" : "chevron-down").size(12).flex_none()),
      this.toggle(k, `set-agent-${a.id}`, on, a.name, () => this.flipAgent(a.id)),
    ].filter(Boolean));
    if (!open) return head;
    // ProviderModelsSection.tsx: 28px rows, the name and its id in mono beside it.
    // What is typed narrows the list; Add takes it as an id the agent hasn't listed.
    const adding = this.add[a.id].value().trim(), needle = adding.toLowerCase();
    const shown = needle ? all.filter((m) => m.name.toLowerCase().includes(needle) || m.value.toLowerCase().includes(needle)) : all;
    const isNew = !!adding && !all.some((m) => m.value === adding);
    return v_flex().child(head)
      .child(v_flex().px(12).pb(10).gap(6)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(12).line_height("16px").text_color(k.muted)
            .child(all.length ? "Ticked models show in this agent's model picker. The one a chat is using always shows." : "This agent hasn't listed its models yet: start a chat with it once, or add ids by hand."))
          .when(!!only, (el) => el.child(button(k, `set-all-${a.id}`, "Show all", (cx) => { setPref(`agents.${a.id}.models`, undefined); cx.notify(); }))))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().h(28).px(9).rounded(8).border(1).border_color(k.input).text_size(13).child(Input.new(this.add[a.id])))
          .child(button(k, `set-add-${a.id}`, "Add", (cx) => { this.addModel(a.id); cx.notify(); }, { size: "sm", disabled: !isNew })))
        .when(shown.length > 0, (el) => el.child(v_flex().id(`set-list-${a.id}`).max_h(196).overflow_y_scrollbar().rounded(8).border(1).border_color(alpha(k.border, 0.5))
          .children(shown.map((m) => {
            const i = all.indexOf(m);
            const ticked = !only || only.includes(m.value);
            return h_flex().id(`set-model-${a.id}-${i}`).h(28).px(8).gap(8).flex_none().items_center().text_size(13).cursor_pointer()
              .role("check_box").accessibility_label(`${m.name}: ${ticked ? "shown" : "hidden"}`).hover((s) => s.bg(alpha(k.accent, 0.6)))
              .on_click((_e, cx) => { this.flipModel(a.id, m.value); cx.notify(); })
              .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border(1)
                .border_color(ticked ? k.primary : k.input).bg(ticked ? k.primary : "#00000000").text_color(k.primaryText)
                .when(ticked, (e) => e.child(icon("check").size(12))))
              .child(div().flex_none().max_w(260).truncate().text_color(ticked ? k.foreground : k.muted).child(m.name))
              .when(m.name !== m.value, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).font_family(k.mono).text_color(alpha(k.muted, 0.7)).child(m.value)))
              .when(!!m.byHand, (e) => e.child(div().flex_none().text_size(11).text_color(alpha(k.muted, 0.7)).child("custom")));
          })))));
  }

  render(_cx) {
    const k = tokens();
    return v_flex().id("ht3-settings").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(h_flex().h(56).px(24).gap(8).flex_none().items_center().border_b(1).border_color(k.border)
        .child(div().flex_1().text_size(20).font_semibold().child("Settings"))
        .child(iconButton(k, "set-close", "x", () => closeOverlay(this.overlay), { tip: "Close" })))
      .child(v_flex().id("ht3-settings-body").flex_1().min_h(0).px(12).py(16).gap(24).overflow_y_scrollbar()
        .when(!this.skip, (top) => top
        .child(this.section(k, "Agents", "The agents New chat and Side chat offer, the one they come up with, and the models each one's chats list.",
          AGENTS.map((a) => this.agentRow(k, a))))
        .child(this.section(k, "Editors", "The editors the Project popover lists, of those installed on this computer.",
          EDITORS.map((e) => this.row(this.editorIcons?.[e.id] ? image(this.editorIcons[e.id]).w(16).h(16).flex_none() : icon("code-xml").size(16).flex_none().text_color(k.muted), e.name, `${e.app}.app, or ${e.bin} on the PATH`,
            [this.toggle(k, `set-editor-${e.id}`, editorOn(e.id), e.name, () => setPref(`editors.${e.id}`, editorOn(e.id) ? false : undefined))])))))
        .child(this.section(k, "Chats", "How a chat with an agent behaves.",
          [this.row(icon("rows-2").size(16).flex_none().text_color(k.muted), "Steer instead of queue", "A message sent while the agent works interrupts it. Off: it waits for the turn to end.",
            [this.toggle(k, "set-steer", followUp() === "steer", "Steer instead of queue", () => setPref("followUp", followUp() === "steer" ? undefined : "steer"))]),
          this.row(icon("clock").size(16).flex_none().text_color(k.muted), "Resume chats when a usage limit resets", "A chat stopped by a usage limit sends “continue” when the limit resets.",
            [this.toggle(k, "set-resume-limit", prefs().autoResumeLimit === true, "Resume chats when a usage limit resets", () => setPref("autoResumeLimit", prefs().autoResumeLimit === true ? undefined : true))]),
          this.row(icon("gauge").size(16).flex_none().text_color(k.muted), "Token budget per chat", "A chat that has used 80% of this many input + output tokens (as its agent reports them) shows a warning over the message box; at 100% the line offers Stop and New session. Agents that report no tokens show nothing.",
            [button(k, "set-token-budget", budgetLabel(chatTokenBudget()), () => setPref("chatTokenBudget", nextBudget(chatTokenBudget()) || undefined), { size: "sm", variant: "outline", tip: "Click to change: Off, 100k, 250k, 500k, 1M, 2M" })]),
          this.row(icon("rotate-ccw").size(16).flex_none().text_color(k.muted), "Checkpoints", "In a Git repository, snapshot the files before and after each turn, for its diff and for Revert.",
            [this.toggle(k, "set-checkpoints", checkpointsOn(), "Checkpoints", () => setPref("checkpoints", checkpointsOn() ? false : undefined))]),
          this.row(icon("bell").size(16).flex_none().text_color(k.muted), "Notify", "A notification when a chat you aren't looking at finishes or needs an approval. A click on it shows the chat.",
            [this.toggle(k, "set-notifications", toastsOn(), "Notify", () => setPref("notifications", toastsOn() ? false : undefined))]),
          this.row(icon("volume-2").size(16).flex_none().text_color(k.muted), "Sound", "Play Herdr's done or blocked sound then.",
            [this.toggle(k, "set-sounds", soundsOn(), "Sound", () => setPref("sounds", soundsOn() ? undefined : true))]),
          this.row(icon("monitor").size(16).flex_none().text_color(k.muted), "Keep the Mac awake while agents work", "While a chat or task agent is working, the Mac doesn't go to sleep (caffeinate). The display may still turn off.",
            [this.toggle(k, "set-awake", keepAwakeOn(), "Keep the Mac awake while agents work", () => setPref("keepAwake", keepAwakeOn() ? undefined : true))])]))
        // Auto-settle: the Inbox reads these three (ht3-inbox autosettle.js), all off by default.
        .child(this.section(k, "Inbox", "Chats the Inbox settles by itself. New work brings a settled chat back.",
          [this.row(icon("clock").size(16).flex_none().text_color(k.muted), "Settle chats idle for", "A chat with no activity for this long is settled. Never one that works, waits for you, is in front, pinned or snoozed.",
            [button(k, "set-autosettle-days", autoDaysLabel(autoDays()), () => setPref("autoSettleDays", AUTO_DAYS[(AUTO_DAYS.indexOf(autoDays()) + 1) % AUTO_DAYS.length] || undefined), { size: "sm", variant: "outline", tip: "Click to change: Off, 1 day, 3 days, 7 days, 14 days" })]),
          this.row(icon("git-merge").size(16).flex_none().text_color(k.muted), "Settle chats whose pull request merged", "A task's chat is settled once its branch was merged (Tasks' Merge), unless it went on working after that.",
            [this.toggle(k, "set-autosettle-merge", prefs().autoSettleOnMerge === true, "Settle chats whose pull request merged", () => setPref("autoSettleOnMerge", prefs().autoSettleOnMerge === true ? undefined : true))]),
          this.row(icon("git-pull-request").size(16).flex_none().text_color(k.muted), "Keep chats with an open pull request", "Idleness doesn't settle a task's chat whose branch isn't merged yet. A merge still does.",
            [this.toggle(k, "set-autosettle-keep", prefs().autoSettleKeepOpenPr === true, "Keep chats with an open pull request", () => setPref("autoSettleKeepOpenPr", prefs().autoSettleKeepOpenPr === true ? undefined : true))])]))
        .child(this.section(k, "Tasks and coordinator", "The agents that work on tasks (Tasks' Run with agent, the coordinator's tasks) and the coordinator chat that plans and starts them.",
          [...this.roleRows(k, "task", "Task", "the agent New chat comes up with"),
            this.row(icon("list-checks").size(16).flex_none().text_color(k.muted), "Tasks running at once", "A task started beyond this many is queued (Tasks' Run with agent, the coordinator's run) and starts when a running one ends. A task that waits for an approval still counts as running; one that is done, failed, closed or merged does not.",
              [button(k, "set-task-cap", capLabel(taskMaxRunning()), () => setPref("taskMaxRunning", nextCap(taskMaxRunning()) || undefined), { size: "sm", variant: "outline", tip: "Click to change: No cap, 1, 2, 3, 4, 6, 8" })]),
            ...this.roleRows(k, "coordinator", "Coordinator", "Claude Code, else the agent New chat comes up with"),
            this.row(icon("messages-square").size(16).flex_none().text_color(k.muted), "Tell the coordinator about tasks", "Herdr sends the coordinator chat a short message when a task's chat finished, failed, waits for an approval or was closed: at most one in 45 seconds. Off: it learns of them when it next reads its state file.",
              [this.toggle(k, "set-coord-notify", coordinatorNotify(), "Tell the coordinator about tasks", () => setPref("coordinatorNotify", coordinatorNotify() ? false : undefined))])]))
        .when(!!this.project, (el) => el.child(this.section(k, "Project scripts", `Commands for ${this.project.name} (${shortPath(this.project.root)}${this.project.on ? ` on ${this.project.on}` : ""}), the project of the shown space. The Project popover runs them in a side terminal. The one marked with the wrench is the setup script: New worktree runs it in the new worktree before the chat starts.`,
          [...scriptsOf(this.project.key).map((s, i, all) => this.row(icon("square-terminal").size(16).flex_none().text_color(k.muted),
            s.setup ? h_flex().gap(6).items_center().child(div().min_w(0).truncate().child(s.name)).child(badge(k, "setup", "info")) : s.name, s.command,
            [iconButton(k, `script-setup-${i}`, "wrench", (cx) => { toggleSetup(this.project.key, s.name); cx.notify(); }, { tip: s.setup ? "The setup script: runs in a new worktree before its chat starts. Click to unmark" : "Run in a new worktree before its chat starts", on: !!s.setup }),
              ...(all.length > 1 ? [iconButton(k, `script-up-${i}`, "chevron-up", (cx) => { this.moveScript(i, -1); cx.notify(); }, { tip: "Move up" }).opacity(i ? 1 : 0.3),
              iconButton(k, `script-down-${i}`, "chevron-down", (cx) => { this.moveScript(i, 1); cx.notify(); }, { tip: "Move down" }).opacity(i < all.length - 1 ? 1 : 0.3)] : []),
              iconButton(k, `script-edit-${i}`, "pen-line", (cx) => { this.editScript(this.editing === i ? null : i); cx.notify(); }, { tip: `Change ${s.name}`, on: this.editing === i }),
              iconButton(k, `script-drop-${i}`, "trash-2", (cx) => { this.dropScript(i); cx.notify(); }, { tip: `Remove ${s.name}` })])),
          h_flex().min_h(52).px(12).py(8).gap(8).items_center()
            .child(div().w(150).flex_none().h(30).px(8).rounded(8).border(1).border_color(k.input).text_size(13).child(Input.new(this.scriptName)))
            .child(div().flex_1().min_w(0).h(30).px(8).rounded(8).border(1).border_color(k.input).text_size(13).font_family(k.mono).child(Input.new(this.scriptCommand)))
            .when(this.editing != null, (e) => e.child(button(k, "script-cancel", "Cancel", (cx) => { this.editScript(null); cx.notify(); }, { size: "sm", variant: "outline" })))
            .child(button(k, "script-add", this.editing != null ? "Save" : "Add", (cx) => { this.addScript(); cx.notify(); }, { size: "sm", variant: this.editing != null ? "default" : "outline", disabled: !this.scriptName.value().trim() || !this.scriptCommand.value().trim() })),
          // Import scripts: what package.json, a Makefile or a justfile in the folder has, to add as scripts.
          this.row(icon("list-plus").size(16).flex_none().text_color(k.muted), "Import scripts", this.importing ? (this.detected ? (this.offers().length ? `${this.offers().length} to add from package.json, Makefile and justfile` : "Nothing new: every command found is already a script.") : "Reading the folder…") : "Offers the package.json scripts, Makefile targets and justfile recipes of the folder.",
            [...(this.importing && this.offers().length > 1 ? [button(k, "script-import-all", "Add all", (cx) => { this.importScripts("all", cx); cx.notify(); }, { size: "sm", variant: "default" })] : []),
              button(k, "script-import", this.importing ? "Close" : "Import…", (cx) => { this.importScripts("", cx); cx.notify(); }, { size: "sm", variant: "outline" })]),
          ...(this.importing ? this.offers().map((s, i) => this.row(icon("square-terminal").size(16).flex_none().text_color(k.muted),
            h_flex().gap(6).items_center().child(div().min_w(0).truncate().child(s.name)).child(badge(k, s.source)), s.command,
            [button(k, `script-import-${i}`, "Add", (cx) => { this.importScripts(String(i), cx); cx.notify(); }, { size: "sm", variant: "outline" })])) : [])])))
        .child(this.section(k, "Files", "How the Files editor opens files.",
          [this.row(icon("eye").size(16).flex_none().text_color(k.muted), "Preview Markdown files", "A .md, .mdx or .markdown file opens as its rendered preview. The Preview button in the editor still switches one file, and the choice is kept for the session.",
            [this.toggle(k, "set-md-preview", mdPreviewDefault(), "Preview Markdown files", () => setPref("mdPreviewDefault", mdPreviewDefault() ? false : undefined))])]))
        .child(this.section(k, "Diff", "How the Diff surface shows changes.",
          [this.row(icon("pilcrow").size(16).flex_none().text_color(k.muted), "Hide whitespace changes", "Runs every diff and commit view with -w, so lines that only changed in whitespace don't show. Also the pilcrow button in Diff's header.",
            [this.toggle(k, "set-diff-ws", diffHidesWhitespace(), "Hide whitespace changes", () => setPref("diffIgnoreWhitespace", diffHidesWhitespace() ? false : undefined))])]))
        .child(this.section(k, "Commit messages", "What Write message in the Commit step asks the agent for.", [this.row(icon("git-commit-horizontal").size(16).flex_none().text_color(k.muted), "Message style", { plain: "A short imperative subject, then a body if it needs one.", conventional: "type(scope): subject (feat, fix, docs, refactor, test, chore, perf, build, ci). Typed messages that don't match get a warning.", template: "The format of the repository's commit.template, or .gitmessage. Without one: plain." }[commitStyle()], [button(k, "set-commit-style", { plain: "Plain", conventional: "Conventional", template: "Template" }[commitStyle()], () => { const next = COMMIT_STYLES[(COMMIT_STYLES.indexOf(commitStyle()) + 1) % COMMIT_STYLES.length]; setPref("commitStyle", next === "plain" ? undefined : next); }, { size: "sm", variant: "outline", tip: "Click to change" })])]))
        .child(this.section(k, "Side panel", "How the right panel comes up.",
          [this.row(icon("panel-right").size(16).flex_none().text_color(k.muted), "Start hidden in new spaces", "A space shown for the first time comes up without the side panel.",
            [this.toggle(k, "set-side", sideStartsHidden(), "Start hidden in new spaces", () => this.flipSide())])])))
      .child(h_flex().h(40).px(24).flex_none().items_center().border_t(1).border_color(k.border).text_size(12).text_color(k.muted)
        .child(div().min_w(0).truncate().child(`Saved as you go to ${shortPath(settingsFile())}, which you can also edit by hand.`)));
  }
}
