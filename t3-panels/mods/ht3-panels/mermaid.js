// Mermaid diagrams in replies (T3: chat/MermaidDiagram.tsx). A mod has no web view, so a
// ```mermaid block is drawn by the Mermaid CLI (`mmdc`) on this computer into a PNG under
// Herdr's own folder, which image() shows. PNG, not SVG: Mermaid's SVG keeps its labels in
// <foreignObject>, which the app's SVG loader leaves out.
//
// One picture per source and theme, kept in data/ht3-panels/mermaid/<hash>-<theme>.png; one
// render at a time; the oldest files go beyond KEEP. Nothing here installs anything.

import { exec, appHome } from "herdr";
import { MOD } from "./look.js";

export const KEEP = 200; // pictures kept in the cache folder
export const SCALE = 2; // rendered at twice its size, so it is crisp on a dense screen
export const MAX_H = 480; // a shown diagram's height at most
export const INSTALL = "npm install -g @mermaid-js/mermaid-cli";
const RENDER_MS = 60000;
const LOOK_AGAIN_MS = 30000; // not found: looked for again this long after, so an install shows without a restart

export const isMermaid = (lang) => String(lang ?? "").toLowerCase() === "mermaid";
export const cacheRel = () => `data/${MOD}/mermaid`;

// cyrb53 twice over: 26 hex digits of the text, enough to name a file.
export function hash(text) {
  const one = (seed) => {
    let a = 0xdeadbeef ^ seed, b = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16).padStart(14, "0");
  };
  return one(0) + one(0x9e3779b9).slice(2);
}
export const keyOf = (source, dark) => `${hash(String(source ?? "").trim())}-${dark ? "dark" : "default"}`;

