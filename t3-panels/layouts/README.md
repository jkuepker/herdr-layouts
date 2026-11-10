# Layout fragment

`ht3-panels` is a mod for a layout you already have (the Herdr T3 layout, `layouts/herdr-t3.json`), so this folder holds no layout file. Five of that layout's mods are kept beside it in `mods/` as this build changed them (`ht3-agents`, `ht3-inbox`, `ht3-tabs`, `ht3-pane`, `ht3-chrome`: they show a chat tab's agent as an agent and never close a chat, see RECIPE.md); the layout already names them (`"mod": "ht3-agents"` in `agents`, `"ht3-inbox"` in `inbox`, `"ht3-tabs"` in `tabs` and `tabs-end`, `"ht3-pane"` as `main`'s pane header, `"ht3-chrome"` in `sidebar-footer`), so copying them over the installed ones needs no change to the layout file. Make these changes to that layout (the file is generated from a backup by a small script in the build notes; every id below is used by the mod and must stay):

1. In `tabs-row`, before `tabs-end`, the buttons (New chat, maximize the panel, bottom panel, right panel):

```json
{ "id": "ht3-panel-buttons", "type": "block", "size": { "px": 132 }, "window_drag": true,
  "content": { "mod": "ht3-panels", "props": { "panel": "buttons" } } }
```

2. In `work-body` (a row with `"padding": [0, 8]`, `"gap": 8` and `"divider": { "width": 1, "color": "border" }`), the work area's `main` block moves into a column, `ht3-center`, with the bottom panel under it, and the right side panel follows it. No `border` and no `radius` on the side panel: only the 1px divider of `work-body` separates it.

```json
{ "id": "ht3-center", "type": "column", "gap": 8, "divider": { "width": 1, "color": "border" },
  "children": [
    { "id": "main", "type": "block", "background": "border",
      "content": { "tab": "active", "pane": { "header": { "content": { "mod": "ht3-pane" }, "reveal": "always", "height": 28, "position": "top" },
                                              "background": "background", "gap": 1, "radius": 0, "lone": true } } },
    { "id": "ht3-bottom", "type": "stack", "size": { "px": 240 }, "min": 120, "max": 800, "hidden": true, "active": "ht3-bottom-empty",
      "children": [ { "id": "ht3-bottom-empty", "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "empty", "bottom": true } } } ] } ] },
{ "id": "ht3-side", "type": "column", "size": { "px": 540 }, "min": 360, "max": 3000, "hidden": true,
  "background": "background", "divider": { "width": 1, "color": "border" },
  "children": [ GROUP("a"), GROUP("b") ] }
```

where `GROUP(g)` is a column that never resizes itself, with a 40px strip and a stack of faces (group `b` has `"hidden": true`):

```json
{ "id": "ht3-<g>", "type": "column", "resizable": false,
  "children": [
    { "id": "ht3-<g>-strip", "type": "block", "size": { "px": 40 }, "content": { "mod": "ht3-panels", "props": { "panel": "strip", "group": "<g>" } } },
    { "id": "ht3-<g>-body", "type": "stack", "active": "ht3-files",
      "children": [
        { "id": "<files>", "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "editor", "group": "<g>" } } },
        { "id": "ht3-<g>-diff",    "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "diff",    "group": "<g>" } } },
        { "id": "ht3-<g>-pr",      "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "pr",      "group": "<g>" } } },
        { "id": "ht3-<g>-prs",     "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "prs",     "group": "<g>" } } },
        { "id": "ht3-<g>-browser", "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "browser", "group": "<g>" } } },
        { "id": "ht3-<g>-chat",    "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "side",    "group": "<g>" } } },
        { "id": "ht3-<g>-empty",   "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "empty",   "group": "<g>" } } } ] } ] }
```

`<files>` is `ht3-files` for group `a` (with props `{"panel": "editor"}` only) and `ht3-b-files` for `b`. Terminal blocks (`ht3-term-<address>` in a group's stack, `ht3-bterm-<address>` in `ht3-bottom`) are not in the fragment: the mod keeps them in step with its tabs, in the layout file. Every terminal tab has one, in its group's stack; a block with one of these ids that no tab holds is removed, so don't add your own under these names. The mod reads the file right before it writes and writes only if it is unchanged since, so other edits to the file are kept.

3. On the root, the themes:

```json
"theme": { "light": "t3code-light", "dark": "t3code-dark" }
```

The ids `ht3-side`, `ht3-center`, `ht3-bottom`, `ht3-a`, `ht3-b` and the stacks `ht3-a-body` / `ht3-b-body` must stay: the buttons, the `cmd-shift-e` key and the mod's state code use them by name.

## Panes have no frame, only a split line

A pane has no `border` and no `focus` frame, and no `radius`: T3 Code's chat has none. Herdr's pane look has no divider of its own (`divider` is for `row` and `column` nodes only, and a `divider` key in `pane` is ignored), so the line between two panes is the 1px `gap` between them with the `main` block's `background` (`"border"`, the theme's border color) showing through. The pane fill (`"background"`) covers the rest of the block. The line still drags: Herdr takes a drag on a band of `max(6px, the line's width)` centered on it, whatever the gap (Herdr 0.1.14), so the gap stays at 1.

## What the chat features need from the layout: nothing

Copy rows, the `/` `$` `@` menu, attachments, thread names, earlier chats, fork, checkpoints, queued messages and the Project popover's Commit, Push and Create PR (RECIPE.md) are all drawn inside the mod's own panes and popups. The layout file needs no new block, id or key for them, and the fragment above is unchanged. What they do use outside the layout:

- Popups the mod opens itself (`openOverlay`, kind `popup`): the message menu (Copy, Fork from here), the Inbox card menu (Rename thread, Settle), the Revert question, and the Project popover, now up to 660 high. The New chat dialog's size is the mod's `mod.json` (`512 × 660`).
- Files under `~/.config/herdr-app/data/ht3-panels/chats/<chat id>/`: `state.json` (a fork is a new folder with one), and `attachments/` (pasted pictures and thumbnails).
- Shared state: `ht3-panels.named` (thread names by chat id), `ht3-panels.turn` (the turn the Diff surface shows), `ht3-panels.reverted` (the last revert's outcome), `ht3-panels.scripts` (project scripts by project folder), `ht3-panels.asks` / `ht3-panels.answers` (an approval and its answer from the Inbox).
- In a chat's git repository: refs under `refs/herdr/checkpoints/<chat id>/` (see RECIPE.md, Checkpoints). Nothing else in the repository is written until you press Commit, Push or Revert.
- Settings in `~/.config/herdr-app/data/ht3-settings.json`: `followUp` (`"steer"`), `checkpoints` (`false`), `notifications` (`false`) and `sounds` (`true`).
- Herdr's toasts (`notify`) and its `done` / `blocked` sounds, for a chat that finishes or needs you while you look elsewhere. The layout needs no toast block for them.
- Keys for the message box in the same section: `cmd-alt-enter` (`ht3-panels.send:new`) and `cmd-alt-shift-enter` (`ht3-panels.send:background`).
- Keys for chats in the layout's section of `keys.json`: `ctrl-shift-]`, `ctrl-shift-[` and `ctrl-shift-1`..`9` (`ht3-tabs.chat:next`, `chat:prev`, `chat:<n>`).
- A key in the layout's section of `keys.json`, `cmd-shift-p`: `mod.open:ht3-palette`, the command palette with the T3 actions (the mod `ht3-palette`; an overlay, so the layout file doesn't name it).
- In a chat's git repository, when New worktree is used: a folder `<repo>/.worktrees/<branch>`, a branch, and, only if `.worktrees/` isn't ignored yet, a line in `.git/info/exclude`.
