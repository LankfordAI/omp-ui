---
omp-ui: true
project: "omp-ui"
session: "01a10e3a-fafa-7475-bc1b-aadc6f51ec09"
date: 2026-10-05
omp-ui-version: "0.19.0"
tags:
  - "decision"
  - "omp-ui"
  - "plan-mode"
---
# Vault Writes in Plan Mode

Status: open. No decision has been made yet.

## Question

Should the agent be able to write vault notes (`omp-ui_vault_write`) while Plan mode is on?

Raised in [[2026-09-29 omp-ui Planning Meeting]]. Priya's position: no, because Plan mode means read-only.

## What Plan mode enforces today

- Plan mode is read-only by way of omp's own plan-mode write guard. The guard rejects working-tree writes, deletes, renames and state-changing commands. Only `local://` session artifacts can be written (`packages/core/src/plan-extension.ts`).
- The guard covers the working tree. The vault is a machine-local folder outside the project, so the guard's path checks may not cover a vault write. This hasn't been verified: no test or code path ties the vault tool to Plan mode.

## Options

1. **Block vault writes in Plan mode.** This keeps "Plan means read-only" with no exceptions and matches Priya's position. Cost: a decision or lesson that comes up during planning can't be saved until the user switches to Build mode.
2. **Allow vault writes in Plan mode.** A vault note isn't project code, much like a `local://` artifact. Cost: Plan mode is no longer strictly read-only, and the agent could change the user's knowledge base while the user expects it to change nothing.
3. **Allow them only with confirmation.** In Plan mode, each vault write needs the user's approval. Cost: more UI, and the rule is harder to explain than options 1 or 2.

## Next step

Before choosing, check whether a vault write is actually blocked when Plan mode is on. Then record the decision here and link the GitHub issue that tracks it.

Index: [[omp-ui/omp-ui Index|omp-ui Index]]
