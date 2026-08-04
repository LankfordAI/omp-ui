import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Button, Empty } from "./ui";

/**
 * A mini shell inside the console drawer. History is deliberately local — omp's
 * `bash` command is stateless per call, so recall is a renderer affordance, not
 * session state worth persisting.
 */
export function BashDrawer({ tabId }: { tabId: string }) {
  const lines = useStore((s) => s.rpc[tabId]?.bashLines) ?? [];
  const runBash = useStore((s) => s.runBash);
  const abortBash = useStore((s) => s.abortBash);
  const clearBash = useStore((s) => s.clearBash);

  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  // -1 = editing a fresh line; 0..n-1 = index into `history`, newest first.
  const [recall, setRecall] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  const run = (): void => {
    const command = cmd.trim();
    if (!command) return;
    setCmd("");
    setRecall(-1);
    setHistory((prev) => (prev[0] === command ? prev : [command, ...prev].slice(0, 50)));
    void runBash(tabId, command);
  };

  const step = (delta: number): void => {
    if (history.length === 0) return;
    const next = Math.min(history.length - 1, Math.max(-1, recall + delta));
    setRecall(next);
    setCmd(next === -1 ? "" : history[next]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-void px-2 py-1.5">
        {lines.length === 0 ? (
          <Empty title="No output yet" hint="Run a command below to shell out inside the agent's cwd." />
        ) : (
          <>
            {lines.map((line, i) => (
              <pre
                key={i}
                data-selectable
                className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ink-mid"
              >
                {line}
              </pre>
            ))}
            <div ref={endRef} />
          </>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-line bg-void px-2 focus-within:border-line-strong">
        <span aria-hidden className="shrink-0 font-mono text-[11px] text-signal">
          $
        </span>
        <input
          value={cmd}
          aria-label="bash command"
          placeholder="command…"
          onChange={(e) => {
            setCmd(e.target.value);
            setRecall(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              step(1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              step(-1);
            }
          }}
          className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <Button size="xs" onClick={run} disabled={cmd.trim() === ""} title="run this command">
          run
        </Button>
        <Button size="xs" variant="ghost" tone="rose" onClick={() => void abortBash(tabId)} title="abort the running command">
          abort
        </Button>
        <span className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => clearBash(tabId)}
          disabled={lines.length === 0}
          title="clear this output pane"
        >
          clear
        </Button>
      </div>
    </div>
  );
}
