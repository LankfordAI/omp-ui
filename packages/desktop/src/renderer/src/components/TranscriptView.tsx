import { useEffect, useRef } from "react";
import { strField } from "../lib/fields";
import type {
  AdvisoryItem,
  AssistantItem,
  RenderItem,
  ToolItem,
} from "../lib/transcript";
import { DiffViewer } from "./DiffViewer";

const SEVERITY_CLASS: Record<string, string> = {
  blocker: "border-red-600 bg-red-950/50 text-red-200",
  concern: "border-amber-600 bg-amber-950/40 text-amber-200",
  nit: "border-neutral-700 bg-neutral-900 text-neutral-400",
};

function AdvisoryCard({ item }: { item: AdvisoryItem }) {
  return (
    <div className="space-y-1">
      {item.notes.map((note, i) => (
        <div
          key={i}
          className={`rounded border-l-4 px-3 py-1.5 text-xs ${SEVERITY_CLASS[note.severity ?? ""] ?? SEVERITY_CLASS.nit}`}
        >
          <div className="flex gap-2">
            {note.advisor && <span className="font-semibold uppercase">{note.advisor}</span>}
            {note.severity && <span className="opacity-70">{note.severity}</span>}
          </div>
          <p className="whitespace-pre-wrap">{note.note}</p>
        </div>
      ))}
    </div>
  );
}

function AssistantBlock({ item }: { item: AssistantItem }) {
  return (
    <div className="space-y-1">
      {item.thinking && (
        <details className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1">
          <summary className="cursor-pointer text-[10px] uppercase text-neutral-500">
            thinking
          </summary>
          <p className="whitespace-pre-wrap text-xs text-neutral-400">{item.thinking}</p>
        </details>
      )}
      {item.text && (
        <p className="whitespace-pre-wrap text-sm text-neutral-200">
          {item.text}
          {item.streaming && <span className="animate-pulse">▍</span>}
        </p>
      )}
      {!item.text && item.streaming && <p className="text-xs text-neutral-500">…</p>}
    </div>
  );
}

function ToolCallCard({ item }: { item: ToolItem }) {
  const argsText = (() => {
    if (item.args === undefined || item.args === null) return "";
    try {
      const s = JSON.stringify(item.args);
      return s.length > 300 ? `${s.slice(0, 300)}…` : s;
    } catch {
      return "";
    }
  })();
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold text-neutral-200">{item.name}</span>
        {item.status === "running" && (
          <span className="animate-pulse text-amber-400">running…</span>
        )}
        {item.status === "done" && <span className="text-green-500">done</span>}
        {item.status === "error" && <span className="text-red-400">error</span>}
      </div>
      {argsText && <div className="mt-1 font-mono text-[11px] text-neutral-500">{argsText}</div>}
      {item.resultText && (
        <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-neutral-400">
          {item.resultText}
        </pre>
      )}
      {item.diff && item.diff.length > 0 && (
        <div className="mt-1">
          <DiffViewer rows={item.diff} />
        </div>
      )}
      {item.notes && item.notes.length > 0 && (
        <div className="mt-1">
          <AdvisoryCard item={{ kind: "advisory", id: `${item.id}-notes`, notes: item.notes }} />
        </div>
      )}
    </div>
  );
}

export function TranscriptView({ items }: { items: RenderItem[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length]);

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className="flex justify-end">
                <p className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-neutral-800 px-3 py-1.5 text-sm">
                  {item.text}
                </p>
              </div>
            );
          case "assistant":
            return <AssistantBlock key={item.id} item={item} />;
          case "tool":
            return <ToolCallCard key={item.id} item={item} />;
          case "advisory":
            return <AdvisoryCard key={item.id} item={item} />;
          case "notice":
            return (
              <div key={item.id} className="rounded bg-neutral-800/60 px-2 py-1 text-center text-[11px] text-neutral-400">
                {item.text}
              </div>
            );
          case "irc":
            return (
              <div key={item.id} className="text-[11px] text-neutral-500">
                <span className="font-semibold">{item.from}:</span> {item.text}
              </div>
            );
          case "marker":
            return (
              <div key={item.id} className="py-0.5 text-center text-[10px] uppercase tracking-wide text-neutral-600">
                {item.label ?? strField(item, "label")}
              </div>
            );
        }
      })}
      <div ref={endRef} />
    </div>
  );
}
