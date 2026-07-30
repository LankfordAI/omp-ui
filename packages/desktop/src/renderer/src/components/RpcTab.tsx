import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Composer } from "./Composer";
import { ExtensionDialogHost } from "./ExtensionDialogHost";
import { InspectorRail } from "./InspectorRail";
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

export function RpcTab({ tabId }: { tabId: string; active: boolean }) {
  const rpc = useStore((s) => s.rpc[tabId]);
  const bootRpcTab = useStore((s) => s.bootRpcTab);
  const exitCode = useStore((s) => s.exited[tabId]);
  const resumeDead = useStore((s) => s.resumeDead);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  useEffect(() => {
    if (!rpc) void bootRpcTab(tabId);
  }, [rpc, tabId, bootRpcTab]);

  const status = rpc?.status ?? "starting";
  const error = rpc?.error && rpc.error !== dismissedError ? rpc.error : null;
  // `busy` is ref-counted off in-flight rpc commands, so the sweep is honest for
  // any blocking round-trip (compact, export, branch), not just boot.
  const working = status === "starting" || (rpc?.busy ?? false);

  return (
    <div className="relative flex h-full flex-col bg-surface">
      <SessionHud tabId={tabId} />

      {working && <ProgressSweep tone={status === "starting" ? "neutral" : "signal"} />}

      {error && (
        <div className="px-3 pt-2">
          <Panel tone="rose" className="animate-rise flex items-start gap-2 px-2.5 py-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] leading-snug text-rose">
              {error}
            </p>
            <CopyButton text={error} />
            <Button size="xs" variant="ghost" tone="rose" onClick={() => void bootRpcTab(tabId)}>
              retry boot
            </Button>
            <Button
              size="xs"
              variant="ghost"
              title="dismiss"
              onClick={() => setDismissedError(error)}
            >
              ✕
            </Button>
          </Panel>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {status === "starting" && (rpc?.items.length ?? 0) === 0 ? (
            <TranscriptSkeleton />
          ) : (
            <TranscriptView items={rpc?.items ?? []} />
          )}
          <Composer tabId={tabId} />
        </div>
        <InspectorRail tabId={tabId} />
      </div>

      <ExtensionDialogHost tabId={tabId} />

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
