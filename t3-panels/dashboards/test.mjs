// node t3-panels/dashboards/test.mjs: the Dashboard surface's data steps, its edit and source paths with Herdr
// stubbed, and that every shipped dashboard reads.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const d = await import(join(here, "../mods/ht3-panels/dash-data.js"));

const fleet = { hosts: [{ name: "box-a", free_gb: 82, services: [{ name: "vllm", status: "up" }] }, { name: "mini", free_gb: 8, services: [] }] };
assert.deepEqual(d.pick(fleet, ".hosts[].name"), ["box-a", "mini"]);
assert.equal(d.pick(fleet, ".hosts[0].free_gb"), 82);
assert.deepEqual(d.pick(fleet, ".hosts[].services[].status"), ["up"]);
assert.equal(d.pick(fleet, ".nope.deeper"), undefined);
assert.equal(d.pick({ "a b": { c: 1 } }, '."a b".c'), 1);
assert.equal(d.pick(5, "."), 5);
assert.throws(() => d.pick(fleet, "hosts"));
assert.equal(d.field(fleet.hosts[0], "{.name}: {.free_gb} GB"), "box-a: 82 GB");
assert.equal(d.field(fleet.hosts[0], ".free_gb"), 82);
assert.equal(d.field(fleet.hosts[0], "plain"), "plain");

assert.equal(d.show(1234567.891), "1,234,567.9");
assert.equal(d.show(0.4236, { format: "percent" }), "42%");
assert.equal(d.show(42, { format: "percent", scale: 1, decimals: 1 }), "42.0%");
assert.equal(d.show(82, { unit: "GB" }), "82 GB");
assert.equal(d.show(null), "–");
assert.equal(d.show(3, { unit: "%" }), "3%");
assert.equal(d.show(3 * 1024 * 1024, { format: "bytes" }), "3.0 MB");
assert.equal(d.show(7200, { format: "age" }), "2h");
assert.equal(d.show(1000, { format: "since" }, 1090), "1m");
assert.equal(d.show("main"), "main");

assert.equal(d.level(96, { warn: 80, bad: 95 }), "bad");
assert.equal(d.level(85, { warn: 80, bad: 95 }), "warn");
assert.equal(d.level(8, { below: true, warn: 15, bad: 10 }), "bad");
assert.equal(d.level(8, { below: true, bad: 10, when: { path: ".name", match: "^box" } }, { name: "mini" }), null);
assert.equal(d.level(8, [{ below: true, bad: 10, when: { path: ".name", match: "^box" } }, { below: true, bad: 2 }], { name: "mini" }), "ok");
assert.equal(d.level("up", { ok: ["up"], warn: ["starting"] }), "ok");
assert.equal(d.level("gone", { ok: ["up"] }), "bad");
assert.equal(d.level("x", { warn: 1 }), null);
assert.equal(d.stateLevel(1), "ok");
assert.equal(d.stateLevel("DOWN"), "bad");
assert.equal(d.stateLevel("loading"), "warn");

assert.deepEqual(d.keep(fleet.hosts, { path: ".name", match: "^box" }).map((h) => h.name), ["box-a"]);
assert.deepEqual(d.sortRows(fleet.hosts, ".free_gb").map((h) => h.name), ["mini", "box-a"]);
assert.deepEqual(d.sortRows(fleet.hosts, "-.free_gb").map((h) => h.name), ["box-a", "mini"]);

const instant = { status: "success", data: { resultType: "vector", result: [{ metric: { __name__: "up", host: "a" }, value: [10, "1"] }, { metric: { host: "b" }, value: [10, "0"] }] } };
assert.deepEqual(d.promRows(instant), [{ host: "a", metric: "up", value: 1, time: 10 }, { host: "b", metric: null, value: 0, time: 10 }]);
const range = { status: "success", data: { resultType: "matrix", result: [{ metric: { host: "a" }, values: [[1, "2"], [2, "NaN"], [3, "4.5"]] }] } };
assert.deepEqual(d.promRows(range)[0].points, [[1, 2], [2, null], [3, 4.5]]);
assert.equal(d.promRows(range)[0].value, 4.5);
assert.throws(() => d.promRows({ status: "error", error: "bad query" }), /bad query/);
const joined = d.joinBy({ up: d.promRows(instant), run: [{ host: "a", value: 3 }, { host: "a", value: 2 }, { host: "c", value: 1 }] }, "host");
assert.deepEqual(joined, [{ host: "a", up: 1, run: 5 }, { host: "b", up: 0 }, { host: "c", run: 1 }]);

