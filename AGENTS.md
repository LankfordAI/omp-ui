# AGENTS.md

Instructions for coding agents working in this repository.

## Project orientation

- Read `CONTEXT.md` first — it defines the project vocabulary (session, live
  session, tab, lineage, owned session, inspector rail, ...). Use those terms
  and respect their _Avoid_ lists in code, commits, and issues.
- Current architecture lives in `docs/architecture.md`. Phase plans remain in
  `docs/` (`phase-1-pty-embed.md`, `phase-2-rpc-ui.md`, `phase-3-acp.md`), and
  design decisions remain in `docs/adr/`. Check the ADRs before proposing an
  approach an ADR already rejected.
- `packages/core` is plain Node/TS with **zero Electron imports**
  (ADR-0002). `packages/desktop` is the Electron shell. Never introduce an
  Electron dependency into `core`.
- Open upstream issues, bug reports, PRs, or feature requests — including
  against OMP, Chromium, Electron, or any other project — only when the user
  explicitly asks for or confirms that specific filing. An explicit request
  is authorization; do not ask for redundant confirmation. Never initiate a
  filing on your own, whether through a web page, CLI, or API. A plan that
  prescribes an upstream request is not authorization: deliver the draft and
  ask unless the user has already explicitly requested that filing. Where
  OMP's current state constrains this UI and no upstream filing has been
  requested, work around it inside `omp-ui` where possible; otherwise surface
  the constraint to the user.
- A verification run that boots the app uses `npm run dev:headless`
  (`docs/development.md`, "Verification runs"): it maps no window and takes no
  focus. Never launch the visible app (`npm run dev`) for a check unless the user
  asks to see it.
- A plan or spec document ends at verification. It prescribes the change, not
  the delivery route: no commit messages, branch names, pushes, merge targets,
  or `Fixes #N` trailers — where the work goes is the user's call, made after
  they read the plan. Git that is the subject of the change or evidence for a
  diagnosis (`git log --grep`, `git blame`) does belong in a plan.

## Commit messages and issue closing

- Every `#N` a commit cites is marked: `Fixes #N` when this commit completes
  the issue and the change is verified, `Refs #N` otherwise.
  `.githooks/commit-msg` rejects an unmarked `#N`, and `npm install` enables it.
- Never write `Refs` to get past the hook when the work is done: a `Refs`
  landing leaves the issue open on purpose.
- A `Fixes #N` landing on `main` or `develop` closes the issue, so do not close
  it by hand.
- Wrap a `#N` that is not an issue in backticks.

## Feature requests and bugs → GitHub issues

**Every incoming feature request or bug report MUST be captured as a GitHub
issue in `LankfordAI/omp-ui` before (or alongside) any implementation work.**
This applies whether the request arrives in conversation, is discovered while
working, or is implied by a failing behavior you observe.

Use the `gh` CLI. The repo has form templates under `.github/ISSUE_TEMPLATE/`;
when filing from the CLI, mirror their structure in the issue body and apply
the matching title prefix and label:

### Bug

```bash
gh issue create --repo LankfordAI/omp-ui \
  --title "[Bug]: <short summary>" \
  --label bug \
  --body-file /tmp/bug.md
```

Body must cover (matching `.github/ISSUE_TEMPLATE/bug_report.yml`):

- **Description** — what went wrong, in CONTEXT.md vocabulary
- **Steps to reproduce**
- **Expected behavior** / **Actual behavior**
- **Tab mode** — PTY/terminal, rpc-ui/native transcript, both, or N/A
- **omp-ui version/commit**, **omp version**, **OS**
- **Logs/output** — relevant main-process or devtools console output

### Feature request

```bash
gh issue create --repo LankfordAI/omp-ui \
  --title "[Feature]: <short summary>" \
  --label enhancement \
  --body-file /tmp/feature.md
```

Body must cover (matching `.github/ISSUE_TEMPLATE/feature_request.yml`):

- **Problem / motivation** — the problem, not just the solution
- **Proposed solution** — in CONTEXT.md vocabulary
- **Area** — sidebar, terminal tab, native transcript, composer, session HUD,
  inspector rail, plan mode, `packages/core`, packaging, other
- **Alternatives considered** — cite the ADR if one covers this ground
- **Additional context**

### Rules

- Search for duplicates first: `gh issue list --repo LankfordAI/omp-ui --search "<keywords>"`.
  If a duplicate exists, comment on it instead of opening a new issue.
- One issue per distinct request or defect — never bundle several into one.
- If you then implement the fix/feature, mark it in the commit that completes
  it (`Fixes #N`) and report the issue number.
- Do not close an issue until the change is verified working.
