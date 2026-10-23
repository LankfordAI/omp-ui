import { useEffect, useState, type JSX } from "react";
import { LOCAL_MACHINE_KEY } from "@omp-ui/core/fleet";
import { useT, type MessageKey } from "../lib/i18n";
import type { LifecycleConfirmation } from "../store";
import { useStore } from "../store";
import { Button, ConfirmDialog, type Tone } from "./ui";

/**
 * The app's one feedback host (issue #373): pending session/project
 * confirmations and backend error notices render as DOM alertdialogs through
 * the shared overlay stack — drivable by keyboard and automation alike, never
 * a renderer-blocking native modal.
 *
 * Only one dialog ever shows: the oldest error notice outranks a pending
 * confirmation without dropping that decision, and dismissing the last notice
 * restores the confirmation. State here is data-only (store/types.ts) — the
 * effects live in the lifecycle slice, keyed by confirmation id.
 */

const MODE_LABEL: Record<"pty" | "rpc-ui", MessageKey> = {
  pty: "dialog.lifecycle.terminal",
  "rpc-ui": "dialog.lifecycle.native",
};

/** A fleet machine's display name across the three version-update gates:
 *  nickname, else raw key — "This computer" for the local arm (the same rule
 *  ProviderKeyRolloutDialog applies). */
function fleetMachineLabel(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  machineKey: string,
  nickname: string | null,
): string {
  return machineKey === LOCAL_MACHINE_KEY ? t("fleet.machine.thisComputer") : nickname ?? machineKey;
}

/** Whether a member joins over HTTPS — the rollout gate's transport rule
 *  (#905) reused by the version-update gates: a plain-http join URL must be
 *  named as unencrypted in the body. */
function fleetJoinEncrypted(machineKey: string): boolean {
  return (
    useStore.getState().state?.remoteInstances.find((i) => i.id === machineKey)?.url ?? ""
  ).startsWith("https:");
}

