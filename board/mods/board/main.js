// Board: the xo crew as a board in Herdr. One mod draws every part; the layout says which with props().part:
// "top" (the pinned Board tab with its needs-you badge, then the shown space's tabs), "board" (today's numbers, the
// next move, project chips and four columns: NEEDS YOU, WORKING, READY TO LAND, DONE) and "bottom" (the counts).
// Data comes from the xo CLI, as the xo-bridge mod reads it: `xo bearings --rows` (the tasks and their group),
// `xo log --json` (what landed when) and `xo act` (Merge, Ship, Archive). local.json beside this file may say
// {"xo": "/path/to/xo", "home": "/an/xo/home"}. Focus (F) fades everything but NEEDS YOU and shows the picked task's
// live terminal in the layout's hidden "focus-term" block, so the question can be answered in place.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, terminals, run, props, exec, readTextFile, appHome, home, watchFolder, shared, setShared, window, knownAgents, nextCommand, layout } from "herdr";

const findNode = (node, id) => node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null);

const MOD = "board";
const C = {
  top: "#101012", side: "#0f0f11", main: "#121214", card: "#1a1a1d", raised: "#242328", hover: "#1f1f23",
  line: "#1e1e20", line2: "#2a2a30", text: "#e4e4e7", soft: "#c8c8cc", muted: "#8a898e", dim: "#56555b",
  accent: "#b4a0db", accentDim: "#625187",
  you: "#ffb406", youBg: "#1f1a10", youCard: "#1b1912", youAsk: "#241f12", youLine: "#4a3a12",
  work: "#8f7fd1", land: "#53cf91", landBg: "#12201a", landLine: "#1d3a2c", done: "#6fb3f2", red: "#e0707f",
};
const COLS = [
  ["needs_you", "NEEDS YOU", C.you],
  ["in_flight", "WORKING", C.work],
  ["ready", "READY TO LAND", C.land],
  ["done", "DONE", C.done],
];
const CHIPS = [
  ["#e0707f", "#3b1d24"], ["#3ec9b4", "#11302d"], ["#f0a050", "#3a2410"], ["#a690e8", "#2a2245"],
  ["#e6c35c", "#352c10"], ["#6fb3f2", "#152a40"], ["#e88cc8", "#3a1a30"], ["#8fd18a", "#1c321c"],
];
const MONO = "JetBrains Mono";
const SANS = "Geist";
const SAFETY_MS = 15000; // a read nothing asked for
const TICK_MS = 1000; // checks worker terminals and running actions; runs no program while nothing moved
const ASK_MS = 5000; // how often the questions of blocked agents are read off their screens
const WATCHED = /\/(state\.json(\.tmp-\d+)?|events\.jsonl(\.1)?)$/; // what xo writes when a task changes
const CONFIRM = new Set(["merge", "ship", "remove"]); // asked on the card first
const LABEL = { merge: "Merge", ship: "Ship PR", remove: "Archive" };
const VIEW = "board.view"; // shared: "board" or "work", which child of the main stack shows
const LEFT = "board.left"; // shared: when the top bar last sent a picked space to the work view (ms)
const FOCUS = "board.focus"; // shared: Focus is on (the top bar fades tabs too)
const COUNTS = "board.counts"; // shared: what the top bar and status bar count

let counter = 0;
const clientId = () => `brd-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const firstLine = (s) => ((s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 160);
const mono = (size, color, text) => div().font_family(MONO).text_size(size).text_color(color).child(text);
const icon = (name, size, color) => svg(`mods/board/${name}.svg`).size(size).flex_none().text_color(color);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function human(n) { // like xo's tokens.human: 52.5K, 926K, 1.2M
  if (n < 1000) return String(n);
  for (const [size, unit] of [[1e3, "K"], [1e6, "M"], [1e9, "B"]]) {
    const v = n / size, text = v >= 99.95 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
    if (Number(text) < 1000 || unit === "B") return text + unit;
  }
  return String(n);
}
function dur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d`;
}
function chip(name) {
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [fg, bg] = CHIPS[h % CHIPS.length];
  return div().flex_none().px(5).rounded(3).bg(bg).text_color(fg).font_family(SANS).text_size(11).child(name);
}
// a count that is a number: xo prints "-" or "?" when it can't tell
const num = (v) => (v === undefined || v === null || v === "-" || v === "?" ? null : Number(v));
// what the agent is doing, as xo-bridge shows it
function pill(row) {
  const a = row.agent ?? "-";
  if (a === "blocked" || a === "idle" || a === "working" || a.startsWith("queued #") || a.startsWith("slot #")) return a;
  return row.session_status !== "Live" ? "gone" : a === "-" ? "no agent" : a;
}

