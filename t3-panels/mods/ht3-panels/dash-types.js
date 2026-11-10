// The Dashboard widget types beyond the six data ones, as the editor knows them: what the Add widget picker says,
// what a new one starts as, and the settings form's fields (dash-edit.js registerWidget). No Herdr imports: node
// reads it in t3-panels/dashboards/test.mjs. They are drawn by dash-widgets.js and dash-xomap.js.

import { registerWidget } from "./dash-edit.js";

const VALUE = [
  { key: "unit", label: "Unit", kind: "text" },
  { key: "decimals", label: "Decimals", kind: "number", min: 0 },
];

registerWidget({ type: "gauge", about: "A ring that fills to a share of a maximum, coloured by thresholds",
  make: { type: "gauge", title: "New gauge", w: 1, source: { type: "static", data: 62 }, max: 100, unit: "%", thresholds: { warn: 80, bad: 95 } } },
[{ key: "value", label: "Value", kind: "path", hint: "a path into the data, e.g. .used" }, { key: "min", label: "From", kind: "number" },
  { key: "max", label: "To", kind: "numberOrPath", hint: "a number or a path; default 100" }, ...VALUE, { key: "sub", label: "Line under it", kind: "path" }]);

registerWidget({ type: "text", about: "Markdown or plain text, written here or from a source",
  make: { type: "text", title: "New text", w: 2, text: "**Notes.** Write Markdown here, or give this widget a source." } },
[{ key: "text", label: "Text", kind: "lines", hint: "Markdown; used when the widget has no source" }, { key: "plain", label: "Plain text, not Markdown", kind: "bool" },
  { key: "value", label: "Field", kind: "path", hint: "with a source: the path or template to show; default the whole answer" }], { source: "optional" });

registerWidget({ type: "log", about: "The last lines of a command or a file, newest at the bottom",
  make: { type: "log", title: "New log", w: 2, source: { type: "static", data: ["first line", "second line", "the newest line"] }, lines: 8 } },
[{ key: "lines", label: "Lines", kind: "number", min: 1, hint: "how many of the last lines; default 12" }, { key: "wrap", label: "Wrap long lines", kind: "bool" }]);

registerWidget({ type: "heatmap", about: "Rows by columns of coloured cells, e.g. a value per box by hour",
  make: { type: "heatmap", title: "New heatmap", w: 2, source: { type: "static", data: [
    { row: "one", col: "a", value: 1 }, { row: "one", col: "b", value: 5 }, { row: "one", col: "c", value: 9 },
    { row: "two", col: "a", value: 7 }, { row: "two", col: "b", value: 2 }, { row: "two", col: "c", value: 4 }] } } },
[{ key: "label", label: "Row name", kind: "path", hint: "with a range source (rows with points): a template per series, e.g. {.host}" },
  { key: "steps", label: "Time steps", kind: "number", min: 1, hint: "with a range source: how many columns; default 24" },
  { key: "row", label: "Row", kind: "path", hint: "without points: the row's name, default .row" }, { key: "col", label: "Column", kind: "path", hint: "default .col" },
  { key: "value", label: "Value", kind: "path", hint: "default .value" }, { key: "min", label: "Scale from", kind: "number" }, { key: "max", label: "Scale to", kind: "number" }, ...VALUE]);

registerWidget({ type: "link", about: "A button: a Herdr command, a web address, or a space",
  make: { type: "link", title: "New link", w: 1, label: "Open the command palette", run: "mod.open:ht3-palette" } },
[{ key: "label", label: "Label", kind: "text" }, { key: "sub", label: "Line under it", kind: "text" },
  { key: "url", label: "Web address", kind: "text", hint: "http:// or https://, opened in the system browser" },
  { key: "run", label: "Herdr command", kind: "text", hint: "e.g. layout.toggle:ht3-side" }, { key: "args", label: "Its arguments", kind: "json", shape: "object" },
  { key: "space", label: "Space", kind: "text", hint: "a space's name: shows it" }], { source: false });

registerWidget({ type: "terminal", about: "A button that runs a command in a side terminal and shows its last line",
  make: { type: "terminal", title: "New terminal", w: 2, label: "Say hello", command: "echo hello from the dashboard" } },
[{ key: "label", label: "Label", kind: "text" }, { key: "command", label: "Command", kind: "text", hint: "typed into a new terminal tab of the side panel" },
  { key: "cwd", label: "Folder", kind: "text", hint: "default: the shown space's" }, { key: "on", label: "Machine", kind: "text" }], { source: false });

registerWidget({ type: "chat", about: "Open chats: status, name, agent and last message; a click goes there",
  make: { type: "chat", title: "Chats", w: 2 } },
[{ key: "chat", label: "Chat", kind: "text", hint: "a chat's id for that one; empty: every open chat" }, { key: "limit", label: "At most", kind: "number", min: 1 }], { source: false });

registerWidget({ type: "xo-map", about: "xo's plan as xo-map draws it: the fleet, or one project's components",
  make: { type: "xo-map", title: "xo map", w: 4, view: "fleet", layout: "compact" } },
[{ key: "view", label: "View", kind: "choice", options: ["fleet", "project"], hint: "the fleet, or the project picked below" },
  { key: "project", label: "Project", kind: "pick", from: "xo-projects", none: "xo's projects are listed here once the widget has read them", hint: "used by the project view" },
  { key: "layout", label: "Layout", kind: "choice", options: ["compact", "full"], hint: "full: a project's cards list their tasks and live workers" }], { source: false });
