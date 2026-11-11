// Fuzzy matching of file paths for Quick open (quick.js), with no Herdr imports so node can test it.
//
// The matcher is fzy's: every character of the query must appear in the path, in order, case ignored, and the
// best way to lay them out wins. A match scores higher when it
//  - starts right after a "/" (a path segment) or at the start of the basename, a word break ("-", "_", ".", " ")
//    or a camelCase hump;
//  - runs on consecutively (typing "edit" for "editor.js" beats e…d…i…t spread over the path);
//  - lies in the basename (the last segment) rather than in the folders;
// and a shorter path wins a tie (the gaps cost a little, and the sort looks at the length).
// Case is ignored, but a character typed in the case the path has scores a little more.

const SLASH = 0.9, WORD = 0.8, CAMEL = 0.7, BASE = 0.35, BASE_START = 0.6;
const CONSEC = 1.0, EXACT = 0.02;
const GAP_LEAD = -0.005, GAP_TRAIL = -0.005, GAP_INNER = -0.01;
export const MAX_QUERY = 48;

const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c);
const isUpper = (c) => c >= 65 && c <= 90;
const isLowerCh = (c) => c >= 97 && c <= 122;
// Normalises what was typed: backslashes are slashes, whitespace goes (a space never matches).
export const clean = (q) => String(q ?? "").replace(/\\/g, "/").replace(/\s+/g, "").slice(0, MAX_QUERY);

// Whether `q` (already clean) is a subsequence of `p`, case ignored: a quick filter before the scoring.
export function has(q, p) {
  const n = q.length;
  if (!n) return true;
  let i = 0, c = lower(q.charCodeAt(0));
  for (let j = 0, m = p.length; j < m; j++) {
    if (lower(p.charCodeAt(j)) !== c) continue;
    if (++i === n) return true;
    c = lower(q.charCodeAt(i));
  }
  return false;
}

// The score of the position j of `p`, by what is before it.
function bonusAt(p, j, baseStart) {
  const c = p.charCodeAt(j);
  let b = j >= baseStart ? BASE : 0;
  if (j === 0) return b + SLASH + (baseStart === 0 ? BASE_START : 0); // the start of the path is a segment start
  const prev = p.charCodeAt(j - 1);
  if (prev === 47) b += j === baseStart ? SLASH + BASE_START : SLASH; // "/"
  else if (prev === 45 || prev === 95 || prev === 32) b += WORD; // - _ space
  else if (prev === 46) b += WORD - 0.2; // "."
  else if (isLowerCh(prev) && isUpper(c)) b += CAMEL;
  return b;
}

let size = 0, bonus, rows;
const grow = (n) => {
  if (size >= n) return;
  size = Math.max(n, size * 2, 256);
  bonus = new Float64Array(size);
  rows = [new Float64Array(size), new Float64Array(size), new Float64Array(size), new Float64Array(size)]; // D, M of this row and of the one before
};

