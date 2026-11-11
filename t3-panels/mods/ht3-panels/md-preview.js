// Pure logic of the Files editor's Markdown preview (editor.js draws it); no Herdr imports, so `.scratch/md-preview.test.mjs`
// runs on it.
//
// - `isMarkdownPath(path)`: .md, .mdx and .markdown files get the Preview button.
// - `resolveLink(href, fromPath, root?)`: what a link in the file's text means: an http(s) address (opened in the system
//   browser), another file of the repository (opened in Files; a leading "/" is the repository's top), an anchor within the
//   page (nothing to open), or something else (left alone).
// - `splitMarkdown(text)`: the text as stretches of prose and fenced code blocks, so a ```mermaid block can be drawn as a
//   picture while the rest stays one markdown view each (the same fences chat.js `segments` knows); a code block's `raw` is its source with its fences, to draw it as it was written.

export const isMarkdownPath = (path) => /\.(md|mdx|markdown)$/i.test(String(path ?? ""));

// Resolves "../a/./b.md" against `fromPath`'s folder (both relative to the repository's top). null when it climbs out of it.
export function joinPath(fromPath, rel) {
  const parts = rel.startsWith("/") ? [] : String(fromPath ?? "").split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

// -> { kind: "web", url } | { kind: "file", path, hash } | { kind: "anchor" } | { kind: "none" }.
// `root`: the repository's folder on disk, for a viewer that hands back a link already resolved to file://<root>/<path>.
export function resolveLink(href, fromPath, root = null) {
  let h = String(href ?? "").trim();
  if (h.startsWith("<") && h.endsWith(">")) h = h.slice(1, -1).trim();
  if (!h) return { kind: "none" };
  if (h.startsWith("#")) return { kind: "anchor" };
  if (/^https?:\/\//i.test(h)) return { kind: "web", url: h };
  if (/^mailto:/i.test(h)) return { kind: "web", url: h };
  if (root && /^file:\/\//i.test(h)) {
    let abs = h.slice(7);
    try { abs = decodeURIComponent(abs); } catch { /* as written */ }
    const base = root.replace(/\/+$/, "") + "/";
    const rel = abs.startsWith(base) ? abs.slice(base.length).replace(/[?#].*$/, "") : "";
    const at = rel ? joinPath("", rel) : null;
    return at ? { kind: "file", path: at, hash: "" } : { kind: "none" };
  }
  // Any other scheme (file:, javascript:, vscode:, data: …) and protocol-relative addresses: not opened.
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return { kind: "none" };
  const cut = h.search(/[?#]/);
  let path = cut < 0 ? h : h.slice(0, cut);
  const hash = h.includes("#") ? h.slice(h.indexOf("#") + 1) : "";
  try { path = decodeURIComponent(path); } catch { /* left as written */ }
  if (!path) return { kind: "none" };
  const at = joinPath(fromPath, path);
  return at ? { kind: "file", path: at, hash } : { kind: "none" };
}

// Prose and fenced code: [{ code: false, text } | { code: true, lang, text, open? }]. A fence left open at the end is `open`.
export function splitMarkdown(text) {
  const out = [];
  let buf = [], code = null;
  const flush = () => { if (buf.join("\n").trim()) out.push({ code: false, text: buf.join("\n") }); buf = []; };
  for (const line of String(text ?? "").split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
    if (!code && f) { flush(); code = { fence: f[1], lang: f[2], lines: [], raw: [line] }; }
    else if (code && f && f[1][0] === code.fence[0] && f[1].length >= code.fence.length && !f[2]) { out.push({ code: true, lang: code.lang, text: code.lines.join("\n"), raw: [...code.raw, line].join("\n") }); code = null; }
    else if (code) { code.lines.push(line); code.raw.push(line); }
    else buf.push(line);
  }
  if (code) out.push({ code: true, lang: code.lang, text: code.lines.join("\n"), raw: code.raw.join("\n"), open: true });
  flush();
  return out;
}
