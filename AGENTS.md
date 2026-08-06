# AGENTS.md

Instructions for coding agents working in this repository.

## Project orientation

- Read `CONTEXT.md` first — it defines the project vocabulary (session, live
  session, tab, lineage, owned session, inspector rail, ...). Use those terms
  and respect their _Avoid_ lists in code, commits, and issues.
- Architecture and phase plans live in `README.md` and `docs/`
  (`phase-1-pty-embed.md`, `phase-2-rpc-ui.md`, `phase-3-acp.md`). Design
  decisions live in `docs/adr/` — check them before proposing an approach
  an ADR already rejected.
- `packages/core` is plain Node/TS with **zero Electron imports**
  (ADR-0002). `packages/desktop` is the Electron shell. Never introduce an
  Electron dependency into `core`.

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
- If you then implement the fix/feature, reference the issue in the commit or
  PR (`Fixes #N` / `Closes #N`).
- Do not close an issue until the change is verified working.
