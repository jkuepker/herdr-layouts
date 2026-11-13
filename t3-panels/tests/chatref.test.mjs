// node t3-panels/tests/chatref.test.mjs
import assert from "node:assert/strict";
import { chatRefBlock, quoteLines, matchChat, lastAgentText, chatTitle, otherChats } from "../mods/ht3-panels/chatref.js";

// Nothing: no title and no reply.
assert.equal(chatRefBlock({}), null);
assert.equal(chatRefBlock(), null);
assert.equal(chatRefBlock({ agent: "Claude", cwd: "/x", lastReply: "  \n" }), null);

// All the fields.
assert.equal(
  chatRefBlock({ title: "Fix login", agent: "Claude Code", cwd: "/work/app", branch: "fix-login", path: "/data/chats/ab12/state.json", lastReply: "Done.\n\nTests pass." }),
  "From the chat \"Fix login\" (Claude Code, in `/work/app` on `fix-login`). Its full transcript: `/data/chats/ab12/state.json`. Its last reply:\n> Done.\n>\n> Tests pass.");

// Missing fields are left out with their words.
assert.equal(chatRefBlock({ title: "T", lastReply: "ok" }), "From the chat \"T\". Its last reply:\n> ok");
assert.equal(chatRefBlock({ title: "T", agent: "Codex", lastReply: "ok" }), "From the chat \"T\" (Codex). Its last reply:\n> ok");
assert.equal(chatRefBlock({ title: "T", cwd: "/a", lastReply: "ok" }), "From the chat \"T\" (in `/a`). Its last reply:\n> ok");
assert.equal(chatRefBlock({ title: "T", branch: "main", lastReply: "ok" }), "From the chat \"T\" (on `main`). Its last reply:\n> ok");
assert.equal(chatRefBlock({ title: "T", agent: "A", branch: "main", path: "/p", lastReply: "ok" }), "From the chat \"T\" (A, on `main`). Its full transcript: `/p`. Its last reply:\n> ok");
// A title and no reply: the heading alone. A reply and no title: "another chat".
assert.equal(chatRefBlock({ title: "T", path: "/p" }), "From the chat \"T\". Its full transcript: `/p`.");
assert.equal(chatRefBlock({ lastReply: "hi" }), "From another chat. Its last reply:\n> hi");
// Quotes in a title and backticks in a path can't break the heading.
assert.equal(chatRefBlock({ title: 'Say "hi"\nnow', cwd: "/a`b", lastReply: "x" }), "From the chat \"Say 'hi' now\" (in `/a'b`). Its last reply:\n> x");

// Cut to the last maxLines lines, with a note.
const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
const q = quoteLines(many).split("\n");
assert.equal(q.length, 31);
assert.equal(q[0], "> (…earlier lines cut)");
assert.equal(q[1], "> line 21");
assert.equal(q.at(-1), "> line 50");
assert.equal(quoteLines(many, 2), "> (…earlier lines cut)\n> line 49\n> line 50");
assert.equal(quoteLines("a\nb\nc", 3), "> a\n> b\n> c");
assert.equal(quoteLines("a\nb\nc", 0).split("\n").length, 3); // a bad count is the default (30): nothing is cut
assert.equal(chatRefBlock({ title: "T", lastReply: many, maxLines: 5 }).split("\n").length, 1 + 1 + 5);
assert.equal(quoteLines("one\r\ntwo  \r\n"), "> one\n> two");
assert.equal(quoteLines(""), "");
assert.equal(quoteLines(null), "");

// The last thing the agent said; a chat's name.
const items = [{ kind: "user", text: "first line\nmore" }, { kind: "agent", text: "A1" }, { kind: "tool" }, { kind: "agent", text: " A2 \n" }, { kind: "agent", text: "  " }];
assert.equal(lastAgentText(items), "A2");
assert.equal(lastAgentText([{ kind: "user", text: "hi" }]), null);
assert.equal(lastAgentText(null), null);
assert.equal(chatTitle("c1", items, {}), "first line");
assert.equal(chatTitle("c1", items, { c1: "Named" }), "Named");
assert.equal(chatTitle("c1", [{ kind: "user", text: "x".repeat(100) }]), `${"x".repeat(80)}…`);
assert.equal(chatTitle("c1", []), "");

// The chats on offer: never this one, never one with no name.
const chats = [
  { id: "a", title: "Refactor the parser", at: 5 },
  { id: "b", title: "Fix login bug", at: 9 },
  { id: "c", title: "Login page design", at: 7 },
  { id: "d", title: "", at: 8 },
  { id: "e", title: "fix LOGIN", at: 1 },
];
assert.deepEqual(otherChats(chats, "b").map((c) => c.id), ["a", "c", "e"]);
assert.deepEqual(otherChats(null, "b"), []);

// Best match by name: all words, any case; the closest fit first, then the most recent.
assert.equal(matchChat(chats, "parser").id, "a");
assert.equal(matchChat(chats, "LOGIN").id, "c"); // a title that starts with it beats ones that only have it
assert.equal(matchChat(chats, "login fix").id, "b"); // the words apart: b and e, b is newer
assert.equal(matchChat(chats, ["fix", "login"]).id, "e"); // the whole title (e, older) beats one that starts with it (b)
assert.equal(matchChat(chats, "fix login").id, "e");
assert.equal(matchChat(chats, "fix LOGIN").id, "e");
assert.equal(matchChat(chats, "fix log").id, "b"); // starts with it in b and e: b is newer
assert.equal(matchChat(chats, "login page").id, "c");
assert.equal(matchChat(chats, "nothing here"), null);
assert.equal(matchChat(chats, "login nothing"), null);
assert.equal(matchChat(chats, ""), null);
assert.equal(matchChat(chats, "   "), null);
assert.equal(matchChat([], "x"), null);
assert.equal(matchChat(null, "x"), null);
// Without `at`, the list's order (the first) wins a tie.
assert.equal(matchChat([{ id: "p", title: "same" }, { id: "q", title: "same" }], "same").id, "p");
// The exact title beats a newer longer one.
assert.equal(matchChat([{ id: "n", title: "fix login again", at: 9 }, { id: "o", title: "fix login", at: 1 }], "fix login").id, "o");

console.log("chatref: ok");
