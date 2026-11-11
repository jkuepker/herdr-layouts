// Editing a dashboard from the Dashboard surface, as data (dash-editor.js is the UI over it). No Herdr calls here,
// so node runs it (t3-panels/dashboards/test.mjs): every change goes raw file object -> edit() -> checked() -> text,
// and only a text that reads back as a dashboard is ever written.
//
// The file's own object is what gets edited, so a field this surface doesn't know (or a named source under
// "sources") stays as it was. A saved file is written as plain two-space JSON: hand formatting is not kept.

import { pick, isPath, readDashboard, TYPES, typeOf } from "./dash-data.js";

// The widget types, in the order the "Add widget" picker shows them, each with what it is for and what a new one
// starts as (data written in the file, so it draws at once; its settings then point it at a real source).
export const WIDGETS = [
  { type: "stat", about: "One number, coloured by thresholds, with a sparkline",
    make: { type: "stat", title: "New stat", w: 1, source: { type: "static", data: 42 }, thresholds: { warn: 80, bad: 95 } } },
  { type: "table", about: "Rows and columns, a row can run a Herdr command",
    make: { type: "table", title: "New table", w: 2, source: { type: "static", data: [{ name: "one", value: 1 }, { name: "two", value: 2 }] },
      columns: [{ title: "Name", value: ".name" }, { title: "Value", value: ".value", w: 64 }] } },
  { type: "list", about: "A line per item, with a status dot",
    make: { type: "list", title: "New list", w: 2, source: { type: "static", data: [{ label: "first", state: "running" }, { label: "second", state: "queued" }] }, text: ".label", state: ".state" } },
  { type: "bars", about: "A horizontal bar per item, against a maximum",
    make: { type: "bars", title: "New bars", w: 2, source: { type: "static", data: [{ name: "one", used: 30, cap: 100 }, { name: "two", used: 85, cap: 100 }] }, label: ".name", value: ".used", max: ".cap" } },
  { type: "line", about: "Series over time, from a Prometheus range query",
    make: { type: "line", title: "New line", w: 2, source: { type: "static", data: [{ host: "sample", points: [[0, 1], [60, 3], [120, 2], [180, 5], [240, 4]] }] }, legend: "{.host}" } },
  { type: "status", about: "A dot and a label per item: up, starting, down",
    make: { type: "status", title: "New status", w: 2, source: { type: "static", data: [{ name: "api", state: "up" }, { name: "worker", state: "down" }] }, state: ".state" } },
];
export const widgetInfo = (type) => WIDGETS.find((w) => w.type === type) ?? null;

// Source types the settings offer, and "named" for a source written once under the file's "sources".
export const SOURCE_KINDS = ["prometheus", "command", "http", "file", "fleetq", "projects", "static", "named"];
const PARSE = ["auto", "json", "lines", "text", "number"];
const FORMATS = ["number", "percent", "bytes", "age", "since", "text"];

