# Project copy clones on the member and carries chosen gitignored files main-to-main

> **Status:** Accepted, 2026-10-30 ([#992](https://github.com/LankfordAI/omp-ui/issues/992)).

A **Fleet** member can already take a checkout two ways: an agent provisions
it over its own ssh (ADR-0064), or calls the rung-3 `clone` verb through
`omp-ui_fleet_project` (ADR-0062). Neither is a human action, and neither
moves the files a checkout needs to run that git does not track — `.env`,
local config — so a fresh member checkout does not work until someone copies
them by hand.

Facts that shape the design:

- The rung-3 `clone` verb already clones an https URL into a declared
  `fleetProjectRoots` root and registers it through `addProjectPath`, so the
  new checkout gets its repository key and head watcher at once (#906). It
  runs with no credential of the member's own and a 45 s bound.
- The source checkout is on this computer: only its main can list its
  gitignored files and read their bytes. `git status --porcelain=v1 -z
  --ignored=matching` names each ignored path once, a folder only when a
  pattern matched the folder itself.
- ADR-0065 sends Provider keys only by an explicit, Full-control rollout, and
  never takes a key from a project `.env`. omp itself loads `.env`,
  `.env.<NODE_ENV>`, `.env.local`, and `.env.<NODE_ENV>.local` from a project
  directory (verified in the omp 18.14.0 binary's dotenv loader), so a carried
  `.env` holding a key would hand that key to every session on the member.
- The join socket's request frame cap is 64 MiB (`MAX_PAYLOAD`); the member
  call is bounded by the dispatcher's 45 s deadline.

## Why not the obvious routes

- **Carry the files through `fleet:exec`.** Needs Full control and the
  member's master switch, which are default-off (ADR-0062), and turns a file
  write into an arbitrary shell command. Rejected: a fixed rung-3 verb.
- **Copy files the renderer read.** The renderer would hold file bytes —
  secrets, in practice — and pass them through a second process. Rejected,
  as for Provider keys (ADR-0065): the renderer names files; main reads and
  sends.
- **Copy every gitignored file.** Dependency and build trees (`node_modules`,
  `.venv`, `dist`) are large and platform-specific, and the member rebuilds
  them. Rejected: per-file and total caps, and ignored folders over a file
  count are skipped whole.
- **Strip Provider key lines from a file and send the rest.** Requires
  parsing every config format and silently changes the user's file.
  Rejected: a file whose text names any Provider key variable is skipped
  whole and the dialog says which variable.
- **Fold private and SSH remotes into this action.** The member clones with
  no credential, and omp-ui holds none to give it (ADR-0064). Rejected: the
  dialog and the refusal point at agent provisioning instead.

## Decision

**Project copy is a user-started action from the project quick-open. The
member clones and registers with the existing rung-3 `clone` verb; chosen
gitignored files then travel main-to-main on a new rung-3 verb,
`fleet:projectFiles`, that writes new files only.**

- **Source.** `previewProjectCopy` / `readProjectCopyFiles`
  (`packages/core/src/project-copy.ts`) resolve the clone URL — `origin`,
  else the only remote, through `parseRemoteWebUrl` — and record whether the
  checkout reaches it over https or ssh. They list ignored files: at most
  1 MiB each, 8 MiB and 500 files in total, no symlinks, ignored folders over
  50 files skipped whole, and any file naming a `PROVIDER_ENV_NAMES` variable
  skipped as `provider-key`. The copy re-scans before reading, so a pick that
  stopped qualifying is reported, never sent. Both channels refuse a path
  this app has not registered.
- **Channels.** `fleet:projectCopyPreview` (names and sizes) and
  `fleet:copyProject` (renderer sends file names only) are local
  orchestration. `fleet:projectFiles` joins `REMOTE_PROXY_CHANNELS` beside
  `fleet:projectManage`.
- **Member.** `FleetServer.projectFiles` checks Manage projects, then
  requires the target to be a registered project strictly under a declared
  root. Each file is written with `wx` (an existing path, including one a
  symlink names, is never overwritten), only after the deepest existing
  parent resolves inside the checkout, mode 0600 or 0700 when executable.
  One `manage` audit line names the checkout and the written count, never a
  file's bytes.
- **UI.** **Copy project to…** on a project page for this computer's
  checkout, while a remote instance is joined. The dialog lists members with
  why one cannot take the copy, an opt-in **Also copy gitignored files**
  switch (off by default) listing eligible files and every skip, and a note
  when the remote is SSH or missing. Continue stages a `copy-project`
  lifecycle confirmation naming the member, the file count, and whether the
  join is encrypted.

## Consequences

- The member owns the copy: it clones from its own network, and a clone
  failure names agent provisioning as the route for private or SSH-only
  repositories.
- Gitignored files cross the join in plaintext over an `http://` join, like
  Provider keys; the confirmation says so.
- A clone that succeeds but whose file write fails (an older member answers
  "unknown channel") leaves the registered checkout in place and reports
  each file as not copied.
- Repeating a copy refuses at the clone once every root holds a folder with
  the repository's name; it never overwrites a checkout.
- Agents gain no tool: `omp-ui_fleet_project` keeps its two verbs, and file
  carry is a human decision.

## Amends / relates

- ADR-0062 (fleet exec ladder) adds `fleet:projectFiles` to rung 3 and to
  the proxied allowlist.
- ADR-0064 (provision over own ssh) remains the route for remotes the member
  cannot clone without credentials.
- ADR-0065 (Provider keys) keeps keys off this path: a file naming one is
  never carried.
