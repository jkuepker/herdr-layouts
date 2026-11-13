// node t3-panels/tests/termctx.test.mjs
import assert from "node:assert/strict";
import { terminalBlock, pickTerminal } from "../mods/ht3-panels/termctx.js";

// Empty, blank and prompt-only text: nothing.
assert.equal(terminalBlock("", { name: "zsh" }), null);
assert.equal(terminalBlock(null), null);
assert.equal(terminalBlock("\n  \n\n"), null);
assert.equal(terminalBlock("user@host ~/proj %\n"), null);

// Trailing blank and prompt lines go; the output stays, with a heading naming the terminal and its line count.
assert.equal(terminalBlock("$ npm test\nFAIL a.test.js\n  1 failing\n\nuser@host ~/proj % \n\n", { name: "zsh" }),
  "Terminal `zsh` (last 3 lines):\n```text\n$ npm test\nFAIL a.test.js\n  1 failing\n```");
assert.equal(terminalBlock("boom\r\n", { name: "t5" }), "Terminal `t5` (last 1 line):\n```text\nboom\n```");
// A prompt drawn with icon-font glyphs is a prompt too; one in the middle is output.
assert.equal(terminalBlock("one\n ~/proj\n", { name: "x" }), "Terminal `x` (last 1 line):\n```text\none\n```");
assert.ok(terminalBlock("a\nuser@host %\nb\n").includes("a\nuser@host %\nb"));

// Only the last `lines`; the default is 40; a bad count is the default.
const many = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
assert.ok(terminalBlock(many, { name: "n", lines: 3 }).endsWith("```text\nline 98\nline 99\nline 100\n```"));
assert.ok(terminalBlock(many, { name: "n" }).startsWith("Terminal `n` (last 40 lines):\n```text\nline 61\n"));
assert.ok(terminalBlock(many, { name: "n", lines: 0 }).includes("(last 40 lines)"));
assert.ok(terminalBlock(many, { name: "n", lines: "x" }).includes("(last 40 lines)"));
// The cut counts after the trailing prompt is gone.
assert.ok(terminalBlock("a\nb\nc\nuser@host %\n", { name: "n", lines: 2 }).endsWith("```text\nb\nc\n```"));

// Backticks in the output don't end the block; in the name they are changed.
assert.equal(terminalBlock("run ```x```", { name: "a`b" }), "Terminal `a'b` (last 1 line):\n````text\nrun ```x```\n````");

// pickTerminal: the chat's tab first, then the space's other tabs; the last focused, then the focused, then the first.
const p = (pane, tab, terminal, focused = false) => ({ pane, tab, terminal, focused });
const ps = [p("p1", "tabA", null), p("p2", "tabA", "t1"), p("p3", "tabA", "t2"), p("p4", "tabB", "t3", true), p("p5", "tabC", "t9")];
assert.equal(pickTerminal(ps, { tab: "tabA", tabs: ["tabA", "tabB"] }).terminal, "t1");
assert.equal(pickTerminal(ps, { tab: "tabA", tabs: ["tabA", "tabB"], recent: "t2" }).terminal, "t2");
assert.equal(pickTerminal(ps, { tab: "tabA", tabs: ["tabA", "tabB"], recent: "t3" }).terminal, "t1");
assert.equal(pickTerminal([p("p1", "tabA", null), p("p4", "tabB", "t3"), p("p6", "tabB", "t4", true)], { tab: "tabA", tabs: ["tabA", "tabB"] }).terminal, "t4");
assert.equal(pickTerminal(ps.filter((x) => x.tab !== "tabA"), { tab: "tabA", tabs: ["tabA", "tabB"], recent: "t3" }).terminal, "t3");
assert.equal(pickTerminal([p("p1", "tabA", null), p("p5", "tabC", "t9")], { tab: "tabA", tabs: ["tabA", "tabB"] }), null);
assert.equal(pickTerminal([], { tab: "tabA" }), null);
// A two-line Nerd Font prompt: its top row goes, its glyph sign reads "$".
{
  const t = " \u{F0035} josef\u{F0065}endor  …/coordinator                     \u{F0954} 8:08:09 PM 100% \n\u{F0142} echo a; echo b\na\nb\n \u{F0035} josef  …/x                    \u{F0954} 8:08:16 PM\n\u{F0142} ";
  assert.equal(terminalBlock(t, { name: "t1" }), "Terminal `t1` (last 3 lines):\n```text\n$ echo a; echo b\na\nb\n```");
}

console.log("termctx: ok");
