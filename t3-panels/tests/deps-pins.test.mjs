// node t3-panels/tests/deps-pins.test.mjs
import assert from "node:assert/strict";
import { detectEcosystems, exactPins } from "../mods/ht3-panels/deps-parse.js";

const pkg = { dependencies: { lodash: "4.17.15", chalk: "^4.1.0", a: "=1.0.0", b: "v2.0.0-rc.1" }, devDependencies: { vitest: "1.0.0", eslint: "~8.0.0" } };
assert.deepEqual([...exactPins(pkg)].sort(), ["a", "b", "lodash", "vitest"]);
const row = (name, latest, dev = false) => ({ name, latest, dev });
const rows = [row("lodash", "4.18.1"), row("chalk", "6.0.1"), row("vitest", "3.0.0", true)];
const eco = (lock, extra = {}) => detectEcosystems({ names: ["package.json", lock], "package.json": JSON.stringify({ ...pkg, ...extra }) })[0];
assert.equal(eco("package-lock.json").update(rows), "npm install chalk@6.0.1 && npm install --save-exact lodash@4.18.1 vitest@3.0.0");
assert.equal(eco("pnpm-lock.yaml").update(rows), "pnpm update chalk --latest && pnpm add --save-exact lodash@4.18.1 && pnpm add --save-exact -D vitest@3.0.0");
assert.equal(eco("bun.lock").update(rows), "bun update --latest chalk && bun add --exact lodash@4.18.1 && bun add --exact -d vitest@3.0.0");
assert.equal(eco("yarn.lock").update(rows), "yarn upgrade chalk@6.0.1 && yarn upgrade --exact lodash@4.18.1 vitest@3.0.0");
assert.equal(eco("package-lock.json").update([row("chalk", "6.0.1")]), "npm install chalk@6.0.1");
assert.equal(eco("package-lock.json").update([row("lodash", "4.18.1")]), "npm install --save-exact lodash@4.18.1");
console.log("deps-pins: ok");
