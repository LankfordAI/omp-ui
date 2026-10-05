---
omp-ui: true
project: "omp-ui"
session: "01a10e34-4586-7480-a2d2-c7bd44e6ce48"
date: 2026-10-05
omp-ui-version: "0.19.0"
tags:
  - "decision"
---
Decision (2026-10-05): a project's knowledge home is stored as a field on omp-ui's `ProjectRecord`, not as a key in `<project>/.omp/config.yml`.

Why:
- omp-ui is the only reader. omp never consumes the key, and the repo's rule is that `.omp/config.yml` holds settings omp loads (ADR-0031, ADR-0025). Settings only omp-ui reads live in the registry.
- The value is a machine-local vault path. A project file that may be committed or synced is the wrong place for it.
- Precedent: ADR-0047 (#738) moved the review roster from `REVIEW.yml` files into `ProjectRecord.reviewRoster`.
- No YAML parsing or line-scoped writer edge cases, and no chance of colliding with omp's config schema.

Accepted loss: the setting is not shared through git, and runs outside the app cannot see it.

Index: [[omp-ui/omp-ui Index|omp-ui Index]]



Confirmed by the user on 2026-10-05 and recorded as a partial resolution on LankfordAI/omp-ui#756: https://github.com/LankfordAI/omp-ui/issues/756#issuecomment-6004578052. The field is nullable (null = not set, so the routing default applies) and needs room for a vault reference. Still open on #756: the default rule, whether a project's vault is pinned or follows the default write vault, what `both` writes, and how the agent learns the rule.
