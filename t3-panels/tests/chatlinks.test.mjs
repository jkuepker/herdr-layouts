// node t3-panels/tests/chatlinks.test.mjs
import assert from "node:assert/strict";
import { CHAT_SCHEME, validChatId, chatUrl, chatMdLink, chatIdOf, knownId, chatLinker, chatLinkParts, linkify } from "../mods/ht3-panels/chatlinks.js";
import { chatRefBlock } from "../mods/ht3-panels/chatref.js";

// The link form.
assert.equal(CHAT_SCHEME, "herdr-chat://");
assert.equal(chatUrl("mf3k2x9a"), "herdr-chat://mf3k2x9a");
assert.equal(chatMdLink("Fix login", "mf3k2x9a"), "[Fix login](herdr-chat://mf3k2x9a)");
assert.equal(chatMdLink("a [b]\n c", "x1"), "[a (b) c](herdr-chat://x1)"); // one line, no square brackets
assert.equal(chatMdLink("", "x1"), "[chat x1](herdr-chat://x1)");
assert.equal(validChatId("mf3k2x9a"), true);
assert.equal(validChatId("a-b_c"), true);
for (const bad of ["", "a b", "a/b", "../x", null, undefined, 12]) assert.equal(validChatId(bad), false);

// An address's chat id: as written, and as a viewer may hand it back.
assert.equal(chatIdOf("herdr-chat://mf3k2x9a"), "mf3k2x9a");
assert.equal(chatIdOf(" HERDR-CHAT://mf3k2x9a/ "), "mf3k2x9a");
for (const not of ["https://example.com", "herdr-chat://", "herdr-chat://a/b", "herdr-chat://a b", "chat:abc", "", null]) assert.equal(chatIdOf(not), null);

const known = { mf3k2x9a: "Fix login", mg7q1abc: "Refactor the parser", mh00zz11: "", coordinator: "Coordinator", Mi5UPPER: "Mixed", twin0001: "Same name", twin0002: "Same name" };
assert.equal(knownId("mf3k2x9a", known), "mf3k2x9a");
assert.equal(knownId("mi5upper", known), "Mi5UPPER"); // a viewer lowered it
assert.equal(knownId("nope1234", known), null);
assert.equal(knownId("toString", known), null);
assert.equal(knownId("a b", known), null);
assert.equal(knownId("mf3k2x9a", null), null);

const L = chatLinker(known);
const md = (t) => L.markdown(t);

// Nothing names a chat: the very same text.
for (const t of ["", "Hello there.", "See https://example.com/mf3k2x9a and `code`.", "```\nmf3k2x9a\n```", "the coordinator said so", "[x](https://a.b/mf3k2x9a)"]) assert.equal(md(t), t);
assert.equal(md(null), "");

// A Markdown chat link stays; a bare address gets the chat's name; a chat with no name is "chat <id>".
assert.equal(md("See [Fix login](herdr-chat://mf3k2x9a)."), "See [Fix login](herdr-chat://mf3k2x9a).");
assert.equal(md("See herdr-chat://mf3k2x9a."), "See [Fix login](herdr-chat://mf3k2x9a).");
assert.equal(md("(herdr-chat://mh00zz11)"), "([chat mh00zz11](herdr-chat://mh00zz11))");
assert.equal(md("[](herdr-chat://mg7q1abc)"), "[Refactor the parser](herdr-chat://mg7q1abc)");
assert.equal(md("herdr-chat://coordinator"), "[Coordinator](herdr-chat://coordinator)");
assert.deepEqual(L.parts("See herdr-chat://mf3k2x9a now"), [{ text: "See " }, { text: "Fix login", chat: "mf3k2x9a" }, { text: " now" }]);

// A chat that isn't known: plain text, no link.
assert.equal(md("See [Old chat](herdr-chat://gone9999)."), "See Old chat.");
assert.equal(md("See herdr-chat://gone9999."), "See herdr-chat://gone9999.");
assert.deepEqual(L.parts("See [Old chat](herdr-chat://gone9999)."), [{ text: "See Old chat." }]);
assert.equal(md("gone9999 and `gone9999`"), "gone9999 and `gone9999`");
assert.equal(linkify("See herdr-chat://mf3k2x9a.", {}), "See herdr-chat://mf3k2x9a.");
assert.equal(linkify("See herdr-chat://mf3k2x9a."), "See herdr-chat://mf3k2x9a.");

// A chat's id by itself, also in a path; never as a piece of a longer word, never an id that reads as a word.
assert.equal(md("Ask mf3k2x9a about it"), "Ask [mf3k2x9a](herdr-chat://mf3k2x9a) about it");
assert.equal(md("mf3k2x9a, mg7q1abc."), "[mf3k2x9a](herdr-chat://mf3k2x9a), [mg7q1abc](herdr-chat://mg7q1abc).");
assert.equal(md("in /data/ht3-panels/chats/mf3k2x9a/state.json"), "in /data/ht3-panels/chats/[mf3k2x9a](herdr-chat://mf3k2x9a)/state.json");
for (const t of ["xmf3k2x9a", "mf3k2x9a2", "mf3k2x9a-b", "a_mf3k2x9a", "coordinator", "file:///x/chats/mf3k2x9a/state.json"]) assert.equal(md(t), t);

