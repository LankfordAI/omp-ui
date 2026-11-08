import { useT } from "../lib/i18n";
import { canOpenLivePeer } from "../lib/live-peer";
import { NATIVE_LIVE_MIN_OMP, supportsNativeLive } from "../lib/live-voice";
import { queueChipCount, queueChipView } from "../lib/queue-chip";
import type { CheckoutEntry } from "../lib/repository-members";
import { findOwner, isChatTab, useStore } from "../store";
import type { BranchChipExternalRequest } from "./BranchChip";
import type { SubmitRoute } from "./Composer";
import { ComposerActions } from "./ComposerActions";
import { ComposerOptionsContent } from "./ComposerOptionsContent";
import { LiveVoiceControl } from "./LiveVoiceControl";
import { QueuedMessageList } from "./QueuedMessageList";
import type { WorkspaceSelection } from "./WorktreeBranchFields";
import { Button, Chip, Sheet } from "./ui";

/**
 * The compact options container: the same Model / Session / Workspace body
 * as the desktop popover, with queue, live voice, stash, and submit actions.
 * Store-aware on `tabId`; only draft and pending-workspace state comes from
 * the composer.
 */
export function ComposerSheet({
  open,
  onClose,
  tabId,
  projectCwd,
  unavailable,
  liveVoiceVisible = true,
  canSend,
  onSubmit,
  stash,
  onStash,
  workspace,
  onWorkspaceChange,
  workspaceDisabled = unavailable,
  onCreateWorktree,
  finishTabId,
  offerMachine = false,
  machineDisabled = unavailable,
  onPickMachine,
  branchRequest,
}: {
  open: boolean;
  onClose: () => void;
  tabId: string;
  projectCwd: string | undefined;
  unavailable: boolean;
  liveVoiceVisible?: boolean;
  canSend: boolean;
  onSubmit: (route: SubmitRoute) => void;
  /** Draft stash (issue #989): "stash" parks the draft, "pick" opens the picker. */
  stash: "stash" | "pick";
  onStash: () => void;
  workspace?: WorkspaceSelection;
  onWorkspaceChange?: (
    next: WorkspaceSelection | ((prev: WorkspaceSelection) => WorkspaceSelection),
  ) => void;
  workspaceDisabled?: boolean;
  onCreateWorktree?: () => Promise<boolean>;
  finishTabId?: string;
  offerMachine?: boolean;
  machineDisabled?: boolean;
  onPickMachine?: (member: CheckoutEntry) => void;
  branchRequest?: BranchChipExternalRequest | null;
}) {
  const t = useT();
  const status = useStore((s) => s.rpc[tabId]?.status);
  const queued = useStore((s) => {
    const session = s.rpc[tabId]?.session;
    return session ? queueChipCount(session) : 0;
  });
  const queueListed = useStore((s) => s.rpc[tabId]?.session.queuedMessages != null);
  // Live voice gates on the omp version, like the inline rows (issue #778),
  // and on this client carrying the call's peer (issue #968): a remote web
  // client or a joined remote-instance tab runs the peer here and signals
  // through the session host; a non-secure origin has no microphone.
  const liveSupported = useStore(
    (s) => supportsNativeLive(s.rpc[tabId]?.capabilities?.ompVersion ?? null) && canOpenLivePeer(),
  );
  // The version gate alone, so the row's title can name the required omp
  // when old-harness omp — not a missing microphone — is why live voice is absent.
  const liveGateBlocked = useStore((s) => {
    const v = s.rpc[tabId]?.capabilities?.ompVersion ?? null;
    return v !== null && !supportsNativeLive(v);
  });
  const abortAgent = useStore((s) => s.abortAgent);
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  // A chat is Build-only and has no repo (#894): no mode control, no branch row.
  const chat = useStore((s) => isChatTab(s.state, tabId));
  const running = status === "running";
  const queueChip = queueChipView(running, queued);

  return (
    <Sheet open={open} placement="bottom" label={t("composer.options.title")} onClose={onClose}>
      <div className="prompt-options space-y-4 px-[max(1rem,var(--safe-left))] py-4 pr-[max(1rem,var(--safe-right))]">
        <div className="rounded-md border border-line bg-raised/60 p-1">
          <ComposerOptionsContent
            compact
            tabId={tabId}
            disabled={unavailable}
            chat={chat}
            projectCwd={projectCwd}
            instanceId={instanceId}
            workspace={workspace}
            onWorkspaceChange={onWorkspaceChange}
            workspaceDisabled={workspaceDisabled}
            onCreateWorktree={onCreateWorktree}
            finishTabId={finishTabId}
            offerMachine={offerMachine}
            machineDisabled={machineDisabled}
            onPickMachine={onPickMachine}
            branchRequest={branchRequest}
            onModeSelected={onClose}
            modelExtras={liveVoiceVisible && (liveSupported ? (
              <div className="flex min-h-11 items-center px-2 py-1.5">
                <LiveVoiceControl tabId={tabId} layout="sheet" disabled={unavailable} className="w-full" />
              </div>
            ) : liveGateBlocked ? (
              // Keep the version-blocked control mounted with its upgrade hint.
              // A client without a microphone still hides it: newer omp cannot help.
              <div className="flex min-h-11 items-center px-2 py-1.5" title={t("composer.live.needsNewerOmp", { version: NATIVE_LIVE_MIN_OMP })}>
                <LiveVoiceControl tabId={tabId} layout="sheet" disabled startDisabled className="w-full" />
              </div>
            ) : null)}
            sessionExtras={queueChip && (
              <div className="space-y-2 px-2 py-1.5">
                <div className="flex min-h-11 items-center">
                  <Chip mono tone="copper" title={running ? t("composer.queue.queuedTitle") : t("composer.queue.parkedTitle")}>{running ? t("composer.queue.queued", { n: queued }) : t("composer.queue.parked", { n: queued })}</Chip>
                </div>
                {queueListed && (
                  <div className="rounded-md border border-line bg-void/35 p-3">
                    <QueuedMessageList tabId={tabId} disabled={unavailable} />
                  </div>
                )}
              </div>
            )}
          />
        </div>
        <Button disabled={unavailable} onClick={onStash} className="min-h-11 w-full justify-center">
          {stash === "pick" ? t("composer.stash.open") : t("composer.stash.stash")}
        </Button>
        <ComposerActions
          layout="sheet"
          running={running}
          isSlash={false}
          canSend={canSend}
          onSubmit={onSubmit}
          onAbort={() => void abortAgent(tabId)}
        />
      </div>
    </Sheet>
  );
}
