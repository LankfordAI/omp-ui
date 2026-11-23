import { useEffect, useState, type JSX } from "react";
import { LOCAL_MACHINE_KEY } from "@omp-ui/core/fleet";
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

const MODE_LABEL: Record<"pty" | "rpc-ui", string> = {
  pty: "terminal",
  "rpc-ui": "native",
};

/** A fleet machine's display name across the three version-update gates:
 *  nickname, else raw key — "This computer" for the local arm (the same rule
 *  ProviderKeyRolloutDialog applies). */
function fleetMachineLabel(
  machineKey: string,
  nickname: string | null,
): string {
  return machineKey === LOCAL_MACHINE_KEY ? "This computer" : nickname ?? machineKey;
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
  confirmation: LifecycleConfirmation,
): {
  tone: Tone;
  title: string;
  body: string;
  action: string;
  target: string | null;
} {
  switch (confirmation.kind) {
    case "settle-running": {
      // Settle mid-turn (#1005): only the running rows are listed.
      const n = confirmation.runningTitles.length;
      const action =
        confirmation.tabIds.length === 1
          ? "Settle"
          : `Settle ${confirmation.tabIds.length} sessions`;
      return n === 1
        ? {
            tone: "copper",
            title: "Interrupt the running turn?",
            body: "Settling stops the session's process now and interrupts the turn in progress. The session moves to Settled and stays resumable; Undo resumes it.",
            action,
            target: confirmation.runningTitles[0]!,
          }
        : {
            tone: "copper",
            title: `Interrupt ${n} running turns?`,
            body: `Settling stops these sessions' processes now and interrupts their turns in progress. Each moves to Settled and stays resumable; Undo resumes them.\n\n${confirmation.runningTitles.join("\n")}`,
            action,
            target: null,
          };
    }
    case "switch-mode":
      return {
        tone: "copper",
        title: "Switch session mode?",
        body: `Restart this session in ${MODE_LABEL[confirmation.mode]} mode? The process is killed and resumed.`,
        action: "Restart session",
        target: confirmation.title,
      };
    case "remove-project":
      return {
        tone: "rose",
        title: "Remove project?",
        // The interpolated path is verbatim; the dialog body wraps it.
        body: `Remove project ${confirmation.projectPath} and its session records? Files on disk are kept.`,
        action: "Remove project",
        // The full path is in the body; no separate title line.
        target: null,
      };
    case "remove-remote-instance":
      return {
        tone: "rose",
        title: "Remove",
        body: `Remove ${confirmation.nickname}? Its sessions keep running on that host; only this app forgets the connection.`,
        action: "Remove",
        target: null,
      };
    case "resume-forked-source":
      // CONTEXT.md **Fork**: the default is the running fork (third button).
      return {
        tone: "copper",
        title: "Resume the original session?",
        body:
          confirmation.otherForks === 0
            ? `“${confirmation.title}” was forked into “${confirmation.forkTitle}”, which is running. Resuming the original starts a second session from the same history.`
            : `“${confirmation.title}” was forked into “${confirmation.forkTitle}” and ${confirmation.otherForks} other running sessions. Resuming the original starts another session from the same history.`,
        action: "Resume original",
        target: null,
      };
    case "rewind":
      // The count and the "still in the file" note in the body are the whole
      // story (issue #680): no session title — the tab is the target.
      return {
        tone: "copper",
        title: "Rewind to this prompt?",
        body: `Rewind the session to this prompt? ${confirmation.laterTurns} later turns stop being the current branch — they stay in the session file as another branch.`,
        action: "Rewind",
        target: null,
      };
    case "fork":
      // The tab is the subject, like rewind (issue #717): no target line.
      return {
        tone: "copper",
        title: "Fork from this prompt?",
        body: `Continue this tab in a new session cut at this prompt? The new file holds everything up to and including it — ${confirmation.laterTurns} later turns stop being this session's branch and stay in the original file, which remains on disk.`,
        action: "Fork",
        target: null,
      };
    case "navigate":
      return {
        tone: "copper",
        title: "Navigate the tree here?",
        body: `Move the session's leaf to this entry? ${confirmation.laterTurns} later turns stop being the current branch — they stay in the session file as another branch.`,
        action: "Navigate",
        target: null,
      };
    case "carry-auth":
      // The credential gate (#888): says exactly what moves and that the
      // bundle is plaintext on the far side. save-file imports/exports a
      // user-named file; the two instance arms name the peer.
      return {
        tone: "rose",
        title: "Carry credentials?",
        body: `This writes every stored API key and login token in plaintext — to ${confirmation.targetLabel}. Nothing is removed from this machine. Continue?`,
        action: "Carry sign-ins",
        target: null,
      };
    case "rollout-keys":
      // The Provider key rollout gate (#905): the count, the member, and
      // whether the join transport is encrypted.
      return {
        tone: "rose",
        title: "Roll out Provider keys?",
        body: confirmation.envNames.length === 1 ? confirmation.encrypted ? `This sends 1 Provider key from this computer to ${confirmation.targetLabel} over HTTPS, where it is stored in its OS credential store and replaces any stored value with the same name. Sessions already running there keep their old key until restarted. Continue?` : `This sends 1 Provider key from this computer to ${confirmation.targetLabel} over an unencrypted HTTP connection, where it is stored in its OS credential store and replaces any stored value with the same name. Sessions already running there keep their old key until restarted. Continue?` : confirmation.encrypted ? `This sends ${confirmation.envNames.length} Provider keys from this computer to ${confirmation.targetLabel} over HTTPS, where they are stored in its OS credential store and replace any stored value with the same name. Sessions already running there keep their old keys until restarted. Continue?` : `This sends ${confirmation.envNames.length} Provider keys from this computer to ${confirmation.targetLabel} over an unencrypted HTTP connection, where they are stored in its OS credential store and replace any stored value with the same name. Sessions already running there keep their old keys until restarted. Continue?`,
        action: "Roll out keys",
        target: null,
      };
    case "copy-project": {
      // The Project copy gate (#992): the project, the member, and — when
      // gitignored files ride along — their count and the join transport.
      const count = confirmation.files.length;
      const name = confirmation.projectName;
      const target = confirmation.targetLabel;
      return {
        tone: count === 0 ? "copper" : "rose",
        title: `Copy project to ${confirmation.targetLabel}?`,
        body:
          count === 0
            ? `${target} clones ${name} from its remote into one of its project roots and registers it. No files leave this computer. Continue?`
            : count === 1
              ? confirmation.encrypted
                ? `${target} clones ${name} from its remote into one of its project roots and registers it. Then this computer sends 1 gitignored file to it over HTTPS, written into the new checkout. Continue?`
                : `${target} clones ${name} from its remote into one of its project roots and registers it. Then this computer sends 1 gitignored file to it over an unencrypted HTTP connection, written into the new checkout. Continue?`
              : confirmation.encrypted
                ? `${target} clones ${name} from its remote into one of its project roots and registers it. Then this computer sends ${count} gitignored files to it over HTTPS, written into the new checkout. Continue?`
                : `${target} clones ${name} from its remote into one of its project roots and registers it. Then this computer sends ${count} gitignored files to it over an unencrypted HTTP connection, written into the new checkout. Continue?`,
        action: "Copy project",
        target: confirmation.projectCwd,
      };
    }
    case "fleet-update-omp": {
      // The omp-binary arm of the Fleet remote version update: names the member
      // and the version hop (null target = latest). Live sessions on the member
      // keep the binary they started with; transport spelled out like rollout's,
      // with no transport sentence for the local arm.
      const local = confirmation.machineKey === LOCAL_MACHINE_KEY;
      return {
        tone: "copper",
        title: "Update omp remotely?",
        body: local ? `This asks this computer to update its own omp binary from ${confirmation.currentVersion ?? "an unknown version"} to ${confirmation.targetVersion ?? "latest"}. Sessions already running keep the binary they started with until they restart. Continue?` : fleetJoinEncrypted(confirmation.machineKey) ? `This sends ${fleetMachineLabel(confirmation.machineKey, confirmation.machineNickname)} a request over HTTPS, asking it to update its own omp binary from ${confirmation.currentVersion ?? "an unknown version"} to ${confirmation.targetVersion ?? "latest"}. Sessions already running there keep the binary they started with until they restart. Continue?` : `This sends ${fleetMachineLabel(confirmation.machineKey, confirmation.machineNickname)} a request over an unencrypted HTTP connection, asking it to update its own omp binary from ${confirmation.currentVersion ?? "an unknown version"} to ${confirmation.targetVersion ?? "latest"}. Sessions already running there keep the binary they started with until they restart. Continue?`,
        action: "Update omp",
        target: null,
      };
    }
    case "fleet-stage-app": {
      // Staging downloads the package; nothing installs until the apply arm.
      const local = confirmation.machineKey === LOCAL_MACHINE_KEY;
      return {
        tone: "copper",
        title: "Stage the omp-ui app update?",
        body: local ? `This asks this computer to download and stage its omp-ui app update (${confirmation.version ?? "latest"}). Nothing installs until the update is applied the next time it quits. Continue?` : fleetJoinEncrypted(confirmation.machineKey) ? `This sends ${fleetMachineLabel(confirmation.machineKey, confirmation.machineNickname)} a request over HTTPS, asking it to download and stage its omp-ui app update (${confirmation.version ?? "latest"}). Nothing installs until the update is applied the next time that machine quits. Continue?` : `This sends ${fleetMachineLabel(confirmation.machineKey, confirmation.machineNickname)} a request over an unencrypted HTTP connection, asking it to download and stage its omp-ui app update (${confirmation.version ?? "latest"}). Nothing installs until the update is applied the next time that machine quits. Continue?`,
        action: "Stage update",
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
        title: "Install the staged update on quit?",
        body: confirmation.liveSessions > 0 ? `${confirmation.liveSessions} live session(s) run on ${confirmation.machineKey === LOCAL_MACHINE_KEY
                ? "this computer"
                : confirmation.machineNickname ?? confirmation.machineKey}. It will install its staged omp-ui update the next time it quits, and those sessions keep running until then. Continue?` : `This arms ${confirmation.machineKey === LOCAL_MACHINE_KEY
                ? "this computer"
                : confirmation.machineNickname ?? confirmation.machineKey} to install its staged omp-ui update the next time it quits; nothing is interrupted before then. Continue?`,
        action: "Install when I quit",
        target: null,
      };
    }
    case "fleet-update-all":
      // Update all (#990): names how many members it asks and how many it
      // leaves out; nothing restarts, and live sessions keep running.
      return {
        tone: "copper",
        title: "Update every fleet member?",
        body: (confirmation.eligible === 1 ? "This asks 1 member to update itself: it installs the newest omp binary, then stages its omp-ui update to install the next time that machine quits. Nothing restarts, and live sessions keep running. Continue?" : `This asks ${confirmation.eligible} members to update themselves: each installs the newest omp binary, then stages its omp-ui update to install the next time that machine quits. Nothing restarts, and live sessions keep running. Continue?`) + (confirmation.skipped > 0 ? ` ${`${confirmation.skipped} other member(s) without Full control or not ready are listed as skipped.`}` : ""),
        action: "Update all",
        target: null,
      };
  }
}

