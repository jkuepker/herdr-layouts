// Chat links: text that names another chat becomes a link that opens it (T3's thread mentions). Pure: chat.js draws
// the links and launcher.js openChat goes there.
// The link form is `herdr-chat://<chat id>`, in Markdown `[<the chat's name>](herdr-chat://<chat id>)`: what "/chatref"
// writes (chatref.js), so an agent that echoes it gives the link back.
// What is taken for a chat, when its id is one of the known chats (`known`: chat id -> its name, "" for none):
// - `[label](herdr-chat://<id>)`, and a bare `herdr-chat://<id>` (shown as the chat's name);
// - the chat's id by itself (an id of 6 or more characters with a digit in it), also inside a path;
// - a code span that is such an id, the link, or the path of its transcript (…/ht3-panels/chats/<id>/state.json);
// - `chat "<name>"`, when exactly one known chat has that name.
// Never inside a fenced code block, another Markdown link or another address. A link to a chat that isn't known is
// plain text (its label, or the address as it was written).

export const CHAT_SCHEME = "herdr-chat://";
const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export const validChatId = (id) => typeof id === "string" && /^[\w-]+$/.test(id);
export const chatUrl = (id) => `${CHAT_SCHEME}${id}`;
// A name as a Markdown link's label: one line, no square brackets.
const label = (s) => one(s).replace(/\[/g, "(").replace(/\]/g, ")");
// `[<name>](herdr-chat://<id>)`; a chat with no name is "chat <id>".
export const chatMdLink = (title, id) => `[${label(title) || `chat ${id}`}](${chatUrl(id)})`;

// The chat id of a link's address (as written, or as a viewer hands it back: any case of the scheme, a "/" after it);
// null for any other address.
export function chatIdOf(url) {
  const m = /^herdr-chat:\/\/([\w-]+)\/?$/i.exec(String(url ?? "").trim());
  return m ? m[1] : null;
}

// The id as the known chats spell it (a viewer may hand an address back in lower case); null when no chat has it.
export function knownId(id, known) {
  if (!validChatId(id) || !known) return null;
  if (Object.hasOwn(known, id)) return id;
  const low = id.toLowerCase(), found = Object.keys(known).filter((k) => k.toLowerCase() === low);
  return found.length === 1 ? found[0] : null;
}

// An id that can stand by itself in a sentence without being an ordinary word.
const idLike = (id) => id.length >= 6 && /\d/.test(id);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATH = /\/ht3-panels\/chats\/([\w-]+)\/state\.json$/;

// For one set of known chats: `parts(text)` is the text as [{ text }, { text, chat }, …] (a part with `chat` is a link to
// that chat id, its `text` what to show; `code`: it was a code span), `markdown(text)` the same text with each link as a
// Markdown link (the text itself, unchanged, when nothing in it names a chat).
export function chatLinker(known = {}) {
  const ids = Object.keys(known ?? {}).filter(validChatId), bare = ids.filter(idLike).sort((a, b) => b.length - a.length);
  const byTitle = new Map();
  for (const id of ids) {
    const t = one(known[id]).replace(/"/g, "'").toLowerCase();
    if (t) byTitle.set(t, byTitle.has(t) ? null : id); // null: more than one chat has this name
  }
  // 1 a fence, 2 a code span, 3 4 a chat link's label and id, 5 any other Markdown link, 6 a bare chat address,
  // 7 any other address, 8 9 `chat "<name>"`, 10 a known id.
  const re = new RegExp([
    "(```[\\s\\S]*?(?:```|$))",
    "(`[^`\\n]+`)",
    "\\[([^\\]\\n]*)\\]\\(\\s*herdr-chat:\\/\\/([\\w-]+)\\/?\\s*\\)",
    "(\\[[^\\]\\n]*\\]\\([^)\\n]*\\))",
    "herdr-chat:\\/\\/([\\w-]+)",
    "([A-Za-z][\\w+.-]*:\\/\\/[^\\s<>)\\]]+)",
    "\\b(chats? )([\"“][^\"“”\\n]{1,120}[\"”])",
    ...(bare.length ? [`(${bare.map(esc).join("|")})`] : []),
  ].join("|"), "g");
  const nameOf = (id) => one(known[id]) || `chat ${id}`;

  function parts(text) {
    const s = String(text ?? ""), out = [];
    const plain = (t) => { if (!t) return; const last = out[out.length - 1]; if (last && !last.chat) last.text += t; else out.push({ text: t }); };
    const link = (t, chat, code) => out.push({ text: t, chat, ...(code ? { code: true } : {}) });
    let at = 0;
    re.lastIndex = 0;
    for (let m; (m = re.exec(s)); ) {
      plain(s.slice(at, m.index));
      at = m.index + m[0].length;
      if (m[2] != null) {
        const inner = m[2].slice(1, -1).trim(), id = knownId(chatIdOf(inner) ?? PATH.exec(inner)?.[1] ?? (idLike(inner) ? inner : null), known);
        if (id) link(m[2], id, true); else plain(m[2]);
      } else if (m[4] != null) {
        const id = knownId(m[4], known);
        if (id) link(m[3] || nameOf(id), id); else plain(m[3] || m[0]);
      } else if (m[6] != null) {
        const id = knownId(m[6], known);
        if (id) link(nameOf(id), id); else plain(m[0]);
      } else if (m[9] != null) {
        const id = byTitle.get(one(m[9].slice(1, -1)).replace(/"/g, "'").toLowerCase());
        plain(m[8]);
        if (id) link(m[9], id); else plain(m[9]);
      } else if (m[10] != null) {
        // The id by itself: not a piece of a longer word or id.
        const before = s[m.index - 1] ?? " ", after = s[at] ?? " ";
        if (/[\w-]/.test(before) || /[\w-]/.test(after)) plain(m[0]); else link(m[0], m[10]);
      } else plain(m[0]);
    }
    plain(s.slice(at));
    return out;
  }

  function markdown(text) {
    const s = String(text ?? ""), ps = parts(s);
    // Nothing names a chat and nothing was rewritten (a link to an unknown chat loses its address): the text as it is.
    if (!ps.some((p) => p.chat) && ps.map((p) => p.text).join("") === s) return s;
    return ps.map((p) => (p.chat ? `[${p.code ? p.text : label(p.text)}](${chatUrl(p.chat)})` : p.text)).join("");
  }

  return { parts, markdown };
}

export const chatLinkParts = (text, known) => chatLinker(known).parts(text);
export const linkify = (text, known) => chatLinker(known).markdown(text);
