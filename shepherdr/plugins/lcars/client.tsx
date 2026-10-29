// LCARS: a Star Trek computer theme for Shepherdr, matching the LCARS layout for the Herdr app.
// Shepherdr has no theme slot, so this sets the colour variables of src/styles.css (both :root and
// :root[data-theme=dark], so light and dark look the same: black) and adds a little CSS for the LCARS shapes.
// Fonts are embedded (fonts.ts), so it works offline. See ../../README.md.
import { definePlugin } from '@client/kernel.ts'
import { antonioBold, antonioRegular } from './fonts.ts'

// The LCARS palette (the same as the Herdr layout's)
const C = {
  orange: '#ff9900',
  peach: '#ff9966',
  gold: '#ffcc66',
  tan: '#ffcc99',
  lilac: '#cc99cc',
  violet: '#9999ff',
  blue: '#99ccff',
  sky: '#5599ff',
  red: '#ff5544',
  gray: '#666688',
  black: '#000000',
}

const colours = `
:root, :root[data-theme=light], :root[data-theme=dark] {
  color-scheme: dark;
  --canvas: ${C.black};
  --bg: ${C.black};
  /* body text is tan (14:1 on black); the second and third reads lilac and a lighter grey-violet, both above 4.5:1 */
  --fg: ${C.tan};
  --fg2: ${C.lilac};
  --fg3: #9a9ac0;
  --line: rgb(255 153 0 / 0.22);
  --line2: rgb(255 153 0 / 0.42);
  --hover: rgb(255 153 0 / 0.13);
  --sel: rgb(255 153 0 / 0.26);
  --well: #0b0b12;
  --bubble: #15151f;
  /* your bubbles: a violet tint, apart from the agent's */
  --reply: #1d1a33;
  /* the picked segment of a toggle is an orange slab, its text black (see below) */
  --seg-on: ${C.orange};
  --thumb: rgb(255 153 0 / 0.42);
  --thumb-held: rgb(255 153 0 / 0.75);
  /* status: working blue, needs you red, ready gold */
  --need: ${C.red};
  --ready: ${C.gold};
  --work: ${C.blue};
  --muted: ${C.gray};
  --ready-fg: ${C.gold};
  --work-fg: ${C.blue};
  --need-fg: ${C.red};
  --accent: ${C.orange};
  --focus: ${C.blue};
  --term: ${C.black};
  --term-fg: ${C.tan};
  --ansi-0: ${C.black};
  --ansi-1: ${C.red};
  --ansi-2: ${C.gold};
  --ansi-3: ${C.orange};
  --ansi-4: ${C.sky};
  --ansi-5: ${C.lilac};
  --ansi-6: ${C.blue};
  --ansi-7: ${C.tan};
  --ansi-0b: ${C.gray};
  --ansi-1b: #ff8877;
  --ansi-2b: #ffe099;
  --ansi-3b: ${C.peach};
  --ansi-4b: ${C.blue};
  --ansi-5b: #e0b8e0;
  --ansi-6b: #c4e0ff;
  --ansi-7b: #fff2e0;
  --merged: ${C.violet};
  --add: rgb(255 204 102 / 0.16);
  --del: rgb(255 85 68 / 0.18);
  --syn-kw: ${C.lilac};
  --syn-str: ${C.gold};
  --syn-num: ${C.peach};
  --syn-com: #9a9ac0;
  --syn-fn: ${C.blue};
  --syn-type: ${C.violet};
  --syn-tag: ${C.peach};
  --syn-attr: ${C.orange};
  --syn-meta: #9a9ac0;
  /* no soft shadows on black: an orange keyline instead */
  --menu-shadow: 0 0 0 2px ${C.orange};
  --sheet-shadow: none;
  --drawer-shadow: none;
  --push-shadow: none;
  --dialog-shadow: 0 0 0 2px ${C.orange};
  --toast-shadow: 0 0 0 2px ${C.orange};
  --seg-shadow: 0 0 0 1px var(--line2);
  --soft-shadow: inset 0 0 0 1px var(--line2);
  --box-shadow: inset 0 0 0 2px rgb(255 153 0 / 0.42);
  --box-focus-shadow: inset 0 0 0 2px ${C.orange};
  /* LCARS corners: rounder boxes */
  --box-radius: 20px;
  --bubble-radius: 22px;
}
`

const fonts = `
@font-face { font-family: 'Antonio'; font-weight: 400; font-style: normal; font-display: swap; src: url(${antonioRegular}) format('truetype'); }
@font-face { font-family: 'Antonio'; font-weight: 700; font-style: normal; font-display: swap; src: url(${antonioBold}) format('truetype'); }
`

