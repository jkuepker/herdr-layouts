# Herdr layouts

Layouts and mods for the [Herdr](https://herdr.dev) app, one folder each. A layout folder has `layouts/<name>.json` and its `mods/<name>/`; a mod folder has only `mods/<name>/` and maybe a `keys.json`. Each has a `RECIPE.md` to build it from scratch and a `preview.png`.

| Layout | |
| --- | --- |
| [LCARS](lcars/RECIPE.md) | A Star Trek LCARS frame: an orange elbow and sidebar of spaces and crew, status-coloured tab pills, blocked agents pulse red. |
| [Slate](slate/RECIPE.md) | A quiet, dense dark frame: a sidebar with the shown space pinned, cards for agents that need you with their question, spaces as colour chips with each agent's icon, agents in flight, text tabs with an underline, a task graph of the shown space on the right. |
| [Board](board/RECIPE.md) | The xo crew as a board: a pinned Board tab, today's numbers, the next move, and NEEDS YOU / WORKING / READY TO LAND / DONE columns with Merge, Ship and Archive. Focus (F) shows the picked agent's live terminal beside it. |

| Mod | |
| --- | --- |
| [ACP Chat](acp-chat/RECIPE.md) | A chat pane for agents that speak the Agent Client Protocol (omp, OpenCode, Claude Code and Codex adapters, Gemini CLI): markdown replies, tool cards, approval buttons, model and mode pickers, sessions that resume. Needs Node.js. |

[Shepherdr](https://github.com/eliasstravik/shepherdr) gets the same look: [`shepherdr/`](shepherdr/README.md) is an LCARS theme plugin for its web app, and the LCARS layout shows Shepherdr's counts in its sidebar.

To add one, ask your agent in Herdr to read `~/.config/herdr-app/AGENTS.md` ("Layouts other people made"), then point it at the folder.

## Licence

MIT (see `LICENSE`), except the Antonio font files in `lcars/mods/lcars/fonts/` and their embedded copy in `shepherdr/plugins/lcars/fonts.ts`, which are under the SIL Open Font License 1.1 (`OFL.txt` beside them). The gear icon, and Slate's icons in `slate/mods/slate/` (except `spinner.svg` and `panel-right.svg`, drawn for it), are Lucide's (ISC licence, lucide.dev).