// The best layout of `q` in `p`, as { score, at } where `at` lists the matched positions of `p` (only when
// `want`), or null when it doesn't match. `q` is clean(query), not empty.
export function match(q, p, want = false) {
  const n = q.length, m = p.length;
  if (!n || n > m || !has(q, p)) return null;
  const baseStart = p.lastIndexOf("/") + 1;
  grow(m);
  for (let j = 0; j < m; j++) bonus[j] = bonusAt(p, j, baseStart);
  // D[i][j]: the best score with q[i] matched at p[j]; M[i][j]: the best with q[0..i] matched within p[0..j].
  // Without `want` two rows are enough; with it the whole tables are kept to walk back.
  const D = want ? new Float64Array(n * m) : null, M = want ? new Float64Array(n * m) : null;
  let [curD, curM, prevD, prevM] = rows;
  for (let i = 0; i < n; i++) {
    const qi = q.charCodeAt(i), ci = lower(qi), gap = i === n - 1 ? GAP_TRAIL : GAP_INNER;
    let run = -Infinity;
    for (let j = 0; j < m; j++) {
      const pc = p.charCodeAt(j);
      let d = -Infinity;
      if (lower(pc) === ci) {
        const ex = pc === qi ? EXACT : 0;
        if (i === 0) d = j * GAP_LEAD + bonus[j] + ex;
        else if (j > 0) d = Math.max(prevM[j - 1] + bonus[j], prevD[j - 1] + CONSEC) + ex;
      }
      run = Math.max(d, run + gap);
      curD[j] = d;
      curM[j] = run;
      if (want) { D[i * m + j] = d; M[i * m + j] = run; }
    }
    [curD, prevD] = [prevD, curD];
    [curM, prevM] = [prevM, curM];
  }
  const score = prevM[m - 1];
  if (score === -Infinity) return null;
  if (!want) return { score, at: null };
  // Walk back: at (i, j) the match is at j when D says the score came from a match there.
  const at = new Array(n);
  let required = false;
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const d = D[i * m + j];
      if (d !== -Infinity && (required || d === M[i * m + j])) {
        required = i > 0 && j > 0 && Math.abs(d - (D[(i - 1) * m + j - 1] + CONSEC + (p.charCodeAt(j) === q.charCodeAt(i) ? EXACT : 0))) < 1e-9;
        at[i] = j--;
        break;
      }
    }
  }
  return { score, at };
}

// Ranks `paths` for `query`: [{ path, score, at }] best first, at most `limit`. `at` is where the query's
// characters are in the path. An empty query returns the first `limit` paths as they are.
export function rank(query, paths, { limit = 100 } = {}) {
  const q = clean(query);
  if (!q) return paths.slice(0, limit).map((path) => ({ path, score: 0, at: [] }));
  const hits = [];
  for (let k = 0; k < paths.length; k++) {
    const path = paths[k];
    const r = match(q, path, false);
    if (r) hits.push({ path, score: r.score });
  }
  hits.sort(order);
  const top = hits.slice(0, limit);
  for (const h of top) h.at = match(q, h.path, true)?.at ?? [];
  return top;
}

const order = (a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// A path cut into the folder part and the name: { dir: "src/lib/", name: "fuzzy.js" }.
export function split(path) {
  const i = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, i), name: path.slice(i) };
}

// `text` (a piece of a path that starts at `offset` of it) as [{ text, on }], `on` where `at` has a position.
export function pieces(text, at, offset = 0) {
  const out = [], set = new Set(at ?? []);
  let cur = null;
  for (let i = 0; i < text.length; i++) {
    const on = set.has(offset + i);
    if (cur && cur.on === on) cur.text += text[i];
    else out.push((cur = { text: text[i], on }));
  }
  return out;
}

// ---- what was typed ----

// "util.js:42:7" -> { term: "util.js", line: 42, col: 7 }; ":42" -> { term: "", line: 42 } (a line of the open
// file); anything else -> { term, line: null }.
export function parseQuery(text) {
  const s = String(text ?? "").trim();
  const m = /^(.*?):(\d+)(?::(\d+))?:?$/.exec(s);
  if (!m) return { term: s, line: null, col: null };
  const line = Number(m[2]);
  return { term: m[1].trim(), line: line > 0 ? line : null, col: m[3] ? Number(m[3]) : null };
}

// ---- recently opened files ----

export const RECENT_MAX = 20, RECENT_PROJECTS = 30;
// `list` with `path` moved (or added) first, at most `max` long.
export function pushRecent(list, path, max = RECENT_MAX) {
  return [path, ...(Array.isArray(list) ? list : []).filter((p) => p !== path)].slice(0, max);
}
// The shared map { "<machine>|<root>": [path, …] } with `path` recorded for `key`; the project last used goes last, and
// only the RECENT_PROJECTS newest are kept.
export function recordIn(all, key, path) {
  const out = { ...(all && typeof all === "object" ? all : {}) };
  const list = pushRecent(out[key], path);
  delete out[key];
  out[key] = list;
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - RECENT_PROJECTS))) delete out[k];
  return out;
}
