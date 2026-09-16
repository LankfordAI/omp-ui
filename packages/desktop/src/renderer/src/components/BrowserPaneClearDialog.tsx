import { useState } from "react";
import { backend, displayMessage } from "../backend";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";

/** Explicit, app-scoped clearing flow for the browser pane profile (#542). */
export function BrowserPaneClearDialog() {
  const t = useT();
  const close = useStore((state) => state.closeBrowserPaneClearDialog);
  const reportError = useStore((state) => state.reportError);
  const [openPages, setOpenPages] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [working, setWorking] = useState(false);

  const clear = async (force: boolean): Promise<void> => {
    if (working) return;
    setWorking(true);
    try {
      const result = await backend.browserPaneClearData(force);
      if (result.status === "busy") setOpenPages(result.openPages);
      else setDone(true);
    } catch (err) {
      reportError(new Error(displayMessage(err)));
    } finally {
      setWorking(false);
    }
  };

  if (done) {
    return (
      <ConfirmDialog
        kicker={t("dialog.browserdata.kicker")}
        title={t("dialog.browserdata.done")}
        tone="signal"
        onClose={close}
        actions={<Button size="sm" onClick={close}>{t("common.overlay.close")}</Button>}
      >
        <p className="text-xs text-ink-mid">{t("dialog.browserdata.done")}</p>
      </ConfirmDialog>
    );
  }

  const busyFace = openPages !== null;
  return (
    <ConfirmDialog
      kicker={t("dialog.browserdata.kicker")}
      title={t(busyFace ? "dialog.browserdata.busyTitle" : "dialog.browserdata.title")}
      tone="rose"
      onClose={close}
      actions={
        <>
          <Button size="sm" disabled={working} onClick={close}>{t("dialog.diagnostics.cancel")}</Button>
          <Button size="sm" tone="rose" disabled={working} onClick={() => void clear(busyFace)}>
            {working
              ? t("dialog.browserdata.working")
              : t(busyFace ? "dialog.browserdata.force" : "dialog.browserdata.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-ink-mid">
        {busyFace
          ? t("dialog.browserdata.busyBody", { count: openPages })
          : t("dialog.browserdata.body")}
      </p>
    </ConfirmDialog>
  );
}
