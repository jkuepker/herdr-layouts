# Next T3 Code features to port into Herdr T3

Ranked from a survey of /opt/code/t3code/apps/web/src and apps/server/src against what t3-panels and the ht3-* sidebar mods have today. All T3 paths below are relative to /opt/code/t3code/apps/web/src unless marked server/ (= apps/server/src). Line numbers were opened and checked.

## Top 8

1. Composer `/` commands and `$` skills: ACP agents already send their command list (kept in `transcript.js:40` as `t.commands`) but nothing shows it; a menu on `/` is the cheapest big win.
2. Composer `@` file mentions: the Files tree and `git ls-files` search already exist in `editor.js`; reuse them as a picker in the composer.
3. Image and file attachments: `on_drop` gives paths, ACP prompts take image blocks, and `session.js:176` sends text only.
4. Thread search, rename and archive in the Inbox: the Inbox already has a search field (`ht3-inbox/filter.js:14`) and settle/snooze (`actions.js:45`); add rename and archive to match T3's thread menu.
5. Fork a thread: start a new ACP session from the same transcript or from a message, so you can branch work on any machine.
6. Per-turn diffs and revert (checkpoints): `diff.js` already renders diffs; snapshot the tree per turn with git and offer "revert to here".
7. Queued messages with a follow-up mode (queue or steer): `session.js:167` refuses a send while working; queueing is small and removes a daily annoyance.
8. Create PR and commit flows: `pr.js` is read-only; adding commit, push and `gh pr create` from the project popover closes the loop for remote work.

## Done

- Copy and paste in chats (rows that copy, a right-click Copy menu). Not checked with real keys: Cmd+C/X/V/A/Z in the message box and Cmd+C on a selection are the text area's and TextView's own.
- 1. `/` commands and `$` skills (`chat.js` `trigger`, `menuItems`, `triggerPanel`). Left: the menu pushes the lane up instead of floating over it; the word must be the last in the text (no caret position from the text area); arrows, Tab and Esc in the menu were only driven by command.
- 2. `@` files: picker, chips, `resource_link` blocks. Left: folders can't be picked, only files; the chip sits where the text ended (no caret position); not tried on another machine.
- 3. Attachments: drop, `+`, paste a picture; image blocks and resource links. Left: a real drop, the file dialog and Cmd+V were not done by hand (driven by `attach:` and `paste-image`); a chat on another machine gets resource links to paths of this computer for non-pictures; thumbnails are not cleaned up.
- 4. Thread names (`/rename`, Inbox right-click menu) and Earlier chats with search, reopen and delete in the New chat dialog. Left: the right-click itself and typing in the rename field were driven by command, not by hand; search reads at most the 60 newest chats; chats on another machine reopen only if that machine is reachable.
- 5. Fork a thread: `/fork`, "Fork from here" on a message. A replay, not a native fork: the new session is told the earlier messages as text. Left: a fork has the same name as its source until renamed; no `session/fork` for agents that have one; a terminal agent's chat can't be forked.
- 6. Checkpoints: a snapshot before and after each turn, a changed-files row with View diff and Revert. Left: no button to undo a revert (the `undo-<time>` ref is there, by hand); checkpoint refs are never pruned; nothing in the Settings dialog (only `set:checkpoints=false`); the snapshot runs `git add -A` into a private index before every message, which will be slow in a very large repository; not tried on another machine or with a terminal agent.
- 7. Queued messages, send-now and a steer setting. Left: the queue can't be reordered and is lost on a reload; steer is cancel-then-send, not a message into the running turn; a terminal agent's chat sends mid-turn as before; the buttons were driven by command.
- 8. Commit, Push and Create PR in the Project popover. Left: `gh pr create` itself was never run (only its command was shown); no commit message written by an agent; Commit takes everything (`git add -A`), there is no picking of files; no pull or sync; no toasts, the outcome shows in the popover only; not tried on another machine.
- The acp-chat mod's chat follows its end too now (same pinned column).

## Candidates

Each entry: what it does / T3 location / mod API support / value for multi-machine agent users / effort.

