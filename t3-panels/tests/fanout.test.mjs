// node t3-panels/tests/fanout.test.mjs
import assert from "node:assert/strict";
import { modelSlug, uniqueNames, cleanModels, typedModels, toggleModel, fanoutTitle, fanoutBranch, fanoutBranches, fanoutProblem, parseFanout, fanoutSpecs, fanoutNotice } from "../mods/ht3-panels/fanout.js";

// Slugs: git-safe, the last part of a provider/model id, never empty, never long.
assert.equal(modelSlug("opus"), "opus");
assert.equal(modelSlug("Claude Sonnet 5.5"), "claude-sonnet-5-5");
assert.equal(modelSlug("fleetq-tatooine-r9700-8080/Qwen3.8"), "qwen3-8");
assert.equal(modelSlug("gpt-5.4[1m]"), "gpt-5-4-1m");
assert.equal(modelSlug("  "), "model");
assert.equal(modelSlug("///"), "model");
assert.equal(modelSlug("Ünïcode Modèl"), "unicode-model");
assert.ok(modelSlug("a".repeat(80)).length <= 24);
assert.ok(!modelSlug("abcdefghijklmnopqrstuvw-xyz").endsWith("-"));

// Unique names: -2, -3 for repeats and for taken ones.
assert.deepEqual(uniqueNames(["a", "b"]), ["a", "b"]);
assert.deepEqual(uniqueNames(["a", "a", "a"]), ["a", "a-2", "a-3"]);
assert.deepEqual(uniqueNames(["a", "b"], ["a", "a-2"]), ["a-3", "b"]);
assert.deepEqual(uniqueNames(["a", "a-2", "a"]), ["a", "a-2", "a-3"]);

// Models: ids or { value, name }, trimmed, each once.
assert.deepEqual(cleanModels([" opus ", "opus", "", null, { value: "sonnet", name: "Sonnet 5.5" }, { value: "x" }]),
  [{ value: "opus", name: "opus" }, { value: "sonnet", name: "Sonnet 5.5" }, { value: "x", name: "x" }]);
assert.deepEqual(cleanModels("opus"), []);
assert.deepEqual(typedModels("opus, sonnet\nhaiku,,opus"), ["opus", "sonnet", "haiku"]);

// Ticks: on, off, at most four.
assert.deepEqual(toggleModel([], "a"), ["a"]);
assert.deepEqual(toggleModel(["a", "b"], "a"), ["b"]);
assert.deepEqual(toggleModel(["a", "b", "c", "d"], "e"), ["a", "b", "c", "d"]);
assert.deepEqual(toggleModel(["a", "b", "c", "d"], "d"), ["a", "b", "c"]);

// Titles and the made-up branch.
assert.equal(fanoutTitle("  Fix the login\n\nmore"), "Fix the login");
assert.equal(fanoutTitle(""), "Chat");
assert.equal(fanoutTitle("x".repeat(100)).length, 60);
assert.equal(fanoutBranch("Fix the login!", "Ab12"), "fix-the-login-ab12");
assert.equal(fanoutBranch("", ""), "fanout-x");

// Branches: <branch>-<slug>, unlike each other and the taken ones.
assert.deepEqual(fanoutBranches("fix-login", ["opus", "sonnet"]), ["fix-login-opus", "fix-login-sonnet"]);
assert.deepEqual(fanoutBranches("fix-login-", ["a/Qwen 3", "b/Qwen-3"]), ["fix-login-qwen-3", "fix-login-qwen-3-2"]);
assert.deepEqual(fanoutBranches("f", ["opus", "sonnet"], ["f-opus"]), ["f-opus-2", "f-sonnet"]);

// What stops a fan-out.
assert.equal(fanoutProblem({ prompt: "p", models: ["a", "b"] }), null);
assert.equal(fanoutProblem({ prompt: "p", models: ["a", "b", "c", "d"], branch: "feat/x" }), null);
assert.match(fanoutProblem({ prompt: " ", models: ["a", "b"] }), /prompt/);
assert.match(fanoutProblem({ prompt: "p", models: ["a", "a"] }), /at least 2/);
assert.match(fanoutProblem({ prompt: "p", models: ["a", "b", "c", "d", "e"] }), /at most 4/);
assert.match(fanoutProblem({ prompt: "p", models: ["a", "b"], branch: "has space" }), /Not a branch name/);
assert.match(fanoutProblem({ prompt: "p", models: ["a", "b"], branch: "-x" }), /Not a branch name/);

