import { useEffect, useId, useState } from "react";
import type { SpillReadResult, SpillReference } from "@omp-ui/core/spill";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { backend, displayMessage } from "../backend";
import { Button, CopyButton, Label, Modal } from "./ui";

/** {@link SPILL_READ_MAX_BYTES} as the viewer names it; the bound itself is main's. */
const READ_BOUND = "1 MiB";

type ViewerState =
  | { status: "loading" }
  | SpillReadResult
  | { status: "error"; message: string };

/**
 * Read-only view of one spill (`local://<id>.log`, issue #1236). The read is
 * confined on the owning host — main derives the path from the session's own
 * transcript; this component never names a file. A missing file, a legacy
 * pre-19 (`artifact://`) reference, and a failed read each get their own
 * honest state. Nothing here touches the saved transcript.
 */
export function RawOutputViewer({
  tabId,
  spill,
  onClose,
}: {
  tabId: string;
  spill: SpillReference;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let canceled = false;
    void backend
      .readSpill(tabId, spill.id)
      .then((next) => {
        if (!canceled) setState(next);
      })
      .catch((reason: unknown) => {
        if (!canceled) setState({ status: "error", message: displayMessage(reason) });
      });
    return () => {
      canceled = true;
    };
  }, [tabId, spill.id, attempt]);

  const ref = `local://${spill.id}.log`;
  return (
    <Modal onClose={onClose} labelledBy={titleId} width="w-[48rem]" className="flex flex-col gap-2 p-3">
      <div className="flex min-w-0 items-center gap-2 pr-8">
        <Label>
          <span id={titleId}>{t("transcript.tool.rawOutput.title")}</span>
        </Label>
        <span className="min-w-0 truncate font-mono text-xs text-ink-faint" title={ref}>
          {ref}
        </span>
        <span className="ml-auto shrink-0">
          {state.status === "ok" && <CopyButton text={state.text} />}
        </span>
      </div>
      {state.status === "loading" && (
        <div className="text-xs text-ink-faint">{t("transcript.tool.rawOutput.loading")}</div>
      )}
      {state.status === "missing" && (
        <div className="text-xs text-ink-faint">{t("transcript.tool.rawOutput.missing")}</div>
      )}
      {state.status === "legacy" && (
        <div className="text-xs text-ink-faint">{t("transcript.tool.rawOutput.legacy")}</div>
      )}
      {state.status === "error" && (
        <div className="min-w-0">
          <div className="text-xs text-rose [overflow-wrap:anywhere]">
            {t("transcript.tool.rawOutput.failed", { reason: state.message })}
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("transcript.tool.rawOutput.retry")}
          </Button>
        </div>
      )}
      {state.status === "ok" && (
        <div className="min-w-0 space-y-1.5">
          {spill.sample && (
            <div className="text-xs text-copper">{t("transcript.tool.rawOutput.sample")}</div>
          )}
          {state.truncated && (
            <div className="text-xs text-copper">
              {t("transcript.tool.rawOutput.truncated", { limit: READ_BOUND })}
            </div>
          )}
          <pre
            data-selectable
            className={cn(
              "max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-sunken px-2 py-1.5",
              "font-mono text-xs leading-[1.55] text-ink",
            )}
          >
            {state.text}
          </pre>
        </div>
      )}
    </Modal>
  );
}