export function AppFeedback(): JSX.Element | null {
  const errorNotices = useStore((s) => s.errorNotices);
  const dismissError = useStore((s) => s.dismissError);
  const infoNotices = useStore((s) => s.infoNotices);
  const dismissNotice = useStore((s) => s.dismissNotice);
  const confirmation = useStore((s) => s.lifecycleConfirmation);
  const confirmLifecycleAction = useStore((s) => s.confirmLifecycleAction);
  const cancelLifecycleAction = useStore((s) => s.cancelLifecycleAction);
  const openForkInstead = useStore((s) => s.openForkInstead);
  // Opt-out for the settle-running confirmation (issues #925, #1005). The host component
  // stays mounted across confirmations — ConfirmDialog is keyed, this is not —
  // so the checkbox must be cleared explicitly whenever a new decision is
  // staged, including other kinds that never render the row.
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
        kicker="Action failed"
        title="Could not complete the action"
        tone="rose"
        onClose={() => dismissError(notice.id)}
        actions={
          <Button
            variant="solid"
            tone="rose"
            initialFocus
            onClick={() => dismissError(notice.id)}
          >
            Dismiss
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
        kicker="Done"
        title="A word from omp-ui"
        tone="copper"
        onClose={() => dismissNotice(infoNotice.id)}
        actions={
          <Button
            variant="solid"
            tone="copper"
            initialFocus
            onClick={() => dismissNotice(infoNotice.id)}
          >
            Dismiss
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
  const copy = lifecycleCopy(confirmation);
  const busy = confirmation.busy;
  const forkChoice = confirmation.kind === "resume-forked-source" ? confirmation : null;
  return (
    <ConfirmDialog
      key={confirmation.id}
      kicker="Session action"
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
            initialFocus={forkChoice === null}
            onClick={() => cancelLifecycleAction(confirmation.id)}
          >
            Cancel
          </Button>
          <Button
            variant={forkChoice === null ? "solid" : "outline"}
            tone={copy.tone}
            disabled={busy}
            onClick={() => {
              // Persist before dispatching so a concurrent stop cannot slip
              // past an unsaved setting; a failed persist still proceeds.
              if (skipTerminate && confirmation.kind === "settle-running") {
                void setSkipTerminateConfirmation(true);
              }
              void confirmLifecycleAction(confirmation.id);
            }}
          >
            {busy ? "Working…" : copy.action}
          </Button>
          {forkChoice !== null && (
            <Button
              variant="solid"
              tone="signal"
              disabled={busy}
              initialFocus
              onClick={() => void openForkInstead(forkChoice.id)}
            >
              Open fork
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {copy.target !== null && (
          <p className="truncate text-sm font-medium text-ink">
            {copy.target}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim [overflow-wrap:anywhere] break-words">
          {copy.body}
        </p>
        {confirmation.kind === "settle-running" && !busy && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink">
            <input
              type="checkbox"
              checked={skipTerminate}
              onChange={(event) => setSkipTerminate(event.target.checked)}
              className="size-3.5 accent-current"
            />
            Do not show this warning again
          </label>
        )}
      </div>
    </ConfirmDialog>
  );
}