// The command's JSON.
assert.deepEqual(parseFanout('{"folder":"/work/app/","prompt":" Fix it ","models":["opus","sonnet"],"branch":"fix","agent":"claude"}'),
  { folder: "/work/app", prompt: "Fix it", models: [{ value: "opus", name: "opus" }, { value: "sonnet", name: "sonnet" }], branch: "fix", agent: "claude" });
assert.deepEqual(parseFanout('{"folder":"/","prompt":"p","models":["a","b"]}'), { folder: "/", prompt: "p", models: [{ value: "a", name: "a" }, { value: "b", name: "b" }], branch: null, agent: null });
// from: the start point, and fetch with it; never an option for git.
assert.deepEqual(parseFanout('{"folder":"/a","prompt":"p","models":["a","b"],"from":" origin/main ","fetch":true}'),
  { folder: "/a", prompt: "p", models: [{ value: "a", name: "a" }, { value: "b", name: "b" }], branch: null, agent: null, from: "origin/main", fetch: true });
assert.equal(parseFanout('{"folder":"/a","prompt":"p","models":["a","b"],"from":"main"}').from, "main");
assert.equal("fetch" in parseFanout('{"folder":"/a","prompt":"p","models":["a","b"],"fetch":true}'), false);
assert.match(parseFanout('{"folder":"/a","prompt":"p","models":["a","b"],"from":"--force"}').error, /from/);
assert.match(parseFanout('{"folder":"/a","prompt":"p","models":["a","b"],"from":7}').error, /from/);
assert.match(parseFanout("nope").error, /JSON/);
assert.match(parseFanout("[]").error, /JSON object/);
assert.match(parseFanout('{"folder":"app","prompt":"p","models":["a","b"]}').error, /folder/);
assert.match(parseFanout('{"folder":"/a","prompt":"p","models":"a"}').error, /models/);
assert.match(parseFanout('{"folder":"/a","prompt":"p","models":["a"]}').error, /at least 2/);
assert.match(parseFanout('{"folder":"/a","models":["a","b"]}').error, /prompt/);

// The launch specs: one per model, the same prompt, its own branch, title and model.
const specs = fanoutSpecs({ prompt: "Fix the login\nand test it", models: [{ value: "opus", name: "Opus 5.5" }, "x/sonnet"], branch: "fix-login", taken: ["fix-login-sonnet"] });
assert.deepEqual(specs, [
  { model: "opus", name: "Opus 5.5", branch: "fix-login-opus", title: "Fix the login · Opus 5.5", prompt: "Fix the login\nand test it", set: { model: "opus" } },
  { model: "x/sonnet", name: "x/sonnet", branch: "fix-login-sonnet-2", title: "Fix the login · x/sonnet", prompt: "Fix the login\nand test it", set: { model: "x/sonnet" } },
]);
// No branch given: one is made from the title and the suffix.
assert.deepEqual(fanoutSpecs({ prompt: "Fix it", models: ["a", "b"], suffix: "k3f9" }).map((s) => s.branch), ["fix-it-k3f9-a", "fix-it-k3f9-b"]);

// The notice: Compare only for exactly two, all started.
const two = fanoutNotice([{ chat: "c1", title: "T · a", branch: "f-a" }, { chat: "c2", title: "T · b", branch: "f-b" }]);
assert.deepEqual(two, { title: "Started 2 chats in the background", body: "T · a (f-a)\nT · b (f-b)\nClick to compare the two.", level: "info", compare: ["c1", "c2"] });
const three = fanoutNotice([1, 2, 3].map((i) => ({ chat: `c${i}`, title: `T · ${i}`, branch: `f-${i}` })));
assert.equal(three.compare, null);
assert.equal(three.title, "Started 3 chats in the background");
const part = fanoutNotice([{ chat: "c1", title: "T · a", branch: "f-a" }], [{ name: "b", why: "git said no" }]);
assert.deepEqual(part, { title: "Started 1 chat in the background", body: "T · a (f-a)\nb didn't start: git said no", level: "warning", compare: null });
assert.equal(fanoutNotice([], [{ name: "a", why: "x" }]).level, "error");

console.log("fanout: ok");
