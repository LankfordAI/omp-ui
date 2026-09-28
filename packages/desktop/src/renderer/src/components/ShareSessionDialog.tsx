import { useEffect, useId, useState } from "react";
import { backend } from "../backend";
import { useT } from "../lib/i18n";
import { findRecord, sessionCwd, useStore } from "../store";
import { Button, Modal } from "./ui";

/**
 * The first-share privacy dialog (issue #679): what omp's /share guarantees,
 * plus the effective `share.*` values for this session's working tree. One
 * confirm per install; the flag lives in lib/share-privacy.ts. A shared link
 * is secret material — this component never logs the URL and uploads nothing:
 * confirming only unblocks the slash-command forward.
 */
export function ShareSessionDialog({ tabId }: { tabId: string }) {
  const t = useT();
  const titleId = useId();
  const confirm = useStore((s) => s.confirmSharePrivacy);
  const cancel = useStore((s) => s.cancelSharePrivacy);
  const [targets, setTargets] = useState<{
    store: string | null;
    serverUrl: string | null;
    redact: boolean | null;
  }>({ store: null, serverUrl: null, redact: null });

  // Effective values ride the settings layers omp resolves for THIS session's
  // working tree, same read the omp settings page uses. Remote sessions read
  // nothing local (SubagentModelsControl's routing) and show the static
  // wording instead.
  useEffect(() => {
    const rec = findRecord(useStore.getState().state, tabId);
    const cwd = sessionCwd(rec);
    const instanceId =
      useStore.getState().tabs.find((tab) => tab.tabId === tabId)?.instanceId ?? null;
    if (cwd === undefined || instanceId !== null) return;
    let live = true;
    void backend.readOmpSettings(cwd).then(
      (snap) => {
        if (!live || snap.error !== null) return;
        const value = (key: string): unknown =>
          snap.entries.find((e) => e.key === key)?.value;
        setTargets({
          store: typeof value("share.store") === "string" ? (value("share.store") as string) : null,
          serverUrl:
            typeof value("share.serverUrl") === "string"
              ? (value("share.serverUrl") as string)
              : null,
          redact:
            typeof value("share.redactSecrets") === "boolean"
              ? (value("share.redactSecrets") as boolean)
              : null,
        });
      },
      () => {
        // IPC hop failed: the static wording stands.
      },
    );
    return () => {
      live = false;
    };
  }, [tabId]);

  const redactLine =
    targets.redact === true
      ? t("dialog.share.redactOn")
      : targets.redact === false
        ? t("dialog.share.redactOff")
        : t("dialog.share.redactDefault");
  const targetLine =
    targets.store === "gist"
      ? t("dialog.share.targetGist")
      : targets.store === "blob" && targets.serverUrl !== null
        ? t("dialog.share.targetServer", { url: targets.serverUrl })
        : t("dialog.share.targetDefault");

  return (
    <Modal onClose={cancel} labelledBy={titleId} width="w-[32rem]">
      <div className="border-b border-line px-5 pb-4 pt-5">
        <h2 id={titleId} className="font-display text-lg font-semibold tracking-tight text-ink">
          {t("dialog.share.title")}
        </h2>
        <p className="mt-0.5 text-xs text-ink-dim">{t("dialog.share.intro")}</p>
      </div>
      <ul className="space-y-2.5 px-5 py-4 text-xs leading-relaxed text-ink-mid">
        <li className="flex gap-2">
          <span aria-hidden className="text-ink-faint">
            •
          </span>
          <span>{t("dialog.share.encryption")}</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-ink-faint">
            •
          </span>
          <span>{t("dialog.share.key")}</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-ink-faint">
            •
          </span>
          <span>{redactLine}</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-ink-faint">
            •
          </span>
          <span>{targetLine}</span>
        </li>
      </ul>
      <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" onClick={cancel}>
          {t("dialog.share.cancel")}
        </Button>
        <Button size="sm" variant="solid" onClick={() => void confirm(tabId)}>
          {t("dialog.share.confirm")}
        </Button>
      </footer>
    </Modal>
  );
}