### Thread search
- Does: full-text search across threads, with the match shown under the title.
- T3: `components/Sidebar.tsx:159` (`useThreadSearch`), `:885` (result ids); matching row in `components/ThreadSearchMatch.tsx`; query atoms in `state/queries.ts:7`.
- API: partly. Searching titles and agent names is a filter on `agents()`, as `ht3-inbox/filter.js:14` does. Searching message bodies has no index; it could read saved chats under `data/ht3-panels/chats/*/state.json` (`readTextFile`, local only) or the Claude/Codex session logs.
- Value: medium. Find "that thread where I fixed X" across many machines; body search matters only for ACP chats we own.
- Effort: S for titles, M for bodies.

### Thread filter
- Does: narrow the list by status, project or environment.
- T3: `components/Sidebar.logic.ts` (status and grouping logic), `sidebarProjectGrouping.ts` (in `src/`).
- API: yes. The Inbox filter row exists; add status/machine chips.
- Value: medium, high with many machines.
- Effort: S.

### Thread rename
- Does: "Rename thread" in the thread menu, plus "Regenerate title".
- T3: `components/threadActionMenu.logic.ts:169`.
- API: yes for tabs and spaces (`tab.rename`, `space.rename` per AGENTS.md); ACP chats keep a name in their own state. Regenerate title would need a model call: partly.
- Value: medium.
- Effort: S.

### Thread archive
- Does: archive a thread out of the list, restore it from settings, block it while the provider is active.
- T3: `hooks/useThreadActions.ts:277` (`threadEnvironment.archive`), guard at `:71`; list in `components/settings/ArchivedThreadsPanel.tsx:34`.
- API: yes, and done as Settle. The Inbox's Settled section holds terminal agents (a `settled` label on the terminal) and, since this build, chat tabs (shared `ht3-inbox.cards`); a chat stays open when settled and new work brings it back. Missing against T3: a list of archived chats whose tab was closed (the saved `data/ht3-panels/chats/<id>/state.json` could be listed and reopened), and delete.
- Value: medium for the reopen list: a closed chat tab can only be brought back by hand today.
- Effort: S.

### Fork a thread
- Does: copy a thread (whole, or up to a message) into a new thread that continues on its own.
- T3: `components/chat/useTimelineRewind.ts:89` (`forkFromRun`), `:171` (`onForkFromRun`); policy for native forks `server/orchestration-v2/CommandPolicy.ts:290`; `state/entities.ts:380` (`forkedFrom`).
- API: partly. We can start a new ACP session and send the earlier transcript as the first prompt (a handoff), or call `session/load` then `session/fork` where an agent supports it. There is no native fork in the ACP agents we run today, so it is a replay.
- Value: high. Branch a long run to try two approaches, on any machine.
- Effort: M.

### Composer `@` files
- Does: `@` opens a path picker over the project's files; the chosen file becomes a chip sent as context.
- T3: `composer-logic.ts:251` (`detectComposerTrigger`, kind "path" at `:288`), menu in `components/chat/ComposerCommandMenu.tsx`, chip `components/chat/FileTagChip.tsx`, editor `components/ComposerPromptEditorTiptap.tsx:133`.
- API: partly. The composer is a `Textarea`; no inline chips or caret-anchored popup. Detect `@token` by text, show a list above the composer (like the model menu), insert `@path`, and send ACP `resource_link` blocks. `git ls-files` search exists (`editor.js`). Remote machines: `exec` with `on:`.
- Value: high.
- Effort: M.

### Composer `$` skills
- Does: `$` lists the provider's skills and inserts one.
- T3: `composer-logic.ts:277` (kind "skill"), `providerSkillSearch.ts:13,72`, rendering in `components/chat/ComposerCommandMenu.tsx:1`.
- API: partly. ACP has no skills list; for Claude Code read `~/.claude/skills` and project `.claude/skills` (local `readTextFile`/`exec`, remote via `exec on:`). Same menu as `@`.
- Value: medium.
- Effort: S once the `@` menu exists.

### Composer `/` commands
- Does: `/` lists commands. T3 has local ones (`model`, `plan`, `default`, `side`, `btw`, `clear`) plus the provider's.
- T3: `composer-logic.ts:21,258`; `components/chat/ComposerCommandMenu.tsx`.
- API: yes. Our ACP chats already receive `available_commands_update` (`transcript.js:40`); list them and send `/name args` as a prompt. Local ones map onto existing options (model/mode) and `chat.js` actions.
- Value: high (agents like Claude Code and OpenCode ship many).
- Effort: S to M.

