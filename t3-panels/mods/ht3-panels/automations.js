// Automations of the shown space's project (T3 Code's ThreadAutomationsPanel: a list with Run now): Herdr
// automations are Luau scripts that `herdr-automate`, a daemon on each machine, runs on a schedule or by hand once
// the person approved them. A dialog (`ht3-panels.automations`, an overlay with props.menu "automations") lists the
// project's (and, with All, every one the machine knows), each with its schedule in words, its last run, its next
// run and whether it is approved; Run now, open the script in Files, the last run's output, and "New automation…",
// which starts a chat with a request for the agent's herdr-automations skill in its message box.
//
// Where it reads (one `sh -c` through exec, in the project's folder, `on:` the space's machine):
// - the scripts: `<repository>/.herdr/automations/*.luau` (the checkout's and, in a linked worktree, the main
//   checkout's too), `~/.config/herdr-automate/automations/*.luau` (personal ones), and every path the daemon has seen;
// - the schedule: the `herdr.at / every / cron / manual` calls in the script's own text;
// - approval, runs, switches: the daemon's state, `~/.local/state/herdr-automate/state.sqlite`, read-only with sqlite3
//   (tables scripts, approvals, switches, cursors, runs, steps, daemon).
// What it changes: nothing by itself. Run now is `herdr-automate run-now FILE` (which refuses a script that isn't
// approved). It never approves: "Approve…" opens Herdr's own approval dialog (`Herdr automation approve FILE`, where
// the person reviews the plan) or, where that isn't there, copies `herdr-automate approve FILE` for the person's own terminal.
// For scripts, while the dialog is open: `ht3-panels.auto:all`, `auto:project`, `auto:refresh`, `auto:new`,
// `auto:run:<name>` (asks first), `auto:run-yes` (the answer), `auto:output:<name>`, `auto:open:<name>`,
// `auto:approve:<name>`, `auto:back`, and `automations` again closes it.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, closeOverlay, run, shared, setShared, focused, notify } from "herdr";
import { MOD, tokens, alpha, icon, iconButton, button, badge, shortPath } from "./look.js";
import { activeSpace, placeOf } from "./side.js";
import { AGENTS, detect } from "./agent-acp.js";
import { firstAgent } from "./settings.js";

export const AUTOMATIONS_SIZE = { width: 780, height: 600 };
const EVERY_MS = 5000; // how often the open dialog reads again
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---- reading ----

// $1 the state file ("" for the daemon's own), $2 the personal folder ("" for the usual one).
// Prints "#key<TAB>value" lines; a script's text follows its "#file<TAB>sha256<TAB>path" line, every line led by a space.
export const PROBE = `
db=$1; pers=$2
top=$(git rev-parse --show-toplevel 2>/dev/null) || top=$(pwd)
main=
if common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then case "$common" in */.git) main=\${common%/.git};; esac; fi
[ "$main" = "$top" ] && main=
[ -n "$db" ] || db="\${XDG_STATE_HOME:-$HOME/.local/state}/herdr-automate/state.sqlite"
[ -n "$pers" ] || pers="\${XDG_CONFIG_HOME:-$HOME/.config}/herdr-automate/automations"
bin=
for c in "$(command -v herdr-automate 2>/dev/null)" /Applications/Herdr.app/Contents/MacOS/herdr-automate "$HOME/Applications/Herdr.app/Contents/MacOS/herdr-automate"; do
  if [ -n "$c" ] && [ -x "$c" ]; then bin=$c; break; fi
done
ui=
case "$bin" in */Contents/MacOS/herdr-automate) [ -x "\${bin%/herdr-automate}/Herdr" ] && ui="\${bin%/herdr-automate}/Herdr";; esac
printf '#top\\t%s\\n#main\\t%s\\n#home\\t%s\\n#personal\\t%s\\n#bin\\t%s\\n#ui\\t%s\\n' "$top" "$main" "$HOME" "$pers" "$bin" "$ui"
havedb=
# Read-only; where the state's folder can't be written (no -shm file can be made), the file as it is.
qdb() { sqlite3 -readonly "$db" "$1" 2>/dev/null || sqlite3 "file:$db?immutable=1" "$1" 2>/dev/null; }
if [ -f "$db" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    havedb=1
    if out=$(qdb "
select '#scripts'||char(9)||json_group_array(json_object('path',path,'name',name,'repo',repo,'hash',hash,'error',error,'triggers',triggers,'seen_at',seen_at)) from scripts;
select '#approvals'||char(9)||json_group_array(json_object('path',path,'hash',hash,'approved_at',approved_at)) from approvals;
select '#switches'||char(9)||json_group_array(json_object('path',path,'paused',paused,'disabled',disabled,'reason',reason)) from switches;
select '#cursors'||char(9)||json_group_array(json_object('path',path,'trigger',trigger,'checked',checked,'fired',fired)) from cursors;
select '#runs'||char(9)||json_group_array(json_object('id',id,'path',path,'name',name,'trigger',trigger,'trigger_name',trigger_name,'reason',reason,'scheduled',scheduled,'started_at',started_at,'finished_at',finished_at,'state',state,'detail',detail,'steps',steps)) from runs where id in (select max(id) from runs group by path);
select '#steps'||char(9)||json_group_array(json_object('run',run,'position',position,'kind',kind,'summary',summary,'state',state,'exit',exit,'log_tail',log_tail,'started_at',started_at,'finished_at',finished_at)) from (select * from steps where run in (select max(id) from runs group by path) order by run, position);
select '#daemon'||char(9)||json_group_array(json_object('pid',pid,'version',version,'started_at',started_at,'beat_at',beat_at,'paused_all',paused_all)) from daemon;
select '#repos'||char(9)||json_group_array(path) from repos;
"); then printf '%s\\n' "$out"; else printf '#dberr\\t%s\\n' "$(sqlite3 -readonly "$db" 'select 1' 2>&1 | head -n 1)"; fi
  else
    printf '#dberr\\t%s\\n' "sqlite3 isn't installed"
  fi
else
  printf '#nodb\\t%s\\n' "$db"
fi
{
  for d in "$top" "$main"; do [ -n "$d" ] && ls "$d"/.herdr/automations/*.luau 2>/dev/null; done
  ls "$pers"/*.luau 2>/dev/null
  [ -n "$havedb" ] && qdb "select path from scripts"
} | awk '!seen[$0]++' | head -n 200 | while IFS= read -r f; do
  if [ ! -f "$f" ]; then printf '#gone\\t%s\\n' "$f"; continue; fi
  sum=$(shasum -a 256 "$f" 2>/dev/null || sha256sum "$f" 2>/dev/null); sum=\${sum%% *}
  printf '#file\\t%s\\t%s\\n' "$sum" "$f"
  head -c 40000 "$f" | sed 's/^/ /'
  printf '\\n'
done
`;

