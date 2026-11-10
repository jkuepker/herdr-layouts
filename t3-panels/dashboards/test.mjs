// node t3-panels/dashboards/test.mjs: the Dashboard surface's data steps, and that every shipped dashboard reads.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const d = await import(join(here, "../mods/ht3-panels/dash-data.js"));

const fleet = { hosts: [{ name: "spark1", free_gb: 82, services: [{ name: "vllm", status: "up" }] }, { name: "endor", free_gb: 8, services: [] }] };
assert.deepEqual(d.pick(fleet, ".hosts[].name"), ["spark1", "endor"]);
assert.equal(d.pick(fleet, ".hosts[0].free_gb"), 82);
assert.deepEqual(d.pick(fleet, ".hosts[].services[].status"), ["up"]);
assert.equal(d.pick(fleet, ".nope.deeper"), undefined);
assert.equal(d.pick({ "a b": { c: 1 } }, '."a b".c'), 1);
assert.equal(d.pick(5, "."), 5);
assert.throws(() => d.pick(fleet, "hosts"));
assert.equal(d.field(fleet.hosts[0], "{.name}: {.free_gb} GB"), "spark1: 82 GB");
assert.equal(d.field(fleet.hosts[0], ".free_gb"), 82);
assert.equal(d.field(fleet.hosts[0], "plain"), "plain");

assert.equal(d.show(1234567.891), "1,234,567.9");
assert.equal(d.show(0.4236, { format: "percent" }), "42%");
assert.equal(d.show(42, { format: "percent", scale: 1, decimals: 1 }), "42.0%");
assert.equal(d.show(82, { unit: "GB" }), "82 GB");
assert.equal(d.show(null), "–");
assert.equal(d.show(3 * 1024 * 1024, { format: "bytes" }), "3.0 MB");
assert.equal(d.show(7200, { format: "age" }), "2h");
assert.equal(d.show(1000, { format: "since" }, 1090), "1m");
assert.equal(d.show("main"), "main");

assert.equal(d.level(96, { warn: 80, bad: 95 }), "bad");
assert.equal(d.level(85, { warn: 80, bad: 95 }), "warn");
assert.equal(d.level(8, { below: true, warn: 15, bad: 10 }), "bad");
assert.equal(d.level(8, { below: true, bad: 10, when: { path: ".name", match: "^spark" } }, { name: "endor" }), null);
assert.equal(d.level(8, [{ below: true, bad: 10, when: { path: ".name", match: "^spark" } }, { below: true, bad: 2 }], { name: "endor" }), "ok");
assert.equal(d.level("up", { ok: ["up"], warn: ["starting"] }), "ok");
assert.equal(d.level("gone", { ok: ["up"] }), "bad");
assert.equal(d.level("x", { warn: 1 }), null);
assert.equal(d.stateLevel(1), "ok");
assert.equal(d.stateLevel("DOWN"), "bad");
assert.equal(d.stateLevel("loading"), "warn");

assert.deepEqual(d.keep(fleet.hosts, { path: ".name", match: "^spark" }).map((h) => h.name), ["spark1"]);
assert.deepEqual(d.sortRows(fleet.hosts, ".free_gb").map((h) => h.name), ["endor", "spark1"]);
assert.deepEqual(d.sortRows(fleet.hosts, "-.free_gb").map((h) => h.name), ["spark1", "endor"]);

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

const dash = d.readDashboard('{"title":"T","widgets":[{"type":"stat","w":9},{"type":"pie","refresh":"2m"}]}', "t");
assert.equal(dash.widgets[0].w, 4);
assert.equal(dash.widgets[1].type, null);
assert.equal(dash.widgets[1].refresh, 120);
assert.throws(() => d.readDashboard("{", "broken"), /not valid JSON/);
assert.throws(() => d.readDashboard("{}", "empty"), /widgets/);

// Every shipped dashboard reads, names known widget types, and its paths parse.
let files = 0;
for (const f of readdirSync(here).filter((x) => x.endsWith(".json"))) {
  const dash = d.readDashboard(readFileSync(join(here, f), "utf8"), f.replace(/\.json$/, ""));
  files++;
  for (const w of dash.widgets) {
    if (w.broken) continue; // kit.json shows what a mistake looks like
    assert.ok(w.type, `${f}: unknown widget type "${w.typeName}"`);
    assert.ok(w.source?.type, `${f}: "${w.title}" has no source`);
    const paths = [w.pick, w.value, w.label, w.state, w.text, w.sub, w.max, w.legend, w.filter?.path, ...(w.columns ?? []).map((c) => c.value)];
    for (const p of paths) if (typeof p === "string") { if (d.isPath(p)) d.pick({}, p); else for (const m of p.matchAll(/\{([^{}]+)\}/g)) d.pick({}, m[1].trim()); }
  }
}
console.log(`ok: data steps, ${files} shipped dashboard${files === 1 ? "" : "s"}`);
