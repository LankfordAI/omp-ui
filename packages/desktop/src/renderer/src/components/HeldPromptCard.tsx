import { useEffect, useState } from "react";
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
    ? "sent — waiting for the turn to end"
    : held.error !== null
      ? `not sent: ${held.error}`
      : held.sendAtMs === null
        ? "hit the usage limit again — waiting for the next reported reset"
        : held.sendAtMs <= now
          ? "sending…"
          : `sends ${formatSnoozeUntil(held.sendAtMs, new Date(now))}`;
  const attachments = [
    held.imageCount > 0 ? `images: ${held.imageCount}` : null,
    held.documentCount > 0 ? `documents: ${held.documentCount}` : null,
  ].filter((part) => part !== null);
  return (
    <div data-held-prompt className="animate-rise rounded-md border border-copper-dim/60 bg-raised px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Chip tone="copper">Send at reset</Chip>
        <span className="min-w-0 flex-1 truncate text-ink-mid">{status}</span>
        {!sent && (
          <>
            <Button size="xs" variant="ghost" onClick={() => void cancelHeldPrompt(tabId)}>
              cancel
            </Button>
            <Button size="xs" tone="copper" onClick={() => void sendHeldPromptNow(tabId)}>
              send now
            </Button>
          </>
        )}
      </div>
      {held.preview !== "" && (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-ink">{held.preview}</p>
      )}
      {attachments.length > 0 && <p className="mt-0.5 text-xs text-ink-dim">{attachments.join(" · ")}</p>}
      {held.attempts > 0 && !sent && (
        <p className="mt-0.5 text-xs text-ink-dim">{`re-armed after the limit: ${held.attempts}`}</p>
      )}
    </div>
  );
}
