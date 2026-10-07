import { useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { queueEntryDisplayText, supportsPromoteQueued, supportsRestoreQueue } from "../lib/queue-chip";
import { useStore } from "../store";
import { Button, Label } from "./ui";

/**
 * omp's queue, listed from its own queue-chip text (issue #714): steering
 * rows carry only an edit action, follow-up rows carry promote and edit;
 * edit withdraws the message from omp and restores it to the composer draft
 * (issue #776). Store-aware on `tabId` — the same idiom as AdvisorControl
 * and BuildPlanControl — so the composer popover and the compact sheet
 * mount it identically.
 *
 * Actions send the RAW text: omp matches it exactly, while the row shows it
 * cleaned the way the transcript does. An action hides when the runtime
 * version is unknown or older than its verb — a rejected command must never
 * fall back to another verb, so offering it blind would only ever fail.
 */
export function QueuedMessageList({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const t = useT();
  const queued = useStore((s) => s.rpc[tabId]?.session.queuedMessages ?? null);
  const count = useStore((s) => s.rpc[tabId]?.session.queuedMessageCount ?? 0);
  const running = useStore((s) => s.rpc[tabId]?.status === "running");
  const canPromote = useStore((s) => supportsPromoteQueued(s.rpc[tabId]?.capabilities?.ompVersion ?? null));
  const canEdit = useStore((s) => supportsRestoreQueue(s.rpc[tabId]?.capabilities?.ompVersion ?? null));
  const promoteQueuedMessage = useStore((s) => s.promoteQueuedMessage);
  const editQueuedMessage = useStore((s) => s.editQueuedMessage);
  // One action at a time: omp re-sends the list after each mutation, so a
  // second click before it lands could target a row index that shifted.
  const [pending, setPending] = useState<number | null>(null);

  if (queued === null) return null;

  const act = async (index: number, run: () => Promise<void>): Promise<void> => {
    setPending(index);
    try {
      await run();
    } finally {
      setPending(null);
    }
  };
  const promote = (index: number, raw: string): Promise<void> =>
    act(index, () => promoteQueuedMessage(tabId, raw));
  const edit = (index: number, raw: string, queue: "steering" | "followUp"): Promise<void> =>
    act(index, () => editQueuedMessage(tabId, raw, queue));
  // Advisor cards and deferred items are counted but never listed.
  const unlisted = Math.max(0, count - (queued.steering.length + queued.followUp.length));

  return (
    <div className="flex flex-col gap-2">
      {queued.steering.length > 0 && (
        <section className="flex flex-col gap-1">
          <Label>{t("composer.queue.steering")}</Label>
          {queued.steering.map((raw, index) => (
            <QueueRow key={`steering-${index}`} raw={raw}>
              {canEdit && <EditButton disabled={disabled} title={t("composer.queue.editTitle")} pending={pending !== null} onEdit={() => void edit(index, raw, "steering")} />}
            </QueueRow>
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
              {canEdit && <EditButton disabled={disabled} title={t("composer.queue.editTitle")} pending={pending !== null} onEdit={() => void edit(index, raw, "followUp")} />}
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

function EditButton({
  disabled,
  title,
  pending,
  onEdit,
}: {
  disabled: boolean;
  title: string;
  pending: boolean;
  onEdit: () => void;
}) {
  const t = useT();
  return (
    <Button
      size="xs"
      tone="copper"
      disabled={disabled || pending}
      title={title}
      onClick={onEdit}
      className="shrink-0"
    >
      {t("composer.queue.edit")}
    </Button>
  );
}
