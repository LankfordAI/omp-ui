# Chats run in app-data scratch dirs with a record marker, never a pseudo-project

> **Status:** Accepted, 2026-10-20 ([#894](https://github.com/LankfordAI/omp-ui/issues/894)).

A **Chat** (CONTEXT.md) is conversation not tied to a repo: an owned native
session with no **Project**. Every other owned session hangs off a project —
the sidebar groups by `projectCwd`, last-used model and thinking level live on
the project record, vault identity and memory scoping derive from it, and omp
itself needs a real working directory to run in. A project is, by definition,
a directory the user *explicitly registered*, so a chat cannot borrow one
without bending the vocabulary every other surface relies on.

Facts that shape the design:

- omp needs a real cwd; it writes nothing there on its own, but tools the
  agent runs (`bash`, `write`) do, so a shared cwd would mix unrelated chats'
  files.
- omp-ui seeds `mnemopi.scoping` to per-project tagging (ADR-0025). Under that
  default each scratch cwd is its own project to mnemopi, so every chat would
  open on an empty memory bank and retain into a bank no other chat reads.
- The warm pool keys its plan on `projectCwd`; a chat cwd is minted per chat
  and never reused, so a warm process could never be claimed.
- Joined remote instances project `RemoteInstanceSummary.projects` and proxy a
  fixed channel allowlist (ADR-0028); anything added to `projects` leaks into
  both.

## Why not the obvious routes

- **One persistent "desk" assistant**: a single long-lived session is one
  ever-growing context, not a list of conversations; it cannot be branched,
  deleted, or hibernated per topic, and it collapses back into a session
  without a project anyway.
- **A sentinel pseudo-project** (a hidden `ProjectRecord` for a chats
  folder): contradicts "Project = explicitly registered", and every project
  consumer — settings, remove-project, knowledge home, remote summaries,
  sidebar groups — would need a special case to hide or protect it. Missing
  one leaks it.
- **Meta-queries only** (answer "chatty" prompts from an existing project
  session): pollutes that project's transcript and memory, and still leaves
  no place for a conversation that belongs to no repo.
- **Remote-visible chats now**: needs a new summary shape and proxy channels,
  plus a decision about whose memory bank a remote chat writes. Deferred;
  host-local chats ship without touching the remote contract.

## Decision

**A real scratch cwd per chat plus a `chat: true` record marker; no project
record, a separate state array, and a global-bank overlay.**

- `OwnedSessionRecord.chat: boolean` (required-with-false, the #294
  convention: absent loads as false, a non-boolean drops the record). A chat
  spawn is `NewChatSpawnRequest` (`origin: "new"`, `chat: true`, `mode:
  "rpc-ui"`); `parseSpawnRequest` rejects `projectCwd`, worktree, plan-mode,
  plan-implementation, and experiment fields on it, so the renderer never
  names a directory.
- Main mints the cwd as `<userData>/chats/chat-<uuid>` (`chatDirPath`) and
  stores it as the record's working directory. The directory is created only
  after the record is written; a failed spawn rolls both back. The boot sweep
  (`sweepOrphanChatDirs`) checks `isReferenced` live against the registry, so
  a directory minted mid-spawn is never swept. A branch is a chat sharing its
  source's directory; deleting the last record that uses a directory deletes
  it; resume recreates a missing one. `CH.addProject` refuses the chats root
  and anything inside it.
- Every chat spawn writes `omp-ui-chat.yml` into the lineage dir pinning
  `mnemopi.scoping: global`, so all chats share omp's global memory bank
  instead of fragmenting into one empty bank per scratch dir. It deep-merges
  with the private overlay (ADR-0031, ADR-0055), so a private chat is both
  global-scoped and write-quiet.
- Registry settings `chatLastModel` / `chatLastThinkingLevel` seed new chats
  and are written by model changes on a chat; projects keep their own
  last-used state, untouched by chats.
- `buildState` publishes chats in a separate `BackendState.chats` array,
  never in `projects`, so `RemoteInstanceSummary` and the proxy allowlist stay
  unchanged; a chat spawn sent over the proxy is refused before forwarding.
- Chats are excluded from warm reservation and refill: the plan key includes
  `projectCwd`, and a chat cwd is never reused.
- Chats run in Build mode only: plan mode is forced false on every launch,
  and a chat cannot switch to PTY mode. All chats hibernate as one group, so
  at most the freshest chat stays warm.

## Consequences

- Project-scoped code paths need no special case: a chat simply has no
  project, and every consumer that iterates `projects` never sees one.
  Consumers that index all records (`ownerIndex`, tab reconciliation, seance
  sources) read `chats` explicitly.
- Files the agent writes in a chat live in its scratch directory and vanish
  with its last record — chats are not a place to keep work.
- Remote instances cannot see or start chats until a later decision extends
  the remote contract.

## Amends / relates

- ADR-0003 (lineage dirs) — chats use ordinary lineage dirs; only the cwd is
  new.
- ADR-0005 / ADR-0055 (per-lineage `--config` overlays) — the chat overlay is
  one more record-derived overlay on the same rail.
- ADR-0025 (memory defaults seeded per project) — chats opt out to the global
  bank.
- ADR-0031 (overlays deep-merge) — chat and private overlays compose.