// what a blocked agent asks: the lowest line on its screen that ends a question (as Slate reads it)
async function question(address) {
  const r = await exec("hc", ["read", address]);
  if (r.code !== 0) return "";
  const lines = r.stdout.split("\n").map((l) => l.replace(/^[\s│┃╭╰╮╯─━❯›>⎿⏺●•◆□☐✳*]+/u, "").trim()).reverse();
  const q = lines.find((l) => l.length >= 10 && /\p{L}/u.test(l) && /\?(\s|\)|$)/.test(l) && !l.startsWith("?") && !/shortcuts/i.test(l));
  return !q ? "" : q.length > 160 ? q.slice(0, 159) + "…" : q;
}

const isWorker = (x) => (Array.isArray(x.labels) ? x.labels.includes("xo=worker") : x.labels?.xo === "worker");
// the xo workers' terminals and their status words: a change means an agent started or stopped working
const workerSig = () => terminals().filter(isWorker).map((x) => `${x.address}:${x.status}:${x.state}`).sort().join(" ");

// The xo CLI, run with the user's environment (XO_HOME too, unless local.json names a home).
class Cli {
  constructor(xo, dir) { this.xo = xo; this.dir = dir; }
  async call(args) {
    const r = this.dir ? await exec("env", [`XO_HOME=${this.dir}`, this.xo, ...args]) : await exec(this.xo, args);
    if (r.code !== 0) {
      const last = (r.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
      if (/unrecognized arguments|invalid choice/.test(last)) throw new Error("this xo is too old for the board: it needs xo bearings --rows and xo act");
      throw new Error(last.replace(/^xo: (error: )?/, "").slice(0, 200) || `${this.xo} exited ${r.code}`);
    }
    return JSON.parse(r.stdout);
  }
  state() { return this.call(["bearings", "--rows"]); }
  log() { return this.call(["log", "--json", "--lines", "1000"]); }
  start(key, what, id) { return this.call(["act", key, what, "--id", id]); }
  action(id) { return this.call(["act", "--state", id]); }
}

export default class Board extends View {
  init(_props, cx) {
    this.part = _props?.part ?? props()?.part;
    this.now = Date.now();
    if (this.part !== "board") { // the bars only draw what the board shares, and the clock
      cx.timer.every(30000, (cx) => { this.now = Date.now(); cx.notify(); });
      return;
    }
    this.h = cx.focus_handle();
    this.src = new Cli("xo", null);
    this.tasks = []; // {key, project, slug, kind, reason, next, row}
    this.events = [];
    this.problem = null;
    this.polling = false;
    this.again = false;
    this.lastRead = 0;
    this.termSig = null;
    this.titles = {}; // task key -> first line of its brief
    this.asks = {}; // task key -> the question on its screen
    this.asking = false;
    this.programs = {}; // harness -> Program, for the agent icons
    this.filter = null; // a project, or null for all
    this.sel = null; // the selected task key
    this.focus = false;
    this.confirm = null; // {key, do}; key "*" archives every DONE task
    this.acts = {}; // task key -> {id, do, state, line}
    this.configured = false;
    // Focus starts off; the layout remembers a shown focus-term across reloads, so close it to match
    run("layout.hide", { id: "focus-term" });
    if (shared(FOCUS)) setShared(FOCUS, false);
    cx.spawn(async (cx) => {
      await this.loadConfig();
      this.configured = true;
      this.watch(cx);
      this.refresh(cx);
      try { for (const p of await knownAgents()) this.programs[p.key] = p; } catch { /* no icons: letters */ }
      cx.notify();
    });
    // board.<command> from keys.json or `herdr-app do`: works while the board doesn't have the keyboard
    cx.spawn(async (cx) => { for (;;) { this.command(String(await nextCommand()).replace(/^board\./, ""), cx); cx.notify(); } });
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.timer.every(ASK_MS, (cx) => this.readAsks(cx));
    cx.timer.every(30000, (cx) => { this.now = Date.now(); cx.notify(); });
  }

  // ---- data -------------------------------------------------------------------------------------------------

  async loadConfig() {
    let cfg = {};
    try { cfg = JSON.parse((await readTextFile(`${appHome()}/mods/${MOD}/local.json`)) || "{}"); } catch { /* defaults */ }
    const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    this.src = new Cli(str(cfg.xo) ?? "xo", str(cfg.home));
    let watch = str(cfg.home);
    if (!watch) {
      try { watch = (await exec("sh", ["-c", 'printf %s "$XO_HOME"'])).stdout.trim(); } catch { /* the default */ }
    }
    this.watchDir = watch || `${home()}/.local/state/xo`;
  }