// A code span that is the id, the address or the transcript's path is a link, the code kept; other code is left alone.
assert.equal(md("chat `mf3k2x9a`"), "chat [`mf3k2x9a`](herdr-chat://mf3k2x9a)");
assert.equal(md("`herdr-chat://mf3k2x9a`"), "[`herdr-chat://mf3k2x9a`](herdr-chat://mf3k2x9a)");
assert.equal(md("Its transcript: `/h/data/ht3-panels/chats/mg7q1abc/state.json`."), "Its transcript: [`/h/data/ht3-panels/chats/mg7q1abc/state.json`](herdr-chat://mg7q1abc).");
assert.deepEqual(L.parts("`mf3k2x9a`"), [{ text: "`mf3k2x9a`", chat: "mf3k2x9a", code: true }]);
for (const t of ["`coordinator`", "`git log mf3k2x9a`", "`/h/chats/mf3k2x9a/other.json`", "```js\nherdr-chat://mf3k2x9a\n```", "```\nopen fence mf3k2x9a"]) assert.equal(md(t), t);

// `chat "<name>"`: the one known chat of that name, any case; not a name two chats have, not an unknown one.
assert.equal(md('From the chat "Fix login" (Claude).'), 'From the chat ["Fix login"](herdr-chat://mf3k2x9a) (Claude).');
assert.equal(md("the chat “fix LOGIN” said"), "the chat [“fix LOGIN”](herdr-chat://mf3k2x9a) said");
assert.equal(md('chats "Refactor the parser"'), 'chats ["Refactor the parser"](herdr-chat://mg7q1abc)');
for (const t of ['the chat "Same name"', 'the chat "Nobody"', 'say "Fix login"', 'the chat ""']) assert.equal(md(t), t);

// Another link's text and address are never touched.
assert.equal(md("[mf3k2x9a](https://example.com) and mf3k2x9a"), "[mf3k2x9a](https://example.com) and [mf3k2x9a](herdr-chat://mf3k2x9a)");

// Parts: plain stretches are joined, lines kept.
assert.deepEqual(chatLinkParts("a\nmf3k2x9a\nb `x` c", known), [{ text: "a\n" }, { text: "mf3k2x9a", chat: "mf3k2x9a" }, { text: "\nb `x` c" }]);
assert.deepEqual(chatLinkParts("plain", known), [{ text: "plain" }]);
assert.deepEqual(chatLinkParts("", known), []);

// The same linker gives the same answer when asked again (its pattern is kept between calls).
assert.equal(md("mf3k2x9a"), md("mf3k2x9a"));
assert.deepEqual(L.parts("x mf3k2x9a"), L.parts("x mf3k2x9a"));

// "/chatref" writes the link, and it comes back as one: from the block as sent, and from an agent's echo of it.
const block = chatRefBlock({ id: "mf3k2x9a", title: "Fix login", agent: "Claude Code", cwd: "/work/app", branch: "fix-login", path: "/h/data/ht3-panels/chats/mf3k2x9a/state.json", lastReply: "Done." });
assert.equal(block, "From the chat [Fix login](herdr-chat://mf3k2x9a) (Claude Code, in `/work/app` on `fix-login`). Its full transcript: `/h/data/ht3-panels/chats/mf3k2x9a/state.json`. Its last reply:\n> Done.");
assert.deepEqual(L.parts(block).filter((p) => p.chat), [{ text: "Fix login", chat: "mf3k2x9a" }, { text: "`/h/data/ht3-panels/chats/mf3k2x9a/state.json`", chat: "mf3k2x9a", code: true }]);
assert.equal(md(md(block)), md(block)); // linking what is linked changes nothing
assert.equal(chatIdOf(/\]\(([^)]+)\)/.exec(block)[1]), "mf3k2x9a");
assert.equal(chatRefBlock({ id: "mf3k2x9a", title: 'A [b] "c"', lastReply: "ok" }), "From the chat [A (b) 'c'](herdr-chat://mf3k2x9a). Its last reply:\n> ok");
assert.equal(chatRefBlock({ id: "mf3k2x9a", lastReply: "ok" }), "From [another chat](herdr-chat://mf3k2x9a). Its last reply:\n> ok");
// No id (or one that isn't an id): the block as it was.
assert.equal(chatRefBlock({ title: "T", lastReply: "ok" }), "From the chat \"T\". Its last reply:\n> ok");
assert.equal(chatRefBlock({ id: "a b", title: "T", lastReply: "ok" }), "From the chat \"T\". Its last reply:\n> ok");

console.log("chatlinks: ok");
