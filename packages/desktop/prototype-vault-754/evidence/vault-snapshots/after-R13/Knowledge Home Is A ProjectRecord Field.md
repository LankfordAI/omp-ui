---
omp-ui: true
project: "omp-ui"
session: "01a10e41-35a8-74f1-b49f-3f91a845a4b4"
date: 2026-10-05
omp-ui-version: "0.19.0"
tags:
  - "decision"
---
# Knowledge Home Is A ProjectRecord Field

**Decision:** omp-ui stores a project's knowledge home as a field on `ProjectRecord` (`packages/core/src/types.ts`), not as a key in the project's `.omp/config.yml`.

**Why:**

- A knowledge home points into one user's vault on one machine. `ProjectRecord` lives in omp-ui's own per-machine project registry, which is where that kind of value belongs. `.omp/config.yml` sits in the repository and can be committed and shared.
- `.omp/config.yml` is omp's config file. An omp-ui-only key there extends a schema omp-ui does not own.
- `ProjectRecord` already holds per-project UI state (`lastModel`, `defaultModel`, `lastAdvisor`, ...). The new field follows the same pattern: nullable, with legacy registries that lack it normalized to `null` at parse time.

**Rejected:** a `.omp/config.yml` key, because it would tie a machine-local path to a shared, omp-owned file.

Index: [[omp-ui/omp-ui Index|omp-ui Index]]
