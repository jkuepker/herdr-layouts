// node t3-panels/tests/approve-rules.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { plainCommand, commandOf, requestOf, parseRules, matches, rulesFor, projectRules, globalRules, withRules, addRule, removeRule, onceOption, decide, offerOf, ruleNotice } from "../mods/ht3-panels/approve-rules.js";
import { ChatSession } from "../mods/ht3-panels/session.js";

// A pattern matches the command it spells, and that command with more arguments; never a longer word.
assert.equal(matches("npm test", "npm test"), true);
assert.equal(matches("npm test", "npm test -- foo"), true);
assert.equal(matches("npm test", "  npm test\t--watch=false "), true);
assert.equal(matches(" npm test ", "npm test"), true);
assert.equal(matches("npm test", "npm testx"), false);
assert.equal(matches("npm test", "npm tes"), false);
assert.equal(matches("npm test", "npm"), false);
assert.equal(matches("npm test", "sudo npm test"), false);
assert.equal(matches("npm test", "FOO=1 npm test"), false);
assert.equal(matches("npm test", "NPM TEST"), false);
assert.equal(matches("", "npm test"), false);
assert.equal(matches("npm test", ""), false);
assert.equal(matches(null, undefined), false);

// With more arguments the command must be one plain command: chaining, pipes, redirection and substitution are refused.
for (const more of ["; rm -rf x", "&& rm -rf x", "|| rm -rf x", "| sh", "& rm -rf x", "`rm -rf x`", "$(rm -rf x)", "> /etc/hosts", ">> out.txt", "2> err", "< /etc/passwd", "<(curl evil)", "\nrm -rf x", "\r\nrm -rf x", "-- 'a;b'", "--name \"$(id)\""]) {
  assert.equal(plainCommand(`npm test ${more}`), false, more);
  assert.equal(matches("npm test", `npm test ${more}`), false, more);
}
assert.equal(matches("npm test", "npm test;rm -rf x"), false);
assert.equal(plainCommand("npm test -- foo --bar=1 ./a/b.js"), true);
assert.equal(plainCommand("echo $HOME ${x}"), true);
// ... unless the pattern spells that command whole.
assert.equal(matches("npm test | tail -5", "npm test | tail -5"), true);
assert.equal(matches("npm run build && npm test", "npm run build && npm test"), true);
assert.equal(matches("npm test | tail -5", "npm test | tail -5 -q"), false);
assert.equal(matches("npm test | tail", "npm test | tail -5"), false);
assert.equal(matches("npm test | tail -5", "npm test | tail -5; rm -rf x"), false);
assert.equal(matches("npm run build && npm test", "npm run build && npm test && rm -rf x"), false);
// No globs, no patterns: a rule is its text.
assert.equal(matches("*", "rm -rf x"), false);
assert.equal(matches("npm *", "npm test"), false);
assert.equal(matches(".*", "ls"), false);

// The command of a tool call's raw input.
assert.equal(commandOf({ command: " npm test " }), "npm test");
assert.equal(commandOf({ cmd: "ls" }), "ls");
assert.equal(commandOf({ command: ["bash", "-lc", "npm test && ls"] }), "npm test && ls");
assert.equal(commandOf({ command: ["/bin/sh", "-c", "ls"] }), "ls");
assert.equal(commandOf({ command: ["git", "status", "--short"] }), "git status --short");
assert.equal(commandOf({ command: ["echo", "a b"] }), null); // an argument with a space: not said as a line
assert.equal(commandOf({ command: ["echo", "a;b"] }), null);
assert.equal(commandOf({ command: ["git", 3] }), null);
assert.equal(commandOf({ command: "" }), null);
assert.equal(commandOf({ file_path: "/x" }), null);
assert.equal(commandOf(null), null);

// What a permission request asks: a command only for a tool of kind "execute"; the raw input before the title.
assert.deepEqual(requestOf({ toolCallId: "t", title: "Run tests", kind: "execute", rawInput: { command: "npm test" } }), { kind: "execute", command: "npm test", titled: false });
// The request itself may only name the tool call: what the agent said of it before is used.
assert.deepEqual(requestOf({ toolCallId: "t", title: "`npm test`" }, { kind: "execute", rawInput: { command: "npm test -- a" } }), { kind: "execute", command: "npm test -- a", titled: false });
// The request's own raw input wins over the earlier one.
assert.equal(requestOf({ rawInput: { command: "rm -rf x" } }, { kind: "execute", rawInput: { command: "npm test" } }).command, "rm -rf x");
// No raw input at all: the title, said to be one.
assert.deepEqual(requestOf({ title: "`git status`", kind: "execute" }), { kind: "execute", command: "git status", titled: true });
assert.deepEqual(requestOf({ title: "git status", kind: "execute" }), { kind: "execute", command: "git status", titled: true });
assert.deepEqual(requestOf({ kind: "execute" }), { kind: "execute", command: null, titled: false });
// Not a command: an edit, a tool of no kind, a tool of another kind that happens to carry a "command".
assert.equal(requestOf({ title: "Edit notes.md", kind: "edit", rawInput: { file_path: "/p/notes.md" } }).command, null);
assert.equal(requestOf({ title: "npm test" }).command, null);
assert.equal(requestOf({ title: "remote", kind: "other", rawInput: { command: "npm test" } }).command, null);
assert.equal(requestOf({ title: "x", kind: "edit", rawInput: { command: "npm test" } }).command, null);
assert.equal(requestOf(undefined).command, null);

