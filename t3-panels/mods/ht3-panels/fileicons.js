// File-type icons as T3 Code's file tree draws them: @pierre/trees' built-in "complete" icon set
// and T3 Code's few additions (TOML, PDF, XML, …), colored per token as T3 Code's
// PierreEntryIcon.tsx colors them. The tables and SVGs are generated from those packages: see NOTICE.

import { svg } from "gpui-kit";
import data from "./fileicons.data.js";
import { MOD } from "./look.js";

const { colors, byName, byExt } = data;
const cache = new Map();

// The icon id for a file name: its name first, then its extensions, longest first (a.test.ts: test.ts, ts).
export function fileIconId(name) {
  const hit = cache.get(name);
  if (hit) return hit;
  const lower = name.toLowerCase();
  let id = byName[lower];
  if (!id) {
    const parts = lower.split(".");
    for (let i = 1; i < parts.length && !id; i++) id = byExt[parts.slice(i).join(".")];
  }
  id = id && colors[id] ? id : "default";
  cache.set(name, id);
  return id;
}

// The icon as an element: 14px by default, in T3 Code's color for the theme.
export function fileIcon(name, dark, size = 14) {
  const id = fileIconId(name);
  const pair = colors[id] ?? colors.default;
  return svg(`mods/${MOD}/icons/files/${id}.svg`).size(size).flex_none().text_color(pair[dark ? 1 : 0]);
}
