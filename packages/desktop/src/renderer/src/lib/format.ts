import type { WorktreeReleaseResult } from "@omp-ui/core/types";

/**
 * Number, cost, and ref formatting for display — the one home for count and
 * cost strings (ADR-0004: a formatter two components need lives here).
 */

/** `34900` → `34.9K`, `1000000` → `1M`. Exact values belong in `title=`. */
export function compactNum(value: number): string {
  const abs = Math.abs(value);
  const step: readonly [number, string] =
    abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  if (step[0] === 1) return `${Math.round(value)}`;
  const scaled = (value / step[0]).toFixed(1);
  return `${scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled}${step[1]}`;
}

/** Grouped digits for `title=` tooltips, where truncation would be a lie. */
export function exactNum(value: number): string {
  return value.toLocaleString("en-US");
}

/** Cost display precision is a product decision, shared by the HUD and the rail. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** 40-hex git commit → first 8 chars; refs pass through. */
export function shortBase(base: string): string {
  return /^[0-9a-f]{40}$/.test(base) ? base.slice(0, 8) : base;
}

/**
 * The transcript notice for a worktree release (issue #334). The session
 * survives, so this is the only durable record in the UI of where it moved and
 * what happened to its checkout and branch. `commits` is the merge's folded
 * count, null when the branch was already merged or nothing was merged;
 * `keepBranch` (issue #386) names the finish-dialog outcome where the branch
 * deliberately survives.
 */
export function releaseNoticeText(
  release: WorktreeReleaseResult,
  commits: number | null,
  keepBranch = false,
): string {
  const head =
    commits === null && keepBranch
      ? `this session now runs in ${release.projectCwd}`
      : commits === null
        ? `${release.branch} was already in the project checkout — this session now runs in ${release.projectCwd}`
        : `merged ${release.branch} (${commits} commit${commits === 1 ? "" : "s"}) into the project checkout — this session now runs in ${release.projectCwd}`;
  if (release.checkoutKept === "shared") {
    return `${head}. The checkout ${release.worktreePath} and branch ${release.branch} are kept: another session still runs there.`;
  }
  if (release.checkoutKept !== null) {
    return `${head}. The checkout ${release.worktreePath} could not be removed (${release.checkoutKept}) and the branch was kept — remove it by hand, or omp-ui sweeps it at next launch.`;
  }
  if (keepBranch) {
    return `${head}. The checkout is gone; branch ${release.branch} is kept.`;
  }
  if (release.branchOutcome !== "removed" && release.branchOutcome !== "already-gone") {
    return `${head}. The checkout is gone; branch ${release.branch} was kept (${release.branchOutcome}).`;
  }
  return `${head}. The checkout and branch ${release.branch} are gone.`;
}

/**
 * info when everything landed as asked — reclaimed, already gone, or kept on
 * purpose (issue #386) — warn when something was left behind by accident.
 */
export function releaseNoticeLevel(release: WorktreeReleaseResult): "info" | "warn" {
  return release.checkoutKept === null &&
    (release.branchOutcome === "removed" ||
      release.branchOutcome === "already-gone" ||
      release.branchOutcome === "kept-requested")
    ? "info"
    : "warn";
}

/**
 * The usage receipt's token count — deliberately not `compactNum`: the receipt
 * is a quiet mono line, and its scale (lowercase `k`, 10 000 cutoff, raw
 * digits below) is denser than the HUD's `K` at 1 000.
 */
export function tokenCount(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}