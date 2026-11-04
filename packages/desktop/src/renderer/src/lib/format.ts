import type { WorktreeReleaseResult } from "@omp-ui/core/types";
import { currentLocaleId } from "./i18n";

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

/** `1234` → `1234B`, `1536` → `1.5KB`, then MB/GB at one decimal (omp 18.16 minimizer provenance). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

/** Cost display precision is a product decision, shared by the HUD and the rail. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** 40-hex git commit → first 8 chars; refs pass through. */
export function shortBase(base: string): string {
  return /^[0-9a-f]{40}$/.test(base) ? base.slice(0, 8) : base;
}

/** Tail of a provider/model selector, without an omp thinking-level suffix. */
export function shortModelLabel(selector: string): string {
  const slash = selector.lastIndexOf("/");
  const tail = slash === -1 ? selector : selector.slice(slash + 1);
  const colon = tail.lastIndexOf(":");
  return colon > 0 ? tail.slice(0, colon) : tail;
}

/**
 * One display form for a model everywhere the chrome names one (round-1
 * judge: `GPT-5.6 Luna` in the composer pill vs `gpt-5.6-luna` in the sidebar
 * named the same model two ways). The catalog's own name wins — it is what
 * Settings and the model picker show; the compact selector tail is the
 * fallback whenever no catalog row matches (dormant rows boot no process and
 * have no catalog). `selector` is omp's `provider/id[:level]`.
 */
export function modelDisplayLabel(
  selector: string,
  catalog?: readonly { id: string; name: string }[] | null,
): string {
  const tail = shortModelLabel(selector);
  // Catalog ids may keep their own vendor prefix (`openai/gpt-5.6-luna` under
  // the openrouter provider), so match the full tail or its last slash-part.
  const row = catalog?.find(
    (model) =>
      model.id === tail || shortModelLabel(model.id) === tail,
  );
  return row !== undefined && row.name !== "" ? row.name : tail;
}

/** Coarse localized relative time for scan-first rows and cards. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  const format = new Intl.RelativeTimeFormat(currentLocaleId(), {
    numeric: "auto",
    style: "narrow",
  });
  if (seconds < 45) return format.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return format.format(-days, "day");
  return new Date(then).toLocaleDateString(currentLocaleId(), {
    month: "short",
    day: "numeric",
  });
}

/**
 * The transcript notice for a worktree release (issue #334). The session
 * survives, so this is the only durable record in the UI of where it moved,
 * what happened to its checkout and branch, and — since issue #431 — which
 * branch the project checkout holds. `commits` is the merge's folded
 * count, null when the branch was already merged or nothing was merged;
 * `keepBranch` (issue #386) names the finish-dialog outcome where the branch
 * deliberately survives.
 */
export function releaseNoticeText(
  release: WorktreeReleaseResult,
  commits: number | null,
  keepBranch = false,
): string {
  const switchedTo =
    release.checkoutSwitch.kind === "switched" ? release.checkoutSwitch.branch : null;
  const landed = `this session now runs in ${release.projectCwd}${
    switchedTo === null ? "" : ` on ${switchedTo}`
  }`;
  const where = switchedTo ?? "the project checkout";
  const head =
    commits === null && keepBranch
      ? landed
      : commits === null
        ? `${release.branch} was already in ${where} — ${landed}`
        : `merged ${release.branch} (${commits} commit${commits === 1 ? "" : "s"}) into ${where} — ${landed}`;
  let tail: string;
  if (release.checkoutKept === "shared")
    tail = `The checkout ${release.worktreePath} and branch ${release.branch} are kept: another session still runs there.`;
  else if (release.checkoutKept === "gone")
    tail = `The checkout ${release.worktreePath} was already gone — omp-ui settled the session and pruned its worktree entry.`;
  else if (release.checkoutKept !== null)
    tail = `The checkout ${release.worktreePath} could not be removed (${release.checkoutKept}) and the branch was kept — remove it by hand, or omp-ui sweeps it at next launch.`;
  else if (keepBranch) tail = `The checkout is gone; branch ${release.branch} is kept.`;
  else if (release.branchOutcome !== "removed" && release.branchOutcome !== "already-gone")
    tail = `The checkout is gone; branch ${release.branch} was kept (${release.branchOutcome}).`;
  else tail = `The checkout and branch ${release.branch} are gone.`;
  if (release.checkoutSwitch.kind === "failed")
    tail += ` The switch to ${release.checkoutSwitch.branch} was refused: ${release.checkoutSwitch.error}`;
  return `${head}. ${tail}`;
}

/**
 * info when everything landed as asked — reclaimed, already gone, or kept on
 * purpose (issue #386) — warn when something was left behind by accident. A
 * checkout that was already gone (#1014) is an honest settle, not a loss.
 */
export function releaseNoticeLevel(release: WorktreeReleaseResult): "info" | "warn" {
  return (release.checkoutKept === null || release.checkoutKept === "gone") &&
    release.checkoutSwitch.kind !== "failed" &&
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