const jsonOr = (text, or) => { try { return JSON.parse(text); } catch { return or; } };

// What PROBE printed -> { top, main, home, personal, bin, ui, nodb, dberr, files: [{ path, sha, text }], gone: [path],
// scripts, approvals, switches, cursors, runs, steps, daemon, repos } (the tables as arrays of rows).
export function parseProbe(stdout) {
  const out = { top: null, main: null, home: null, personal: null, bin: null, ui: null, nodb: null, dberr: null, files: [], gone: [],
    scripts: [], approvals: [], switches: [], cursors: [], runs: [], steps: [], daemon: [], repos: [] };
  let file = null;
  for (const ln of String(stdout ?? "").split("\n")) {
    if (ln.startsWith(" ")) { if (file) file.lines.push(ln.slice(1)); continue; }
    file = null;
    if (!ln.startsWith("#")) continue;
    const at = ln.indexOf("\t"), key = ln.slice(1, at < 0 ? undefined : at), value = at < 0 ? "" : ln.slice(at + 1);
    if (key === "file") { const t = value.indexOf("\t"); out.files.push((file = { sha: value.slice(0, t) || null, path: value.slice(t + 1), lines: [] })); }
    else if (key === "gone") out.gone.push(value);
    else if (["top", "main", "home", "personal", "bin", "ui", "nodb", "dberr"].includes(key)) out[key] = value || null;
    else if (Array.isArray(out[key])) { const rows = jsonOr(value, null); if (Array.isArray(rows)) out[key] = rows; }
  }
  for (const f of out.files) { f.text = f.lines.join("\n"); delete f.lines; }
  return out;
}

// ---- the schedule, from the script's text ----

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

// Luau without its comments (strings are kept as they are).
function bare(src) {
  let out = "";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (src.startsWith("--[[", i)) { const j = src.indexOf("]]", i + 4); i = j < 0 ? src.length : j + 2; }
    else if (src.startsWith("--", i)) { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; }
    else { out += c; i++; }
  }
  return out;
}

const STR = `(?:"((?:[^"\\\\\\n]|\\\\.)*)"|'((?:[^'\\\\\\n]|\\\\.)*)')`;
const optOf = (table, key) => { const m = new RegExp(`\\b${key}\\s*=\\s*${STR}`).exec(table ?? ""); return m ? (m[1] ?? m[2]) : null; };

// The triggers a script declares, in its order: [{ kind: "at" | "every" | "cron" | "manual", spec, name, tz, days }].
export function triggersOf(source) {
  const src = bare(String(source ?? "")), out = [];
  const re = new RegExp(`\\bherdr\\s*\\.\\s*(at|every|cron|manual)\\s*\\(\\s*(?:${STR}\\s*,?\\s*)?(\\{[^}]*\\})?`, "g");
  for (let m; (m = re.exec(src));) {
    const kind = m[1], spec = m[2] ?? m[3] ?? null, table = m[4] ?? "";
    if (kind !== "manual" && spec == null) continue;
    out.push({ kind, spec: kind === "manual" ? null : spec.trim(), name: optOf(table, "name"), tz: optOf(table, "tz"), days: optOf(table, "days") });
  }
  return out;
}

// The daemon's own note of a script's triggers (its `triggers` column, JSON whose shape isn't documented), read with
// what is known of it: used only for a script whose file can't be read.
export function triggersFromState(text) {
  const rows = jsonOr(text, null);
  if (!Array.isArray(rows)) return [];
  return rows.map((t) => {
    if (!t || typeof t !== "object") return null;
    const s = (v) => (typeof v === "string" ? v : null);
    const kind = s(t.kind) ?? s(t.type) ?? (t.cron ? "cron" : t.every ? "every" : t.at ? "at" : "manual");
    const spec = s(t.spec) ?? s(t[kind]) ?? s(t.time) ?? s(t.interval) ?? s(t.expr) ?? null;
    if (!["at", "every", "cron", "manual"].includes(kind) || (kind !== "manual" && !spec)) return null;
    return { kind, spec: kind === "manual" ? null : spec, name: s(t.name), tz: s(t.tz), days: s(t.days) };
  }).filter(Boolean);
}

// "mon-fri", "weekdays", "mon,wed", "daily" or nothing -> the days of the week it means (0 Sunday), or null if unreadable.
export function daysOf(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || t === "daily" || t === "all" || t === "*" || t === "every day") return [0, 1, 2, 3, 4, 5, 6];
  if (t === "weekdays") return [1, 2, 3, 4, 5];
  if (t === "weekends") return [0, 6];
  const set = new Set();
  for (const part of t.split(/[\s,]+/).filter(Boolean)) {
    const [a, b] = part.split("-").map((d) => DAYS.indexOf(d.slice(0, 3)));
    if (a < 0 || (part.includes("-") && (b == null || b < 0))) return null;
    if (!part.includes("-")) set.add(a);
    else for (let d = a; ; d = (d + 1) % 7) { set.add(d); if (d === b) break; }
  }
  return [...set].sort((x, y) => x - y);
}

const listed = (words) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

