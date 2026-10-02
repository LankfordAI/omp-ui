import { useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { queueEntryDisplayText, supportsPromoteQueued } from "../lib/queue-chip";
import { useStore } from "../store";
import { Button, Label } from "./ui";

/**
 * omp's queue, listed from its own queue-chip text (issue #714): steering
 * rows are read-only, follow-up rows carry a promote action that moves the
 * message into steering. Store-aware on `tabId` — the same idiom as
 * AdvisorControl and BuildPlanControl — so the composer popover and the
 * compact sheet mount it identically.
 *
 * Promote sends the RAW text: omp matches it exactly, while the row shows
 * it cleaned the way the transcript does. The action hides when the runtime
 * version is unknown or older than the verb — a rejected promote must never
 * fall back to `steer`, so offering it blind would only ever fail.
 */
export function QueuedMessageList({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const t = useT();
  const queued = useStore((s) => s.rpc[tabId]?.session.queuedMessages ?? null);
  const count = useStore((s) => s.rpc[tabId]?.session.queuedMessageCount ?? 0);
  const running = useStore((s) => s.rpc[tabId]?.status === "running");
  const canPromote = useStore((s) => supportsPromoteQueued(s.rpc[tabId]?.capabilities?.ompVersion ?? null));
  const promoteQueuedMessage = useStore((s) => s.promoteQueuedMessage);
  // One promote at a time: the list is re-sent by omp after each move, so a
  // second click before it lands could target a row index that shifted.
  const [pending, setPending] = useState<number | null>(null);

  if (queued === null) return null;

  const promote = async (index: number, raw: string): Promise<void> => {
    setPending(index);
    try {
      await promoteQueuedMessage(tabId, raw);
    } finally {
      setPending(null);
    }
  };
  // Advisor cards and deferred items are counted but never listed.
  const unlisted = Math.max(0, count - (queued.steering.length + queued.followUp.length));

  return (
    <div className="flex flex-col gap-2">
      {queued.steering.length > 0 && (
        <section className="flex flex-col gap-1">
          <Label>{t("composer.queue.steering")}</Label>
          {queued.steering.map((raw, index) => (
            <QueueRow key={`steering-${index}`} raw={raw} />
          ))}
        </section>
      )}
      {queued.followUp.length > 0 && (
        <section className="flex flex-col gap-1">
          <Label>{t("composer.queue.followUp")}</Label>
          {queued.followUp.map((raw, index) => (
            <QueueRow key={`followUp-${index}`} raw={raw}>
              {canPromote && (
                <Button
                  size="xs"
                  tone="copper"
                  disabled={disabled || pending !== null}
                  title={running ? t("composer.queue.promoteTitleRunning") : t("composer.queue.promoteTitleIdle")}
                  onClick={() => void promote(index, raw)}
                  className="shrink-0"
                >
                  {t("composer.queue.promote")}
                </Button>
              )}
            </QueueRow>
          ))}
        </section>
      )}
      {unlisted > 0 && (
        <p className="font-mono text-[11px] text-ink-faint">{t("composer.queue.unlisted", { n: unlisted })}</p>
      )}
    </div>
  );
}

function QueueRow({ raw, children }: { raw: string; children?: ReactNode }) {
  // An entry that is nothing but omp-ui's own context still shows something.
  const display = queueEntryDisplayText(raw) || raw;
  return (
    <div className="flex items-start gap-2">
      <span title={display} className="min-w-0 flex-1 line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px]">
        {display}
      </span>
      {children}
    </div>
  );
}
