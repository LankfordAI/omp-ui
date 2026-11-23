import { useEffect, useId, useState } from "react";
import type { CollabAccess } from "@omp-ui/core/collab";
import { useStore } from "../store";
import { Button, Chip, ChoiceCapsule, CopyButton, Label, Modal } from "./ui";
import { PairingQr } from "./PairingQr";

/**
 * The Share-live dialog (issue #686): omp hosts the room from inside the
 * tab's TUI; this surface reads the registry mirror and carries the two
 * generation-bound links (control and view-only). omp-ui never holds a room
 * key — the link's fragment is the key, so a link is secret material: this
 * component never logs it and uploads nothing, and links live only as long
 * as the dialog is open.
 */
export function ShareLiveDialog({ tabId }: { tabId: string }) {
  const titleId = useId();
  const close = useStore((s) => s.closeShareLive);
  const view = useStore((s) => s.collab[tabId]);
  // omp's collab surface lives in the TUI: a native tab has no host to open,
  // whatever the map holds (issue #686).
  const native = useStore((s) => s.tabs.some((t) => t.tabId === tabId && t.mode === "rpc-ui"));
  const startCollab = useStore((s) => s.startCollab);
  const stopCollab = useStore((s) => s.stopCollab);
  const collabLink = useStore((s) => s.collabLink);
  const [access, setAccess] = useState<CollabAccess>("full");
  const [controlUrl, setControlUrl] = useState<string | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);

  const sharing = view?.kind === "sharing" ? view.state : null;
  const status = sharing?.status ?? null;
  // Links are generation-bound: fetch on open and whenever the generation
  // rotates (omp re-rooms on /new, /resume, branch). A failed fetch leaves
  // the previous link out rather than showing a dead one.
  const generation = sharing?.generation ?? null;
  useEffect(() => {
    setControlUrl(null);
    setViewUrl(null);
    if (generation === null) return;
    let live = true;
    if (status === "view") {
      // A view-only host publishes one link only: omp refuses a control
      // link for it ("does not publish control access"), so ask for the
      // read-only one directly.
      void collabLink(tabId, true).then(
        (url) => live && setViewUrl(url),
        () => {},
      );
    } else {
      void collabLink(tabId, false).then(
        (url) => live && setControlUrl(url),
        () => {},
      );
      void collabLink(tabId, true).then(
        (url) => live && setViewUrl(url),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [tabId, generation, status, collabLink]);

  return (
    <Modal onClose={close} labelledBy={titleId} width="w-[34rem]">
      <div className="border-b border-line px-5 pb-4 pt-5">
        <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight text-ink">
          Share live
        </h2>
        <p className="mt-0.5 text-xs text-ink-dim">
          {native
            ? "live sharing needs a terminal tab — omp's /collab lives in the TUI, and native sessions do not expose it."
            : sharing === null
              ? "omp hosts a live room from this terminal; guests watch and steer as it runs."
              : "This session is hosting a live Collab room."}
        </p>
      </div>

      <div className="space-y-3 px-5 py-4">
        {native ? null : sharing === null ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <Label>access</Label>
              <ChoiceCapsule
                label="access"
                value={access}
                options={[
                  { value: "full", label: "full" },
                  { value: "view", label: "view-only" },
                ]}
                onChange={setAccess}
              />
            </div>
            <p className="text-xs leading-relaxed text-ink-faint">full access: guests steer and approve; view-only: they watch, and approval stays with you.</p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-mid">
              <Chip tone={sharing.status === "full" ? "signal" : "copper"}>
                {sharing.status === "full" ? "full" : "view-only"}
              </Chip>
              <Chip mono>
                {`${sharing.participants} guest(s)`}
              </Chip>
              {!sharing.relayConnected && (
                <Chip tone="rose">relay offline</Chip>
              )}
              {sharing.inputRequired && (
                <Chip tone="copper">waiting for input</Chip>
              )}
            </div>
            {controlUrl !== null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>control link</Label>
                  <CopyButton
                    text={controlUrl}
                    label="copy"
                    doneLabel="copied"
                  />
                </div>
                <p data-selectable className="truncate font-mono text-xs text-ink-mid">
                  {controlUrl}
                </p>
                <PairingQr url={controlUrl} title="scan to join" caption="opens the room with the access shown above" />
              </div>
            )}
            {viewUrl !== null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>view-only link</Label>
                  <CopyButton
                    text={viewUrl}
                    label="copy"
                    doneLabel="copied"
                  />
                </div>
                <p data-selectable className="truncate font-mono text-xs text-ink-mid">
                  {viewUrl}
                </p>
              </div>
            )}
            <p className="text-xs leading-relaxed text-ink-faint">
              a link is secret material — the key to the room lives in its fragment; anyone who holds it can join while the room is open.
            </p>
          </>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" onClick={close}>
          close
        </Button>
        {!native && sharing === null && (
          <Button size="sm" variant="solid" onClick={() => void startCollab(tabId, access)}>
            start sharing
          </Button>
        )}
        {sharing !== null && (
          <Button size="sm" variant="outline" tone="rose" onClick={() => void stopCollab(tabId)}>
            stop sharing
          </Button>
        )}
      </footer>
    </Modal>
  );
}
