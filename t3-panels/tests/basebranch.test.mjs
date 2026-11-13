// node t3-panels/tests/basebranch.test.mjs
import assert from "node:assert/strict";
import { baseRefs, defaultBase, filterRefs, cleanFrom, onOrigin, fetchArgs, baseLabel } from "../mods/ht3-panels/basebranch.js";

// What branches.js parseRefs gives (git's order, newest first): feature is checked out.
const parsed = {
  locals: [{ name: "main", current: false, date: 30, upstream: "origin/main" }, { name: "feature", current: true, date: 20, upstream: null }, { name: "old", current: false, date: 10, upstream: null }],
  remotes: [{ ref: "origin/main", remote: "origin", name: "main", date: 31 }, { ref: "fork/main", remote: "fork", name: "main", date: 29 },
    { ref: "origin/release/1.0", remote: "origin", name: "release/1.0", date: 25 }, { ref: "origin/feature", remote: "origin", name: "feature", date: 19 }],
};
const list = baseRefs(parsed);

// Order: the checked-out branch and its origin/ one, the other local ones each with theirs, then origin-only ones.
assert.deepEqual(list.map((b) => b.ref), ["feature", "origin/feature", "main", "origin/main", "old", "origin/release/1.0"]);
assert.deepEqual(list[0], { ref: "feature", local: true, current: true, name: "feature" });
assert.deepEqual(list[1], { ref: "origin/feature", local: false, current: false, name: "feature" });
assert.ok(!list.some((b) => b.ref.startsWith("fork/")));
assert.deepEqual(baseRefs(null), []);
assert.deepEqual(baseRefs({ locals: [], remotes: [] }), []);

// The default: the checked-out branch; none when HEAD is detached.
assert.equal(defaultBase(list), "feature");
assert.equal(defaultBase(baseRefs({ ...parsed, locals: parsed.locals.map((b) => ({ ...b, current: false })) })), null);
assert.equal(defaultBase([]), null);
assert.equal(defaultBase(null), null);

// The filter: every word, any case, the order kept.
assert.deepEqual(filterRefs(list, "").map((b) => b.ref), list.map((b) => b.ref));
assert.deepEqual(filterRefs(list, "MAIN").map((b) => b.ref), ["main", "origin/main"]);
assert.deepEqual(filterRefs(list, "origin ma").map((b) => b.ref), ["origin/main"]);
assert.deepEqual(filterRefs(list, "  1.0 ").map((b) => b.ref), ["origin/release/1.0"]);
assert.deepEqual(filterRefs(list, "nothing"), []);
assert.deepEqual(filterRefs(null, "x"), []);

// A scripted start point: trimmed; never an option, never with a space.
assert.equal(cleanFrom(" origin/main "), "origin/main");
assert.equal(cleanFrom("4c38421"), "4c38421");
assert.equal(cleanFrom("--force"), null);
assert.equal(cleanFrom("a b"), null);
assert.equal(cleanFrom(""), null);
assert.equal(cleanFrom(null), null);

// On origin: by the list when there is one (a local branch may be called origin/x), else by its name.
assert.equal(onOrigin("origin/main", list), true);
assert.equal(onOrigin("main", list), false);
assert.equal(onOrigin("origin/odd", [{ ref: "origin/odd", local: true, current: false, name: "origin/odd" }]), false);
assert.equal(onOrigin("origin/unlisted", list), true);
assert.equal(onOrigin("origin/main"), true);
assert.equal(onOrigin("origin/"), false);
assert.equal(onOrigin("fork/main"), false);
assert.equal(onOrigin(null), false);

// Fetch first: only for a branch on origin; a slash in the branch stays.
assert.deepEqual(fetchArgs("origin/main", list), ["fetch", "origin", "main"]);
assert.deepEqual(fetchArgs("origin/release/1.0"), ["fetch", "origin", "release/1.0"]);
assert.equal(fetchArgs("main", list), null);
assert.equal(fetchArgs("4c38421"), null);
assert.equal(fetchArgs(null), null);

assert.equal(baseLabel("origin/main"), "From origin/main");
assert.equal(baseLabel(null), "From HEAD");

console.log("basebranch: ok");