// A text area's lines.
assert.deepEqual(parseRules("npm test\n\n  git status  \n# a note\nnpm test\n"), ["npm test", "git status"]);
assert.deepEqual(parseRules(["a", " ", null, 4, "a", "b"]), ["a", "b"]);
assert.deepEqual(parseRules(null), []);

// The kept store: a global list and one per project; the project's rules come first.
let store;
store = addRule(store, ":/p", "npm test");
store = addRule(store, ":/p", "npm test");
store = addRule(store, null, "git status");
store = addRule(store, "spark1:/q", "make");
assert.deepEqual(store, { global: ["git status"], projects: { ":/p": ["npm test"], "spark1:/q": ["make"] } });
assert.deepEqual(rulesFor(store, ":/p"), [{ pattern: "npm test", scope: "project" }, { pattern: "git status", scope: "global" }]);
assert.deepEqual(rulesFor(store, ":/other"), [{ pattern: "git status", scope: "global" }]);
assert.deepEqual(projectRules(store, ":/p"), ["npm test"]);
assert.deepEqual(globalRules(store), ["git status"]);
assert.deepEqual(rulesFor(undefined, ":/p"), []);
assert.deepEqual(rulesFor({ global: "x", projects: [] }, ":/p"), [{ pattern: "x", scope: "global" }]);
store = removeRule(store, "spark1:/q", "make");
assert.deepEqual(store, { global: ["git status"], projects: { ":/p": ["npm test"] } });
store = removeRule(store, ":/p", "nope");
assert.deepEqual(projectRules(store, ":/p"), ["npm test"]);
assert.deepEqual(withRules(store, ":/p", "a\nb"), { global: ["git status"], projects: { ":/p": ["a", "b"] } });
assert.equal(removeRule(removeRule(store, ":/p", "npm test"), null, "git status"), undefined);
assert.deepEqual(withRules({ other: 1, global: ["a"] }, null, ""), { other: 1 }); // unknown keys stay

// A rule's answer: only "allow once", never "always"; nothing when the agent offers no "allow once".
const OPTIONS = [{ optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }];
const ask = (toolCall, options = OPTIONS, known = null) => ({ title: toolCall.title, options, request: requestOf(toolCall, known) });
const RULES = rulesFor({ global: ["git status"], projects: { ":/p": ["npm test", "npm run build && npm test"] } }, ":/p");
assert.equal(onceOption(OPTIONS).optionId, "yes");
assert.equal(onceOption([OPTIONS[0], OPTIONS[2]]), null);
assert.equal(onceOption(null), null);
const run = (command) => ({ title: `\`${command}\``, kind: "execute", rawInput: { command } });
assert.deepEqual(decide(ask(run("npm test -- foo")), RULES), { optionId: "yes", command: "npm test -- foo", pattern: "npm test", scope: "project", titled: false });
assert.deepEqual(decide(ask(run("git status")), RULES), { optionId: "yes", command: "git status", pattern: "git status", scope: "global", titled: false });
assert.equal(decide(ask(run("npm run build && npm test")), RULES).pattern, "npm run build && npm test");
assert.equal(decide(ask(run("npm test; rm -rf x")), RULES), null);
assert.equal(decide(ask(run("npm test && git push")), RULES), null);
assert.equal(decide(ask(run("git status > /etc/hosts")), RULES), null);
assert.equal(decide(ask(run("git push")), RULES), null);
assert.equal(decide(ask(run("npm test")), []), null);
assert.equal(decide(ask(run("npm test")), null), null);
assert.equal(decide(ask(run("npm test"), [OPTIONS[0], OPTIONS[2]]), RULES), null); // only "always" on offer: asked
assert.equal(decide(ask(run("npm test"), [{ optionId: "a", name: "Allow", kind: "allow_always" }]), RULES), null);
assert.equal(decide(ask(run("npm test"), []), RULES), null);
// The title says one thing, the raw input another: the raw input is what runs.
assert.equal(decide(ask({ title: "`npm test`", kind: "execute", rawInput: { command: "rm -rf /" } }), RULES), null);
assert.equal(decide(ask({ title: "`npm test`" }, OPTIONS, { kind: "execute", rawInput: { command: "rm -rf /" } }), RULES), null);
// Edits and writes are never a rule's, inside the chat's folder or outside it, whatever their title or input says.
for (const kind of ["edit", "delete", "move", "read", "fetch", "search", "think", "other", undefined]) {
  assert.equal(decide(ask({ title: "npm test", kind, rawInput: { command: "npm test", file_path: "/etc/hosts" }, locations: [{ path: "/etc/hosts" }] }), RULES), null, String(kind));
  assert.equal(decide(ask({ title: "npm test", kind, rawInput: { file_path: "/p/notes.md" }, locations: [{ path: "/p/notes.md" }] }), RULES), null, String(kind));
}
assert.equal(decide({ title: "x", options: OPTIONS }, RULES), null); // an approval kept before requests were (no `request`)
assert.equal(decide(null, RULES), null);
// Matched on the title when there is no raw input, and said so.
const titled = decide(ask({ title: "`npm test -- a`", kind: "execute" }), RULES);
assert.equal(titled.titled, true);
assert.equal(ruleNotice(titled), "Allowed automatically: `npm test -- a` (rule `npm test`, matched on the request's title)");
assert.equal(ruleNotice(decide(ask(run("npm test -- foo")), RULES)), "Allowed automatically: `npm test -- foo` (rule `npm test`)");

