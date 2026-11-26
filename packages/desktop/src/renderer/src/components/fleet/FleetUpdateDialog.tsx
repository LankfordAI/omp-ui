import { useEffect, useState } from "react";
import type { FleetMachine, FleetOmpCheck, FleetUpdateAck, FleetUpdateCheck } from "@omp-ui/core/fleet";
import { FLEET_VERSION_PATTERN } from "@omp-ui/core/fleet";
import { backend, displayMessage } from "../../backend";
import { FIELD } from "../settings/rows";
import { Button, Chip, ConfirmDialog, Label } from "../ui";

/**
 * One version change this dialog asks a member to make. The dialog only
 * requests; the lifecycle confirmation slice (AppFeedback) owns running it —
 * nothing here calls the backend for `stage`/`apply`.
 */
export interface FleetUpdateConfirmRequest {
  machineKey: string;
  target: "omp" | "app";
  action: "stage" | "apply";
  /** null = newest release. */
  version: string | null;
  allowLiveSessions: boolean;
  machineNickname: string | null;
}

type SectionState<Target extends FleetUpdateCheck["target"]> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "refused"; reason: string }
  | { status: "check"; check: Extract<FleetUpdateCheck, { target: Target }> };

/**
 * Ask one member to bring itself up to date (issue #905, ADR-0066), launched
 * from a Fleet machine row beside the Provider key rollout. Mirrors
 * ProviderKeyRolloutDialog: this only asks — every action fires
 * `onRequestConfirmation` and closes, leaving the run to the lifecycle
 * confirmation gate. Checks ride `fleetUpdateMachine` directly because they
 * change nothing; refusals come back as inline answers, never toasts. The
 * member downloads from its own network through its own verified updater —
 * nothing ships across the join, and apply never restarts a member: it arms
 * install-at-next-quit only.
 */
