import { useEffect, useState } from "react";
import { localeTag, useT } from "../lib/i18n";
import { formatSnoozeUntil } from "../lib/snooze-until";
import { startVisibleInterval } from "../lib/visible-interval";
import { findRecord, useStore } from "../store";
import { Button, Chip } from "./ui";

/** Re-reads the clock so "sending…" replaces the time once the reset passes. */
const HELD_PROMPT_TICK_MS = 30_000;

/**
 * The pending Send at reset card (issue #986) at the transcript's tail: the
 * prompt the owning host holds for this session, when it goes out, and
 * Cancel (back into the draft) and Send now. It reads the session record, so
 * every client of the session — and a joined remote instance's tab — sees the
 * same card.
 */
export function HeldPromptCard({ tabId }: { tabId: string }) {
  const t = useT();
  const held = useStore((s) => findRecord(s.state, tabId)?.heldPrompt ?? null);
  const cancelHeldPrompt = useStore((s) => s.cancelHeldPrompt);
  const sendHeldPromptNow = useStore((s) => s.sendHeldPromptNow);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (held === null) return;
    return startVisibleInterval(() => setNow(Date.now()), HELD_PROMPT_TICK_MS);
  }, [held]);
  if (held == null) return null;
  const sent = held.sentAtMs !== null;
  const status = sent
    ? t("transcript.heldPrompt.sent")
    : held.error !== null
      ? t("transcript.heldPrompt.failed", { error: held.error })
      : held.sendAtMs === null
        ? t("transcript.heldPrompt.waiting")
        : held.sendAtMs <= now
          ? t("transcript.heldPrompt.due")
          : t("transcript.heldPrompt.at", { when: formatSnoozeUntil(held.sendAtMs, new Date(now), localeTag()) });
  const attachments = [
    held.imageCount > 0 ? t("transcript.heldPrompt.images", { count: held.imageCount }) : null,
    held.documentCount > 0 ? t("transcript.heldPrompt.documents", { count: held.documentCount }) : null,
  ].filter((part) => part !== null);
  return (
    <div data-held-prompt className="animate-rise rounded-md border border-copper-dim/60 bg-raised px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Chip tone="copper">{t("transcript.heldPrompt.label")}</Chip>
        <span className="min-w-0 flex-1 truncate text-ink-mid">{status}</span>
        {!sent && (
          <>
            <Button size="xs" variant="ghost" onClick={() => void cancelHeldPrompt(tabId)}>
              {t("transcript.heldPrompt.cancel")}
            </Button>
            <Button size="xs" tone="copper" onClick={() => void sendHeldPromptNow(tabId)}>
              {t("transcript.heldPrompt.sendNow")}
            </Button>
          </>
        )}
      </div>
      {held.preview !== "" && (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[12px] text-ink">{held.preview}</p>
      )}
      {attachments.length > 0 && <p className="mt-0.5 text-[11px] text-ink-dim">{attachments.join(" · ")}</p>}
      {held.attempts > 0 && !sent && (
        <p className="mt-0.5 text-[11px] text-ink-dim">{t("transcript.heldPrompt.attempts", { count: held.attempts })}</p>
      )}
    </div>
  );
}