// A settings field: { key (a dotted place in the widget), label, kind, hint, options }.
// kind: text, path (a path or a template), pathOnly, pick (chips the surface fills in), number, json, bool, choice, lines (text over several lines).
const SOURCE_FIELDS = {
  prometheus: [
    { key: "source.query", label: "Query", kind: "text", hint: "PromQL, e.g. sum by (host) (up)" },
    { key: "source.range", label: "Range", kind: "text", hint: "e.g. 30m: each row gets points, for a line or a sparkline" },
    { key: "source.step", label: "Step, seconds", kind: "number", min: 1 },
    { key: "source.queries", label: "Queries", kind: "json", shape: "object", hint: '{ "name": "query", … } instead of Query: one row per value of By' },
    { key: "source.by", label: "By", kind: "text", hint: "the label that Queries are joined on, e.g. host" },
    { key: "source.url", label: "Server", kind: "text", hint: 'default: the file\'s "prometheus"' },
  ],
  command: [
    { key: "source.shell", label: "Shell line", kind: "text", hint: "a line of sh; or Program and Arguments" },
    { key: "source.run", label: "Program", kind: "text" },
    { key: "source.args", label: "Arguments", kind: "json", shape: "array", hint: '["status", "--json"]' },
    { key: "source.on", label: "Machine", kind: "text", hint: "as a space's machine; empty: this computer" },
    { key: "source.cwd", label: "Folder", kind: "text" },
    { key: "source.timeout", label: "Timeout, seconds", kind: "number", min: 1 },
    { key: "source.parse", label: "Read as", kind: "choice", options: PARSE },
  ],
  http: [
    { key: "source.url", label: "URL", kind: "text", hint: "http:// or https://, a GET" },
    { key: "source.headers", label: "Headers", kind: "json", shape: "object" },
    { key: "source.parse", label: "Read as", kind: "choice", options: PARSE },
  ],
  file: [
    { key: "source.path", label: "Path", kind: "text", hint: "~/ is the home folder" },
    { key: "source.on", label: "Machine", kind: "text" },
    { key: "source.parse", label: "Read as", kind: "choice", options: PARSE },
  ],
  fleetq: [],
  projects: [
    { key: "source.extra", label: "More folders", kind: "json", shape: "array", hint: '[{ "path": "~/code/x", "name": "x", "on": null }]' },
    { key: "source.gh", label: "Ask GitHub", kind: "choice", options: ["true", "false"], json: true },
  ],
  static: [{ key: "source.data", label: "Data", kind: "json", hint: "any JSON: the widget's data, written here" }],
  named: [{ key: "source", label: "Source name", kind: "text", hint: 'a name under the file\'s "sources"' }],
};
const VALUE_FIELDS = [
  { key: "unit", label: "Unit", kind: "text" },
  { key: "format", label: "Format", kind: "choice", options: FORMATS },
  { key: "decimals", label: "Decimals", kind: "number", min: 0 },
  { key: "scale", label: "Scale", kind: "number", hint: "the value is multiplied by this" },
];
const TYPE_FIELDS = {
  stat: [{ key: "value", label: "Value", kind: "path", hint: "a path into the data, e.g. .free" }, { key: "count", label: "Count the rows", kind: "bool" },
    ...VALUE_FIELDS, { key: "sub", label: "Line under it", kind: "path" }, { key: "spark", label: "Sparkline", kind: "bool" }],
  table: [{ key: "columns", label: "Columns", kind: "json", shape: "array", hint: '[{ "title", "value", "w", "unit", "thresholds", "dot" }]' },
    { key: "click", label: "Row click", kind: "json", shape: "object", hint: '{ "run": "space.select", "args": { "id": ".space" } }' }],
  list: [{ key: "text", label: "Text", kind: "path" }, { key: "sub", label: "Right side", kind: "path" }, { key: "state", label: "State (the dot)", kind: "path" }],
  bars: [{ key: "label", label: "Label", kind: "path" }, { key: "value", label: "Value", kind: "path" }, { key: "max", label: "Maximum", kind: "numberOrPath", hint: "a number, or a path" },
    { key: "of", label: "Colour follows", kind: "path" }, ...VALUE_FIELDS],
  line: [{ key: "legend", label: "Legend", kind: "path", hint: "a template per series, e.g. {.host}" }, { key: "min", label: "Scale from", kind: "number" }, { key: "max", label: "Scale to", kind: "number" }, ...VALUE_FIELDS],
  status: [{ key: "label", label: "Label", kind: "path" }, { key: "state", label: "State", kind: "path" }, { key: "sub", label: "Note", kind: "path" }],
};
// What the widget types added later bring (dash-types.js) is registered here by them.
// source: true (needs one), false (has none: a link, a terminal button), "optional" (a text: written in the file, or from a source).
export function registerWidget(info, fields, { source = true } = {}) {
  if (!WIDGETS.some((w) => w.type === info.type)) WIDGETS.push(info);
  TYPE_FIELDS[info.type] = fields;
  if (!TYPES.includes(info.type)) TYPES.push(info.type);
  if (source === false) NO_SOURCE.add(info.type);
  if (source === "optional") OPTIONAL_SOURCE.add(info.type);
}
// Types that have no source, and types that may go without one.
export const NO_SOURCE = new Set();
export const OPTIONAL_SOURCE = new Set();
// The source kinds a type's settings offer: "none" where it may go without.
export const sourceKindsFor = (type) => (OPTIONAL_SOURCE.has(type) ? ["none", ...SOURCE_KINDS] : SOURCE_KINDS);