// Days of the week in words: "Every day", "Weekdays", "Weekends", "Monday to Thursday", "Monday, Wednesday and Friday".
export function dayWords(days) {
  if (!days || days.length === 7) return "Every day";
  const key = days.join("");
  if (key === "12345") return "Weekdays";
  if (key === "06") return "Weekends";
  // A run of days, Monday first (so Friday to Monday reads as a run too).
  const week = [1, 2, 3, 4, 5, 6, 0], on = week.map((d) => days.includes(d));
  if (days.length >= 3) {
    for (let s = 0; s < 7; s++) {
      if (!on[s] || on[(s + 6) % 7]) continue;
      let n = 0;
      while (n < 7 && on[(s + n) % 7]) n++;
      if (n === days.length) return `${DAY_NAMES[week[s]]} to ${DAY_NAMES[week[(s + n - 1) % 7]]}`;
      break;
    }
  }
  return listed(week.filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]));
}

// "6h", "90m", "1h30m", "1d" -> milliseconds, or null.
export function intervalMs(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!/^(\d+\s*(ms|s|m|h|d|w)\s*)+$/.test(t)) return null;
  let ms = 0;
  for (const m of t.matchAll(/(\d+)\s*(ms|s|m|h|d|w)/g)) ms += Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2]];
  return ms || null;
}

function intervalWords(text) {
  const ms = intervalMs(text);
  if (!ms) return `Every ${text}`;
  const parts = [];
  let left = ms;
  for (const [unit, size] of [["day", 86400000], ["hour", 3600000], ["minute", 60000], ["second", 1000]]) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n) parts.push([n, unit]);
  }
  if (parts.length === 1) return parts[0][0] === 1 ? `Every ${parts[0][1]}` : `Every ${parts[0][0]} ${parts[0][1]}s`;
  return `Every ${listed(parts.map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`))}`;
}

// One cron field -> { any, step, values (sorted) }, or null when it can't be read. `names`: three-letter names for its numbers.
function cronField(text, lo, hi, names = null, wrap = null) {
  const set = new Set();
  let any = false, step = null;
  const num = (s) => { const i = names ? names.indexOf(String(s).toLowerCase().slice(0, 3)) : -1; const n = i >= 0 ? i + (names === MONTHS ? 1 : 0) : /^\d+$/.test(s) ? Number(s) : NaN; return n === wrap ? lo : n; };
  for (const part of String(text).split(",")) {
    const [range, by] = part.split("/");
    const st = by == null ? 1 : Number(by);
    if (!Number.isInteger(st) || st < 1) return null;
    let a, b;
    if (range === "*") { a = lo; b = hi; if (by == null) any = true; else if (!text.includes(",")) step = st; }
    else if (range.includes("-")) { [a, b] = range.split("-").map(num); }
    else { a = num(range); b = by == null ? a : hi; }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi) return null;
    if (a <= b) for (let v = a; v <= b; v += st) set.add(v);
    else for (let v = a; v <= b + (hi - lo + 1); v += st) set.add(lo + ((v - lo) % (hi - lo + 1))); // sat-mon
  }
  return { any: any || set.size === hi - lo + 1 && step == null, step, values: [...set].sort((x, y) => x - y) };
}

// A five-field cron line -> { minute, hour, dom, month, dow } (each a cronField), or null.
export function parseCron(expr) {
  const f = String(expr ?? "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  const c = { minute: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31), month: cronField(f[3], 1, 12, MONTHS), dow: cronField(f[4], 0, 6, DAYS, 7) };
  return Object.values(c).every(Boolean) ? c : null;
}

const isRun = (v) => v.length > 1 && v.every((x, i) => i === 0 || x === v[i - 1] + 1);
const nth = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

// A cron line in words; one it can't put in words is shown as it is ("Cron 5 4 1-7 * 2").
export function cronWords(expr) {
  const c = parseCron(expr), raw = `Cron ${String(expr ?? "").trim()}`;
  if (!c) return raw;
  const { minute: m, hour: h } = c;
  let time = null, repeats = true;
  if (m.any && h.any) time = "every minute";
  else if (m.step && h.any) time = `every ${m.step} minutes`;
  else if (m.any && !h.any && isRun(h.values)) time = `every minute from ${pad(h.values[0])}:00 to ${pad(h.values[h.values.length - 1])}:59`;
  else if (m.step && !h.any && isRun(h.values)) time = `every ${m.step} minutes from ${pad(h.values[0])}:00 to ${pad(h.values[h.values.length - 1])}:59`;
  else if (m.step && h.values.length === 1) time = `every ${m.step} minutes from ${pad(h.values[0])}:00 to ${pad(h.values[0])}:59`;
  else if (m.values.length === 1 && h.any) time = m.values[0] === 0 ? "every hour" : `every hour at :${pad(m.values[0])}`;
  else if (m.values.length === 1 && h.step) time = `every ${h.step} hours${m.values[0] ? ` at :${pad(m.values[0])}` : ""}`;
  else if (m.values.length === 1 && isRun(h.values) && h.values.length > 3) time = `every hour from ${pad(h.values[0])}:${pad(m.values[0])} to ${pad(h.values[h.values.length - 1])}:${pad(m.values[0])}`;
  else if (m.values.length * h.values.length <= 4) { repeats = false; time = `at ${listed(h.values.flatMap((hh) => m.values.map((mm) => `${pad(hh)}:${pad(mm)}`)))}`; }
  if (!time) return raw;
  const month = c.month.any ? "" : ` in ${listed(c.month.values.map((v) => MONTH_NAMES[v - 1]))}`;
  let day;
  if (c.dom.any && c.dow.any) day = repeats && !month ? "" : "Every day";
  else if (c.dom.any) day = dayWords(c.dow.values);
  else if (c.dow.any) day = c.dom.values.length <= 4 ? `On the ${listed(c.dom.values.map(nth))}` : null;
  else day = c.dom.values.length <= 4 ? `On the ${listed(c.dom.values.map(nth))} and on ${dayWords(c.dow.values)}` : null;
  if (day == null) return raw;
  const head = day ? (repeats ? `${time[0].toUpperCase()}${time.slice(1)}, ${/^(Every|Week|On )/.test(day) ? day[0].toLowerCase() + day.slice(1) : day}` : `${day} ${time}`) : `${time[0].toUpperCase()}${time.slice(1)}`;
  return head + month;
}

// One trigger in words: "Weekdays at 03:00 (Europe/Paris)", "Every 6 hours", "Every 15 minutes from 09:00 to 17:59, weekdays", "By hand only".
export function triggerWords(t) {
  const zone = t.tz ? ` (${t.tz})` : "";
  if (t.kind === "manual") return "By hand only";
  if (t.kind === "every") return intervalWords(t.spec);
  if (t.kind === "cron") return cronWords(t.spec) + zone;
  const days = daysOf(t.days);
  return `${days ? dayWords(days) : t.days} at ${t.spec}${zone}`;
}

// All of a script's triggers in words; each with its name when it has one and there are several.
export function scheduleWords(triggers) {
  if (!triggers.length) return "No trigger found in the script";
  return triggers.map((t) => (triggers.length > 1 && t.name ? `${t.name}: ` : "") + triggerWords(t)).join("; ");
}

// ---- the next run ----

// Minutes a zone is ahead of UTC at a moment (null: this machine's zone). Throws on a zone it doesn't know.
export function zoneOffset(ms, tz) {
  if (!tz) return -new Date(ms).getTimezoneOffset();
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms))) parts[p.type] = Number(p.value);
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000) / 60000);
}

// When a trigger fires next after `now` (ms), or null: by hand, not computable, or an interval that never fired
// (`fired`: when it last did, ms). Wall-clock times are taken in the trigger's zone; around a clock change a time may be an hour off.
export function nextRun(t, now, fired = null) {
  try {
    if (t.kind === "every") { const ms = intervalMs(t.spec); return ms && fired ? Math.max(fired + ms, now) : null; }
    if (t.kind !== "at" && t.kind !== "cron") return null;
    let c;
    if (t.kind === "at") {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t.spec ?? ""), days = daysOf(t.days);
      if (!m || !days || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
      c = { minute: { values: [Number(m[2])] }, hour: { values: [Number(m[1])] }, dom: { any: true }, month: { any: true }, dow: { any: days.length === 7, values: days } };
    } else c = parseCron(t.spec);
    if (!c) return null;
    const off = zoneOffset(now, t.tz) * 60000;
    // The zone's wall clock as if it were UTC.
    const wall = new Date(now + off);
    for (let d = 0; d < 400; d++) {
      const day = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + d));
      if (!c.month.any && !c.month.values.includes(day.getUTCMonth() + 1)) continue;
      const domOk = c.dom.any || c.dom.values.includes(day.getUTCDate()), dowOk = c.dow.any || c.dow.values.includes(day.getUTCDay());
      // cron's rule: with both a day of the month and a day of the week given, either one counts.
      if (!(c.dom.any || c.dow.any ? domOk && dowOk : domOk || dowOk)) continue;
      for (const hh of c.hour.values) for (const mm of c.minute.values) {
        const at = day.getTime() + hh * 3600000 + mm * 60000;
        const real = at - zoneOffset(at - off, t.tz) * 60000;
        if (real > now) return real;
      }
    }
  } catch {}
  return null;
}

// ---- words for times and runs ----

// The daemon's clock values: seconds or milliseconds since 1970 -> milliseconds, or null.
export const stamp = (v) => (typeof v === "number" && v > 0 ? (v > 1e11 ? v : v * 1000) : null);

// "today 03:00", "yesterday 14:02", "tomorrow 03:00", "Mon 03:00" (within six days), "Nov 9, 03:00", "Nov 9 2025, 03:00".
export function whenWords(ms, now = Date.now()) {
  if (ms == null) return "";
  const d = new Date(ms), n = new Date(now), time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayNo = (x) => Math.round(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86400000);
  const diff = dayNo(d) - dayNo(n);
  if (diff === 0) return `today ${time}`;
  if (diff === -1) return `yesterday ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (Math.abs(diff) < 7) return `${DAY_NAMES[d.getDay()].slice(0, 3)} ${time}`;
  const month = MONTH_NAMES[d.getMonth()].slice(0, 3);
  return `${month} ${d.getDate()}${d.getFullYear() === n.getFullYear() ? "" : ` ${d.getFullYear()}`}, ${time}`;
}

