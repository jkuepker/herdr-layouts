# T3 Panels

T3 Code's chat and its file panel inside the Herdr T3 layout, with T3 Code's colors. A chat pane opens beside a terminal: it shows the conversation of the Claude Code or Codex already running there, or starts an agent of its own over the Agent Client Protocol (Oh My Pi, Pi, OpenCode, …). A Files panel slides in on the right: the folder as a tree, files in tabs, edited and saved in place. Two themes, `t3code-dark` and `t3code-light`, give the whole layout T3 Code's palette.

![T3 Panels](preview.png)

## What you see

Everything uses T3 Code's sizes (1rem = 16px): 14px text on a 23px line, 8px control corners, 16px card corners.

1. **Two buttons** in the tab bar, right of the layout's own (28px square, 8 round, muted icons): a speech bubble (New chat) and a side panel (Files, filled while the panel shows).
2. **New chat** dialog (512×520): a 20px semibold title, then rows 32px high with 8px corners. "Running in this tab" lists the Claude Code and Codex terminals of the shown tab (a dot: blue working, amber waiting). "Start an agent" shows the folder the agent will run in with **Change…**, one row per known ACP agent (dimmed with an install hint when it isn't installed), and a field for any other command. **Cancel** and a blue **Open chat** sit in a footer under a line.
3. **Chat pane**, a 736px lane centered in the pane:
   - a 40px header: the folder's name in muted text, `/`, the agent's name, a small badge while it is Starting, Working, Waiting for you or Stopped, the share of the context window used, a button to go to the agent's terminal (when it has one) and New chat;
   - your messages right-aligned in a bubble (at most 80% wide, 16 round, 12 in, the theme's `raised`);
   - the agent's replies as plain markdown, no bubble;
   - its work as flat rows 24px high: a 16px icon by kind (eye read, pen edit, terminal run, magnifier search, globe fetch, brain thinking, wrench other), a muted one-line label and a chevron; a failed one is red with an ×. A click opens what it printed in 12px mono;
   - a plan as a card (16 round, 16 in) with a checkbox per step;
   - notes (resumed, stopped) as 11px words between two hairlines; errors as a red row;
   - while it works, "Working for 12s" in muted text over a hairline, counting;
   - scrolled up, a "Scroll to end" pill over the bottom.
4. **Composer**: a card (16 round, 1px outline at 8% of the text color, the theme's `surface`) with "Ask anything", two lines high, growing to eight. Under the text, right-aligned: one control per option the agent offers (28px high, a 16px icon, the current choice: model, effort, mode) and a 32px round button: blue with an up arrow to send, grey when there is nothing to send, red with a square to stop. A control's choices open as a menu above the composer (320 wide, 28px rows, a search field when there are more than eight, a check on the current one).
5. **Approval drawer**, tucked on top of the composer while the agent waits: "Waiting for approval" with an amber shield, the tool's title, and one 24px button per answer (the allowing ones blue).
6. **Files panel** (540px, 360 to 900, on the right of the terminals):
   - a 40px strip of tabs 24px high and 6 round: **Files**, then one per open file with an × and a dot on its icon while it has unsaved edits; the shown one is filled;
   - with a file open: a 28px line with the last folders and the name, "Unsaved", **Save**, word wrap and the explorer switch; the file in an editor (13px mono, line numbers, folding, syntax colors from the theme's ANSI colors); the explorer 256px wide on the right;
   - the explorer: refresh, a "Search files" field, collapse all; rows 24px high, 12px text, 6 round, 12px of indent per level, git marks as a letter (green A, amber M, red D or U). With no file open it fills the panel.

## How it behaves

- **New chat**: the speech-bubble button or `cmd-shift-o` opens the dialog; **Open chat** opens the chat as a tab of its own in the focused space (named after the agent), filling the work area; split a terminal in beside it like any tab.
- **A terminal agent's chat** (Claude Code, Codex) follows the agent's own session log: it updates when the log grows. Enter types your message into the agent's terminal (also while it works; Claude Code is told to take it at once). The red button presses Esc there. When the agent waits on its own dialog, the drawer says so and offers **Go to terminal** and **Dismiss (Esc)**; the dialog itself is answered in the terminal. Closing the chat pane leaves the agent running.
- **An ACP agent's chat**: the pane starts the agent in the folder and talks to it directly. Enter sends, Shift+Enter adds a line; one message per turn. The red button cancels the turn. Approval requests show in the drawer with the agent's own answers. Picking a model, effort or mode tells the agent. Closing the pane stops the agent; opening the layout again resumes the agent's session when it can load one ("Resumed the agent's session."), else starts a new one under the old messages. A stopped agent shows why, with **Restart agent**.
- Agent status in the header badge: working (blue "Working", and the counting line), blocked (amber "Waiting for you" and the drawer), stopped (red "Stopped" and the reason); idle and done show no badge.
- The timeline follows new output until you scroll up.
- **Files**: the side-panel button or `cmd-shift-e` shows and hides the panel. It shows the repository (else the folder) of the focused terminal, and keeps to it until a terminal somewhere else gets focus. Below the search row, the folder's path with **Up one folder** on its left; **Open folder…** (folder icon, this machine only) picks any folder, such as `/opt/code`. A folder chosen either way stays for that space (kept in shared state `ht3-files.pinned`) until **Back to the terminal's folder** (terminal icon, shown only then). A click on a folder opens it, on a file opens it in a tab (twelve at most). Typing in "Search files" lists matching paths from the whole folder.
- **Editing**: typing marks the tab with a dot and "Unsaved"; **Save** or `cmd-s` writes the file. If the file changed on disk meanwhile, a red line offers **Reload** and **Overwrite**. Closing an unsaved tab asks: **Keep editing**, **Close without saving**, **Save and close**. An open file without edits follows changes on disk.
- A space on another machine: its files open read-only, and the panel says so. Files over 1 MB open as a read-only preview of their first 400 KB.

## Built from

- **One mod, `ht3-panels`**, with four faces picked in `main.js` by how a copy is opened (`mod.json`: `{"place": "none", "overlay": {"width": 512, "height": 520}}`):
  - `props.panel: "chat"` → `chat.js`. Props: `terminal` (a terminal address: show that agent), or `chat` (an id naming the chat) with `agent` (an id from the list or an argv array), `cwd`, `machine`, `prompt` (a new chat's first message) and `set` (options to set before it, e.g. `{"model": "provider/model"}`).
  - `props.panel: "editor"` → `editor.js`, the file panel. Commands: `ht3-panels.save`, and `ht3-panels.open:<path>` (a path in the shown folder).
  - `props.panel: "buttons"` → the two tab-bar buttons (`openOverlay` for the dialog, `layout.toggle {"id": "ht3-side"}`).
  - opened as an overlay (`mod.open {"name": "ht3-panels"}`) → `launcher.js`, the dialog; it runs `tab.new {"space", "name", "mod": "ht3-panels", "props"}`. The layout gives panes a 1px `border` frame (`input` when focused) and `work-body` a 1px divider, so the resize lines show; t3code-dark uses `#262626` / `#3a3a3a` for them.
- **`look.js`**: T3's tokens read from `theme()` (`surface` card, `raised` user bubble, `selected` hover fill, `accent` primary, `muted`, `border`, `input`) plus T3's own red, amber, green and blue; `button`, `iconButton`, `control`, `badge`, `workLine`, `divider`. Every control has `role("button")` and a label.
- **The chat's two sources** give `chat.js` the same rows (`view()`, `send`, `stop`, `answer`, `setOption`, `expand`):
  - `agent-term.js` with `core/` (Shepherdr's `chat-reader.js`, `chat-log.js`, `bg-jobs.js`, `asks.js`, `send.js`, unchanged): finds the log of the process the terminal runs (`hc get`, then a shell script per look: `~/.claude/sessions/<pid>.json` for Claude Code, the open `rollout-*.jsonl` for Codex), reads its newest page and what it gains (`exec("sh", …)`, `watchFolder` on the log's folder, else every 1.5 to 4 s), sends with `hc send` and `hc keys`.
  - `agent-acp.js` with the acp-chat mod's `session.js`, `acp.js`, `transcript.js`, unchanged: `spawn` starts `"$SHELL" -lic 'exec <agent>'` in the folder, `processWrite` / `processNextLine` carry JSON-RPC, `processKill` stops it. The chat is saved to `data/ht3-panels/chats/<chat>/state.json` (at most every second) only to resume. On another machine the program is `ssh <target>` (from `hc machine ls`), as in acp-chat.
- **`editor.js`**: the listing script, git marks (`git status --porcelain`) and folder watch of Herdr's shipped `files` mod; `git rev-parse --show-toplevel` for the folder; `git ls-files -co --exclude-standard` (else `find`) for search; `readTextFile`, `writeTextFile(path, text, expected)`; `EditorState` / `Editor`.
- `gpui-kit`: `list` (rows of any height) with `on_item_click`; `gpui-base`: `TextView.markdown`, `TextareaState` / `Textarea`, `InputState` / `Input`, `Scrollbar`, `VirtualListScrollHandle`, `EditorState` / `Editor`.
- **Themes** `themes/t3code-dark.json` and `t3code-light.json`: T3 Code's `index.css` tokens (dark: black `canvas` and `chrome`, `#111111` `surface`, `#1e1e1e` `raised`, `#346bf1` `accent`; light: `#fcfcfc`, `#ffffff`, `#ebebed`, `#1b4ed8`), with VS Code's terminal colors, since T3 Code defines none.
- **Layout** (see `layouts/README.md`): a 68px `ht3-panel-buttons` block in `tabs-row`, a hidden 540px `ht3-side` column in `work-body` holding the file panel, and the root's `theme`.
- **Keys** (`keys.json`): `layout:herdr-t3` gets `cmd-shift-o` (New chat, T3 Code's own key) and `cmd-shift-e` (Files); `mod:ht3-panels` gets `cmd-s`.
- Icons: Lucide, in `mods/ht3-panels/icons/`.
- It runs programs: `sh`, `git`, `hc`, `ssh` (another machine), `wc`, `head`, `find`, and the agent you pick. It reads files outside its folder: the agents' session logs under `~/.claude` and `~/.codex`, and the files of the folder it shows. It writes the files you save, and its own chats under `data/ht3-panels/`. It reaches the network only through the agent and ssh.

## Watch out

- The chat is a pane and the file panel a side column, as in T3 Code, where the thread is the main surface and Files is a surface of the right panel. The file panel is not a pane: a second copy with the same props would share its state.
- A mod's `line_height(23)` is not pixels: write `line_height("23px")`.
- `list` rows can't hold their own click handlers: clicks go through `on_item_click` by row id. That is why a work row opens as a whole and the approval buttons live in the drawer, not in the timeline as in T3 Code.
- A textarea's Enter inserts a newline and then fires `submit` (with `shift` for Shift+Enter); the send trims it.
- It needs a Herdr with `spawn` for ACP chats (there is no bridge fallback as in acp-chat). `spawn` gives the agent Herdr's own environment, which often lacks the API keys a shell profile exports, so the agent is started through the login, interactive shell; what the profile prints on the way is skipped as not JSON.
- A terminal agent's chat can't answer the agent's own dialogs, change its model or mode (the model shows as a plain label), or show approval cards: Shepherdr does those with hooks it installs, which this mod doesn't. Only Claude Code and Codex have logs it can read; any other terminal says so.
- A terminal reports `claude-code` or `codex` only once the agent has started; until then the dialog doesn't list it.
- The editor saves only when asked (T3 Code saves by itself half a second after a change). `writeTextFile` works on this computer only. `readTextFile` reads at most 1 MiB, so bigger files are previews.
- The file panel resets when the mod's files are saved (hot reload): open tabs and unsaved edits are gone.
- The file tree lists at most 500 entries per folder and 5,000 in all; search looks through at most 20,000 paths and shows 200. The listing script needs `sh` (not Windows).
- Left out from T3 Code: threads and their sidebar, the diff, pull request, browser and terminal surfaces of the right panel, attachments, `@` files, `$` skills and `/` commands in the composer, queued and steered messages as their own states, the plan-mode toggle, reverting and forking from a message, copy buttons, the code block header with its language and copy button (code blocks are `TextView.markdown`'s own), the glass blur, and file-icon themes.
- `cmd-alt-b`, T3 Code's key for the right panel, is taken (`layout.toggle:side`); Files is on `cmd-shift-e`.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/ht3-panels` passes, and `herdr-app status` shows no errors.
- `herdr-app do mod.open --name ht3-panels` shows the dialog with the installed agents and, in a tab with Claude Code running, that terminal.
- `herdr-app do pane.split --direction right --mod ht3-panels --props '{"panel":"chat","chat":"t1","agent":"opencode","cwd":"<folder>","prompt":"Read a file here and say what it does."}'` opens a chat whose agent answers in markdown with a read row above it; reloading the mod shows "Resumed the agent's session.".
- `--props '{"panel":"chat","terminal":"<address of a Claude Code terminal>"}'` shows that conversation, and a message sent to the terminal appears in the chat with its reply.
- `herdr-app do layout.toggle --id ht3-side` shows the file panel; `herdr-app do "ht3-panels.open:<path>"` opens a file with syntax colors; changing the file on disk changes the editor.
- Typing in the editor shows the dot and "Unsaved"; `cmd-s` writes the file and clears them.
- Closing a chat pane leaves no agent process it started.
