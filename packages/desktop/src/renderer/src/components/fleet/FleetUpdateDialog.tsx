import { useEffect, useState } from "react";
import type { FleetMachine, FleetOmpCheck, FleetUpdateAck, FleetUpdateCheck } from "@omp-ui/core/fleet";
import { FLEET_VERSION_PATTERN } from "@omp-ui/core/fleet";
import { backend, displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
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
  const t = useT();
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

  const dash = "\u2014";
  return (
    <ConfirmDialog
      kicker={t("fleet.header.title")}
      title={t("fleet.update.title", { target })}
      tone="copper"
      onClose={onClose}
      width="w-[30rem]"
      actions={
        <Button variant="ghost" onClick={onClose}>
          {t("dialog.migrate.cancel")}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-faint">{t("fleet.update.intro", { target })}</p>

        {omp.status === "loading" && app.status === "loading" && (
          <p className="text-xs text-ink-faint">{t("fleet.update.loading", { target })}</p>
        )}

        {omp.status !== "loading" && (
          <section data-update-section="omp">
            <Label className="mb-1.5 block">{t("fleet.update.section.omp")}</Label>
            {omp.status === "error" ? (
              <p className="text-xs text-rose">{omp.message}</p>
            ) : omp.status === "refused" ? (
              <p className="text-xs text-rose">{omp.reason}</p>
            ) : (
              <div className="space-y-1.5">
                <p className="font-mono text-xs tabular-nums text-ink">
                  {omp.check.installedVersion === null
                    ? t("fleet.update.ompMissing")
                    : t("fleet.update.line", {
                        current: omp.check.installedVersion,
                        latest: omp.check.latestVersion ?? dash,
                      })}
                </p>
                {omp.check.belowMinimum && <p className="text-xs text-rose">{t("fleet.update.belowMinimum")}</p>}
                {omp.check.pinned && <p className="text-xs text-copper">{t("fleet.update.pinned")}</p>}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    aria-label={t("fleet.update.versionLabel")}
                    className={`${FIELD} w-36`}
                    value={ompVersion}
                    spellCheck={false}
                    placeholder={t("fleet.update.versionPlaceholder")}
                    onChange={(event) => setOmpVersion(event.target.value)}
                  />
                  <Button
                    variant="solid"
                    tone="copper"
                    size="xs"
                    disabled={!ompReady(omp.check) || (typedVersion !== "" && !typedExact)}
                    onClick={() => request({ target: "omp", action: "stage", version: typedExact ? typedVersion : null, allowLiveSessions: false })}
                  >
                    {t("fleet.update.ompUpdate")}
                  </Button>
                </div>
                <p className="text-[10px] text-ink-faint">
                  {typedVersion !== "" && !typedExact ? (
                    <span className="text-rose">{t("fleet.update.invalidVersion")}</span>
                  ) : (
                    t("fleet.update.versionHint")
                  )}
                </p>
              </div>
            )}
          </section>
        )}

        {app.status !== "loading" && (
          <section data-update-section="app">
            <Label className="mb-1.5 block">{t("fleet.update.section.app")}</Label>
            {app.status === "error" ? (
              <p className="text-xs text-rose">{app.message}</p>
            ) : app.status === "refused" ? (
              <p className="text-xs text-rose">{app.reason}</p>
            ) : (
              <div className="space-y-1.5">
                <p className="font-mono text-xs tabular-nums text-ink">
                  {t("fleet.update.line", { current: app.check.currentVersion ?? dash, latest: app.check.latestVersion ?? dash })}
                  {app.check.format !== null && <Chip className="ml-2">{app.check.format}</Chip>}
                </p>
                {app.check.staged ? (
                  <>
                    <p className="text-xs text-ink-mid">
                      {app.check.installOnQuit ? t("fleet.update.armed") : t("fleet.update.staged")}
                    </p>
                    {app.check.liveSessions > 0 && (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-mid">
                        <input
                          type="checkbox"
                          checked={allowLiveSessions}
                          onChange={(event) => setAllowLiveSessions(event.target.checked)}
                          className="size-3.5 accent-current"
                        />
                        {t(
                          app.check.liveSessions === 1
                            ? "fleet.update.allowLiveSessions.one"
                            : "fleet.update.allowLiveSessions",
                          { count: app.check.liveSessions },
                        )}
                      </label>
                    )}
                    <Button
                      variant="solid"
                      tone="copper"
                      size="xs"
                      onClick={() => request({ target: "app", action: "apply", version: null, allowLiveSessions })}
                    >
                      {t("fleet.update.apply")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="solid"
                    tone="copper"
                    size="xs"
                    onClick={() => request({ target: "app", action: "stage", version: null, allowLiveSessions: false })}
                  >
                    {t("fleet.update.stageApp")}
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
