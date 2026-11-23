import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { findOwner } from "../store/slices/view";
import { Button, ChoiceCapsule, ConfirmDialog } from "./ui";
import { DirectoryPicker } from "./DirectoryPicker";

/**
 * Carries one dormant session's transcript to another machine — or into a new
 * directory on this one (issue #888). The heavy lifting is omp's own
 * pack/unpack pair plus the store slice's chunk relay; this dialog only picks
 * the target: an instance from the joined roster (or "this machine") and a
 * directory on that host via the shared DirectoryPicker, which already browses
 * remote hosts through `dir:browse`. Dismissal is locked mid-flight because
 * abandoning the relay would strand a staged bundle until the idle sweep.
 */
export function MigrateSessionDialog({
  tabId,
}: {
  tabId: string;
}) {
  const state = useStore((s) => s.state);
  const closeMigrateDialog = useStore((s) => s.closeMigrateDialog);
  const migrateSession = useStore((s) => s.migrateSession);
  const phase = useStore((s) => s.migrating[tabId]);
  const percent = useStore((s) => s.migrationProgress[tabId] ?? 0);

  const joined = useMemo(
    () => (state?.remoteInstances ?? []).filter((i) => i.status === "joined"),
    [state],
  );
  const [targetInstanceId, setTargetInstanceId] = useState<string | null>(null);
  const record = findOwner(state, tabId)?.record;
  // Default the directory to the session's own project — the common case is
  // the same path existing on the target machine.
  const [directory, setDirectory] = useState<string | null>(record?.projectCwd ?? null);
  const [picking, setPicking] = useState(false);
  /** True once Migrate is clicked: the dialog rides out the relay and retires
   *  itself when the slice clears `migrating[tabId]` — success or failure
   *  (failures arrive as the app-global error dialog, which outranks this
   *  one anyway). */
  const [started, setStarted] = useState(false);

  const busy = phase !== undefined;
  useEffect(() => {
    if (started && phase === undefined) closeMigrateDialog();
  }, [started, phase, closeMigrateDialog]);
  const close = (): void => {
    if (busy) return;
    closeMigrateDialog();
  };
  const submit = async (): Promise<void> => {
    if (busy || directory === null) return;
    // The slice owns progress state and reports success/failure through the
    // notice surfaces.
    setStarted(true);
    void migrateSession(tabId, targetInstanceId, directory);
  };

  if (picking) {
    return (
      <DirectoryPicker
        mode="project"
        instanceId={targetInstanceId}
        banner={null}
        onClose={() => setPicking(false)}
        onSubmit={async (path) => {
          setDirectory(path);
          setPicking(false);
        }}
      />
    );
  }

  return (
    <ConfirmDialog
      kicker="Carry session"
      title={`Migrate “${record?.cachedTitle ?? tabId}”`}
      tone="copper"
      onClose={close}
      width="w-[30rem]"
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="copper"
            initialFocus
            disabled={busy || directory === null}
            onClick={() => void submit()}
          >
            {busy ? `Transferring ${percent}%` : "Migrate"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-xs text-ink-dim">Send to</p>
          {joined.length === 0 && (
            <p className="mt-1.5 text-xs text-ink-faint">No joined instances — join one on the Remote settings page, or pick a directory here on this machine.</p>
          )}
          {/* "" is the local-target sentinel: ChoiceCapsule values are
              strings, and no instance id is ever empty. */}
          <div className="mt-1.5">
            <ChoiceCapsule
              label="Send to"
              value={targetInstanceId ?? ""}
              options={[
                { value: "", label: "This machine" },
                ...joined.map((instance) => ({ value: instance.id, label: instance.nickname })),
              ]}
              onChange={(value) => setTargetInstanceId(value === "" ? null : String(value))}
            />
          </div>
        </div>
        <div>
          <p className="text-xs text-ink-dim">Project directory on the target</p>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              data-selectable
              className="min-w-0 flex-1 truncate rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink"
            >
              {directory ?? "No directory chosen"}
            </span>
            <Button variant="ghost" disabled={busy} onClick={() => setPicking(true)}>
              Browse…
            </Button>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-ink-faint">omp packs the transcript (with its images and artifacts) and unpacks it on the target at that directory. The session must be stopped. To another machine the source copy stays put and is marked as moved; on this machine omp consolidates the duplicate copies into the new location.</p>
      </div>
    </ConfirmDialog>
  );
}