assert.equal(d.seconds("30m"), 1800);
assert.equal(d.seconds(45), 45);
assert.equal(d.seconds("soon", 7), 7);
assert.deepEqual(d.parse('{"a":1}'), { a: 1 });
assert.equal(d.parse(" 42\n"), 42);
assert.equal(d.parse("hello\n"), "hello");
assert.deepEqual(d.parse("a\n\nb\n", "lines"), ["a", "b"]);
assert.throws(() => d.parse("x", "json"));

assert.equal(d.ciOf([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]), "passing");
assert.equal(d.ciOf([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }]), "pending");
assert.equal(d.ciOf([{ state: "FAILURE" }, { status: "IN_PROGRESS" }]), "failing");
assert.equal(d.ciOf([]), null);

const dash = d.readDashboard('{"title":"T","widgets":[{"type":"stat","w":9},{"type":"pie","refresh":"2m"}]}', "t");
assert.equal(dash.widgets[0].w, 4);
assert.equal(dash.widgets[1].type, null);
assert.equal(dash.widgets[1].refresh, 120);
assert.deepEqual(d.readDashboard('{"sources":{"s":{"type":"static","data":1}},"widgets":[{"type":"stat","source":"s"}]}', "n").widgets[0].source, { type: "static", data: 1 });
assert.throws(() => d.readDashboard("{", "broken"), /not valid JSON/);
assert.throws(() => d.readDashboard("{}", "empty"), /widgets/);

