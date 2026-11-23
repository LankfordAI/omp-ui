import { useState } from "react";
import { backend, displayMessage } from "../backend";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";

/** Explicit, app-scoped clearing flow for the browser pane profile (#542). */
export function BrowserPaneClearDialog() {
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
        kicker="Browser pane"
        title="Browser pane data cleared"
        tone="signal"
        onClose={close}
        actions={<Button size="sm" onClick={close}>close dialog</Button>}
      >
        <p className="text-xs text-ink-mid">Browser pane data cleared</p>
      </ConfirmDialog>
    );
  }

  const busyFace = openPages !== null;
  return (
    <ConfirmDialog
      kicker="Browser pane"
      title={busyFace ? "Pages are still open" : "Clear browser pane data?"}
      tone="rose"
      onClose={close}
      actions={
        <>
          <Button size="sm" disabled={working} onClick={close}>Cancel</Button>
          <Button size="sm" tone="rose" disabled={working} onClick={() => void clear(busyFace)}>
            {working
              ? "Clearing…"
              : busyFace ? "Close pages and clear" : "Clear"}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-ink-mid">
        {busyFace
          ? `${openPages} browser pane page(s) are running. Closing them clears the data and reopens each visible pane at its last address, signed out; the agent's connection to those pages is dropped until it reconnects.`
          : "Cookies, site storage, the HTTP cache and saved HTTP logins of every page opened in the browser pane are deleted. Sessions, transcripts and settings are not affected."}
      </p>
    </ConfirmDialog>
  );
}
