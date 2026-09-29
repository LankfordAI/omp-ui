import { useEffect, useId, useState } from "react";
import type { CollabAccess } from "@omp-ui/core/collab";
import { useStore } from "../store";
import { Button, Chip, ChoiceCapsule, CopyButton, Label, Modal } from "./ui";
import { PairingQr } from "./PairingQr";
import { useT } from "../lib/i18n";

/**
 * The Share-live dialog (issue #686): omp hosts the room from inside the
 * tab's TUI; this surface reads the registry mirror and carries the two
 * generation-bound links (control and view-only). omp-ui never holds a room
 * key — the link's fragment is the key, so a link is secret material: this
 * component never logs it and uploads nothing, and links live only as long
 * as the dialog is open.
 */
export function ShareLiveDialog({ tabId }: { tabId: string }) {
  const t = useT();
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
    void collabLink(tabId, false).then(
      (url) => live && setControlUrl(url),
      () => {},
    );
    // A view-only host has no separate control link to hide behind: its
    // single link already is the read-only one.
    if (status === "full") {
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
        <h2 id={titleId} className="font-display text-lg font-semibold tracking-tight text-ink">
          {t("collab.dialog.title")}
        </h2>
        <p className="mt-0.5 text-xs text-ink-dim">
          {native
            ? t("collab.dialog.unavailable")
            : sharing === null
              ? t("collab.dialog.introOff")
              : t("collab.dialog.introOn")}
        </p>
      </div>

      <div className="space-y-3 px-5 py-4">
        {native ? null : sharing === null ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <Label>{t("collab.dialog.access")}</Label>
              <ChoiceCapsule
                label={t("collab.dialog.access")}
                value={access}
                options={[
                  { value: "full", label: t("collab.access.full") },
                  { value: "view", label: t("collab.access.view") },
                ]}
                onChange={setAccess}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-ink-faint">{t("collab.dialog.hint")}</p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-mid">
              <Chip tone={sharing.status === "full" ? "signal" : "copper"}>
                {sharing.status === "full" ? t("collab.access.full") : t("collab.access.view")}
              </Chip>
              <Chip mono>
                {t("collab.dialog.participants", { count: sharing.participants })}
              </Chip>
              {!sharing.relayConnected && (
                <Chip tone="rose">{t("collab.dialog.relayDown")}</Chip>
              )}
              {sharing.inputRequired && (
                <Chip tone="copper">{t("collab.dialog.inputRequired")}</Chip>
              )}
            </div>
            {controlUrl !== null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{t("collab.dialog.controlLink")}</Label>
                  <CopyButton
                    text={controlUrl}
                    label={t("collab.dialog.copy")}
                    doneLabel={t("collab.dialog.copied")}
                  />
                </div>
                <p data-selectable className="truncate font-mono text-[11px] text-ink-mid">
                  {controlUrl}
                </p>
                <PairingQr url={controlUrl} title={t("collab.dialog.scan")} caption={t("collab.dialog.controlCaption")} />
              </div>
            )}
            {viewUrl !== null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{t("collab.dialog.viewLink")}</Label>
                  <CopyButton
                    text={viewUrl}
                    label={t("collab.dialog.copy")}
                    doneLabel={t("collab.dialog.copied")}
                  />
                </div>
                <p data-selectable className="truncate font-mono text-[11px] text-ink-mid">
                  {viewUrl}
                </p>
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-ink-faint">
              {t("collab.dialog.linkWarning")}
            </p>
          </>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" onClick={close}>
          {t("collab.dialog.close")}
        </Button>
        {!native && sharing === null && (
          <Button size="sm" variant="solid" onClick={() => void startCollab(tabId, access)}>
            {t("collab.dialog.start")}
          </Button>
        )}
        {sharing !== null && (
          <Button size="sm" variant="outline" tone="rose" onClick={() => void stopCollab(tabId)}>
            {t("collab.dialog.stop")}
          </Button>
        )}
      </footer>
    </Modal>
  );
}
