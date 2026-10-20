import { useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import type { LifecycleConfirmationChoice } from "../../store/types";
import { Button, ChoiceCapsule, ConfirmDialog } from "../ui";

type CarryAction = "to-instance" | "from-instance" | "save-file" | "import-file";

/**
 * The credential carry surface (issue #888): four routes for `omp auth
 * export`/`import`, launched from the Providers page footer. This dialog only
 * picks the route and its target — every route stages a lifecycle
 * confirmation first, because that dialog is the mandatory credential gate:
 * it spells out that the bundle is plaintext on disk, and nothing touches
 * disk until the user accepts it (ADR-0028). Bundle bytes never come near the
 * renderer: instance routes proxy main-to-main, file routes run their native
 * pickers in main.
 */
export function CarryAuthDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const state = useStore((s) => s.state);
  const stageLifecycleConfirmation = useStore((s) => s.stageLifecycleConfirmation);
  const joined = (state?.remoteInstances ?? []).filter((i) => i.status === "joined");
  const [action, setAction] = useState<CarryAction>("to-instance");
  const [instanceId, setInstanceId] = useState<string | null>(joined[0]?.id ?? null);
  const [pickingFile, setPickingFile] = useState(false);

  const peer = joined.find((i) => i.id === instanceId) ?? null;
  const needsPeer = (action === "to-instance" || action === "from-instance") && peer === null;
  const stage = (choice: LifecycleConfirmationChoice): void => {
    // Staging the gate closes this picker; the confirmation dialog carries
    // the decision from here.
    onClose();
    stageLifecycleConfirmation(choice);
  };

  const submit = async (): Promise<void> => {
    if (action === "save-file") {
      stage({ kind: "carry-auth", action, targetLabel: t("dialog.carryAuth.fileTarget") });
      return;
    }
    if (action === "import-file") {
      // Choosing the file is not importing it: the path dialog runs first so
      // the gate can name the exact file it is about to read. Cancel leaves
      // everything untouched.
      setPickingFile(true);
      try {
        const path = await backend.authPickBundleFile();
        if (path !== null) stage({ kind: "carry-auth", action, targetLabel: path });
      } finally {
        setPickingFile(false);
      }
      return;
    }
    if (peer === null) return;
    stage({ kind: "carry-auth", action, targetLabel: peer.nickname, instanceId: peer.id });
  };

  return (
    <ConfirmDialog
      kicker={t("dialog.carryAuth.kicker")}
      title={t("dialog.carryAuth.title")}
      tone="copper"
      onClose={onClose}
      width="w-[30rem]"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dialog.migrate.cancel")}
          </Button>
          <Button
            variant="solid"
            tone="copper"
            initialFocus
            disabled={needsPeer || pickingFile}
            onClick={() => void submit()}
          >
            {t("dialog.carryAuth.action")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-xs text-ink-dim">{t("dialog.carryAuth.routeLabel")}</p>
          <ChoiceCapsule
            label={t("dialog.carryAuth.routeLabel")}
            value={action}
            options={[
              { value: "to-instance", label: t("dialog.carryAuth.toInstance") },
              { value: "from-instance", label: t("dialog.carryAuth.fromInstance") },
              { value: "save-file", label: t("dialog.carryAuth.saveFile") },
              { value: "import-file", label: t("dialog.carryAuth.importFile") },
            ]}
            onChange={(value) => setAction(value as CarryAction)}
          />
        </div>
        {(action === "to-instance" || action === "from-instance") && (
          <div>
            {joined.length === 0 ? (
              <p className="text-xs text-ink-faint">{t("dialog.migrate.emptyInstances")}</p>
            ) : (
              <ChoiceCapsule
                label={t("dialog.carryAuth.peerLabel")}
                value={instanceId ?? joined[0]!.id}
                options={joined.map((instance) => ({ value: instance.id, label: instance.nickname }))}
                onChange={(value) => setInstanceId(String(value))}
              />
            )}
          </div>
        )}
        <p className="text-xs leading-relaxed text-ink-faint">
          {action === "save-file" || action === "import-file"
            ? t("dialog.carryAuth.hintFile")
            : t("dialog.carryAuth.hintInstance")}
        </p>
      </div>
    </ConfirmDialog>
  );
}
