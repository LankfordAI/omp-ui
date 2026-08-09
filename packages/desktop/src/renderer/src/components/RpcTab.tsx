import { useEffect, useState } from "react";
import { useCompactShell } from "../lib/responsive";
import { useStore, type RpcFailure } from "../store";
import { Composer } from "./Composer";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { ExtensionDialogHost } from "./ExtensionDialogHost";
import { InspectorRail } from "./InspectorRail";
import { PlanReview } from "./PlanReview";
import { SessionHud } from "./SessionHud";
import { TranscriptView } from "./TranscriptView";
import { Button, Chip, CopyButton, Panel, ProgressSweep } from "./ui";

/** Boot placeholder — an empty pane reads as a hang, three bars read as work. */
function TranscriptSkeleton() {
  return (
    <div className="animate-rise flex flex-1 flex-col gap-3 px-5 py-4">
      {[0.62, 0.9, 0.44].map((width, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-line-soft"
          style={{ width: `${width * 100}%`, animationDelay: `${i * 140}ms` }}
        />
      ))}
    </div>
  );
}

export function RpcTab({ tabId, active }: { tabId: string; active: boolean }) {
  const rpc = useStore((s) => s.rpc[tabId]);
  const bootRpcTab = useStore((s) => s.bootRpcTab);
  const refreshState = useStore((s) => s.refreshState);
  const exitCode = useStore((s) => s.exited[tabId]);
  const resumeDead = useStore((s) => s.resumeDead);
  const compact = useCompactShell();
  const [dismissedFailure, setDismissedFailure] = useState<RpcFailure | null>(null);

  useEffect(() => {
    if (!rpc) void bootRpcTab(tabId);
  }, [rpc, tabId, bootRpcTab]);

  const status = rpc?.status ?? "starting";
  const failure = rpc?.failure && rpc.failure !== dismissedFailure ? rpc.failure : null;
  const failureText = failure ? `${failure.message}\n\n${failure.recovery}` : "";
  // `busy` is ref-counted off in-flight rpc commands, so the sweep is honest for
  // any blocking round-trip (compact, export, branch), not just boot.
  const working = status === "starting" || (rpc?.busy ?? false);

  return (
    <div className="relative flex h-full flex-col bg-surface">
      {compact && <SessionHud tabId={tabId} />}

      {/* Flush with the tab pane's top edge, never in flow: a 1px bar that
          mounts/unmounts in flow shifts the whole transcript and jitters it.
          On desktop that edge is the hairline under the merged title bar; in
          the compact shell it remains the HUD's bottom border. The -top-px
          mechanics are unchanged either way. */}
      {working && (
        <div className="relative z-10 h-0">
          <div className="absolute inset-x-0 -top-px">
            <ProgressSweep tone={status === "starting" ? "neutral" : "signal"} />
          </div>
        </div>
      )}

      {failure && (
        <div className="px-3 pt-2">
          <Panel tone="rose" className="animate-rise flex items-start gap-2 px-2.5 py-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] leading-snug text-rose">
              {failureText}
            </p>
            <CopyButton text={failureText} label="Copy" />
            {failure.kind === "boot" && (
              <Button size="xs" variant="ghost" tone="rose" onClick={() => void bootRpcTab(tabId)}>
                Retry boot
              </Button>
            )}
            {!failure.fatal && (
              <>
                <Button size="xs" variant="ghost" tone="rose" onClick={() => void refreshState(tabId)}>
                  Refresh state
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  tone="rose"
                  onClick={() => setDismissedFailure(failure)}
                >
                  Dismiss
                </Button>
              </>
            )}
          </Panel>
        </div>
      )}

      {/* The console drawer spans the full tab width — transcript column and
          rail — docked at the bottom edge below the composer (issue #33). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {status === "starting" && (rpc?.items.length ?? 0) === 0 ? (
              <TranscriptSkeleton />
            ) : (
              <TranscriptView items={rpc?.items ?? []} />
            )}
            {/* Docked, not modal: the user may need to scroll the transcript to
                answer, so the question must not cover it. */}
            <ExtensionDialogHost tabId={tabId} />
            <Composer tabId={tabId} />
          </div>
          <InspectorRail tabId={tabId} />
        </div>
        <ConsoleDrawer tabId={tabId} />
      </div>

      {/* Only the focused tab's review may overlay the screen — a background
          session's pending plan lives in the rail's plans tab until revisited. */}
      {active && <PlanReview tabId={tabId} />}

      {exitCode !== undefined && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/80 backdrop-blur-sm">
          <Panel className="edge-lit animate-rise flex flex-col items-center gap-3 px-8 py-6">
            <p className="font-display text-sm text-ink">Agent exited</p>
            <Chip tone="rose" mono title={`process exit code ${exitCode}`}>
              exit {exitCode}
            </Chip>
            <Button variant="solid" tone="signal" onClick={() => void resumeDead(tabId)}>
              resume session
            </Button>
          </Panel>
        </div>
      )}
    </div>
  );
}