// ---- edit mode's save path (dash-edit.js): a change is an edit(), then checked() gives the text to write ----
const e = await import(join(here, "../mods/ht3-panels/dash-edit.js"));
await import(join(here, "../mods/ht3-panels/dash-types.js")); // registers gauge, text, log, heatmap, link, terminal, chat, plan-map
assert.ok(["gauge", "text", "log", "heatmap", "link", "terminal", "chat", "plan-map"].every((x) => e.WIDGETS.some((w) => w.type === x) && d.TYPES.includes(x)));
// "xo-map" is the Plan map's old name: a file with it loads as plan-map, and any change writes plan-map.
const old = { widgets: [{ type: "xo-map", view: "fleet" }, { type: "stat", source: { type: "static", data: 1 } }] };
assert.equal(d.readDashboard(JSON.stringify(old), "o").widgets[0].type, "plan-map");
assert.equal(e.renamed(old).widgets[0].type, "plan-map");
assert.equal(old.widgets[0].type, "xo-map"); // the object read is left alone
assert.equal(JSON.parse(e.checked(e.edit(old, { width: 1, w: 2 }), "o", old)).widgets[0].type, "plan-map");
assert.ok(!e.WIDGETS.some((w) => w.type === "xo-map") && e.WIDGETS.find((w) => w.type === "plan-map").name === "Plan map");
// A text may go without a source ("none"); a link has none at all, and its form never adds one.
assert.equal(e.sourceKindOf({ type: "text", text: "x" }), "none");
assert.equal(e.applyForm({ type: "text", text: "x", source: { type: "static", data: 1 } }, "none", { text: "y" }).widget.source, undefined);
assert.deepEqual(e.applyForm({ type: "link", url: "https://example.com" }, "static", { label: "Go" }).widget, { type: "link", url: "https://example.com", label: "Go" });
assert.ok(e.sourceKindsFor("text").includes("none") && !e.sourceKindsFor("stat").includes("none"));
let raw = e.blank("  My fleet ");
assert.equal(raw.title, "My fleet");
assert.equal(e.fileName("My fleet!", ["my-fleet", "my-fleet-2"]), "my-fleet-3");
assert.equal(e.fileName("???"), "dashboard");
for (const w of e.WIDGETS) raw = e.edit(raw, { add: w.type });
assert.equal(raw.widgets.length, e.WIDGETS.length);
// Every type's starting widget reads back, and its settings form applied unchanged gives the same widget.
const all = d.readDashboard(e.checked(raw, "t"), "t");
assert.ok(all.widgets.every((w) => w.type));
raw.widgets.forEach((w, i) => {
  const kind = e.sourceKindOf(w), texts = {};
  for (const g of e.fieldsFor(w.type, kind)) for (const f of g.fields) texts[f.key] = e.fieldText(w, f);
  const r = e.applyForm(w, kind, texts);
  assert.deepEqual(r.widget, w, `${w.type}: the form changed an untouched widget ${JSON.stringify(r.errors ?? {})}`);
  assert.throws(() => e.edit(raw, { add: "nope" }), /No widget type/);
});
assert.throws(() => e.edit(raw, { remove: 99 }), /No widget/);
const first = raw.widgets[0].type, second = raw.widgets[1].type;
raw = e.edit(raw, { move: 0, by: 1 });
assert.deepEqual([raw.widgets[0].type, raw.widgets[1].type], [second, first]);
assert.deepEqual(e.edit(raw, { move: 0, by: -1 }), raw); // already first: nothing moves
raw = e.edit(raw, { width: 0, w: 9 });
assert.equal(raw.widgets[0].w, 4);
raw = e.edit(raw, { remove: 0 });
assert.equal(raw.widgets[0].type, first);
assert.throws(() => e.edit(raw, { title: "  " }), /needs a name/);
assert.equal(e.edit(raw, { title: "Renamed" }).title, "Renamed");
// The settings form: fields become values, an empty one leaves its key out, a wrong one is an error and no widget.
const stat = { type: "stat", title: "Old", w: 2, source: { type: "static", data: 1 }, unit: "GB", keepMe: { odd: true } };
let r = e.applyForm(stat, "command", { title: "Load", "source.shell": "uptime", "source.timeout": "5", unit: "", decimals: "2", thresholds: '{"warn":2}', spark: "yes", count: "", refresh: "", pick: ".a[0]" });
assert.deepEqual(r.widget, { type: "stat", title: "Load", w: 2, source: { type: "command", shell: "uptime", timeout: 5 }, keepMe: { odd: true }, decimals: 2, thresholds: { warn: 2 }, spark: true, pick: ".a[0]" });
r = e.applyForm(stat, "static", { thresholds: "{bad", decimals: "two", pick: "hosts", refresh: "2", format: "nope", "source.data": "" });
assert.deepEqual(Object.keys(r.errors).sort(), ["decimals", "format", "pick", "refresh", "source.data", "thresholds"]);
assert.equal(r.widget, undefined);
r = e.applyForm(stat, "named", { source: "fleet" });
assert.equal(r.widget.source, "fleet");
assert.ok(e.applyForm(stat, "named", { source: "" }).errors.source);
r = e.applyForm({ type: "table", source: { type: "static", data: [] } }, "static", { columns: '{"not":"a list"}', "source.data": "[]" });
assert.match(r.errors.columns, /list/);
// checked(): a file that wouldn't read as a dashboard is never text to write.
assert.throws(() => e.checked({ title: "x" }, "x"), /widgets/);
assert.throws(() => e.checked({ widgets: [{ type: "pie" }] }, "x"), /No widget type "pie"/);
assert.equal(JSON.parse(e.checked(raw, "t")).widgets.length, raw.widgets.length);
// A file that already had an unknown type can still be changed; a change can't bring a new one.
const odd = { widgets: [{ type: "pie" }] };
assert.ok(e.checked(e.edit(odd, { add: "stat" }), "x", odd));
assert.throws(() => e.checked({ widgets: [{ type: "pie" }, { type: "donut" }] }, "x", odd), /donut/);

