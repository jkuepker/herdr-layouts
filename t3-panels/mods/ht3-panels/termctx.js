// A terminal's output as a block for the chat's message box (T3's formatTerminalContextReference: the agent gets a
// failing command's output without a paste). Pure: chat.js reads the text (`hc read`) and puts the block in the box.

// A shell waiting is not output: a bare prompt sign, user@host…, or a prompt drawn with icon-font glyphs.
// (dash-widgets.js's terminal widget uses it to find a command's last line.)
export const PROMPT = /^\S{0,40}\s?[%$#❯>]\s*$|^[^\s]*@[^\s]*.*[%$#❯]\s*$|[-\u{F0000}-\u{FFFFD}]/u;
export const TERM_LINES = 40;

// `text` as "Terminal `name` (last N lines):" and a fenced block: no blank or prompt-only lines at its end (or at its
// start), at most `lines` lines (the last ones). The fence is longer than any run of backticks in the output. null for
// no output.
export function terminalBlock(text, { name = "terminal", lines = TERM_LINES } = {}) {
  const rows = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (rows.length && (!rows.at(-1) || PROMPT.test(rows.at(-1)))) rows.pop();
  while (rows.length && !rows[0]) rows.shift();
  if (!rows.length) return null;
  const max = Math.max(1, Math.floor(Number(lines)) || TERM_LINES), kept = rows.slice(-max);
  const ticks = Math.max(3, ...[...kept.join("\n").matchAll(/`+/g)].map((m) => m[0].length + 1)), fence = "`".repeat(ticks);
  const label = String(name || "terminal").replace(/`/g, "'");
  return `Terminal \`${label}\` (last ${kept.length} ${kept.length === 1 ? "line" : "lines"}):\n${fence}text\n${kept.join("\n")}\n${fence}`;
}

// Which terminal: the chat's own (a terminal pane of its tab), else one in another tab of its space. In either, the one
// last focused (`recent`: its address), else the one that has the keyboard, else the first. `ps`: panes(); `tabs`: the
// ids of the space's tabs. null for none.
export function pickTerminal(ps, { tab, tabs = [], recent = null } = {}) {
  const terms = (ps ?? []).filter((p) => p.terminal);
  const best = (pool) => pool.find((p) => recent && p.terminal === recent) ?? pool.find((p) => p.focused) ?? pool[0] ?? null;
  return best(terms.filter((p) => p.tab === tab)) ?? best(terms.filter((p) => p.tab !== tab && tabs.includes(p.tab)));
}
