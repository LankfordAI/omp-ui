// One notice per bulk action (issue #988): every per-row failure of a
// multi-session action lands together, never one dialog per row.
import { t } from "../../lib/i18n";

export interface BulkFailure {
  tabId: string;
  title: string;
  /** The reason, read after the row's title in a multi-row notice. */
  message: string;
  /** The whole notice when this is the action's only row; defaults to `message`. */
  alone?: string;
}

/** The thrown value's text, the way reportError renders it. */
export function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The one notice text for an action's failures, or null when none failed.
 * A single-row action keeps that row's own message verbatim; a multi-row one
 * names each failed row in `order` (request order, not completion order).
 */
export function bulkFailureNotice(
  failures: readonly BulkFailure[],
  order: readonly string[],
): string | null {
  if (failures.length === 0) return null;
  if (order.length <= 1) return failures[0]!.alone ?? failures[0]!.message;
  const sorted = [...failures].sort((a, b) => order.indexOf(a.tabId) - order.indexOf(b.tabId));
  return t("bulk.error.failed", {
    n: sorted.length,
    total: order.length,
    failures: sorted.map((f) => `${f.title}: ${f.message}`).join("\n"),
  });
}
