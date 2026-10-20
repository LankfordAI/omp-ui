# Ask chats pin the source session's summary as one hidden message, never a system-prompt flag

> **Status:** Accepted, 2026-10-20 ([#895](https://github.com/LankfordAI/omp-ui/issues/895)).

*Ask about this session* starts a fresh **Chat** (ADR-0059) about another
session: the user wants to ask "what did that session decide, and why?"
without waking the source, polluting its transcript, or re-explaining it. The
new chat needs two things the plain chat spawn does not give it: a title that
names the source, and the source's summary as background the model can see on
every turn.

Facts that shape the design:

- omp's `--append-system-prompt` flag does not append: it **replaces** the
  user's own `APPEND_SYSTEM.md`. The omp 18.12.3 bundle resolves it as
  `const Z = u.appendSystemPrompt ?? D8()`, so any value passed silently drops
  the user's file (filed as
  [#896](https://github.com/LankfordAI/omp-ui/issues/896)).
- A hidden `sendCustomMessage({ display: false })` reaches the model like the
  plan-mode, knowledge-vault, and browser-pane bridges' messages do. After the
  first turn it persists in the transcript as a `custom_message` entry, so a
  `--resume` that re-arms the bridge would stack a second copy unless delivery
  first walks `sessionManager.getBranch()` back to the last `compaction` or
  `reset_boundary` entry and skips when the message is already there.
- The sidebar title comes from omp's session header: the watcher overwrites
  `cachedTitle` with the header title whenever it changes (`backend.ts`,
  `watcher-hub.ts`). A title omp-ui wants to keep must therefore be in the
  header, which means `set_session_name` before the first message
  materializes the session.

## Why not the obvious routes

- **`--append-system-prompt`**: replaces the user's `APPEND_SYSTEM.md`
  (above), so every Ask chat would quietly lose the user's own standing
  instructions.
- **A visible first prompt** carrying the summary: pollutes the transcript the
  user reads, and sending it starts a model turn the user never asked for.
- **A renderer-sent prompt after `ready`**: the same turn cost, plus a race
  with whatever the user types first.
- **A Seance consult only**: answers one question from the saved transcript,
  but leaves no chat to continue the conversation in. The Ask chat routes deep
  dives to Seance instead of replacing it.

## Decision

**The renderer requests a chat with an `askSource`; main pins the source's
summary as one hidden, deduplicated custom message delivered by a generated
bridge.**

- The renderer sends `NewChatSpawnRequest.askSource = { tabId, title }` from
  the sidebar row's *Ask about this session* action or the command palette.
  `parseSpawnRequest` accepts it on chat requests only (both strings
  non-empty, no extra keys).
- Main resolves the source record by `tabId`; a source with no saved
  transcript yet (no record, `sessionId` null, or no location on disk) refuses
  the spawn. It renders `omp-ui://sessions/<id>/summary` from disk — the
  source process is never woken, and an archived transcript is read in memory
  without being restored — and composes the pinned text with `askContextText`:
  a fixed head and tail naming the source session id and the read-only Seance
  route (`sourceSession "<transcript path>"`), with only the summary shrinking
  so the whole text stays within 8,000 UTF-16 units.
- The Ask chat's record stores `askSource: { tabId, sessionId }`
  (required-with-null, the #294 convention: absent loads as null, a malformed
  value drops only that record) and `cachedTitle` set to the trimmed title,
  capped at 200 characters. The chat is private when the source is private or
  the request asks for it.
- Main stages the text as `ask-context.md` in the chat's lineage dir. The
  `omp-ui-ask-context` bridge is written and loaded for **every** rpc spawn,
  so warm-pool tree hashes stay identical between warm and cold launches; it
  is armed only for Ask chats, through `initialCommands`:
  `set_session_name` while the session is unmaterialized, then
  `/omp-ui-ask-context set {"text": …}`.
- The bridge binds the root session on its first prompt, then sends one
  `{ customType: "omp-ui:ask-context", display: false }` message
  (`deliverAs: "nextTurn"`, `triggerTurn: false`, so arming costs no turn).
  Before every send it walks the current branch back to the last compaction or
  reset boundary and skips when the pinned message is already there. On
  `session_compact`, `session_branch`, and `session_switch` it re-runs
  delivery and lets that walk decide.
- Resume re-reads `ask-context.md`; when the artifact is gone it re-renders
  from the source, and when the source is gone too it relies on the copy
  already in the transcript.

## Consequences

- The user's `APPEND_SYSTEM.md` keeps applying to Ask chats, and the pinned
  context is invisible in the transcript view.
- The pin is a snapshot of the summary at spawn time. Later work in the source
  session reaches the chat only through the Seance route or a fresh summary
  read, never by rewriting the pinned message.
- A compaction re-sends the pin after the boundary, so long Ask chats keep the
  context the summary would otherwise lose.
- An omp without `sendCustomMessage` warns once
  (`omp-ui ask context: this omp cannot carry the pinned context to the agent`)
  and the chat runs without the pin.

## Amends / relates

- ADR-0059 (chats run in app-data scratch dirs) — an Ask chat is an ordinary
  chat with one more record field and one armed bridge.
- ADR-0055 (private sessions) — privacy is inherited from a private source.
- ADR-0048 (knowledge vault) — the ask-context bridge reuses the knowledge
  vault bridge's generated-extension shape, adding the branch dedupe walk.
- ADR-0003 (per-lineage session dirs) — `ask-context.md` and the generated
  bridge live in the chat's lineage dir and die with it.
