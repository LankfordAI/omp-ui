import { useEffect, useState, type ReactNode } from "react";
import type { FleetMachine } from "@omp-ui/core/fleet";
import type { ProviderKeySource, ProviderKeysSnapshot, ProviderKeyStatus } from "@omp-ui/core/types";
import { displayMessage } from "../../backend";
import { useT, type MessageKey } from "../../lib/i18n";
import { useStore } from "../../store";
import { Button, Chip, ConfirmDialog, type Tone } from "../ui";

type KeysLoad =
  | { status: "loading" }
  | { status: "loaded"; snapshot: ProviderKeysSnapshot }
  | { status: "error"; message: string };

interface SourceFace {
  tone: Tone;
  labelKey: MessageKey;
}

/**
 * The sources omp-ui itself injects, so main can read the value back, and
 * their chip; null leaves the row out (project .env is omp's own read).
 */
const ROLLOUT_SOURCE_FACE: Record<ProviderKeySource, SourceFace | null> = {
  stored: { tone: "signal", labelKey: "settings.providers.savedHere" },
  environment: { tone: "neutral", labelKey: "settings.providers.environment" },
  "login-shell": { tone: "iris", labelKey: "settings.providers.shellProfile" },
  dotenv: null,
  none: null,
};

/**
 * Choose keys for a Provider key rollout (issue #905), launched from a Fleet
 * machine row. Like the credential carry picker (settings/CarryAuthDialog),
 * this only picks: Continue stages a lifecycle confirmation, the mandatory
 * gate that names the count, the member, and whether the join is encrypted.
 * Only env names leave this dialog; main reads the values at confirm time and
 * sends them main-to-main, so no key value ever reaches a renderer.
 */
export function ProviderKeyRolloutDialog({ machine, onClose }: { machine: FleetMachine; onClose: () => void }) {
  const t = useT();
  const stageLifecycleConfirmation = useStore((s) => s.stageLifecycleConfirmation);
  const [load, setLoad] = useState<KeysLoad>({ status: "loading" });
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  const target = machine.nickname ?? machine.key;

  useEffect(() => {
    let live = true;
    useStore
      .getState()
      .readProviderKeys(null)
      .then(
        (snapshot) => {
          if (live) setLoad({ status: "loaded", snapshot });
        },
        (err: unknown) => {
          if (live) setLoad({ status: "error", message: displayMessage(err) });
        },
      );
    return () => {
      live = false;
    };
  }, []);

  // One row per variable: alternates can make two providers resolve to the same activeEnv.
  const rows: Array<{ row: ProviderKeyStatus; face: SourceFace }> = [];
  if (load.status === "loaded") {
    const seen = new Set<string>();
    for (const row of load.snapshot.providers) {
      const face = ROLLOUT_SOURCE_FACE[row.source];
      if (face === null || seen.has(row.activeEnv)) continue;
      seen.add(row.activeEnv);
      rows.push({ row, face });
    }
  }
  const envNames = rows.map(({ row }) => row.activeEnv).filter((env) => !unchecked.has(env));

  const toggle = (env: string, checked: boolean): void => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(env);
      else next.add(env);
      return next;
    });
  };

  const submit = (): void => {
    if (envNames.length === 0) return;
    const encrypted = (
      useStore.getState().state?.remoteInstances.find((i) => i.id === machine.key)?.url ?? ""
    ).startsWith("https:");
    // Staging the gate closes this picker; the confirmation dialog carries
    // the decision from here.
    onClose();
    stageLifecycleConfirmation({
      kind: "rollout-keys",
      instanceId: machine.key,
      targetLabel: target,
      envNames,
      encrypted,
    });
  };

  let body: ReactNode;
  if (load.status === "loading") {
    body = <p className="text-xs text-ink-faint">{t("fleet.rollout.loading")}</p>;
  } else if (load.status === "error") {
    body = <p className="text-xs text-rose">{load.message}</p>;
  } else if (rows.length === 0) {
    body = <p className="text-xs text-ink-faint">{t("fleet.rollout.none")}</p>;
  } else {
    body = (
      <ul className="space-y-1.5">
        {rows.map(({ row, face }) => (
          <li key={row.activeEnv}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink">
              <input
                type="checkbox"
                checked={!unchecked.has(row.activeEnv)}
                onChange={(event) => toggle(row.activeEnv, event.target.checked)}
                className="size-3.5 accent-current"
                data-env={row.activeEnv}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{row.label}</span>
                <span className="block truncate font-mono text-[10px] text-ink-faint">
                  {row.activeEnv}
                  {row.masked !== null && <span className="ml-2 text-ink-dim">{row.masked}</span>}
                </span>
              </span>
              <Chip tone={face.tone}>{t(face.labelKey)}</Chip>
            </label>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ConfirmDialog
      kicker={t("fleet.header.title")}
      title={t("fleet.rollout.title", { target })}
      tone="copper"
      onClose={onClose}
      width="w-[30rem]"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dialog.migrate.cancel")}
          </Button>
          <Button variant="solid" tone="copper" initialFocus disabled={envNames.length === 0} onClick={submit}>
            {t("fleet.rollout.continue")}
          </Button>
        </>
      }
    >
      {body}
    </ConfirmDialog>
  );
}
