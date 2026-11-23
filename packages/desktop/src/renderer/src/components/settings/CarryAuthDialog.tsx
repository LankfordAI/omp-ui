import { useState } from "react";
import { backend } from "../../backend";
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
      stage({ kind: "carry-auth", action, targetLabel: "a file you choose" });
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
      kicker="Carry sign-ins"
      title="Move credentials between machines"
      tone="copper"
      onClose={onClose}
      width="w-[30rem]"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="copper"
            initialFocus
            disabled={needsPeer || pickingFile}
            onClick={() => void submit()}
          >
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-sm text-ink-dim">Route</p>
          <ChoiceCapsule
            label="Route"
            value={action}
            options={[
              { value: "to-instance", label: "This machine → instance" },
              { value: "from-instance", label: "Instance → this machine" },
              { value: "save-file", label: "Save to file…" },
              { value: "import-file", label: "Import from file…" },
            ]}
            onChange={(value) => setAction(value as CarryAction)}
            optionClassName="tab-label px-2"
          />
        </div>
        {(action === "to-instance" || action === "from-instance") && (
          <div>
            {joined.length === 0 ? (
              <p className="text-xs text-ink-faint">No joined instances — join one on the Remote settings page, or pick a directory here on this machine.</p>
            ) : (
              <ChoiceCapsule
                label="Instance"
                value={instanceId ?? joined[0]!.id}
                options={joined.map((instance) => ({ value: instance.id, label: instance.nickname }))}
                onChange={(value) => setInstanceId(String(value))}
                optionClassName="tab-label px-2"
              />
            )}
          </div>
        )}
        <p className="text-sm leading-relaxed text-ink-faint">
          {action === "save-file" || action === "import-file"
            ? "The bundle is a plaintext JSON file holding every API key and login token. Treat the file like a password: delete it once both machines are set up."
            : "Credentials ride the encrypted instance link and merge into the target's store — nothing is removed here."}
        </p>
      </div>
    </ConfirmDialog>
  );
}