  // reads again whenever xo writes its state or mission log
  watch(cx) {
    const dir = this.watchDir;
    cx.spawn(async (cx) => {
      for (;;) {
        let paths;
        try { paths = await watchFolder(dir); } catch { return; } // no such folder yet: the safety read covers it
        if (paths.some((p) => WATCHED.test(p))) this.refresh(cx);
      }
    });
  }

  tick(cx) {
    if (!this.configured) return;
    const sig = workerSig();
    if (sig !== this.termSig) {
      const first = this.termSig === null;
      this.termSig = sig;
      if (!first) this.refresh(cx);
    }
    if (!this.polling && Date.now() - this.lastRead >= SAFETY_MS) this.refresh(cx);
    this.pollActs(cx);
  }

  refresh(cx) {
    if (this.polling) { this.again = true; return; }
    this.polling = true;
    this.again = false;
    cx.spawn(async (cx) => {
      try {
        const [state, events] = await Promise.all([this.src.state(), this.src.log()]);
        const rows = new Map((state.rows ?? []).map((r) => [r.key, r]));
        this.tasks = (state.bearings ?? []).filter((e) => rows.has(e.key)).map((e) => {
          const r = rows.get(e.key);
          return { key: e.key, project: r.project, slug: r.slug ?? e.key.split("/").pop(), kind: e.kind, reason: e.reason, next: e.next ?? "", row: r };
        });
        this.events = events ?? [];
        this.problem = state.error || null;
        for (const t of this.tasks) {
          if (this.titles[t.key] === undefined && t.row.brief) {
            this.titles[t.key] = "";
            readTextFile(t.row.brief).then((s) => { this.titles[t.key] = firstLine(s).replace(/^#+\s*/, ""); cx.notify(); }, () => {});
          }
        }
        if (this.sel && !this.tasks.some((t) => t.key === this.sel)) this.sel = null;
        this.share();
      } catch (e) {
        this.problem = String(e.message ?? e);
      } finally {
        this.polling = false;
        this.lastRead = Date.now();
        this.now = Date.now();
      }
      cx.notify();
      this.readAsks(cx);
      if (this.again) this.refresh(cx);
    });
  }

  // what the bars draw; written only when it changed
  share() {
    const n = (k) => this.tasks.filter((t) => t.kind === k).length;
    const counts = { tasks: this.tasks.length, needs: n("needs_you"), working: n("in_flight"), ready: n("ready"), done: n("done"),
      when: new Date().toTimeString().slice(0, 5), problem: this.problem };
    if (JSON.stringify(counts) !== JSON.stringify(shared(COUNTS) ?? {})) setShared(COUNTS, counts);
  }

  readAsks(cx) {
    if (this.asking) return;
    const blocked = this.tasks.filter((t) => t.kind === "needs_you" && t.row.mux === "hc" && t.row.session);
    if (!blocked.length) return;
    this.asking = true;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const t of blocked) {
        let q = "";
        try { q = await question(t.row.session); } catch { /* no screen */ }
        if (q !== (this.asks[t.key] ?? "")) { this.asks[t.key] = q; changed = true; }
      }
      this.asking = false;
      if (changed) cx.notify();
    });
  }

  // ---- actions ----------------------------------------------------------------------------------------------

