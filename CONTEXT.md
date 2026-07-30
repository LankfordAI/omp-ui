# omp-ui

A cross-platform desktop GUI for the `omp` coding agent: a project sidebar and
an embedded OMP TUI (Phase 1), with optional native transcript rendering
(Phase 2) and ACP integration (Phase 3).

## Language

**Session**:
An on-disk OMP transcript: one `<timestamp>_<uuidv7>.jsonl` file plus its
optional sibling artifacts directory, identified by the UUID in its header.
omp-ui reads and resumes sessions; it never edits them.
_Avoid_: conversation, chat, thread

**Live session**:
An owned session with a running `omp` process owned by the omp-ui instance
(the app is single-instance; the registry lives in the one main process).
Its tab may be visible or hidden — closing a tab hides it (the process keeps
running); clicking the session resurfaces the tab. omp-ui never spawns a
second process for the same session, because omp has no cross-process session
lock (v17.1.8).
_Avoid_: open session, active session, running session

**Tab**:
The renderer's view onto a live session's PTY — one xterm.js instance per
live session. Tabs hide rather than close; focus/dedupe keys on the tab,
which exists from spawn — before the session has an id or file.
_Avoid_: window, pane

**Project**:
A working directory the user has explicitly registered in the sidebar, stored
in omp-ui's own config. Owned sessions attach to the project they were
launched in. A project with zero sessions is valid (fresh repo, nothing run
yet).
_Avoid_: repo, folder, workspace

**Owned session**:
A session whose file lives in an omp-ui lineage dir (ADR-0003) — launched by
omp-ui or produced in-process by such a session (`/new`, `/branch`). The only
sessions the sidebar tracks. Sessions from terminal `omp` use are invisible
to omp-ui, even under registered projects.
_Avoid_: tracked session, managed session

**Lineage**:
The sequence of sessions one spawned `omp` process produces: the initial
session plus every `/new` and `/branch` it switches into (omp replaces the
session file in-process). A lineage shares one pinned session dir.
_Avoid_: tab history