// ---- the Plan map widget's copied layout and data steps (planmap-graph.js, planmap-data.js) ----
const xg = await import(join(here, "../mods/ht3-panels/planmap-graph.js")), xd = await import(join(here, "../mods/ht3-panels/planmap-data.js"));
const plan = { projects: [{ project: "p", has_plan: true, components: [
  { id: "a", title: "A", status: "done", tasks: [{ id: "t", title: "T", state: "done" }], live: [] },
  { id: "b", title: "B", status: "stuck", needs: ["a"], live: [{ task_key: "p/fix", via: "explicit" }] },
  { id: "c", title: "C", status: "planned", needs: ["b"], links: ["a"] }] }, { project: "q", has_plan: false }], edges: [], unplanned: ["p/loose"] };
const live = xd.joinLive(xd.normalize(plan), { rows: [{ key: "p/fix", agent: "blocked", harness: "pi", project: "p", slug: "fix" }], bearings: [{ key: "p/fix", kind: "needs_you" }] });
assert.deepEqual([live.projects[0].live, live.projects[0].needsYou, live.projects[0].unplanned.length], [2, 1, 1]);
assert.deepEqual(xd.counts(live.projects[0]), { done: 1, working: 0, planned: 1, stuck: 1 });
assert.equal(live.projects[0].components[1].workers[0].agent, "blocked");
const pl = xg.projectLayout(live.projects[0], live.edges);
assert.deepEqual(["a", "b", "c"].map((id) => pl.pos[id].col), [0, 1, 2]);
assert.equal(pl.edges.length, 3);
assert.equal(xd.edgeLook(pl.edges.find((x) => x.from === "b" && x.to === "c"), Object.fromEntries(live.projects[0].components.map((c) => [c.id, c]))), "red");
const fl = xg.fleetLayout(live.projects, 1000);
assert.deepEqual(fl.regions.map((r) => [r.project, r.empty, r.minis.length]), [["p", false, 3], ["q", true, 0]]);
assert.throws(() => xd.normalize({}), /no projects list/);