  act(cx, task, what) {
    const a = this.acts[task.key];
    if (a && a.state === "running") return;
    const rec = { id: clientId(), do: what, state: "running", line: "", polled: 0 };
    this.acts[task.key] = rec;
    this.confirm = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const reply = await this.src.start(task.key, what, rec.id);
        if (reply?.state && reply.state !== "running" && reply.state !== "starting") this.finish(cx, task.key, rec, reply);
      } catch (e) {
        rec.state = "failed"; rec.line = String(e.message ?? e);
      }
      cx.notify();
    });
  }

  pollActs(cx) {
    for (const [key, rec] of Object.entries(this.acts)) {
      if (rec.state !== "running" || Date.now() - rec.polled < 2000) continue;
      rec.polled = Date.now();
      cx.spawn(async (cx) => {
        try {
          const got = await this.src.action(rec.id);
          if (got?.state && got.state !== "running" && got.state !== "starting") this.finish(cx, key, rec, got);
        } catch { /* not in the log yet: ask again next tick */ }
      });
    }
  }

  finish(cx, key, rec, got) {
    rec.state = got.state === "done" && !got.code ? "done" : "failed";
    rec.line = firstLine(got.output) || (rec.state === "done" ? "done" : `exit ${got.code}`);
    if (rec.state === "done") delete this.acts[key]; // a failed one stays on its card
    this.refresh(cx);
    cx.notify();
  }

  ask(cx, task, what) {
    if (CONFIRM.has(what)) { this.confirm = { key: task.key, do: what }; cx.notify(); } else this.act(cx, task, what);
  }

  archiveAll(cx) {
    for (const t of this.visible().filter((t) => t.kind === "done")) this.act(cx, t, "remove");
  }

  // ---- moving around ------------------------------------------------------------------------------------------

  visible() {
    const shown = this.tasks.filter((t) => !this.filter || t.project === this.filter);
    return COLS.flatMap(([k]) => shown.filter((t) => t.kind === k && (!this.focus || k === "needs_you")));
  }

  pick(cx, key) {
    this.sel = key;
    const t = this.tasks.find((x) => x.key === key);
    if (this.focus && t?.kind === "needs_you") this.answerIn(t);
    cx.notify();
  }

  // shows the task's agent in the focus-term block and gives that block the keyboard (pane.focus prefers a visible
  // layout terminal block showing the address), so typing answers it
  answerIn(t) {
    if (!t.row.session) return;
    run("agent.focus", { terminal: t.row.session });
    run("pane.focus", { terminal: t.row.session });
  }

  move(cx, by) {
    const list = this.visible();
    if (!list.length) return;
    const i = list.findIndex((t) => t.key === this.sel);
    this.pick(cx, list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + by))].key);
  }

  goTo(cx, t) {
    if (!t?.row.session) return;
    if (this.focus) this.setFocus(cx, false);
    run("agent.focus", { terminal: t.row.session });
    run("layout.select", { stack: "main", child: "work" });
    setShared(VIEW, "work");
  }

  setFocus(cx, on, task) {
    this.focus = on;
    if (on) {
      const needs = this.visible();
      const t = task ?? needs.find((x) => x.key === this.sel) ?? needs[0];
      run("layout.show", { id: "focus-term" });
      if (t) {
        this.sel = t.key;
        this.answerIn(t);
      }
    } else {
      run("layout.hide", { id: "focus-term" });
      this.h?.focus();
    }
    setShared(FOCUS, on);
    cx.notify();
  }

  command(c, cx) {
    const t = this.tasks.find((x) => x.key === this.sel);
    if (c === "focus") this.setFocus(cx, !this.focus);
    else if (c === "unfocus") { if (this.focus) this.setFocus(cx, false); }
    else if (c === "next") this.move(cx, 1);
    else if (c === "prev") this.move(cx, -1);
    else if (c === "go" && t) this.goTo(cx, t);
    else if (c === "archive" && t?.kind === "done") this.ask(cx, t, "remove");
    else if (c === "merge" && t?.kind === "ready") this.ask(cx, t, "merge");
    else if (c === "yes" && this.confirm) {
      if (this.confirm.key === "*") this.archiveAll(cx);
      else { const ct = this.tasks.find((x) => x.key === this.confirm.key); if (ct) this.act(cx, ct, this.confirm.do); }
    } else if (c === "no") this.confirm = null;
  }

  key(e, cx) {
    const k = e.key;
    const t = this.tasks.find((x) => x.key === this.sel);
    if (this.confirm && (k === "y" || k === "enter")) {
      const c = this.confirm;
      if (c.key === "*") this.archiveAll(cx);
      else { const ct = this.tasks.find((x) => x.key === c.key); if (ct) this.act(cx, ct, c.do); }
      return;
    }
    if (this.confirm && (k === "n" || k === "escape")) { this.confirm = null; cx.notify(); return; }
    if (k === "j" || k === "down") this.move(cx, 1);
    else if (k === "k" || k === "up") this.move(cx, -1);
    else if (k === "enter" && t) this.goTo(cx, t);
    else if (k === "f") this.setFocus(cx, !this.focus);
    else if (k === "escape" && this.focus) this.setFocus(cx, false);
    else if (k === "a" && t?.kind === "done") this.ask(cx, t, "remove");
    else if (k === "m" && t?.kind === "ready") this.ask(cx, t, "merge");
    else return;
    cx.stop_propagation();
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  render() {
    if (this.part === "top") return this.top();
    if (this.part === "bottom") return this.bottom();
    if (this.part === "board") return this.board();
    return div().child(`board: unknown part ${this.part}`);
  }

  // terminal address -> its tab's times, for "waiting 6m" and "working 12m"
  times() {
    const tabs = new Map();
    for (const s of spaces()) for (const t of s.tabs) tabs.set(t.id, t);
    const out = new Map();
    for (const a of agents()) {
      const t = tabs.get(a.tab);
      if (t) out.set(a.address, { changed: t.changed_at, working: t.working_since, program: a.program });
    }
    return out;
  }

  glyph(t, times) {
    const p = times.get(t.row.session)?.program ?? this.programs[t.row.harness];
    if (p?.icon) return p.tint ? svg(p.icon).size(14).flex_none().text_color(C.muted) : image(p.icon).w(14).h(14).flex_none();
    return div().w(14).h(14).flex_none().rounded(3).bg(C.raised).flex().items_center().justify_center()
      .font_family(MONO).text_size(9).text_color(C.muted).child((t.row.harness ?? "?").slice(0, 1).toUpperCase());
  }

  btn(id, label, kind, onClick) {
    const [bg, fg, border] = kind === "you" ? [C.you, "#1a1300", C.you] : kind === "land" ? [C.land, "#08180f", C.land]
      : kind === "on" ? [C.you, "#1a1300", C.you] : [C.raised, C.text, C.line2];
    return div().id(id).flex_none().px(9).py(3).rounded(5).bg(bg).border(1).border_color(border).text_color(fg)
      .font_family(SANS).text_size(12).cursor_pointer().hover((st) => st.opacity(0.85))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  stat(label, value, color, extra, win) {
    return v_flex().flex_1().min_w(0).px(12).py(9).rounded(8).border(1)
      .bg(win ? C.landBg : C.card).border_color(win ? C.landLine : C.line)
      .child(mono(10, C.dim, label))
      .child(div().font_family(SANS).text_size(22).text_color(color).child(value))
      .children(extra ? [extra] : []);
  }

  week() {
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = day(new Date(this.now));
    const counts = Array(7).fill(0);
    for (const e of this.events) {
      if (e.kind !== "merged" && e.kind !== "shipped") continue;
      const ts = e.ts ? e.ts * 1000 : Date.parse(e.at ?? "");
      const ago = Math.round((today - day(new Date(ts))) / 86400000);
      if (ago >= 0 && ago < 7) counts[6 - ago]++;
    }
    return counts;
  }

  card(t, times) {
    const r = t.row, sel = t.key === this.sel, kindColor = COLS.find(([k]) => k === t.kind)?.[2] ?? C.dim;
    const tt = times.get(r.session);
    const now = this.now;
    const when = t.kind === "needs_you" ? (tt?.changed ? `waiting ${dur(now - tt.changed)}` : "waiting")
      : t.kind === "in_flight" ? (tt?.working ? dur(now - tt.working) : pill(r))
      : t.kind === "ready" ? "ready" : firstLine(t.reason).slice(0, 28);
    const facts = [];
    const commits = num(r.commits), changed = num(r.changed);
    if (commits !== null) facts.push([plural(commits, "commit"), C.muted]);
    if (changed) facts.push([`${changed} uncommitted`, C.muted]);
    const lines = r.lines ?? (typeof r.added === "number" ? { added: r.added, removed: r.deleted ?? 0 } : null); // xo sends lines; the fixture added/deleted
    if (lines) facts.push([`+${lines.added}`, C.land], [`−${lines.removed}`, C.red]);
    if (r.tokens?.total) facts.push([`${human(r.tokens.total)} tok`, C.muted]);
    if (r.checks_state === "pass") facts.push(["✓ checks", C.land]);
    else if (r.checks_state === "FAIL") facts.push(["✗ checks", C.red]);
    else if (r.checks_state === "stale") facts.push(["checks stale", C.you]);
    const a = this.acts[t.key];
    const confirming = this.confirm?.key === t.key;
    const ask = this.asks[t.key];

    let actions = null;
    if (a && a.state !== "done") {
      actions = h_flex().gap(6).items_center()
        .child(a.state === "running" ? icon("spinner", 11, C.work).spin(900) : div().child(""))
        .child(mono(11, a.state === "failed" ? C.red : C.muted, a.state === "running" ? `${LABEL[a.do] ?? a.do}…` : `${LABEL[a.do] ?? a.do} failed: ${a.line}`));
    } else if (confirming) {
      actions = h_flex().flex_wrap().gap(6).items_center()
        .child(mono(11, C.text, `${LABEL[this.confirm.do]} ${t.slug}?`))
        .child(this.btn(`yes-${t.key}`, "Yes  y", this.confirm.do === "remove" ? "plain" : "land", (cx) => this.act(cx, t, this.confirm.do)))
        .child(this.btn(`no-${t.key}`, "No  n", "plain", (cx) => { this.confirm = null; cx.notify(); }));
    } else if (t.kind === "needs_you") {
      actions = h_flex().gap(6)
        .child(this.btn(`answer-${t.key}`, "Answer", "you", (cx) => this.setFocus(cx, true, t)))
        .when(!!r.session, (el) => el.child(this.btn(`go-${t.key}`, "Go to agent", "plain", (cx) => this.goTo(cx, t))));
    } else if (t.kind === "ready") {
      const land = [];
      if (/^xo merge /.test(t.next)) land.push("merge");
      if (/^xo ship /.test(t.next) || /\bor xo ship\b/.test(t.next + " " + t.reason)) land.push("ship");
      actions = h_flex().gap(6)
        .children(land.map((w) => this.btn(`${w}-${t.key}`, LABEL[w], w === "merge" ? "land" : "plain", (cx) => this.ask(cx, t, w))))
        .when(!!r.session, (el) => el.child(this.btn(`go-${t.key}`, "Go to agent", "plain", (cx) => this.goTo(cx, t))));
    } else if (t.kind === "done") {
      actions = h_flex().gap(6).child(this.btn(`archive-${t.key}`, "Archive", "plain", (cx) => this.ask(cx, t, "remove")));
    } else if (r.session) {
      actions = h_flex().gap(6).child(this.btn(`go-${t.key}`, "Go to agent", "plain", (cx) => this.goTo(cx, t)));
    }

    // a flex row (stretching, unlike h_flex) so the colour bar on the left runs the card's full height
    return div().id(`card-${t.key}`).w_full().flex_none().flex().flex_row().rounded(6).overflow_hidden()
      .bg(t.kind === "needs_you" ? C.youCard : C.card).border(1).border_color(sel ? C.accentDim : C.line)
      .cursor_pointer().hover((st) => st.bg(C.hover))
      .on_click((_e, cx) => this.pick(cx, t.key))
      .child(div().w(3).flex_none().bg(kindColor))
      .child(v_flex().flex_1().min_w(0).px(11).py(9).gap(4)
      .child(h_flex().w_full().gap(6).items_center()
        .child(this.glyph(t, times))
        .child(chip(t.project))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).text_color(C.dim).child(t.slug))
        .child(mono(11, t.kind === "needs_you" ? C.you : t.kind === "ready" ? C.land : C.dim, when)))
      .child(div().font_family(SANS).text_size(13).text_color(C.text).child(this.titles[t.key] || t.slug))
      .when(t.kind === "needs_you", (el) => el.child(v_flex().px(8).py(6).rounded(4).bg(C.youAsk)
        .child(mono(10, C.you, "ASKS YOU"))
        .child(div().font_family(SANS).text_size(12).text_color(C.soft).child(ask || firstLine(t.reason)))))
      .when(t.kind === "in_flight" && pill(r) !== "working", (el) => el.child(mono(11, C.muted, `→ ${pill(r)}`)))
      .child(h_flex().flex_wrap().gap(10).children(facts.map(([s, c]) => mono(11, c, s))))
      .children(actions ? [actions] : []));
  }

  board() {
    // drawing means the stack shows the board (a hidden child doesn't draw, nor take commands): tell the top bar,
    // which can't see the stack, also after a keys.json layout.select brought the board back
    // (not right after the top bar sent a picked space to its terminal: the board can draw once more before the stack switches)
    if (shared(VIEW) === "work" && Date.now() - (shared(LEFT) ?? 0) > 1500) setShared(VIEW, "board");
    const times = this.times();
    const shown = this.tasks.filter((t) => !this.filter || t.project === this.filter);
    const by = (k) => shown.filter((t) => t.kind === k);
    const needs = by("needs_you");
    const week = this.week();
    const maxW = Math.max(1, ...week);
    const tokens = this.tasks.reduce((n, t) => n + (t.row.tokens?.total ?? 0), 0);
    const dimmed = (el) => el.when(this.focus, (e) => e.opacity(0.18));
    // the oldest question
    const next = needs.slice().sort((a, b) => (times.get(a.row.session)?.changed ?? 0) - (times.get(b.row.session)?.changed ?? 0))[0];
    const projects = [...new Set(this.tasks.map((t) => t.project))].sort();

    const strip = dimmed(div().w_full().flex_none().flex().flex_row().gap(10)
      .child(this.stat("LANDED TODAY", String(week[6]), C.land,
        h_flex().h(22).mt(4).gap(4).items_end().children(week.map((n, i) =>
          div().flex_1().h(Math.max(2, Math.round(20 * n / maxW))).rounded(2).bg(C.land).opacity(i === 6 ? 1 : 0.3))), true))
      .child(this.stat("NEEDS YOU", String(this.tasks.filter((t) => t.kind === "needs_you").length), C.you))
      .child(this.stat("WORKING", String(this.tasks.filter((t) => t.kind === "in_flight").length), C.work))
      .child(this.stat("READY TO LAND", String(this.tasks.filter((t) => t.kind === "ready").length), C.land))
      .child(this.stat("TOKENS", human(tokens), C.text, mono(10, C.dim, "live tasks"))));

    const banner = next && h_flex().w_full().flex_none().gap(14).px(14).py(10).rounded(8).items_center()
      .bg(C.youBg).border(1).border_color(C.youLine)
      .child(mono(10, C.you, "NEXT MOVE"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_family(SANS).text_size(15).text_color(C.text).truncate()
          .child(`${next.slug} asks: ${this.asks[next.key] ? `“${this.asks[next.key]}”` : firstLine(next.reason)}`))
        .child(mono(11, C.muted, [next.project, times.get(next.row.session)?.changed ? `waiting ${dur(this.now - times.get(next.row.session).changed)}` : null,
          num(next.row.commits) !== null ? plural(num(next.row.commits), "commit") : null].filter(Boolean).join(" · "))))
      .child(this.btn("next-answer", "Answer  ⏎", "you", (cx) => this.setFocus(cx, true, next)))
      .when(!!next.row.session, (el) => el.child(this.btn("next-go", "Go to agent", "plain", (cx) => this.goTo(cx, next))));

    const chips = h_flex().w_full().flex_none().gap(6).items_center()
      .child(dimmed(h_flex().gap(6).items_center()
        .child(this.filterChip(null, "all", this.tasks.length))
        .children(projects.map((p) => this.filterChip(p, p, this.tasks.filter((t) => t.project === p).length,
          this.tasks.some((t) => t.project === p && t.kind === "needs_you"))))))
      .child(div().flex_1())
      .child(mono(11, C.dim, this.focus ? "type in the terminal to answer · click the board, then F to leave" : "j/k move · ⏎ go to agent · m merge · a archive"))
      .child(this.btn("focus", this.focus ? "◎ Focus  F" : "◎ Focus  F", this.focus ? "on" : "plain", (cx) => this.setFocus(cx, !this.focus)));

    const column = ([k, label, color]) => {
      const list = by(k);
      const head = h_flex().w_full().h(22).flex_none().gap(7).items_center()
        .child(k === "needs_you" ? div().w(7).h(7).rounded(4).bg(color).loop("opacity", { from: 0.35, to: 1, period: 1200 })
          : k === "in_flight" ? icon("spinner", 10, color).spin(900) : div().w(7).h(7).rounded(4).bg(color))
        .child(mono(11, C.dim, label))
        .child(div().px(5).rounded(8).bg(C.raised).font_family(MONO).text_size(10).text_color(C.muted).child(String(list.length)))
        .child(div().flex_1())
        .when(k === "done" && list.length > 0, (el) => el.child(this.confirm?.key === "*"
          ? h_flex().gap(5).items_center().child(mono(11, C.text, `Archive ${list.length}?`))
            .child(this.btn("all-yes", "Yes", "plain", (cx) => this.archiveAll(cx)))
            .child(this.btn("all-no", "No", "plain", (cx) => { this.confirm = null; cx.notify(); }))
          : this.btn("archive-all", "Archive all", "plain", (cx) => { this.confirm = { key: "*", do: "remove" }; cx.notify(); })));
      const empty = { needs_you: "Nothing needs you.", in_flight: "Nothing running.", ready: "Nothing to land.", done: "All archived. Nice." }[k];
      return v_flex().id(`col-${k}`).flex_1().min_w(0).min_h(0).gap(8)
        .when(this.focus && k !== "needs_you", (el) => el.opacity(0.18))
        .child(head)
        .child(v_flex().id(`list-${k}`).w_full().flex_1().min_h(0).gap(8).overflow_y_scrollbar()
          .children(list.map((t) => this.card(t, times)))
          .when(!list.length, (el) => el.child(div().py(16).w_full().flex().justify_center().font_family(SANS).text_size(12).text_color(C.dim).child(empty))));
    };

    return v_flex().id("board").size_full().bg(C.main).px(16).pt(14).pb(10).gap(12)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.h.focus())
      .child(strip)
      .children(banner ? [banner] : [])
      .when(!!this.problem, (el) => el.child(mono(11, C.red, `xo: ${this.problem}`)))
      .child(chips)
      // a plain flex row: h_flex centres its children, which would shrink each column to its header
      .child(div().w_full().flex_1().min_h(0).flex().flex_row().gap(12)
        .children(COLS.map(column)));
  }

  filterChip(p, label, n, alert) {
    const on = this.filter === p;
    return h_flex().id(`chip-${label}`).flex_none().gap(6).px(8).py(2).rounded(5).items_center().cursor_pointer()
      .border(1).border_color(on ? C.accentDim : C.line2).bg(on ? "#1c1926" : "#00000000")
      .hover((st) => st.bg(C.hover))
      .on_click((_e, cx) => { this.filter = on ? null : p; cx.notify(); })
      .when(p !== null, (el) => el.child(div().w(7).h(7).rounded(4).bg(CHIPS[[...String(p)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % CHIPS.length][0])))
      .child(mono(11, on ? C.text : C.soft, label))
      .child(mono(11, C.dim, String(n)))
      .when(!!alert, (el) => el.child(div().w(6).h(6).rounded(3).bg(C.you)));
  }

  top() {
    const counts = shared(COUNTS) ?? {};
    const view = shared(VIEW) ?? "board";
    const focus = Boolean(shared(FOCUS));
    const space = spaces().find((s) => s.active);
    // a space picked in the sidebar or the picker shows its terminal, not the board (Focus moves the space itself;
    // with the side terminal open, the board stays and the side shows it)
    const side = findNode(layout(), "side");
    const sideOpen = Boolean(side && !side.hidden);
    if (space && this.lastSpace && space.id !== this.lastSpace && !focus && view === "board" && !sideOpen) {
      run("layout.select", { stack: "main", child: "work" });
      setShared(LEFT, Date.now());
      setShared(VIEW, "work");
    }
    this.lastSpace = space?.id;
    const mac = window()?.platform === "macos";
    const noDrag = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const tabEl = (id, on, children, onClick, faded) => noDrag(h_flex().id(id).h_full().flex_none().px(11).items_center().gap(7).relative()
      .font_family(MONO).text_size(12).text_color(on ? C.text : C.muted).cursor_pointer()
      .hover((st) => st.text_color(C.text)).when(faded, (el) => el.opacity(0.25))
      .on_click(onClick)
      .children(children)
      .child(div().absolute().bottom(0).left(8).right(8).h(2).rounded(1).bg(on ? C.accent : "#00000000")));
    const boardTab = tabEl("tab-board", view === "board", [
      div().child("▦ Board"),
      ...(counts.needs ? [div().px(5).rounded(8).bg(C.you).text_color("#1a1300").text_size(10).font_weight(700).child(String(counts.needs))] : []),
    ], () => { run("layout.select", { stack: "main", child: "board" }); setShared(VIEW, "board"); }, false);
    const tabs = (space?.tabs ?? []).filter((t) => !t.settled || t.status === "blocked").map((t) =>
      tabEl(`tab-${t.id}`, view === "work" && t.active, [
        ...(t.status === "blocked" ? [div().w(7).h(7).rounded(4).bg(C.you)] : t.status === "working" ? [icon("spinner", 10, C.work).spin(900)] : []),
        div().child(t.name),
      ], () => { run("tab.select", { id: t.id }); run("layout.select", { stack: "main", child: "work" }); setShared(VIEW, "work"); },
      focus && t.status !== "blocked"));
    return h_flex().id("top").size_full().bg(C.top).border_b(1).border_color(C.line)
      .child(h_flex().w(mac ? 170 : 110).h_full().flex_none().pl(mac ? 84 : 16).items_center()
        .child(div().font_family(MONO).text_size(12).font_weight(700).text_color(C.accent).child("H E R D R")))
      .child(boardTab)
      .child(div().w(1).h(16).mx(4).bg(C.line2))
      .child(h_flex().id("tabs").flex_1().min_w(0).h_full().overflow_x_scrollbar().children(tabs))
      .child(h_flex().h_full().flex_none().pr(12).gap(6).items_center()
        .child(mono(11, C.muted, "commands"))
        .children((mac ? ["⌘", "⇧", "P"] : ["Ctrl", "Shift", "P"]).map((k) =>
          div().px(5).rounded(3).bg(C.raised).font_family(MONO).text_size(10).text_color(C.muted).child(k))));
  }

  bottom() {
    const c = shared(COUNTS) ?? {};
    const item = (text, color, dot) => h_flex().gap(5).items_center()
      .when(!!dot, (el) => el.child(div().w(6).h(6).rounded(3).bg(dot)))
      .child(mono(11, color, text));
    return h_flex().id("bottom").size_full().px(12).gap(16).items_center().bg(C.side).border_t(1).border_color(C.line)
      .child(item(plural(c.tasks ?? 0, "task"), C.muted))
      .child(item(`${c.working ?? 0} working`, C.muted, C.work))
      .child(item(`${c.needs ?? 0} ${c.needs === 1 ? "needs" : "need"} you`, c.needs ? C.you : C.muted, C.you))
      .child(item(`${c.ready ?? 0} ready`, C.muted, C.land))
      .child(item(`${c.done ?? 0} done`, C.muted, C.done))
      .child(div().flex_1())
      .when(!!c.problem, (el) => el.child(item(`xo: ${String(c.problem).slice(0, 80)}`, C.red)))
      .child(item(c.when ? `read ${c.when}` : "reading xo…", C.dim))
      .child(item(new Date(this.now).toTimeString().slice(0, 5), C.muted));
  }
}