// What gets Antonio, bold capitals: the app's chrome. Chat and message text, code, paths, fields and the terminal keep
// their readable faces (Inter, monospace): Antonio is condensed and all-caps text is slow to read in a paragraph.
const chrome = `
nav[aria-label=Places], [data-chrome], [data-conversation-head], button, [role=tab], [role=menuitem], [role=menuitemradio],
[role=option], [role=dialog] h1, [role=dialog] h2, [role=dialog] h3, h1, h2, h3, h4, summary, th, label {
  font-family: Antonio, 'Arial Narrow', 'Helvetica Neue', sans-serif;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
/* ...except what is text to read or a name to copy */
input, textarea, select, option, .prose-reply :is(h1, h2, h3, h4, th) {
  font-family: InterVariable, ui-sans-serif, system-ui, sans-serif;
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
}
.prose-reply :is(h1, h2, h3, h4, th) { font-weight: 600; }
code, pre, samp, .font-mono, [class*="font-mono"], .code-view, .code-view *, .xterm, .xterm * {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
}
`

// LCARS shapes, cheap and CSS only. Hooks are the app's own stable ones: nav[aria-label=Places] (the sidebar, and the phone's drawer), [data-chrome],
// [data-conversation-head], [data-msg], [data-composer], [role=group], aria-pressed/aria-current, and the .dot marks.
const shapes = `
/* the page and its columns: black, with no hairlines between them but LCARS's own */
nav[aria-label=Places] { background: ${C.black}; }

/* the sidebar: an orange elbow at its top left running down as a bar, as in the Herdr layout */
nav[aria-label=Places] {
  border-right: 0;
  border-left: 16px solid ${C.orange};
  border-top: 12px solid ${C.orange};
  border-top-left-radius: 44px;
}
nav[aria-label=Places] > :first-child { padding-top: 8px; }
nav[aria-label=Places] li, nav[aria-label=Places] > :first-child { font-size: 1.0625rem; }

/* spaces: orange end-cap slabs; the open one is a solid orange slab with black words */
nav[aria-label=Places] li { border-radius: 4px 999px 999px 4px; }
nav[aria-label=Places] li:has(> button[aria-current]) { background: ${C.orange} !important; }
nav[aria-label=Places] li:has(> button[aria-current]) :is(button, span, h2, svg):not(.attention-badge, .attention-badge *, .dot, .dot *, .mode-pill, .mode-pill *) {
  color: ${C.black} !important;
}
nav[aria-label=Places] li[data-heading] { border-radius: 4px 999px 999px 4px; }
nav[aria-label=Places] li[data-heading] h2 span { color: ${C.peach}; }

/* a thin segmented bar under each header, in place of its hairline */
[data-chrome][class*="border-b"] { border-bottom-width: 0; }
[data-chrome][class*="border-b"]::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 4px;
  pointer-events: none;
  background: linear-gradient(90deg,
    ${C.orange} 0 calc(30% - 2px), ${C.black} calc(30% - 2px) calc(30% + 2px),
    ${C.lilac} calc(30% + 2px) calc(40% - 2px), ${C.black} calc(40% - 2px) calc(40% + 2px),
    ${C.tan} calc(40% + 2px) calc(100% - 50px), ${C.black} calc(100% - 50px) calc(100% - 46px),
    ${C.blue} calc(100% - 46px) 100%);
  border-radius: 999px;
}

/* toggles and tabs: pills; the picked one an orange slab with black words */
[role=group][class~="rounded-full"] { background: rgb(255 153 0 / 0.1); }
button[class~="aria-pressed:bg-seg-on"][aria-pressed=true] {
  color: ${C.black};
  box-shadow: none;
}
button[class~="aria-pressed:bg-seg-on"][aria-pressed=false] { color: ${C.tan}; }

/* the message box: a pill outlined in orange */
[data-composer] { background: ${C.black}; }

/* messages: Inter text kept; the agent's bubble carries an orange bar on its left, yours a violet one on its right */
[data-msg]:not([data-you]) > [data-anchor][class~="rounded-bubble"] { box-shadow: inset 5px 0 0 ${C.orange}; padding-left: 20px; }
[data-msg][data-you] > [data-anchor][class~="rounded-bubble"] { box-shadow: inset -5px 0 0 ${C.violet}; padding-right: 20px; }

/* status marks: black ticks on the gold, black on the badges */
.dot.ready::after, .dot.done::after { border-color: ${C.black}; }
.attention-badge { color: ${C.black} !important; box-shadow: 0 0 0 2px ${C.black}; }
[class~="text-white"][class~="bg-need"], [class~="bg-need-fg!"] { color: ${C.black} !important; }
`

const css = colours + fonts + chrome + shapes

// The phone's status bar and the browser's bar take their colour from <meta name=theme-color>, which theme.ts sets to
// white or near-black on every appearance change. Keep it black.
function keepBarBlack() {
  if (typeof document === 'undefined') return
  const paint = () => {
    const bar = document.querySelector<HTMLMetaElement>('meta[name=theme-color]')
    if (bar && bar.content !== C.black) bar.content = C.black
  }
  paint()
  new MutationObserver(paint).observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] })
}

export default definePlugin({
  name: 'lcars',
  setup(reg) {
    keepBarBlack()
    reg.overlays.push(() => <style>{css}</style>)
  },
})