// ---- the surface itself and its sources, with Herdr stubbed: "herdr", "gpui-kit", "gpui-base", look.js and side.js
// resolve to the stub below (elements that swallow every call, a disk in a Map, an exec the test answers) ----
const STUB = String.raw`const g = globalThis.__h ??= { disk: new Map(), execs: [], reads: [], sharedv: {} };
const chain = () => new Proxy(function () {}, { get: (_t, p) => (p === "then" ? undefined : chain()), apply: () => chain() });
export const div = chain(), v_flex = chain(), h_flex = chain(), icon = chain(), button = chain(), iconButton = chain(), alpha = () => "#000", tokens = () => ({}), agentMark = chain(), shortPath = (p) => p, PathBuilder = chain(), TextView = chain(), Input = chain(), Textarea = chain();
class St { constructor(o) { this.v = o?.value ?? ""; } static new(o) { return new St(o); } value() { return this.v; } set_value(v) { this.v = v; } set_auto_grow() {} on() {} focus() {} release() {} }
export const InputState = St, TextareaState = St;
export const MOD = "ht3-panels", send = () => {}, showing = () => true, openScript = async () => null, activate = () => {}, ensureShown = () => {};
export const home = () => "/home/u", appHome = () => "/app", spaces = () => [], focused = () => null, run = () => {}, notify = () => {}, hc = async () => ({ code: 1, stdout: "", stderr: "" });
export const shared = (k) => g.sharedv[k], setShared = (k, v) => { g.sharedv[k] = v; };
export const exec = async (cmd, args, o) => { g.execs.push([cmd, args, o]); return g.onExec ? g.onExec(cmd, args, o) : { code: 0, stdout: "", stderr: "" }; };
export const readTextFile = async (p, o) => (g.reads.push([p, o]), g.disk.has(p) ? g.disk.get(p) : null);
export const writeTextFile = async (p, text, expected) => { const now = g.disk.has(p) ? g.disk.get(p) : null; if (now !== expected) throw new Error("stale snapshot"); g.writes = (g.writes ?? 0) + 1; g.disk.set(p, text); return null; };
`;
const stubUrl = "data:text/javascript," + encodeURIComponent(STUB);
const isStub = (spec) => ["herdr", "gpui-kit", "gpui-base"].includes(spec) || /\/(look|side)\.js$/.test(spec);
const nodeModule = await import("node:module");
if (nodeModule.registerHooks) nodeModule.registerHooks({ resolve: (spec, ctx, next) => (isStub(spec) ? { url: stubUrl, shortCircuit: true } : next(spec, ctx)) });
else nodeModule.register("data:text/javascript," + encodeURIComponent(`const isStub = ${isStub}; export async function resolve(spec, ctx, next) { return isStub(spec) ? { url: ${JSON.stringify(stubUrl)}, shortCircuit: true } : next(spec, ctx); }`));
const M = join(here, "../mods/ht3-panels/");
const { DashboardPanel } = await import(M + "dashboard.js");
const g = globalThis.__h;
{
const tasks = [];
const cx = { notify() {}, spawn(f) { const p = f(cx); tasks.push(p); return p; }, timer: { every() {}, after() {} } };
const settle = async () => { while (tasks.length) await tasks.shift(); await new Promise((r) => setTimeout(r, 5)); if (tasks.length) await settle(); };
const P = "/app/data/ht3-dashboards/d.json";
const mk = (n) => ({ type: "stat", title: n, w: 1, source: { type: "static", data: 1 } });
const orig = JSON.stringify({ title: "D", widgets: [mk("a"), mk("b"), mk("c")] });
g.disk.set(P, orig);
g.onExec = (cmd, args) => (cmd === "sh" && args[1].includes("ls -1") ? { code: 0, stdout: "d.json\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
const p = new DashboardPanel(); p.init({ group: "a" }, cx); await settle();
assert.equal(p.current().dash.widgets.length, 3);
p.setEditing(cx, true); await settle();
const titles = () => JSON.parse(g.disk.get(P)).widgets.map((w) => w.title).join("");
// no-ops write nothing
g.writes = 0;
p.change(cx, { move: 0, by: -1 }); p.change(cx, { move: 2, by: 1 }); p.change(cx, { width: 0, w: 0 }); p.change(cx, { width: 0, w: 1 }); await settle();
assert.equal(g.writes, 0); assert.equal(g.disk.get(P), orig); assert.equal(p.editError, null); assert.ok(!g.disk.has(P + ".bak"));
// the form follows its widget
p.openForm(cx, 2); assert.equal(p.form.inputs.get("title").value(), "c");
p.change(cx, { move: 2, by: -1 }); await settle();
assert.equal(titles(), "acb"); assert.equal(p.form.i, 1); assert.equal(g.disk.get(P + ".bak"), orig);
p.change(cx, { move: 0, by: 1 }); await settle();
assert.equal(titles(), "cab"); assert.equal(p.form.i, 0);
p.setField("title", "C2"); p.applyForm(cx); await settle();
assert.equal(titles(), "C2ab"); assert.equal(p.form.top, "Saved.");
const before = g.writes; p.applyForm(cx); await settle(); assert.equal(g.writes, before); assert.equal(p.form.top, "Saved.");
// a change while one is being saved says so
p.change(cx, { width: 1, w: 3 }); p.change(cx, { width: 2, w: 4 }); assert.match(p.editError, /Still saving/); await settle();
assert.deepEqual(JSON.parse(g.disk.get(P)).widgets.map((w) => w.w), [1, 3, 1]);
// changed on disk: not overwritten, the .bak not marked taken; a reload closes the form and drops state
const other = JSON.stringify({ title: "D", widgets: [mk("z")] });
g.disk.set(P, other); p.backed.clear(); g.disk.delete(P + ".bak");
p.change(cx, { width: 0, w: 2 }); await settle();
assert.match(p.editError, /changed on disk/); assert.equal(g.disk.get(P), other); assert.ok(!p.backed.has("d"));
assert.ok(p.form); p.loadFiles(cx, true); p.loadFiles(cx, true); await settle(); assert.equal(p.form, null); assert.equal(p.current().dash.widgets.length, 1);
p.change(cx, { width: 0, w: 2 }); await settle(); assert.equal(g.disk.get(P + ".bak"), other); assert.equal(p.editError, null);
// confirm doesn't carry to another dashboard
p.removeWidget(cx, 0); assert.ok(p.confirm); p.choose(cx, "d"); assert.equal(p.confirm, null);
// a new dashboard whose file is there already isn't kept in the list
g.disk.set("/app/data/ht3-dashboards/fresh.json", "{}"); p.newDashboard(cx, "Fresh"); await settle();
assert.ok(!p.files.some((f) => f.name === "fresh")); assert.ok(p.editError);
p.newDashboard(cx, "Other one"); await settle(); assert.ok(g.disk.has("/app/data/ht3-dashboards/other-one.json")); assert.equal(p.current().name, "other-one"); p.choose(cx, "d");
// dash-set without "="
p.openForm(cx, 0); p.editCommand("dash-set:title", cx); assert.equal(p.form.inputs.get("title").value(), "z"); p.editCommand("dash-set:title=q=1", cx); assert.equal(p.form.inputs.get("title").value(), "q=1");
// a slow source is asked once
let n = 0, done; g.onExec = (cmd) => { if (cmd === "slow") { n++; return new Promise((r) => { done = () => r({ code: 0, stdout: "1", stderr: "" }); }); } return { code: 0, stdout: "", stderr: "" }; };
const src = { type: "command", run: "slow" }, a1 = p.ask(src, {}); p.answers.get(JSON.stringify(src)).at -= 60000; const a2 = p.ask(src, {});
assert.equal(a1, a2); await new Promise((r) => setTimeout(r, 5)); assert.equal(n, 1); done(); assert.equal(await a1, 1);
p.answers.get(JSON.stringify(src)).at -= 60000; p.ask(src, {}); await new Promise((r) => setTimeout(r, 5)); assert.equal(n, 2); done();
// sources
const { fetchSource } = await import(M + "dash-sources.js");
g.execs.length = 0; g.onExec = () => ({ code: 0, stdout: JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: { host: "a" }, value: [1, "2"] }] } }), stderr: "" });
assert.deepEqual((await fetchSource({ type: "prometheus", query: "up" }, { prometheus: "localhost:9090/" }))[0].value, 2);
assert.equal(g.execs[0][1].at(-1), "http://localhost:9090/api/v1/query"); assert.ok(g.execs[0][1].includes("-g"));
await assert.rejects(fetchSource({ type: "prometheus", query: "up", url: "file:///etc/passwd" }, {}), /starts with http/);
g.execs.length = 0; await fetchSource({ type: "prometheus", query: "up", url: "-o /x" }, {}); assert.ok(g.execs[0][1].at(-1).startsWith("http://-o"));
g.onExec = () => ({ code: 0, stdout: "not json", stderr: "" });
await assert.rejects(fetchSource({ type: "fleetq" }), /isn't JSON: not json/);

// "~/" is the home of the machine a path is used on: the local one as before, a remote one asked once per machine.
const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
g.execs.length = 0; g.reads.length = 0; g.disk.set("/home/u/a.json", '{"a":1}'); g.disk.set("/remote/home/a.json", '{"a":2}');
g.onExec = (cmd, args, o) => (o?.on === "box" && cmd === "sh" && args[1].includes("$HOME") ? ok("/remote/home\n") : ok("1"));
assert.deepEqual(await fetchSource({ type: "file", path: "~/a.json" }), { a: 1 });
assert.equal(g.execs.length, 0); assert.deepEqual(g.reads[0], ["/home/u/a.json", { on: null }]);
assert.deepEqual(await fetchSource({ type: "file", path: "~/a.json", on: "box" }), { a: 2 });
assert.deepEqual(g.reads[1], ["/remote/home/a.json", { on: "box" }]);
await fetchSource({ type: "command", run: "x", cwd: "~/work", on: "box" }); await fetchSource({ type: "command", run: "x", cwd: "~", on: "box" });
await fetchSource({ type: "command", run: "x", cwd: "~/work" }); await fetchSource({ type: "command", run: "x", cwd: "/abs", on: "box" }); await fetchSource({ type: "command", run: "x", on: "box" });
const ran = g.execs.filter((x) => x[0] === "x").map((x) => x[2].cwd);
assert.deepEqual(ran, ["/remote/home/work", "/remote/home", "/home/u/work", "/abs", undefined]);
assert.equal(g.execs.filter((x) => x[0] === "sh").length, 1); // the remote home was asked once
// A machine that doesn't answer is an error, and is asked again the next time.
let homeAsks = 0; g.onExec = (cmd, args, o) => { if (o?.on === "far" && cmd === "sh") { homeAsks++; return homeAsks === 1 ? { code: 255, stdout: "", stderr: "no route" } : ok("/far/home"); } return ok("1"); };
await assert.rejects(fetchSource({ type: "file", path: "~/a.json", on: "far" }), /far didn't say where its home folder is: no route/);
await assert.rejects(fetchSource({ type: "file", path: "~/a.json", on: "far" }), /no such file/); assert.equal(homeAsks, 2); assert.equal(g.reads.at(-1)[0], "/far/home/a.json");
// projects: an extra folder's ~/ is its machine's too; a machine that can't be asked still gets its row.
g.onExec = (cmd, args, o) => { if (o?.on === "dead") throw new Error("unreachable"); return ok(args?.[1]?.includes("$HOME") && args.length === 2 ? "/remote/home" : "git=0\n"); };
const rows = await fetchSource({ type: "projects", gh: false, extra: [{ path: "~/code/x", on: "box" }, { path: "~/code/y" }, { path: "~/code/z", on: "dead" }] });
assert.deepEqual(rows.map((x) => [x.name, x.path, x.note]), [["x", "/remote/home/code/x", "Not a git repository"], ["y", "/home/u/code/y", "Not a git repository"], ["z", "~/code/z", "dead can't be reached"]]);
// fleetq: "classes" names each host's class; without it there is none, and the old `spark` stays.
const status = JSON.stringify({ hosts: [{ name: "gpu-1", capacity_gb: 100, free_gb: 40 }, { name: "mini", machine: "Mac-Studio" }, { name: "spark-a" }] });
g.onExec = () => ok(status);
let fq = await fetchSource({ type: "fleetq", classes: { gpu: "^gpu", mac: "STUDIO|mini" } });
assert.deepEqual(fq.hosts.map((h) => h.class), ["gpu", "mac", null]); assert.equal(fq.hosts[0].used, 60);
fq = await fetchSource({ type: "fleetq" });
assert.ok(fq.hosts.every((h) => !("class" in h))); assert.deepEqual(fq.hosts.map((h) => h.spark), [false, false, true]);
await assert.rejects(fetchSource({ type: "fleetq", classes: { gpu: "(" } }), /isn't a regular expression/);
await assert.rejects(fetchSource({ type: "fleetq", classes: ["gpu"] }), /"classes" is/);
assert.deepEqual(e.applyForm({ type: "stat", source: { type: "fleetq" } }, "fleetq", { "source.classes": '{"gpu":"^gpu"}' }).widget.source, { type: "fleetq", classes: { gpu: "^gpu" } });
}

// Every shipped dashboard reads, names known widget types, and its paths parse.
let files = 0;
for (const f of readdirSync(here).filter((x) => x.endsWith(".json"))) {
  const dash = d.readDashboard(readFileSync(join(here, f), "utf8"), f.replace(/\.json$/, ""));
  files++;
  for (const w of dash.widgets) {
    if (w.broken) continue; // kit.json shows what a mistake looks like
    assert.ok(w.type, `${f}: unknown widget type "${w.typeName}"`);
    assert.ok(w.source?.type || e.NO_SOURCE.has(w.type) || e.OPTIONAL_SOURCE.has(w.type), `${f}: "${w.title}" has no source`);
    const paths = [w.pick, w.value, w.label, w.state, w.type === "text" ? null : w.text, w.sub, w.max, w.legend, w.filter?.path, ...(Array.isArray(w.columns) ? w.columns : []).map((c) => c.value)];
    for (const p of paths) if (typeof p === "string") { if (d.isPath(p)) d.pick({}, p); else for (const m of p.matchAll(/\{([^{}]+)\}/g)) d.pick({}, m[1].trim()); }
  }
}
console.log(`ok: data steps, the surface with Herdr stubbed, ${files} shipped dashboard${files === 1 ? "" : "s"}`);