const COMMON_HEAD = [{ key: "title", label: "Title", kind: "text" }];
const COMMON_DATA = [
  { key: "pick", label: "Pick", kind: "pathOnly", hint: "a path into what the source answers, e.g. .hosts[]" },
  { key: "filter", label: "Filter", kind: "json", shape: "object", hint: '{ "path": ".state", "match": "^running$" }' },
  { key: "sort", label: "Sort by", kind: "text", hint: "a path; - in front for largest first" },
  { key: "limit", label: "At most", kind: "number", min: 1 },
  { key: "refresh", label: "Refresh, seconds", kind: "number", min: 5, hint: "empty: the dashboard's" },
  { key: "thresholds", label: "Thresholds", kind: "json", hint: '{ "warn": 80, "bad": 95 } or { "below": true, "warn": 20, "bad": 10 }' },
  { key: "empty", label: "When empty", kind: "text" },
];

export function sourceKindOf(widget) {
  if (typeof widget?.source === "string") return "named";
  if (!widget?.source && OPTIONAL_SOURCE.has(widget?.type)) return "none";
  return SOURCE_KINDS.includes(widget?.source?.type) ? widget.source.type : "static";
}
// The fields of a widget's settings, in order: [{ group, fields }].
export function fieldsFor(type, sourceKind) {
  const own = TYPE_FIELDS[type] ?? [];
  const groups = [{ group: "Widget", fields: [...COMMON_HEAD, ...own] }];
  if (sourceKind === "none") groups.push({ group: "Source", fields: [] });
  else if (!NO_SOURCE.has(type)) {
    groups.push({ group: "Source", fields: SOURCE_FIELDS[sourceKind] ?? [] });
    groups.push({ group: "Data", fields: COMMON_DATA });
  }
  return groups;
}

const getAt = (o, key) => key.split(".").reduce((v, k) => (v != null && typeof v === "object" ? v[k] : undefined), o);
function setAt(o, key, value) {
  const ks = key.split(".");
  let at = o;
  for (const k of ks.slice(0, -1)) { if (at[k] == null || typeof at[k] !== "object") at[k] = {}; at = at[k]; }
  if (value === undefined) delete at[ks.at(-1)]; else at[ks.at(-1)] = value;
}

