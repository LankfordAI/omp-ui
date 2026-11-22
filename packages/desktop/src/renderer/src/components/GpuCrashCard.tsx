import { useCallback } from "react";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { UpdateCard } from "./ui";

/**
 * The GPU-process notice (performance plan Phase 4): main saw the GPU child
 * process disappear, and composited blur, transforms and window moves fall to
 * software raster until the app is relaunched. Wording is observation, never
 * cause — Electron offers no supported way to restore the process in-run, so
 * the card names the honest remedy instead of promising recovery.
 */
export function GpuCrashCard() {
  const t = useT();
  const detail = useStore((s) => s.gpuCrashDetail);
  const dismiss = useStore((s) => s.dismissGpuCrash);
  // Stable identity: UpdateCard's timer restarts whenever onDismiss changes.
  const onDismiss = useCallback(() => dismiss(), [dismiss]);
  if (detail === null) return null;
  return (
    <UpdateCard dismissLabel={t("update.card.dismiss")} onDismiss={onDismiss}>
      <div role="alert" className="min-w-0">
        <p className="text-sm font-medium text-ink">{t("gpu.crash.title")}</p>
        <p className="mt-1 text-xs text-ink-mid">{t("gpu.crash.body")}</p>
        <p className="mt-2 break-all font-mono text-[10px] text-ink-faint">{detail}</p>
      </div>
    </UpdateCard>
  );
}