### Attachments
- Does: paste or drop images and files into the composer, with thumbnails.
- T3: `components/chat/ComposerAttachmentStrip.tsx:111,407`, `components/chat/ComposerImageThumbnail.tsx:12`, `composerDraftStore.ts:244`; server `server/attachmentStore.ts`.
- API: partly. `.on_drop` gives `event.paths` (AGENTS.md ~931); read bytes with `exec("base64")`, send ACP `image` blocks if the agent reports `promptCapabilities.image`. Thumbnails via `image(path)`. Clipboard paste of images: no direct mod API (only the terminal paste command), so drop and a file picker (`pickFolder` is folders only: use `exec` with `osascript`) only. Files on a remote machine need `hc` copy.
- Value: high for screenshots.
- Effort: M.

### Plan mode
- Does: toggle plan mode, show the proposed plan as a card with Implement / copy / save, follow-up banner.
- T3: `composerDraftStore.ts:255` (`interactionMode`), `proposedPlan.ts:62`, `components/chat/ProposedPlanCard.tsx:41`, `components/chat/ComposerPlanFollowUpBanner.tsx:4`.
- API: yes. Today's mode picker already sets the agent's mode option; plan cards already render (`transcript.js` "plan"). Missing: a one-click toggle and an "Implement this plan" follow-up that flips the mode and sends.
- Value: medium.
- Effort: S.

### Approvals and permission modes
- Does: approve, decline, always allow this session; runtime mode (supervised / full access) per thread.
- T3: `components/chat/ComposerPendingApprovalActions.tsx:22-29`, `components/ComposerContextPermissions.tsx:19`, `composerDraftStore.ts:254` (`runtimeMode`).
- API: yes, and mostly done (drawer + mode picker). Gap: an "always allow" shortcut and approvals from the Inbox row without opening the chat.
- Value: high for unattended runs across machines; the Inbox gap is the part worth doing.
- Effort: S.

### Queued messages (queue or steer)
- Does: while the agent works, your next message waits in a queue (editable, reorderable) or steers the current run.
- T3: `components/chat/QueuedRunsControl.tsx:42,58`; setting `components/settings/SettingsPanels.tsx:1218`; send logic `components/chat/ComposerPrimaryActions.tsx:34,90`; key `thread.steerQueuedMessage` `components/ChatView.tsx:2755`; edit logic `components/chat/queuedMessageEdit.ts`.
- API: yes for queue (hold in chat state, send when `session/prompt` resolves). Steer = cancel then send; only partly faithful. Currently `session.js:167` drops the send with a notice.
- Value: high.
- Effort: S.

### Checkpoints, per-turn diffs, revert
- Does: a git snapshot per turn, the diff of one turn, and "revert to here" (optionally restoring files).
- T3: `components/chat/useTimelineRewind.ts:93,168`; confirm dialog `components/chat/ChatOverlayHosts.tsx:182-207`; server `server/checkpointing/CheckpointStore.ts:10-15`, `server/checkpointing/CheckpointDiffQuery.ts:84`, `server/orchestration-v2/CheckpointRollbackService.ts:39`.
- API: partly. Run `git stash create` or a temp commit via `exec` at each turn start (works on remote machines with `on:`), extend `diff.js` to diff two refs, and restore with `git restore --source`. Agent-side conversation rewind is not in ACP, so revert is files-only. Risky on dirty trees; needs a confirm dialog.
- Value: high.
- Effort: L.

### Worktree per thread
- Does: a new thread can start in a fresh git worktree on a new branch; previous worktrees can be reused; cleanup later.
- T3: server `server/orchestration-v2/ProviderTurnStartService.ts:201-207` (`createWorktree`), web `components/chat/useComposerSend.ts:1348` (`prepareWorktree`), `components/BranchToolbarEnvModeSelector.tsx:27`, `components/chat/useWorktreeSetup.ts`, `worktreeCleanup.ts`.
- API: yes. `git worktree add` via `exec on:`; start the chat with that `cwd`. The `worktree` mod ships in Herdr; the user's CLAUDE.md already puts worktrees in `.worktrees/`.
- Value: high; parallel agents on one repo without collisions.
- Effort: M.