/** Copy and tone per confirmation discriminant; copper action, rose removal. */
function lifecycleCopy(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  confirmation: LifecycleConfirmation,
): {
  tone: Tone;
  title: string;
  body: string;
  action: string;
  target: string | null;
} {
  switch (confirmation.kind) {
    case "terminate":
      return {
        tone: "copper",
        title: t("dialog.lifecycle.terminateTitle"),
        body: t("dialog.lifecycle.terminateBody"),
        action: t("dialog.lifecycle.terminateAction"),
        target: confirmation.title,
      };
    case "switch-mode":
      return {
        tone: "copper",
        title: t("dialog.lifecycle.switchTitle"),
        body: t("dialog.lifecycle.switchBody", {
          mode: t(MODE_LABEL[confirmation.mode]),
        }),
        action: t("dialog.lifecycle.switchAction"),
        target: confirmation.title,
      };
    case "remove-project":
      return {
        tone: "rose",
        title: t("dialog.lifecycle.removeTitle"),
        // The interpolated path is verbatim; the dialog body wraps it.
        body: t("dialog.lifecycle.removeBody", { path: confirmation.projectPath }),
        action: t("dialog.lifecycle.removeAction"),
        // The full path is in the body; no separate title line.
        target: null,
      };
    case "remove-remote-instance":
      return {
        tone: "rose",
        title: t("remoteinstances.action.remove"),
        body: t("remoteinstances.confirm.remove", { nickname: confirmation.nickname }),
        action: t("remoteinstances.action.remove"),
        target: null,
      };
    case "rewind":
      // The count and the "still in the file" note in the body are the whole
      // story (issue #680): no session title — the tab is the target.
      return {
        tone: "copper",
        title: t("dialog.lifecycle.rewindTitle"),
        body: t("dialog.lifecycle.rewindBody", { count: confirmation.laterTurns }),
        action: t("dialog.lifecycle.rewindAction"),
        target: null,
      };
    case "fork":
      // The tab is the subject, like rewind (issue #717): no target line.
      return {
        tone: "copper",
        title: t("dialog.lifecycle.forkTitle"),
        body: t("dialog.lifecycle.forkBody", { count: confirmation.laterTurns }),
        action: t("dialog.lifecycle.forkAction"),
        target: null,
      };
    case "navigate":
      return {
        tone: "copper",
        title: t("dialog.lifecycle.navigateTitle"),
        body: t("dialog.lifecycle.navigateBody", { count: confirmation.laterTurns }),
        action: t("dialog.lifecycle.navigateAction"),
        target: null,
      };
    case "carry-auth":
      // The credential gate (#888): says exactly what moves and that the
      // bundle is plaintext on the far side. save-file imports/exports a
      // user-named file; the two instance arms name the peer.
      return {
        tone: "rose",
        title: t("dialog.lifecycle.carry-auth.title"),
        body: t("dialog.lifecycle.carry-auth.body", { target: confirmation.targetLabel }),
        action: t("dialog.lifecycle.carry-auth.action"),
        target: null,
      };
    case "rollout-keys":
      // The Provider key rollout gate (#905): the count, the member, and
      // whether the join transport is encrypted.
      return {
        tone: "rose",
        title: t("dialog.lifecycle.rollout-keys.title"),
        body: t(
          confirmation.envNames.length === 1
            ? confirmation.encrypted
              ? "dialog.lifecycle.rollout-keys.body.one"
              : "dialog.lifecycle.rollout-keys.bodyPlain.one"
            : confirmation.encrypted
              ? "dialog.lifecycle.rollout-keys.body"
              : "dialog.lifecycle.rollout-keys.bodyPlain",
          { count: confirmation.envNames.length, target: confirmation.targetLabel },
        ),
        action: t("dialog.lifecycle.rollout-keys.action"),
        target: null,
      };
    case "fleet-update-omp": {
      // The omp-binary arm of the Fleet remote version update: names the member
      // and the version hop (null target = latest). Live sessions on the member
      // keep the binary they started with; transport spelled out like rollout's,
      // with no transport sentence for the local arm.
      const local = confirmation.machineKey === LOCAL_MACHINE_KEY;
      return {
        tone: "copper",
        title: t("fleet.update.omp.title"),
        body: t(
          local
            ? "fleet.update.omp.bodyLocal"
            : fleetJoinEncrypted(confirmation.machineKey)
              ? "fleet.update.omp.body"
              : "fleet.update.omp.bodyPlain",
          {
            target: fleetMachineLabel(t, confirmation.machineKey, confirmation.machineNickname),
            from: confirmation.currentVersion ?? t("fleet.update.unknownVersion"),
            to: confirmation.targetVersion ?? t("fleet.update.latest"),
          },
        ),
        action: t("fleet.update.omp.action"),
        target: null,
      };
    }
    case "fleet-stage-app": {
      // Staging downloads the package; nothing installs until the apply arm.
      const local = confirmation.machineKey === LOCAL_MACHINE_KEY;
      return {
        tone: "copper",
        title: t("fleet.update.stage.title"),
        body: t(
          local
            ? "fleet.update.stage.bodyLocal"
            : fleetJoinEncrypted(confirmation.machineKey)
              ? "fleet.update.stage.body"
              : "fleet.update.stage.bodyPlain",
          {
            target: fleetMachineLabel(t, confirmation.machineKey, confirmation.machineNickname),
            version: confirmation.version ?? t("fleet.update.latest"),
          },
        ),
        action: t("fleet.update.stage.action"),
        target: null,
      };
    }
    case "fleet-apply-app": {
      // The arm-on-quit gate: nothing restarts from a fleet request. With live
      // sessions the body names the count and where they run — accepting IS the
      // "Install when I quit" choice. {target} is the lowercase label so
      // "this computer" reads naturally mid-sentence in both arms.
      return {
        tone: "copper",
        title: t("fleet.update.apply.title"),
        body: t(
          confirmation.liveSessions > 0 ? "fleet.update.apply.bodyLive" : "fleet.update.apply.body",
          {
            target:
              confirmation.machineKey === LOCAL_MACHINE_KEY
                ? t("fleet.update.thisMachine")
                : confirmation.machineNickname ?? confirmation.machineKey,
            count: confirmation.liveSessions,
          },
        ),
        action: t("fleet.update.apply.action"),
        target: null,
      };
    }
  }
}

