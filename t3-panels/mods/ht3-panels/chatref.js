// Another chat as context for the message box (T3's ThreadContextChip / ThreadContextRecord: agent B builds on what
// agent A did). Pure: chat.js reads the chats (saved state.json) and puts the block in the box.

import { chatMdLink, validChatId } from "./chatlinks.js";

export const REF_LINES = 30;
const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const code = (s) => `\`${one(s).replace(/`/g, "'")}\``;

// The reply's text as the last `maxLines` of its lines, each a Markdown quote line ("> "; a blank line is ">"), with
// "> (…earlier lines cut)" first when some were left out. "" for no text.
export function quoteLines(text, maxLines = REF_LINES) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim().split("\n");
  if (lines.length === 1 && !lines[0]) return "";
  const max = Math.max(1, Math.floor(Number(maxLines)) || REF_LINES), cut = lines.length > max;
  return [...(cut ? ["(…earlier lines cut)"] : []), ...(cut ? lines.slice(-max) : lines)].map((l) => (l ? `> ${l}` : ">")).join("\n");
}

// A reference to a chat: where it is and what it said last.
//   From the chat "<title>" (<agent>, in `<cwd>` on `<branch>`). Its full transcript: `<path>`. Its last reply:
//   > <the reply, its last maxLines lines>
// A field that is missing is left out with its words. null when there is no title and no reply.
// With the chat's `id` its name is a link that opens it (chatlinks.js): From the chat [<title>](herdr-chat://<id>) (…).
export function chatRefBlock({ id, title, agent, cwd, branch, path, lastReply, maxLines = REF_LINES } = {}) {
  const name = one(title).replace(/"/g, "'"), quote = quoteLines(lastReply, maxLines), linked = validChatId(id);
  if (!name && !quote) return null;
  const where = [one(cwd) && `in ${code(cwd)}`, one(branch) && `on ${code(branch)}`].filter(Boolean).join(" ");
  const inner = [one(agent) && one(agent) + (where ? "," : ""), where].filter(Boolean).join(" ");
  const head = `${linked ? (name ? `From the chat ${chatMdLink(name, id)}` : `From ${chatMdLink("another chat", id)}`) : name ? `From the chat "${name}"` : "From another chat"}${inner ? ` (${inner})` : ""}.`
    + `${one(path) ? ` Its full transcript: ${code(path)}.` : ""}${quote ? " Its last reply:" : ""}`;
  return quote ? `${head}\n${quote}` : head;
}

// The last thing the agent said in a transcript's items: the text of its last message, trimmed; null if none.
export function lastAgentText(items) {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const m = items[i], t = m?.kind === "agent" ? String(m.text ?? "").trim() : "";
    if (t) return t;
  }
  return null;
}

// A saved chat's name: its rename (`named`: chat id -> name), else its first message's first line (80 characters).
export function chatTitle(id, items, named = {}) {
  if (named?.[id]) return String(named[id]);
  const first = String((items ?? []).find((m) => m?.kind === "user")?.text ?? "").trim().split("\n")[0];
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

// The chats that can be offered from `chats` ({ id, title, at, … }): never `self`, never one with no title.
export const otherChats = (chats, self) => (chats ?? []).filter((c) => c?.id && c.id !== self && one(c.title));

// The chat whose title has all of `words` (a string or a list; case-insensitive), the best fit first: the whole title,
// then one starting with them, then the words together, then apart; ties to the most recent (`at`, then list order).
// null for no words or no chat.
export function matchChat(chats, words) {
  const ws = (Array.isArray(words) ? words.join(" ") : String(words ?? "")).toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return null;
  const phrase = ws.join(" ");
  const rank = (c) => {
    const t = one(c.title).toLowerCase();
    if (!ws.every((w) => t.includes(w))) return 9;
    return t === phrase ? 0 : t.startsWith(phrase) ? 1 : t.includes(phrase) ? 2 : 3;
  };
  let best = null, bestRank = 9;
  (chats ?? []).forEach((c) => {
    if (!c) return;
    const r = rank(c);
    if (r < 9 && (r < bestRank || (r === bestRank && (c.at ?? 0) > (best.at ?? 0)))) { best = c; bestRank = r; }
  });
  return best;
}