// The size to show a picture of `w` x `h` at: no wider than `room`, no higher than `maxH`, never
// larger than it is, its shape kept.
export function fit(w, h, room, maxH = MAX_H) {
  const s = Math.min(1, room / w, maxH / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

const firstLine = (text) => (String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^Error:\s*/, "").slice(0, 200);
// A PNG's width and height are bytes 16..23 of the file: `od` prints them as eight numbers.
function sizeOf(out) {
  const b = String(out ?? "").trim().split(/\s+/).map(Number);
  if (b.length !== 8 || b.some((x) => !Number.isInteger(x))) return null;
  const w = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, h = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;
  return w > 0 && h > 0 ? { w: w / SCALE, h: h / SCALE } : null;
}

// Where mmdc is: the path given (settings' `mermaidCli`, or $HT3_MMDC), PATH, the login shell's PATH, then where npm and
// Homebrew put it. Never npx, never an install.
const FIND = `
for p in "$1" "$HT3_MMDC"; do [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; exit 0; }; done
p=$(command -v mmdc 2>/dev/null) && [ -n "$p" ] && { echo "$p"; exit 0; }
# Herdr started from the Dock has a bare PATH: ask the login shell, as chats do to find their agents.
p=$("\${SHELL:-/bin/sh}" -lic 'command -v mmdc' 2>/dev/null </dev/null | tail -n 1) && [ -x "$p" ] && { echo "$p"; exit 0; }
for p in "$HOME/.local/bin/mmdc" /opt/homebrew/bin/mmdc /usr/local/bin/mmdc "$HOME/.npm-global/bin/mmdc" "$(npm prefix -g 2>/dev/null)/bin/mmdc"; do
  [ -x "$p" ] && { echo "$p"; exit 0; }
done
exit 1`;
// A kept picture: marked as used now (the oldest are the ones pruned), and its size.
const PROBE = `[ -s "$1" ] || exit 1; touch "$1"; od -An -tu1 -j16 -N8 "$1"`;
// $1 folder, $2 key, $3 source, $4 mmdc, $5 theme, $6 scale, $7 keep. The picture is written beside
// its place and moved in whole; then the oldest beyond $7 go.
const RENDER = `
mkdir -p "$1" || exit 3
tmp="$1/.$2.$$"
printf '%s\\n' "$3" > "$tmp.mmd" || exit 3
PATH="$(dirname "$4"):$PATH" "$4" -q -i "$tmp.mmd" -o "$tmp.png" -t "$5" -b transparent -s "$6" > "$tmp.log" 2>&1
code=$?
if [ $code -ne 0 ] || [ ! -s "$tmp.png" ]; then cat "$tmp.log" >&2; rm -f "$tmp.mmd" "$tmp.png" "$tmp.log"; exit 1; fi
mv "$tmp.png" "$1/$2.png"; rm -f "$tmp.mmd" "$tmp.log"
ls -t "$1"/*.png 2>/dev/null | tail -n +$(($7 + 1)) | while IFS= read -r f; do rm -f "$f"; done
od -An -tu1 -j16 -N8 "$1/$2.png"`;

const sh = (script, args, timeout) => exec("/bin/sh", ["-c", script, "sh", ...args], { timeout }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));

let found = null; // { at, path } of the last look for mmdc
let line = Promise.resolve(); // renders, one after another

export async function findCli(given = null) {
  if (found && (found.path || Date.now() - found.at < LOOK_AGAIN_MS) && found.given === given) return found.path;
  const r = await sh(FIND, [given ?? ""], 15000);
  found = { at: Date.now(), given, path: r.code === 0 ? r.stdout.trim().split("\n")[0] || null : null };
  return found.path;
}
export const forget = () => { found = null; };

// The diagrams of one chat. `get(source, dark)` answers at once with what is known of one:
//   { state: "wait" }                          being looked up or drawn
//   { state: "ready", path, w, h }             `path` for image(), its size in pixels of the screen
//   { state: "missing" }                       no Mermaid CLI on this computer
//   { state: "error", error }                  mmdc's first line
// and starts the work when it is new. `next()` resolves each time one of them changes.
export class Diagrams {
  constructor({ cli = () => null, dir = null, keep = KEEP } = {}) {
    this.cli = cli;
    this.dir = dir; // the cache folder's path under Herdr's folder
    this.keep = keep;
    this.byKey = new Map();
    this.waiting = [];
  }

  get(source, dark) {
    const key = keyOf(source, dark);
    let d = this.byKey.get(key);
    if (d?.state === "missing" && Date.now() - d.at > LOOK_AGAIN_MS) d = null;
    if (!d) {
      d = { key, state: "wait", at: Date.now() };
      this.byKey.set(key, d);
      this.work(d, String(source ?? "").trim(), dark);
    }
    return d;
  }

  next() {
    return new Promise((ok) => this.waiting.push(ok));
  }

  settle(d, more) {
    Object.assign(d, more, { at: Date.now() });
    for (const ok of this.waiting.splice(0)) ok(d);
  }

  async work(d, source, dark) {
    const rel = this.dir ?? cacheRel(), dir = `${appHome()}/${rel}`, file = `${dir}/${d.key}.png`;
    const ready = (out) => { const size = sizeOf(out); return size ? (this.settle(d, { state: "ready", path: `${rel}/${d.key}.png`, ...size }), true) : false; };
    // Kept from before: no program needed.
    const kept = await sh(PROBE, [file], 10000);
    if (kept.code === 0 && ready(kept.stdout)) return;
    const turn = line.then(async () => {
      const mmdc = await findCli(this.cli() || null);
      if (!mmdc) return this.settle(d, { state: "missing" });
      const r = await sh(RENDER, [dir, d.key, source, mmdc, dark ? "dark" : "default", String(SCALE), String(this.keep)], RENDER_MS);
      if (r.code === 0 && ready(r.stdout)) return;
      this.settle(d, { state: "error", error: firstLine(r.stderr) || "The Mermaid CLI drew no picture" });
    });
    line = turn.catch(() => {});
    await turn.catch((e) => this.settle(d, { state: "error", error: firstLine(e?.message ?? e) }));
  }
}
