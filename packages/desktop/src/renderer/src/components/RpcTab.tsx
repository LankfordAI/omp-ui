import { useEffect } from "react";
import { field, numField, strField } from "../lib/fields";
import { useStore } from "../store";
import { BashDrawer } from "./BashDrawer";
import { ExtensionDialogHost } from "./ExtensionDialogHost";
import { ModelSelector } from "./ModelSelector";
import { PromptBox } from "./PromptBox";
import { TodoPanel } from "./TodoPanel";
import { TranscriptView } from "./TranscriptView";

function contextUsageText(stats: unknown): string | null {
  const usage = field(stats, "contextUsage");
  if (typeof usage === "number") return `${usage}`;
  const percent = numField(usage, "percent");
  if (percent !== undefined) return `${percent.toFixed(1)}%`;
  const tokens = numField(usage, "tokens");
  const window = numField(usage, "contextWindow");
  if (tokens !== undefined && window !== undefined && window > 0) return `${tokens}/${window}`;
  const used = numField(usage, "used");
  const total = numField(usage, "total");
  if (used !== undefined && total !== undefined && total > 0) return `${used}/${total}`;
  if (used !== undefined) return `${used}`;
  return null;
}

export function RpcTab({ tabId }: { tabId: string; active: boolean }) {
  const rpc = useStore((s) => s.rpc[tabId]);
  const bootRpcTab = useStore((s) => s.bootRpcTab);
  const exitCode = useStore((s) => s.exited[tabId]);
  const resumeDead = useStore((s) => s.resumeDead);

  useEffect(() => {
    if (!rpc) void bootRpcTab(tabId);
  }, [rpc, tabId, bootRpcTab]);

  const stats = rpc?.sessionStats ?? null;
  const thinkingLevel =
    strField(stats, "thinkingLevel") ?? strField(rpc?.model, "thinkingLevel") ?? null;
  const sessionName =
    strField(stats, "sessionName") ?? strField(stats, "title") ?? null;
  const ctxUsage = contextUsageText(stats);
  const statusClass =
    rpc?.status === "ready"
      ? "text-green-400"
      : rpc?.status === "running"
        ? "text-amber-400"
        : rpc?.status === "error"
          ? "text-red-400"
          : "text-neutral-500";

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400">
        <ModelSelector tabId={tabId} />
        {thinkingLevel && <span>thinking: {thinkingLevel}</span>}
        {ctxUsage && <span>ctx: {ctxUsage}</span>}
        <span className="flex-1" />
        {sessionName && <span className="truncate">{sessionName}</span>}
        <span className={statusClass}>{rpc?.status ?? "starting"}</span>
      </div>
      {rpc?.error && (
        <div className="border-b border-red-900 bg-red-950/50 px-3 py-1 text-xs text-red-200">
          {rpc.error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <TranscriptView items={rpc?.items ?? []} />
          <PromptBox tabId={tabId} />
          <BashDrawer tabId={tabId} />
        </div>
        <TodoPanel tabId={tabId} />
      </div>
      <ExtensionDialogHost tabId={tabId} />
      {exitCode !== undefined && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-neutral-900/85">
          <p className="text-sm text-neutral-400">agent exited (code {exitCode})</p>
          <button
            className="rounded bg-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-600"
            onClick={() => void resumeDead(tabId)}
          >
            resume session
          </button>
        </div>
      )}
    </div>
  );
}