export function tookWords(ms) {
  if (ms == null || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// A run's or a step's state as the daemon wrote it -> { word, tone: "success" | "error" | "info" | "warning" | null }.
export function stateOf(state) {
  const s = String(state ?? "").toLowerCase();
  if (/^(ok|success|succeeded|done|passed|finished|complete|completed)$/.test(s)) return { word: "succeeded", tone: "success" };
  if (/fail|error|timeout|timed|kill|crash|refus|denied|abort/.test(s)) return { word: s === "failed" || s === "error" ? "failed" : `failed (${s})`, tone: "error" };
  if (/run|start|pending|queue|wait/.test(s)) return { word: /run|start/.test(s) ? "running" : s, tone: "info" };
  if (/skip|cancel|stop|capp/.test(s)) return { word: s, tone: "warning" };
  return { word: s || "unknown", tone: null };
}

// ---- the rows ----

const under = (path, dir) => !!dir && (path === dir || path.startsWith(`${dir}/`));

// Whether a script is approved as it is now. The approval is for one hash of the script: the file's own sha256 where
// the daemon's hashes are that, else the hash the daemon last saw the script with.
export function approvalOf(file, seen, approval) {
  if (!approval) return "needs";
  if (file?.sha && approval.hash === file.sha) return "approved";
  if (seen && seen.hash === approval.hash && !(file?.sha && looksSha(approval.hash))) return "approved";
  return "changed";
}
const looksSha = (h) => /^[0-9a-f]{64}$/i.test(String(h ?? ""));

// A probe -> the rows to show, the project's first: [{ path, name, scope: "project" | "personal" | "other", repo, gone,
// triggers, schedule, approval: "approved" | "needs" | "changed", paused, disabled, reason, error, last, next, nextWhy }].
// `last`: { id, state, at, took, why, detail, steps: [...] } or null. `next`: ms or null, `nextWhy`: why there is none.
export function rowsOf(probe, now = Date.now()) {
  const by = (list) => new Map(list.map((r) => [r.path, r]));
  const files = by(probe.files), seen = by(probe.scripts), approvals = by(probe.approvals), switches = by(probe.switches), runs = by(probe.runs);
  const roots = [probe.top, probe.main].filter(Boolean);
  const beat = stamp(probe.daemon[0]?.beat_at), alive = beat != null && now - beat < 120000, pausedAll = !!probe.daemon[0]?.paused_all;
  const paths = [...new Set([...probe.files.map((f) => f.path), ...probe.scripts.map((s) => s.path)])];
  // A linked worktree's copy of a script the main checkout has unchanged is the same automation: shown once.
  const twin = (p) => probe.main && under(p, probe.top) && files.get(probe.main + p.slice(probe.top.length))?.sha === files.get(p)?.sha && !seen.has(p);
  const rows = [];
  for (const path of paths) {
    if (twin(path)) continue;
    const file = files.get(path) ?? null, s = seen.get(path) ?? null, sw = switches.get(path) ?? null, r = runs.get(path) ?? null;
    const repo = s?.repo || roots.find((d) => under(path, `${d}/.herdr/automations`)) || (/\/\.herdr\/automations\/[^/]+$/.test(path) ? path.replace(/\/\.herdr\/automations\/[^/]+$/, "") : null);
    const scope = roots.some((d) => under(path, `${d}/.herdr/automations`) || repo === d) ? "project" : under(path, probe.personal) ? "personal" : "other";
    const triggers = file ? triggersOf(file.text) : triggersFromState(s?.triggers);
    const approval = approvalOf(file, s, approvals.get(path));
    const paused = !!sw?.paused || pausedAll, disabled = !!sw?.disabled;
    const cursors = probe.cursors.filter((c) => c.path === path), base = cursors.some((c) => c.trigger === 0) ? 0 : 1;
    let next = null, nextWhy = null;
    if (!file) nextWhy = "the script's file is gone";
    else if (!triggers.some((t) => t.kind !== "manual")) nextWhy = "by hand only";
    else if (approval !== "approved") nextWhy = approval === "changed" ? "changed since it was approved" : "not approved yet";
    else if (disabled) nextWhy = "turned off";
    else if (paused) nextWhy = "paused";
    else if (!probe.bin && !alive) nextWhy = "herdr-automate isn't installed";
    else if (!alive) nextWhy = "the automation daemon isn't running";
    else {
      const times = triggers.map((t, i) => nextRun(t, now, stamp(cursors.find((c) => c.trigger === i + base)?.fired))).filter((x) => x != null);
      if (times.length) next = Math.min(...times); else nextWhy = "after its first run";
    }
    const started = stamp(r?.started_at), finished = stamp(r?.finished_at);
    rows.push({
      path, name: s?.name || path.split("/").pop().replace(/\.luau$/, ""), scope, repo, gone: !file, triggers, schedule: file || triggers.length ? scheduleWords(triggers) : "Schedule unknown",
      approval, paused, disabled, reason: sw?.reason ?? null, error: s?.error || null, next, nextWhy,
      last: r ? { id: r.id, state: r.state, at: started, took: started && finished ? finished - started : null, why: r.reason ?? null, trigger: r.trigger_name ?? null, detail: r.detail ?? null,
        steps: probe.steps.filter((x) => x.run === r.id) } : null,
    });
  }
  const order = { project: 0, personal: 1, other: 2 };
  return rows.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

// The line under a row's schedule: "Last run yesterday 03:00: failed after 2m 3s (validation failed) · Next run today 03:00".
export function runWords(row, now = Date.now()) {
  const l = row.last;
  const st = l ? stateOf(l.state) : null;
  const last = !l ? "Never ran" : `Last run ${whenWords(l.at, now)}${l.why && !/^sched/i.test(l.why) ? ` (${l.why})` : ""}: ${st.word}${l.took != null && st.word !== "running" ? ` after ${tookWords(l.took)}` : ""}`;
  const next = row.next != null ? `Next run ${whenWords(row.next, now)}` : row.nextWhy === "by hand only" ? null : `No next run: ${row.nextWhy}`;
  return { last, next, tone: st?.tone ?? null };
}

// A run as text, for the output view: a line per step, each with the end of what it printed.
export function outputOf(row) {
  const l = row.last;
  if (!l) return "This automation hasn't run yet.";
  const lines = [`${row.name}: run ${l.id}, ${whenWords(l.at)}${l.trigger ? `, trigger ${l.trigger}` : ""}${l.why ? ` (${l.why})` : ""}: ${stateOf(l.state).word}${l.took != null ? ` after ${tookWords(l.took)}` : ""}`];
  if (l.detail) lines.push(String(l.detail));
  if (!l.steps.length) lines.push("", "No step of this run was recorded.");
  for (const s of l.steps) {
    const a = stamp(s.started_at), b = stamp(s.finished_at);
    lines.push("", `${(s.position ?? 0) + 1}. ${s.kind}${s.summary ? `  ${s.summary}` : ""}  [${stateOf(s.state).word}${s.exit != null ? `, exit ${s.exit}` : ""}${a && b ? `, ${tookWords(b - a)}` : ""}]`);
    if (s.log_tail) for (const ln of String(s.log_tail).replace(/\s+$/, "").split("\n")) lines.push(`   ${ln}`);
  }
  return lines.join("\n");
}

// One reading of the machine: -> { probe, rows, error }.
export async function readAutomations({ cwd, on = null, db = "", personal = "" } = {}, now = Date.now()) {
  let r;
  try { r = await exec("sh", ["-c", PROBE, "automations", db, personal], { cwd: cwd ?? undefined, on, timeout: 20000 }); }
  catch (e) { return { probe: null, rows: [], error: on ? `${on} can't be reached: ${String(e?.message ?? e).split("\n")[0]}` : String(e?.message ?? e).split("\n")[0] }; }
  const probe = parseProbe(r.stdout);
  if (!probe.top) return { probe: null, rows: [], error: String(r.stderr ?? "").trim().split("\n")[0] || "The automations couldn't be read." };
  return { probe, rows: rowsOf(probe, now), error: null };
}

// What "New automation…" puts into the new chat's message box: the agent's herdr-automations skill does the writing.
export function newPrompt(project) {
  return `Use the herdr-automations skill to write a Herdr automation for this project (${project}): a Luau script in .herdr/automations/. `
    + "Check it with `herdr-automate check`, show me the plan it prints, register the repository if it isn't yet, and ask me to approve it. Never approve it yourself.\n\n"
    + "What it should do, and when: ";
}

// Run now, apart from the dialog (it goes on when the dialog closes): -> what herdr-automate said in its first two seconds.
export async function runNow(bin, row, { on = null } = {}) {
  const script = 'log="${TMPDIR:-/tmp}/ht3-automation-run.$$.log"; nohup "$1" run-now "$2" >"$log" 2>&1 & sleep 2; head -c 2000 "$log"; kill -0 $! 2>/dev/null || rm -f "$log"';
  const r = await exec("sh", ["-c", script, "run-now", bin, row.path], { cwd: row.repo ?? undefined, on, timeout: 15000 });
  return String(r.stdout ?? "").trim();
}

// ---- the dialog ----

const OPEN = `${MOD}.automations-open`;
export const automationsOpen = () => Date.now() - (shared(OPEN) ?? 0) < 2500;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export class Automations {
  init(p, cx) {
    this.overlay = p.overlay;
    setShared(OPEN, Date.now());
    cx.timer.every(1000, () => setShared(OPEN, Date.now()));
    this.where = placeOf(activeSpace()); // { on, cwd }: fixed while the dialog is open
    this.space = focused()?.space ?? activeSpace()?.id ?? null;
    this.all = p.all === true;
    this.data = null; // { probe, rows, error }
    this.busy = false;
    this.ask = null; // the path Run now is being asked for
    this.note = null; // { text, bad }
    this.view = null; // { row, text }: the output of a row's last run
    this.load(cx);
    cx.timer.every(EVERY_MS, (cx) => this.load(cx));
  }
  close() { setShared(OPEN, 0); }
  shut() { setShared(OPEN, 0); closeOverlay(this.overlay); }

  load(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let d;
      try { d = await readAutomations(this.where ?? {}); } catch (e) { d = { probe: null, rows: [], error: String(e?.message ?? e) }; }
      this.busy = false;
      // A reading that failed doesn't wipe a list that is there.
      if (!d.error || !this.data?.probe) this.data = d;
      cx.notify();
    });
  }

  shown() { return (this.data?.rows ?? []).filter((r) => this.all || r.scope === "project"); }
  named(name) { return this.shown().find((r) => r.name === name || r.path === name) ?? null; }
  say(text, bad = false) { this.note = text ? { text, bad } : null; }

  command(c, cx) {
    if (c === "automations") return this.shut();
    if (!c.startsWith("auto:")) return;
    const [, verb, ...rest] = c.split(":"), row = rest.length ? this.named(rest.join(":")) : null;
    if (verb === "all" || verb === "project") this.all = verb === "all";
    else if (verb === "refresh") this.load(cx);
    else if (verb === "new") this.create(cx);
    else if (verb === "back") this.view = null;
    else if (verb === "run-yes") { const r = this.shown().find((x) => x.path === this.ask); if (r) this.runIt(r, cx); }
    else if (!row) this.say(`No automation named ${rest.join(":")} is listed.`, true);
    else if (verb === "run") this.askRun(row);
    else if (verb === "output") this.output(row, cx);
    else if (verb === "open") this.openScript(row);
    else if (verb === "approve") this.approve(row, cx);
    cx.notify();
  }

  // Why Run now can't be used on a row, or null.
  blocked(row) {
    const d = this.data?.probe;
    if (row.gone) return "The script's file is gone.";
    if (!d?.bin) return `herdr-automate isn't installed${this.where?.on ? ` on ${this.where.on}` : ""}, so nothing can run.`;
    if (row.approval !== "approved") return row.approval === "changed" ? "It changed since you approved it: approve it again first." : "Approve it first.";
    if (row.error) return "The script has an error.";
    return null;
  }

  askRun(row) {
    const why = this.blocked(row);
    if (why) return this.say(`${row.name}: ${why}`, true);
    this.ask = row.path;
    this.say(null);
  }

  runIt(row, cx) {
    this.ask = null;
    const why = this.blocked(row);
    if (why) return this.say(`${row.name}: ${why}`, true);
    this.say(`Starting ${row.name}…`);
    cx.spawn(async (cx) => {
      try {
        const said = await runNow(this.data.probe.bin, row, { on: this.where?.on ?? null });
        const bad = /refus|not approved|error|cannot|can't|no such|denied|fail/i.test(said);
        this.say(said ? `${row.name}: ${said.split("\n").slice(0, 3).join(" ")}` : `${row.name} was started.`, bad);
      } catch (e) { this.say(`${row.name} couldn't be started: ${String(e?.message ?? e).split("\n")[0]}`, true); }
      this.load(cx);
      cx.timer.after(3000, (cx) => this.load(cx));
      cx.notify();
    });
  }

  // The last run's output: what `herdr-automate runs show` prints where it is installed, else the steps the daemon recorded.
  output(row, cx) {
    this.view = { row, text: outputOf(row) };
    const bin = this.data?.probe?.bin;
    if (!bin || !row.last) return;
    cx.spawn(async (cx) => {
      const r = await exec(bin, ["runs", "show", String(row.last.id)], { cwd: row.repo ?? undefined, on: this.where?.on ?? null, timeout: 15000 }).catch(() => null);
      if (r?.code === 0 && r.stdout.trim() && this.view?.row.path === row.path) { this.view = { row, text: r.stdout.replace(/\s+$/, "") }; cx.notify(); }
    });
  }

  // The keeper shows the file in Files (search.js showHit): what this copy started would end with the dialog.
  openScript(row) {
    if (row.gone) return this.say(`${row.name}: the script's file is gone.`, true);
    run(`${MOD}.goto:1:${row.path}`);
    this.shut();
  }

  // Never approves. Herdr's own approval dialog where its app is installed on this machine (the person reviews the plan
  // and approves there); else the command for the person's own terminal, on the clipboard.
  approve(row, cx) {
    const d = this.data?.probe, on = this.where?.on ?? null;
    if (!d?.bin) return this.say(`herdr-automate isn't installed${on ? ` on ${on}` : ""}: install Herdr's automations first, then approve ${row.name} with \`herdr-automate approve\`.`, true);
    const line = `${shq(d.bin)} approve ${shq(row.path)}`;
    if (d.ui && !on) {
      exec("sh", ["-c", '"$1" automation approve "$2" >/dev/null 2>&1 &', "approve", d.ui, row.path], { cwd: row.repo ?? undefined, timeout: 10000 })
        .catch((e) => { this.say(`Herdr's approval dialog didn't open: ${String(e?.message ?? e).split("\n")[0]}`, true); });
      return this.say(`Herdr's approval dialog is opening for ${row.name}: read its plan and approve it there.`);
    }
    cx.write_to_clipboard(line);
    this.say(`Copied the command that approves ${row.name}. Run it in your own terminal${on ? ` on ${on}` : ""}: it shows the plan and asks you (it refuses from an agent's pane).`);
  }

  // New automation…: a chat tab in the project on the agent New chat comes up with (as pr.js starts one), the request
  // in its message box, not sent: the person says what it should do.
  create(cx) {
    const cwd = this.data?.probe?.top ?? this.where?.cwd, on = this.where?.on ?? null;
    if (!cwd) return this.say("This space has no folder: open a terminal or a chat in a project first.", true);
    this.say("Starting a chat…");
    cx.spawn(async (cx) => {
      try {
        const found = await detect(on);
        const agent = AGENTS.find((a) => a.id === firstAgent(found.found));
        if (!agent) throw new Error(found.error ?? "No chat agent is installed and turned on (Settings).");
        run("tab.new", { mod: MOD, ...(this.space ? { space: this.space } : {}), name: "New automation",
          props: { panel: "chat", chat: newId(), agent: [found.found[agent.argv[0]], ...agent.argv.slice(1)], cwd, machine: on, seed: newPrompt(cwd.split("/").pop()) } });
        return this.shut();
      } catch (e) {
        this.say(String(e?.message ?? e), true);
        notify({ title: "New automation", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  // What the body says when there is no list.
  words() {
    const d = this.data, w = this.where;
    if (!w?.cwd) return { glyph: "folder", text: "This space has no folder, so it has no automations. Open a terminal or a chat in a project first." };
    if (!d) return { glyph: "clock", text: "Reading the automations…" };
    if (d.error) return { glyph: "circle-alert", text: d.error, bad: true };
    if (this.shown().length) return null;
    const others = d.rows.length;
    return { glyph: "calendar-clock", text: this.all
      ? "No automation on this machine yet. New automation… starts a chat that writes one for this project."
      : `This project has no automation yet (they live in .herdr/automations/).${others ? ` ${others} elsewhere on this machine: see All.` : ""} New automation… starts a chat that writes one.` };
  }

  render(_cx) {
    const k = tokens(), d = this.data, probe = d?.probe ?? null, rows = this.shown(), now = Date.now();
    const said = this.words(), on = this.where?.on ?? null;
    const nb = (t) => String(t).replace(/ /g, " ").replace(/\t/g, "  ");
    const tab = (id, label, active, pick) => h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).cursor_pointer().text_size(12).font_medium()
      .role("button").accessibility_label(label)
      .bg(active ? k.accent : "#00000000").text_color(active ? k.foreground : k.muted).hover((s) => s.bg(k.accent).text_color(k.foreground))
      .on_click((_e, cx) => { pick(); cx.notify(); }).child(label);

    const approvalBadge = (r) => r.approval === "approved" ? badge(k, "Approved", "success") : r.approval === "changed" ? badge(k, "Changed: needs approval again", "warning") : badge(k, "Needs approval", "warning");
    const rowEl = (r, i) => {
      const w = runWords(r, now), asking = this.ask === r.path, why = this.blocked(r);
      const tone = { success: k.successText, error: k.destructiveText, info: k.info, warning: k.warningText }[w.tone] ?? k.muted;
      return v_flex().id(`auto-row-${i}`).px(16).py(10).gap(4).border_b(1).border_color(alpha(k.border, 0.7))
        .child(h_flex().gap(8).items_center().min_h(24)
          .child(icon(r.triggers.some((t) => t.kind !== "manual") ? "calendar-clock" : "play").size(15).flex_none().text_color(k.muted))
          .child(div().min_w(0).truncate().font_medium().child(r.name))
          .child(approvalBadge(r))
          .when(r.disabled, (el) => el.child(badge(k, "Off")))
          .when(r.paused && !r.disabled, (el) => el.child(badge(k, "Paused")))
          .when(r.gone, (el) => el.child(badge(k, "File gone", "error")))
          .child(div().flex_1())
          .when(asking, (el) => el
            .child(div().flex_none().text_size(12).text_color(k.muted).child("Run it now? It may start agents and spend tokens."))
            .child(button(k, `auto-yes-${i}`, "Run", (cx) => { this.runIt(r, cx); cx.notify(); }, { variant: "default" }))
            .child(button(k, `auto-no-${i}`, "Cancel", (cx) => { this.ask = null; cx.notify(); })))
          .when(!asking, (el) => el
            .when(r.approval !== "approved" && !r.gone, (e2) => e2.child(button(k, `auto-approve-${i}`, "Approve…", (cx) => { this.approve(r, cx); cx.notify(); }, { glyph: "shield", tip: probe?.ui && !on ? "Open Herdr's approval dialog: you review the plan and approve there" : "Copy the command that approves it, for your own terminal" })))
            .child(button(k, `auto-run-${i}`, "Run now", (cx) => { this.askRun(r); cx.notify(); }, { glyph: "play", disabled: !!why, tip: why ?? "Run it once, now" }))
            .child(iconButton(k, `auto-out-${i}`, "square-terminal", (cx) => { this.output(r, cx); cx.notify(); }, { tip: "The last run's output" }))
            .child(iconButton(k, `auto-open-${i}`, "code-xml", () => this.openScript(r), { tip: "Open the script in Files" }))))
        .child(div().pl(23).text_size(13).line_height("18px").text_color(alpha(k.foreground, 0.85)).child(r.schedule))
        .child(h_flex().pl(23).gap(6).text_size(12).line_height("16px")
          .child(div().flex_none().text_color(tone).child(w.last))
          .when(!!w.next, (el) => el.child(div().flex_none().text_color(k.muted).child("·")).child(div().min_w(0).truncate().text_color(k.muted).child(w.next ?? ""))))
        .when(!!r.last?.detail && w.tone === "error", (el) => el.child(div().pl(23).text_size(12).line_height("16px").text_color(k.destructiveText).truncate().child(String(r.last?.detail ?? "").split("\n")[0])))
        .when(!!r.error, (el) => el.child(div().pl(23).text_size(12).line_height("16px").text_color(k.destructiveText).child(`The script has an error: ${String(r.error).split("\n")[0]}`)))
        .when(this.all, (el) => el.child(div().pl(23).text_size(11).text_color(k.muted).truncate().child(`${r.scope === "personal" ? "Personal" : r.scope === "project" ? "This project" : "Another project"}: ${shortPath(r.path)}`)));
    };

    // The line over the list: what stands in the way of all of them.
    const beat = stamp(probe?.daemon[0]?.beat_at);
    const banner = !probe ? null
      : !probe.bin ? `herdr-automate isn't installed${on ? ` on ${on}` : " on this machine"}: the scripts are listed from their files, and nothing runs or is scheduled until it is.`
      : probe.dberr ? `The daemon's state couldn't be read (${probe.dberr}): approvals and runs are missing below.`
      : probe.nodb ? "The automation daemon has no state yet on this machine: nothing was approved or has run."
      : beat == null || now - beat > 120000 ? "The automation daemon isn't running: schedules don't fire until it is."
      : probe.daemon[0]?.paused_all ? "All automations are paused." : null;

    const view = this.view;
    return v_flex().id("ht3-automations").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .on_key_down((e, cx) => { if (String(e.key ?? "").toLowerCase() === "escape") { if (this.view) { this.view = null; cx.notify(); } else this.shut(); cx.stop_propagation?.(); } })
      .child(h_flex().h(48).pl(16).pr(8).gap(8).flex_none().items_center().border_b(1).border_color(k.border)
        .child(icon("calendar-clock").size(16).flex_none().text_color(k.muted))
        .child(div().flex_none().font_semibold().child(view ? `${view.row.name}: last run` : "Automations"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(k.muted).child(view ? shortPath(view.row.path) : this.where?.cwd ? `${on ? `${on}: ` : ""}${shortPath(probe?.top ?? this.where.cwd)}` : "No folder"))
        .when(!!view, (el) => el.child(button(k, "auto-back", "Back", (cx) => { this.view = null; cx.notify(); }, { glyph: "chevron-left" })))
        .when(!view, (el) => el
          .child(h_flex().gap(2).flex_none().child(tab("auto-tab-project", "This project", !this.all, () => { this.all = false; })).child(tab("auto-tab-all", "All", this.all, () => { this.all = true; })))
          .child(iconButton(k, "auto-refresh", "refresh-cw", (cx) => this.load(cx), { tip: "Read again" }))
          .child(button(k, "auto-new", "New automation…", (cx) => { this.create(cx); cx.notify(); }, { glyph: "plus", variant: "default", tip: "Start a chat that writes one for this project" })))
        .child(iconButton(k, "auto-close", "x", () => this.shut(), { tip: "Close (Esc)" })))
      .when(!view && !!banner, (el) => el.child(h_flex().px(16).py(8).gap(8).flex_none().items_center().border_b(1).border_color(k.border).bg(alpha(k.warning, k.dark ? 0.1 : 0.08)).text_size(12).line_height("16px").text_color(k.warningText)
        .child(icon("circle-alert").size(14).flex_none()).child(div().flex_1().min_w(0).child(banner ?? ""))))
      .when(!!view, (el) => el.child(v_flex().id("ht3-automations-output").flex_1().min_h(0).px(16).py(12).overflow_y_scrollbar().font_family(k.mono).text_size(12).line_height("18px")
        .children(String(view?.text ?? "").split("\n").slice(-600).map((ln) => div().min_h(18).whitespace_nowrap().child(nb(ln) || " ")))))
      .when(!view && !!said, (el) => el.child(v_flex().flex_1().min_h(0).px(48).gap(10).items_center().justify_center()
        .child(icon(said?.glyph ?? "clock").size(22).text_color(said?.bad ? k.destructiveText : alpha(k.muted, 0.7)))
        .child(div().text_size(13).line_height("18px").text_color(said?.bad ? k.destructiveText : k.muted).child(said?.text ?? ""))))
      .when(!view && !said, (el) => el.child(v_flex().id("ht3-automations-list").flex_1().min_h(0).overflow_y_scrollbar().children(rows.map(rowEl))))
      .child(h_flex().h(36).px(16).gap(8).flex_none().items_center().border_t(1).border_color(k.border).text_size(12).text_color(this.note?.bad ? k.destructiveText : k.muted)
        .child(div().flex_1().min_w(0).truncate().child(this.note?.text ?? (view ? "Esc goes back to the list." : rows.length ? `${rows.length} automation${rows.length === 1 ? "" : "s"}${this.all ? " on this machine" : " in this project"}. Approving is always yours: it is never done from here.` : ""))));
  }
}