export function AppFeedback(): JSX.Element | null {
  const t = useT();
  const errorNotices = useStore((s) => s.errorNotices);
  const dismissError = useStore((s) => s.dismissError);
  const infoNotices = useStore((s) => s.infoNotices);
  const dismissNotice = useStore((s) => s.dismissNotice);
  const confirmation = useStore((s) => s.lifecycleConfirmation);
  const confirmLifecycleAction = useStore((s) => s.confirmLifecycleAction);
  const cancelLifecycleAction = useStore((s) => s.cancelLifecycleAction);
  // Opt-out for the terminate confirmation (issue #925). The host component
  // stays mounted across confirmations — ConfirmDialog is keyed, this is not —
  // so the checkbox must be cleared explicitly whenever a new decision is
  // staged, including non-terminate kinds that never render the row.
  const [skipTerminate, setSkipTerminate] = useState(false);
  const setSkipTerminateConfirmation = useStore((s) => s.setSkipTerminateConfirmation);
  useEffect(() => {
    setSkipTerminate(false);
  }, [confirmation?.id]);

  const notice = errorNotices[0] ?? null;
  const infoNotice = infoNotices[0] ?? null;
  if (notice !== null) {
    // Keyed by id so each error lands as a fresh alertdialog: the overlay
    // hook re-traps and re-focuses instead of patching the old one in place.
    // There is no retry action — acknowledging is all an error demands here.
    return (
      <ConfirmDialog
        key={notice.id}
        kicker={t("dialog.error.kicker")}
        title={t("dialog.error.title")}
        tone="rose"
        onClose={() => dismissError(notice.id)}
        actions={
          <Button
            variant="solid"
            tone="rose"
            initialFocus
            onClick={() => dismissError(notice.id)}
          >
            {t("dialog.error.dismiss")}
          </Button>
        }
      >
        {/* The original backend text, verbatim and selectable — plain text,
            never HTML, with long messages wrapped instead of clipped. */}
        <p
          data-selectable
          className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim [overflow-wrap:anywhere] break-words"
        >
          {notice.message}
        </p>
      </ConfirmDialog>
    );
  }

  // Successes (#888) sit between errors and pending decisions: acknowledging
  // one restores whatever waited underneath. Same keyed fresh-dialog rule.
  if (infoNotice !== null) {
    return (
      <ConfirmDialog
        key={infoNotice.id}
        kicker={t("dialog.notice.kicker")}
        title={t("dialog.notice.title")}
        tone="copper"
        onClose={() => dismissNotice(infoNotice.id)}
        actions={
          <Button
            variant="solid"
            tone="copper"
            initialFocus
            onClick={() => dismissNotice(infoNotice.id)}
          >
            {t("dialog.error.dismiss")}
          </Button>
        }
      >
        <p
          data-selectable
          className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim [overflow-wrap:anywhere] break-words"
        >
          {infoNotice.message}
        </p>
      </ConfirmDialog>
    );
  }

  if (confirmation === null) return null;
  const copy = lifecycleCopy(t, confirmation);
  const busy = confirmation.busy;
  return (
    <ConfirmDialog
      key={confirmation.id}
      kicker={t("dialog.lifecycle.kicker")}
      title={copy.title}
      tone={copy.tone}
      // While the accepted effect is in flight the dialog cannot be dismissed:
      // close, backdrop, and Escape all reach a no-op, and Cancel is disabled.
      // (Cancellation of an already-dispatched backend command is deliberately
      // not offered.) The store re-checks the target on acceptance.
      onClose={busy ? () => {} : () => cancelLifecycleAction(confirmation.id)}
      actions={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            initialFocus
            onClick={() => cancelLifecycleAction(confirmation.id)}
          >
            {t("common.dialog.cancel")}
          </Button>
          <Button
            variant="solid"
            tone={copy.tone}
            disabled={busy}
            onClick={() => {
              // Persist before dispatching so a concurrent stop cannot slip
              // past an unsaved setting; a failed persist still proceeds.
              if (skipTerminate && confirmation.kind === "terminate") {
                void setSkipTerminateConfirmation(true);
              }
              void confirmLifecycleAction(confirmation.id);
            }}
          >
            {busy ? t("dialog.lifecycle.working") : copy.action}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {copy.target !== null && (
          <p className="truncate font-display text-sm font-medium text-ink">
            {copy.target}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim [overflow-wrap:anywhere] break-words">
          {copy.body}
        </p>
        {confirmation.kind === "terminate" && !busy && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink">
            <input
              type="checkbox"
              checked={skipTerminate}
              onChange={(event) => setSkipTerminate(event.target.checked)}
              className="size-3.5 accent-current"
            />
            {t("dialog.lifecycle.dontShowAgain")}
          </label>
        )}
      </div>
    </ConfirmDialog>
  );
}
