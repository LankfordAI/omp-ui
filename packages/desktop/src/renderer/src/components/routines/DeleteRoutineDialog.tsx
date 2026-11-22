import { useState } from "react";
import type { RoutineRecord } from "@omp-ui/core/routine";
import { displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { Button, ConfirmDialog } from "../ui";

/**
 * Delete-routine confirmation (ADR-0100, #1255 clause 9): main removes the
 * routine and its history without reaping any live run, and releases every
 * surviving run record (routine: null) into the ordinary sidebar. The counts
 * come from the registry snapshot so the body names exactly what happens.
 */
export function DeleteRoutineDialog({
  routine,
  onClose,
  onDeleted,
}: {
  routine: RoutineRecord;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const removeRoutine = useStore((s) => s.removeRoutine);
  const projects = useStore((s) => s.state?.projects);
  const runs = (projects ?? []).flatMap((group) => group.sessions).filter((session) => session.routine?.id === routine.id);
  const live = runs.filter((session) => session.live === "live").length;
  const retained = runs.length - live;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      kicker={t("routines.title")}
      title={t("routines.delete.title", { name: routine.name })}
      tone="rose"
      onClose={onClose}
      width="w-[28rem]"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.dialog.cancel")}
          </Button>
          <Button
            variant="solid"
            tone="rose"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              removeRoutine(routine.id).then(onDeleted, (err: unknown) => {
                setError(displayMessage(err));
                setBusy(false);
              });
            }}
          >
            {t("routines.delete.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-mid">{t("routines.delete.body", { live, retained })}</p>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