### Create PR and commit flows
- Does: one menu: commit, push, create PR, with generated commit message and progress toasts.
- T3: `components/GitActionsControl.tsx:927`, logic `components/GitActionsControl.logic.ts:108,172,219,225`; `state/sourceControlActions.ts:220`.
- API: yes. `git add/commit/push` and `gh pr create` via `exec`; message from the agent or a prompt field; toasts via `notify`. `pr.js` and the project popover (`menus.js`) are the home.
- Value: high.
- Effort: M.

### Project scripts
- Does: named commands per project (test, dev server) run in a terminal from a toolbar button, with optional keys.
- T3: `components/ProjectScriptsControl.tsx:78`, `projectScripts.ts:22,70,84`.
- API: yes. Keep scripts in shared state or a `.herdr-scripts.json` in the repo; run via the side keeper's terminal start (`side.js`). RECIPE.md says Herdr has nowhere to keep them, but shared state works.
- Value: medium.
- Effort: M.

### Stats and usage
- Does: usage page (tokens, cost over time), per-thread usage, rate-limit banners.
- T3: `components/usage/UsagePage.tsx:177`, `components/chat/ThreadDetailsUsage.tsx`, `components/chat/ComposerUsageLimits.tsx:47`, `components/chat/ContextWindowMeter.tsx:22`.
- API: partly. Context share already shows (the chat header in `chat.js`, from `usage_update`). Cost and totals need data ACP does not give; Claude Code logs under `~/.claude/projects` could be summed.
- Value: low to medium.
- Effort: M to L.

### Command palette
- Does: one search over threads, projects, actions and themes.
- T3: `components/CommandPalette.tsx:298`, logic `components/CommandPalette.logic.ts:423` (thread items), `:367` (project items); `components/CommandPaletteThreadItems.tsx:96`.
- API: yes. Herdr has `app.palette` (AGENTS.md ~613) and the `ht3-picker` mod; add ht3 actions (new chat, add surface, settle) as entries.
- Value: medium.
- Effort: S to M.

### Notifications
- Does: sound, desktop notice and badge when a thread needs input or finishes, with per-mode settings.
- T3: `components/ThreadNotificationCoordinator.tsx:26-29`, `threadNotifications.ts:8,15,19`.
- API: yes. `notify({action})` and `playSound` exist. Herdr toasts blocked and done terminal agents itself (AGENTS.md ~658), but not chat tabs: their agent has no terminal, so a chat that finishes or asks for approval in a hidden tab only changes its card and tab mark. `report.js` knows the moment (working to done or blocked while not looked at) and could call `notify` with a `pane.focus` action.
- Value: medium for chat tabs (none today), low for terminal agents (covered).
- Effort: S.

### Prompt stash
- Does: park a draft and recall it.
- T3: `components/chat/ComposerStashMenu.tsx:32`, `promptStashStore.ts`.
- API: yes (shared state).
- Value: low.
- Effort: S.

## Not worth it

- Timeline minimap (`components/chat/TimelineMinimap.tsx`): needs custom drawing the `list` view cannot give; the scroll pill is enough.
- Rich-text composer (Tiptap, code blocks, math, mermaid: `components/ComposerPromptEditorTiptap.tsx`, `components/chat/MermaidDiagram.tsx`): no DOM or web view in mods.
- Voice input (`components/chat/ComposerSpeechButton.tsx`): no microphone API for mods.
- Guest share / ChatGPT sharing (`components/chat/GuestShareControls.tsx`, `components/chat/ChatGptSharingControl.tsx`): needs T3's server and relay.
- MCP app frames and HTML render (`components/chat/McpAppFrame.tsx`, `components/chat/HtmlRenderFrame.tsx`): need a web view.
- Pull request guide runs and full PR review UI (`components/pullRequest/*`): large, and the PR surface plus `gh` in the terminal covers the daily case.
- Device and Browser web views: already ruled out in RECIPE.md.

## Not verified

- ACP agent support for `session/fork`, `promptCapabilities.image` and resource links was not tested; only T3's side and our mod's code were read.
- Whether `exec`-based base64 of large images stays within `exec` output limits was not tested.
- No Herdr API for clipboard image paste into a mod composer was found; AGENTS.md describes terminal paste only.