// What the card offers as a rule: the command, when it can be allowed once.
assert.equal(offerOf(ask(run("npm test -- foo"))), "npm test -- foo");
assert.equal(offerOf(ask(run("npm test"), [OPTIONS[0], OPTIONS[2]])), null);
assert.equal(offerOf(ask({ title: "Edit notes.md", kind: "edit" })), null);
assert.equal(offerOf(null), null);
// The offered command, added as a rule, answers the same command again, chained or not.
assert.equal(decide(ask(run("a && b")), rulesFor(addRule(undefined, ":/p", offerOf(ask(run("a && b")))), ":/p")).optionId, "yes");

// The session against the scripted agent (acp-chat/tests/fake-agent.mjs): "ask <command>" asks to run it.
const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../acp-chat/tests/fake-agent.mjs");
function start(env = {}) {
  const proc = spawn(process.execPath, [agent], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env } });
  const session = new ChatSession({ argv: [agent], cwd: process.cwd(), write: (l) => proc.stdin.write(l), kill: () => proc.kill("SIGKILL"), changed: () => {} });
  let buf = "";
  proc.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) session.feed(buf.slice(0, i));
  });
  return { proc, session };
}
const until = async (pred, what) => {
  for (let i = 0; i < 100; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 30)); }
  assert.fail(`timed out waiting for ${what}`);
};
const tool = (s) => s.state.transcript.items.filter((i) => i.kind === "tool").at(-1);
{
  const a = start();
  assert.equal(await a.session.start(), true);
  // A plain command a rule matches: its request carries the command, the rule picks "allow once".
  a.session.handle({ type: "prompt", text: "ask npm test -- foo" });
  await until(() => a.session.state.permission, "the approval");
  assert.deepEqual(a.session.state.permission.request, { kind: "execute", command: "npm test -- foo", titled: false });
  const d = decide(a.session.state.permission, RULES);
  assert.equal(d.optionId, "yes");
  a.session.handle({ type: "permission", optionId: d.optionId });
  await until(() => a.session.state.status === "ready", "the turn's end");
  assert.equal(tool(a.session).detail, "answered: yes");
  // A chained one: no rule answers, the approval stays for the person.
  a.session.handle({ type: "prompt", text: "ask npm test; rm -rf x" });
  await until(() => a.session.state.permission, "the approval");
  assert.equal(a.session.state.permission.request.command, "npm test; rm -rf x");
  assert.equal(decide(a.session.state.permission, RULES), null);
  a.session.handle({ type: "permission", optionId: "no" });
  await until(() => a.session.state.status === "ready", "the turn's end");
  // An edit ("tool"): never a rule's.
  a.session.handle({ type: "prompt", text: "tool" });
  await until(() => a.session.state.permission, "the approval");
  assert.equal(a.session.state.permission.request.command, null);
  assert.equal(decide(a.session.state.permission, rulesFor({ global: ["Edit notes.md", "Edit"] }, ":/p")), null);
  a.session.handle({ type: "permission", optionId: "no" });
  await until(() => a.session.state.status === "ready", "the turn's end");
  a.proc.kill("SIGKILL");
}
{
  // No raw input (FAKE_AGENT_ASK_BARE): the title is the command, and the request says so.
  const b = start({ FAKE_AGENT_ASK_BARE: "1" });
  assert.equal(await b.session.start(), true);
  b.session.handle({ type: "prompt", text: "ask git status" });
  await until(() => b.session.state.permission, "the approval");
  assert.deepEqual(b.session.state.permission.request, { kind: "execute", command: "git status", titled: true });
  b.proc.kill("SIGKILL");
}
console.log("approve-rules: ok");