export function FleetUpdateDialog({
  machine,
  onClose,
  onRequestConfirmation,
}: {
  machine: FleetMachine;
  onClose: () => void;
  onRequestConfirmation: (request: FleetUpdateConfirmRequest) => void;
}) {
  const [omp, setOmp] = useState<SectionState<"omp">>({ status: "loading" });
  const [app, setApp] = useState<SectionState<"app">>({ status: "loading" });
  const [ompVersion, setOmpVersion] = useState("");
  const [allowLiveSessions, setAllowLiveSessions] = useState(false);
  const target = machine.nickname ?? machine.key;

  useEffect(() => {
    let live = true;
    const ask = (target: "omp" | "app"): Promise<FleetUpdateAck> =>
      backend.fleetUpdateMachine(machine.key, {
        target,
        action: "check",
        version: null,
        allowLiveSessions: false,
      });
    // The two legs settle independently: an older member may answer one and
    // skew-refuse the other, and each section renders from its own answer.
    const ompAnswer = ask("omp").then(
      (ack): SectionState<"omp"> => {
        if (ack.status === "refused") return { status: "refused", reason: ack.reason };
        return "check" in ack && ack.check.target === "omp" ? { status: "check", check: ack.check } : { status: "loading" };
      },
      // An older member answers the proxied channel with the skew refusal.
      (err: unknown): SectionState<"omp"> => ({ status: "error", message: displayMessage(err) }),
    );
    const appAnswer = ask("app").then(
      (ack): SectionState<"app"> => {
        if (ack.status === "refused") return { status: "refused", reason: ack.reason };
        return "check" in ack && ack.check.target === "app" ? { status: "check", check: ack.check } : { status: "loading" };
      },
      (err: unknown): SectionState<"app"> => ({ status: "error", message: displayMessage(err) }),
    );
    void Promise.all([ompAnswer, appAnswer]).then(([ompCheck, appCheck]) => {
      if (!live) return;
      setOmp(ompCheck);
      setApp(appCheck);
    });
    return () => {
      live = false;
    };
  }, [machine.key]);

  const request = (req: Omit<FleetUpdateConfirmRequest, "machineKey" | "machineNickname">): void => {
    // Staging the gate closes this picker; the confirmation carries the
    // decision from here, exactly like the rollout dialog's Continue.
    onRequestConfirmation({ machineKey: machine.key, machineNickname: machine.nickname, ...req });
    onClose();
  };

  const typedVersion = ompVersion.trim();
  const typedExact = typedVersion !== "" && FLEET_VERSION_PATTERN.test(typedVersion);
  const ompReady = (check: FleetOmpCheck): boolean => check.updateAvailable || check.installedVersion === null || typedExact;

  const isContainer = machine.report?.packageFormat === "container" || (app.status === "check" && app.check.format === "container");
  const dash = "\u2014";
  return (
    <ConfirmDialog
      kicker="fleet"
      title={`Update versions on ${target}`}
      tone="copper"
      onClose={onClose}
      width="w-[30rem]"
      actions={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-faint">{`${target} updates itself from its own network through its own verified updaters; nothing ships from this computer.`}</p>

        {omp.status === "loading" && app.status === "loading" && (
          <p className="text-xs text-ink-faint">{`Asking ${target} what it runs…`}</p>
        )}

        {omp.status !== "loading" && (
          <section data-update-section="omp">
            <Label className="mb-1.5 block">omp binary</Label>
            {omp.status === "error" ? (
              <p className="text-xs text-rose">{omp.message}</p>
            ) : omp.status === "refused" ? (
              <p className="text-xs text-rose">{omp.reason}</p>
            ) : (
              <div className="space-y-1.5">
                <p className="font-mono text-xs tabular-nums text-ink">
                  {omp.check.installedVersion === null
                    ? "omp is not installed in the managed path"
                    : isContainer
                      ? omp.check.installedVersion
                      : `${omp.check.installedVersion} → ${omp.check.latestVersion ?? dash}`}
                </p>
                {omp.check.belowMinimum && <p className="text-xs text-rose">Below the minimum omp-ui requires on this machine.</p>}
                {isContainer ? (
                  <p className="text-xs text-ink-mid">
                    omp is baked into this container image. Pull a newer image tag and redeploy the container to update omp.
                  </p>
                ) : (
                  <>
                    {omp.check.pinned && <p className="text-xs text-copper">omp is pinned by OMP_UI_OMP_PATH here; clear the pin or install into the managed path first.</p>}
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        aria-label="Exact omp version"
                        className={`${FIELD} w-36`}
                        value={ompVersion}
                        spellCheck={false}
                        placeholder="exact version"
                        onChange={(event) => setOmpVersion(event.target.value)}
                      />
                      <Button
                        variant="solid"
                        tone="copper"
                        size="xs"
                        disabled={!ompReady(omp.check) || (typedVersion !== "" && !typedExact)}
                        onClick={() => request({ target: "omp", action: "stage", version: typedExact ? typedVersion : null, allowLiveSessions: false })}
                      >
                        Update omp
                      </Button>
                    </div>
                    <p className="text-xs text-ink-faint">
                      {typedVersion !== "" && !typedExact ? (
                        <span className="text-rose">A version must look like 18.13.1</span>
                      ) : (
                        "Leave blank for the newest release, or name an exact version."
                      )}
                    </p>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {app.status !== "loading" && (
          <section data-update-section="app">
            <Label className="mb-1.5 block">omp-ui app</Label>
            {app.status === "error" ? (
              <p className="text-xs text-rose">{app.message}</p>
            ) : app.status === "refused" ? (
              <p className="text-xs text-rose">{app.reason}</p>
            ) : (
              <div className="space-y-1.5">
                <p className="font-mono text-xs tabular-nums text-ink">
                  {app.check.format === "container"
                    ? (app.check.currentVersion ?? dash)
                    : `${app.check.currentVersion ?? dash} → ${app.check.latestVersion ?? dash}`}
                  {app.check.format !== null && <Chip className="ml-2">{app.check.format}</Chip>}
                </p>
                {app.check.format === "container" ? (
                  <p className="text-xs text-ink-mid">
                    This member runs in an immutable container image. Pull a newer image tag and redeploy the container to update omp-ui.
                  </p>
                ) : app.check.staged ? (
                  <>
                    <p className="text-xs text-ink-mid">
                      {app.check.installOnQuit ? "The staged update will install at the next quit." : "An update is staged and waits for this machine's next quit."}
                    </p>
                    {app.check.liveSessions > 0 && (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-mid">
                        <input
                          type="checkbox"
                          checked={allowLiveSessions}
                          onChange={(event) => setAllowLiveSessions(event.target.checked)}
                          className="size-3.5 accent-current"
                        />
                        {app.check.liveSessions === 1 ? "1 live session runs there; arm the install anyway." : `${app.check.liveSessions} live session(s) run there; arm the install anyway.`}
                      </label>
                    )}
                    <Button
                      variant="solid"
                      tone="copper"
                      size="xs"
                      onClick={() => request({ target: "app", action: "apply", version: null, allowLiveSessions })}
                    >
                      Install at next quit
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="solid"
                    tone="copper"
                    size="xs"
                    onClick={() => request({ target: "app", action: "stage", version: null, allowLiveSessions: false })}
                  >
                    Stage update
                  </Button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </ConfirmDialog>
  );
}