// What a field's input starts with.
export function fieldText(widget, f) {
  const v = getAt(widget, f.key);
  if (v == null) return "";
  if (f.kind === "bool") return v ? "yes" : "";
  if (f.kind === "json" || (f.json && typeof v !== "string")) return f.kind === "json" ? JSON.stringify(v) : String(v);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function checkPath(text) {
  if (isPath(text)) pick({}, text);
  else for (const m of text.matchAll(/\{([^{}]+)\}/g)) pick({}, m[1].trim());
}
// One field's text -> its value (undefined: leave the key out). Throws a sentence when the text can't be that.
export function fieldValue(f, text) {
  const t = f.kind === "lines" ? String(text ?? "") : String(text ?? "").trim();
  if (t === "") return undefined;
  if (f.kind === "number") {
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error("Needs a number");
    if (f.min != null && n < f.min) throw new Error(`At least ${f.min}`);
    return n;
  }
  if (f.kind === "json") {
    let v;
    try { v = JSON.parse(t); } catch (e) { throw new Error(`Not JSON: ${String(e?.message ?? e).slice(0, 80)}`); }
    if (f.shape === "array" && !Array.isArray(v)) throw new Error("Needs a list: [ … ]");
    if (f.shape === "object" && (v == null || typeof v !== "object" || Array.isArray(v))) throw new Error("Needs an object: { … }");
    return v;
  }
  if (f.kind === "bool") return /^(yes|true|1|on)$/i.test(t) ? true : undefined;
  if (f.kind === "pick") return t; // one of a list the surface knows only while it runs (xo's projects)
  if (f.kind === "choice") {
    if (!f.options.includes(t)) throw new Error(`One of: ${f.options.join(", ")}`);
    return f.json ? JSON.parse(t) : t;
  }
  if (f.kind === "pathOnly") {
    if (!t.startsWith(".")) throw new Error("A path starts with a dot: .hosts[]");
    try { pick({}, t); } catch (e) { throw new Error(String(e?.message ?? e)); }
    return t;
  }
  if (f.kind === "path") { try { checkPath(t); } catch (e) { throw new Error(String(e?.message ?? e)); } return t; }
  if (f.kind === "numberOrPath") {
    if (Number.isFinite(Number(t))) return Number(t);
    try { checkPath(t); } catch (e) { throw new Error(String(e?.message ?? e)); }
    return t;
  }
  return t;
}

// The settings form applied to a widget. texts: { key: text }. -> { widget } or { errors: { key: sentence } }.
// A source of another kind than before starts empty, so the old kind's fields don't stay behind.
export function applyForm(widget, sourceKind, texts) {
  const next = JSON.parse(JSON.stringify(widget)), errors = {};
  if (sourceKind === "none") delete next.source;
  else if (!NO_SOURCE.has(widget.type)) {
    if (sourceKind === "named") next.source = typeof widget.source === "string" ? widget.source : "";
    else if (sourceKindOf(widget) !== sourceKind || typeof next.source !== "object" || !next.source) next.source = { type: sourceKind };
    else next.source.type = sourceKind;
  }
  for (const g of fieldsFor(widget.type, sourceKind)) for (const f of g.fields) {
    if (!(f.key in texts)) continue;
    try { setAt(next, f.key, fieldValue(f, texts[f.key])); } catch (e) { errors[f.key] = String(e?.message ?? e); }
  }
  if (sourceKind === "named" && !errors.source && (typeof next.source !== "string" || !next.source)) errors.source = "Needs the name of a source";
  if (sourceKind === "static" && !errors["source.data"] && !("data" in (next.source ?? {})) && !NO_SOURCE.has(widget.type)) errors["source.data"] = "Needs some data";
  return Object.keys(errors).length ? { errors } : { widget: next };
}

const clone = (v) => JSON.parse(JSON.stringify(v));
// A dashboard file's object with old widget type names replaced (dash-data.js TYPE_ALIASES), so what is saved has the new ones.
export function renamed(raw) {
  if (!Array.isArray(raw?.widgets)) return raw;
  return { ...raw, widgets: raw.widgets.map((w) => (w && typeOf(w.type) !== w.type ? { ...w, type: typeOf(w.type) } : w)) };
}
// One change to a dashboard file's object -> a new object. Throws when the change makes no sense.
// op: { add: type } | { remove: i } | { move: i, by: -1 | 1 } | { width: i, w } | { replace: i, widget } | { title }.
export function edit(raw, op) {
  const d = renamed(clone(raw));
  if (!Array.isArray(d.widgets)) d.widgets = [];
  const at = (i) => { if (!Number.isInteger(i) || i < 0 || i >= d.widgets.length) throw new Error(`No widget ${i}`); return i; };
  if ("add" in op) {
    const info = widgetInfo(op.add);
    if (!info) throw new Error(`No widget type "${op.add}"`);
    d.widgets.push(clone(info.make));
  } else if ("remove" in op) d.widgets.splice(at(op.remove), 1);
  else if ("move" in op) {
    const i = at(op.move), j = i + (op.by < 0 ? -1 : 1);
    if (j < 0 || j >= d.widgets.length) return d;
    [d.widgets[i], d.widgets[j]] = [d.widgets[j], d.widgets[i]];
  } else if ("width" in op) d.widgets[at(op.width)].w = Math.max(1, Math.min(4, Math.round(Number(op.w) || 1)));
  else if ("replace" in op) d.widgets[at(op.replace)] = clone(op.widget);
  else if ("title" in op) {
    const t = String(op.title ?? "").trim();
    if (!t) throw new Error("A dashboard needs a name");
    d.title = t.slice(0, 80);
  } else throw new Error("Unknown change");
  return d;
}

// The text to write for a dashboard's object: only if it reads back as a dashboard, and brings no widget type that
// doesn't exist (one the file had before, `before`, may stay: it was hand-written, and says so on its card).
export function checked(raw, name, before = null) {
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const dash = readDashboard(text, name);
  const had = new Set((before?.widgets ?? []).map((w) => String(w?.type ?? "")));
  const bad = dash.widgets.find((w) => !w.type && !had.has(w.typeName));
  if (bad) throw new Error(`No widget type "${bad.typeName}"`);
  return text;
}

// A file name for a dashboard called `title`, not one of `taken`: "My fleet" -> "my-fleet", "my-fleet-2".
export function fileName(title, taken = []) {
  const base = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "dashboard";
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}
export const blank = (title) => ({ title: String(title).trim().slice(0, 80), refresh: 30, widgets: [] });
