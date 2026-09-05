import type { JSX } from "react";
import { useT, type MessageKey } from "../lib/i18n";
import type { LifecycleConfirmation } from "../store";
import { useStore } from "../store";
import { Button, ConfirmDialog, type Tone } from "./ui";

/**
 * The app's one feedback host (issue #373): pending session/project
 * confirmations and backend error notices render as DOM alertdialogs through
 * the shared overlay stack — drivable by keyboard and automation alike, never
 * a renderer-blocking native modal.
 *
 * Only one dialog ever shows: the oldest error notice outranks a pending
 * confirmation without dropping that decision, and dismissing the last notice
 * restores the confirmation. State here is data-only (store/types.ts) — the
 * effects live in the lifecycle slice, keyed by confirmation id.
 */

const MODE_LABEL: Record<"pty" | "rpc-ui", MessageKey> = {
  pty: "dialog.lifecycle.terminal",
  "rpc-ui": "dialog.lifecycle.native",
};

/** Copy and tone per confirmation discriminant; copper action, rose removal. */
function lifecycleCopy(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  confirmation: LifecycleConfirmation,
): {
  tone: Tone;
  title: string;
  body: string;
  action: string;
  target: string | null;
} {
  switch (confirmation.kind) {
    case "terminate":
      return {
        tone: "copper",
        title: t("dialog.lifecycle.terminateTitle"),
        body: t("dialog.lifecycle.terminateBody"),
        action: t("dialog.lifecycle.terminateAction"),
        target: confirmation.title,
      };
    case "switch-mode":
      return {
        tone: "copper",
        title: t("dialog.lifecycle.switchTitle"),
        body: t("dialog.lifecycle.switchBody", {
          mode: t(MODE_LABEL[confirmation.mode]),
        }),
        action: t("dialog.lifecycle.switchAction"),
        target: confirmation.title,
      };
    case "remove-project":
      return {
        tone: "rose",
        title: t("dialog.lifecycle.removeTitle"),
        // The interpolated path is verbatim; the dialog body wraps it.
        body: t("dialog.lifecycle.removeBody", { path: confirmation.projectPath }),
        action: t("dialog.lifecycle.removeAction"),
        // The full path is in the body; no separate title line.
        target: null,
      };
  }
}

export function AppFeedback(): JSX.Element | null {
  const t = useT();
  const errorNotices = useStore((s) => s.errorNotices);
  const dismissError = useStore((s) => s.dismissError);
  const confirmation = useStore((s) => s.lifecycleConfirmation);
  const confirmLifecycleAction = useStore((s) => s.confirmLifecycleAction);
  const cancelLifecycleAction = useStore((s) => s.cancelLifecycleAction);

  const notice = errorNotices[0] ?? null;
  if (notice !== null) {
    // Keyed by id so each error lands as a fresh alertdialog: the overlay
    // hook re-traps and re-focuses instead of patching the old one in place.
    // There is no retry action — acknowledging is all an error demands here.
    return (
      <ConfirmDialog
        key={notice.id}
        kicker={t("dialog.error.kicker")}
        title={t("dialog.error.title")}
        tone="rose"
        onClose={() => dismissError(notice.id)}
        actions={
          <Button
            variant="solid"
            tone="rose"
            initialFocus
            onClick={() => dismissError(notice.id)}
          >
            {t("dialog.error.dismiss")}
          </Button>
        }
      >
        {/* The original backend text, verbatim and selectable — plain text,
            never HTML, with long messages wrapped instead of clipped. */}
        <p
          data-selectable
          className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim [overflow-wrap:anywhere] break-words"
        >
          {notice.message}
        </p>
      </ConfirmDialog>
    );
  }

  if (confirmation === null) return null;
  const copy = lifecycleCopy(t, confirmation);
  const busy = confirmation.busy;
  return (
    <ConfirmDialog
      key={confirmation.id}
      kicker={t("dialog.lifecycle.kicker")}
      title={copy.title}
      tone={copy.tone}
      // While the accepted effect is in flight the dialog cannot be dismissed:
      // close, backdrop, and Escape all reach a no-op, and Cancel is disabled.
      // (Cancellation of an already-dispatched backend command is deliberately
      // not offered.) The store re-checks the target on acceptance.
      onClose={busy ? () => {} : () => cancelLifecycleAction(confirmation.id)}
      actions={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            initialFocus
            onClick={() => cancelLifecycleAction(confirmation.id)}
          >
            {t("common.dialog.cancel")}
          </Button>
          <Button
            variant="solid"
            tone={copy.tone}
            disabled={busy}
            onClick={() => void confirmLifecycleAction(confirmation.id)}
          >
            {busy ? t("dialog.lifecycle.working") : copy.action}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {copy.target !== null && (
          <p className="truncate font-display text-sm font-medium text-ink">
            {copy.target}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim [overflow-wrap:anywhere] break-words">
          {copy.body}
        </p>
      </div>
    </ConfirmDialog>
  );
}
