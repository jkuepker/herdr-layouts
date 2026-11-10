// The Usage dialog (T3's usage page and ThreadDetailsUsage): what the chats of this computer have used.
// What the data has, and no more:
// - context: ACP's `usage_update` gives the tokens in the context window and its size; each change is a sample
//   (transcript.js `usageLog`), so the share over time can be drawn;
// - tokens per turn: an agent may send `usage` with a prompt's answer (session.js adds them up as `tokens`);
// - Claude Code writes every answer's tokens to its own logs (~/.claude/projects/<folder>/<session>.jsonl): a chat
//   of Claude Code is summed from its session's log, read only, each answer counted once (the log repeats it);
// - cost: shown only when the agent sends one (`usage_update`'s `cost`). Nothing is estimated from prices.
// Opened with `ht3-panels.usage`, "/usage" in a chat, or the palette.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, closeOverlay, appHome, home, shared, focused, readTextFile } from "herdr";
import { MOD, tokens, alpha, icon, agentMark, iconButton, shortPath } from "./look.js";
import { agentOf } from "./agent-acp.js";
import { agentName } from "./report.js";

export const USAGE_SIZE = { width: 680, height: 660 };

const num = (n) => (n == null ? "–" : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const short = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// The saved chats, newest first, at most 80: { id, at, title, agent, agentId, argv, cwd, machine, sessionId, usage, log, tokens, turns }.
async function readChats() {
  const dir = `${appHome()}/data/${MOD}/chats`, named = shared(`${MOD}.named`) ?? {};
  const r = await exec("/bin/sh", ["-c", "cd \"$1\" 2>/dev/null && stat -f '%m %N' */state.json 2>/dev/null", "sh", dir]).catch(() => null);
  const stats = String(r?.stdout ?? "").split("\n").filter(Boolean).map((l) => ({ at: Number(l.slice(0, l.indexOf(" "))) * 1000, id: l.slice(l.indexOf(" ") + 1).split("/")[0] }))
    .filter((x) => x.at && x.id).sort((a, b) => b.at - a.at).slice(0, 80);
  const out = [];
  for (const { id, at } of stats) {
    try {
      const s = JSON.parse(await readTextFile(`${dir}/${id}/state.json`));
      if (!Array.isArray(s.agentArgv)) continue;
      const t = s.transcript ?? {}, items = t.items ?? [], first = items.find((m) => m.kind === "user")?.text?.trim().split("\n")[0];
      if (!first) continue;
      out.push({ id, at, title: named[id] || (first.length > 80 ? first.slice(0, 80) + "…" : first), agent: agentName(s.agentArgv, s.agentInfo?.title ?? s.agentInfo?.name), agentId: agentOf(s.agentArgv)?.id ?? null,
        argv: s.agentArgv, cwd: s.cwd ?? null, machine: s.machine ?? null, sessionId: s.sessionId ?? null, usage: t.usage ?? null, log: Array.isArray(t.usageLog) ? t.usageLog : [],
        tokens: t.tokens ?? null, turns: items.filter((m) => m.kind === "user").length });
    } catch {}
  }
  return out;
}

// Claude Code's own count for its sessions, from its logs: { <session id>: { input, output, cacheRead, cacheWrite, answers } }.
// Read only. An answer is written to the log several times while it streams: its last entry counts.
const SUM = `
import json, glob, os, sys
out = {}
for sid in sys.argv[1:]:
    seen = {}
    for path in glob.glob(os.path.expanduser("~/.claude/projects/*/" + sid + ".jsonl")):
        try:
            for line in open(path, errors="replace"):
                if '"usage"' not in line: continue
                try: o = json.loads(line)
                except Exception: continue
                m = o.get("message")
                u = m.get("usage") if isinstance(m, dict) else None
                if isinstance(u, dict): seen[m.get("id") or o.get("uuid")] = u
        except OSError: pass
    if seen:
        g = lambda k: sum(int(u.get(k) or 0) for u in seen.values())
        out[sid] = {"input": g("input_tokens"), "output": g("output_tokens"), "cacheRead": g("cache_read_input_tokens"), "cacheWrite": g("cache_creation_input_tokens"), "answers": len(seen)}
print(json.dumps(out))
`;
async function claudeTotals(ids) {
  const safe = ids.filter((s) => /^[\w-]+$/.test(String(s ?? "")));
  if (!safe.length) return {};
  const r = await exec("/usr/bin/python3", ["-I", "-c", SUM, ...safe], { cwd: home(), timeout: 60000 }).catch(() => null);
  try { return r?.code === 0 ? JSON.parse(r.stdout) : {}; } catch { return {}; }
}

export class Usage {
  init(p, cx) {
    this.overlay = p.overlay;
    this.chats = null;
    this.claude = {};
    // The chat of the shown tab, if it is one.
    const tab = focused()?.tab, places = shared(`${MOD}.places`) ?? {};
    this.here = Object.entries(places).find(([, at]) => at.tab === tab)?.[0] ?? null;
    cx.spawn(async (cx) => {
      this.chats = await readChats().catch(() => []);
      cx.notify();
      const ids = this.chats.filter((c) => c.agentId === "claude" && !c.machine && c.sessionId).map((c) => c.sessionId);
      if (ids.length) { this.claude = await claudeTotals(ids); cx.notify(); }
    });
  }
  close() {}
  command(c, cx) {
    if (c === "ui:close") closeOverlay(this.overlay);
    cx.notify();
  }

  // A chat's tokens: { input, output, extra, from } where the data has them, else null.
  tokensOf(c) {
    const log = c.sessionId ? this.claude[c.sessionId] : null;
    if (log) return { input: log.input + log.cacheRead + log.cacheWrite, output: log.output, extra: `${short(log.cacheRead)} of the input read from cache`, from: "Claude Code's log" };
    const t = c.tokens;
    if (t && (t.input || t.output || t.total)) return { input: t.input ?? null, output: t.output ?? null, total: t.total ?? null, extra: null, from: "the agent" };
    return null;
  }

  render(_cx) {
    const k = tokens();
    const chats = this.chats ?? [];
    const me = chats.find((c) => c.id === this.here) ?? null;
    const head = (title, about) => v_flex().px(12).gap(2)
      .child(div().text_size(16).font_semibold().child(title))
      .when(!!about, (el) => el.child(div().text_size(12).line_height("16px").text_color(k.muted).child(about)));
    const box = (children) => v_flex().rounded(12).border(1).border_color(alpha(k.border, 0.6)).bg(alpha(k.card, 0.4)).overflow_hidden().children(children);
    const share = (u) => (u?.size > 0 ? Math.min(1, u.used / u.size) : null);
    const meter = (s, w = 72) => div().w(w).h(6).flex_none().rounded_full().bg(alpha(k.foreground, 0.1))
      .child(div().h(6).rounded_full().w(Math.max(s > 0 ? 2 : 0, Math.round(w * (s ?? 0)))).bg(s > 0.85 ? k.destructive : s > 0.6 ? k.warning : k.primary));
    const cell = (text, w, color = k.muted) => div().w(w).flex_none().text_size(12).text_color(color).truncate().child(text);
    const figure = (label, value, note) => v_flex().flex_1().min_w(0).gap(2)
      .child(div().text_size(11).text_color(k.muted).child(label))
      .child(div().text_size(18).font_semibold().child(value))
      .when(!!note, (el) => el.child(div().text_size(11).line_height("14px").text_color(k.muted).child(note)));
    const cost = (u) => (u?.cost && Number.isFinite(Number(u.cost.amount)) ? `${Number(u.cost.amount).toFixed(Number(u.cost.amount) < 1 ? 4 : 2)} ${u.cost.currency ?? ""}`.trim() : null);

    // This chat: where its context stands, and how it got there.
    const mine = () => {
      const s = share(me.usage), tk = this.tokensOf(me), log = me.log.slice(-64), top = Math.max(0.01, ...log.map((x) => share(x) ?? 0));
      const H = 56;
      return box([
        h_flex().px(12).py(12).gap(16).items_start()
          .child(figure("Context", s == null ? "–" : `${Math.round(s * 100)}%`, me.usage ? `${num(me.usage.used)} of ${num(me.usage.size)} tokens` : "the agent hasn't said"))
          .child(figure("Turns", String(me.turns), `${me.agent} · ${ago(me.at)}`))
          .child(figure("Tokens in", tk ? short(tk.input ?? tk.total) : "–", tk ? (tk.extra ?? `from ${tk.from}`) : "not reported"))
          .child(figure("Tokens out", tk ? short(tk.output) : "–", tk ? `from ${tk.from}` : "not reported"))
          .when(!!cost(me.usage), (el) => el.child(figure("Cost", cost(me.usage), "as the agent reports it"))),
        v_flex().px(12).py(10).gap(6)
          .child(div().text_size(11).text_color(k.muted).child(log.length > 1 ? `Context share over time · peak ${Math.round(top * 100)}%` : "Context share over time: drawn once the agent has reported it more than once"))
          .when(log.length > 1, (el) => el
            .child(h_flex().h(H).gap(2).items_end().children(log.map((x, i) => div().id(`u-bar-${i}`).flex_1().max_w(14).min_w(2).rounded_t(2)
              .h(Math.max(2, Math.round(H * ((share(x) ?? 0) / top)))).bg(i === log.length - 1 ? k.primary : alpha(k.primary, 0.45))
              .tooltip(`${clock(x.at)} · ${num(x.used)} tokens · ${Math.round((share(x) ?? 0) * 100)}%`))))
            .child(h_flex().text_size(11).text_color(k.muted).child(div().flex_1().child(clock(log[0].at))).child(div().flex_none().child(clock(log.at(-1).at))))),
      ]);
    };

    // Per agent: its chats, their turns, and the tokens of those whose data has them.
    const agents = new Map();
    for (const c of chats) {
      const a = agents.get(c.agent) ?? { name: c.agent, argv: c.argv, chats: 0, turns: 0, input: 0, output: 0, counted: 0, cost: 0, costs: 0, currency: null };
      const tk = this.tokensOf(c);
      a.chats++; a.turns += c.turns;
      if (tk) { a.counted++; a.input += tk.input ?? tk.total ?? 0; a.output += tk.output ?? 0; }
      if (cost(c.usage)) { a.costs++; a.cost += Number(c.usage.cost.amount); a.currency = c.usage.cost.currency ?? a.currency; }
      agents.set(c.agent, a);
    }
    const anyCost = [...agents.values()].some((a) => a.costs > 0);
    const agentRows = [...agents.values()].sort((x, y) => y.turns - x.turns).map((a) => h_flex().h(40).px(12).gap(10).items_center()
      .child(h_flex().size(18).flex_none().items_center().justify_center().child(agentMark(agentOf(a.argv), 16, k.foreground) ?? icon("bot").size(16).text_color(k.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().child(a.name))
      .child(cell(`${a.chats} chat${a.chats === 1 ? "" : "s"}`, 64))
      .child(cell(`${a.turns} turn${a.turns === 1 ? "" : "s"}`, 64))
      .child(cell(a.counted ? `${short(a.input)} in` : "tokens: –", 84, a.counted ? k.foreground : k.muted))
      .child(cell(a.counted ? `${short(a.output)} out` : "", 70, k.foreground))
      .when(anyCost, (el) => el.child(cell(a.costs ? `${a.cost.toFixed(a.cost < 1 ? 4 : 2)} ${a.currency ?? ""}` : "", 84, k.foreground))));

    const chatRows = chats.slice(0, 40).map((c) => {
      const s = share(c.usage), tk = this.tokensOf(c);
      return h_flex().h(40).px(12).gap(10).items_center().when(c.id === this.here, (el) => el.bg(alpha(k.accent, 0.6)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).child(c.title))
          .child(div().truncate().text_size(11).text_color(k.muted).child(`${c.agent} · ${c.machine ? `${c.machine}:` : ""}${shortPath(c.cwd) ?? "~"} · ${ago(c.at)}`)))
        .child(cell(`${c.turns} turn${c.turns === 1 ? "" : "s"}`, 56))
        .child(cell(tk ? `${short(tk.input ?? tk.total)} / ${short(tk.output)}` : "–", 84, tk ? k.foreground : k.muted))
        .child(meter(s))
        .child(cell(s == null ? "–" : `${Math.round(s * 100)}%`, 34, k.foreground));
    });
    const divided = (rows) => rows.map((r, i) => (i ? v_flex().border_t(1).border_color(alpha(k.border, 0.5)).child(r) : r));

    return v_flex().id("ht3-usage").size_full().bg(k.popover).text_color(k.foreground).text_size(14)
      .child(h_flex().px(24).pt(20).pb(12).flex_none().items_center().border_b(1).border_color(k.border)
        .child(div().flex_1().text_size(20).font_semibold().child("Usage"))
        .child(iconButton(k, "usage-close", "x", () => closeOverlay(this.overlay), { tip: "Close" })))
      .child(v_flex().id("ht3-usage-body").flex_1().min_h(0).px(12).py(16).gap(24).overflow_y_scrollbar()
        .when(this.chats == null, (el) => el.child(div().px(12).text_size(12).text_color(k.muted).child("Reading the chats…")))
        .when(!!me, (el) => el.child(v_flex().gap(10).child(head("This chat", me.title)).child(mine())))
        .when(this.chats != null && !me, (el) => el.child(head("This chat", "The shown tab isn't a chat that has been used yet. The lists below cover every chat saved on this computer.")))
        .when(agentRows.length > 0, (el) => el.child(v_flex().gap(10).child(head("By agent", "Every chat saved on this computer. Tokens are added up only for chats whose agent reports them, or, for Claude Code, from its own logs.")).child(box(divided(agentRows)))))
        .when(chatRows.length > 0, (el) => el.child(v_flex().gap(10).child(head("Chats", "Turns, tokens in / out where known, and how full the context window is.")).child(box(divided(chatRows)))))
        .when(this.chats != null && !chats.length, (el) => el.child(div().px(12).text_size(12).text_color(k.muted).child("No chats yet."))))
      .child(div().px(24).py(12).flex_none().border_t(1).border_color(k.border).text_size(12).text_color(k.muted)
        .child(anyCost ? "Cost is what the agents report themselves; nothing is worked out from prices." : "No agent here reports a cost, so none is shown; nothing is worked out from prices."));
  }
}
