import { useState } from "react";
import { useStore } from "../store";

export function BashDrawer({ tabId }: { tabId: string }) {
  const [open, setOpen] = useState(false);
  const [cmd, setCmd] = useState("");
  const lines = useStore((s) => s.rpc[tabId]?.bashLines);
  const runBash = useStore((s) => s.runBash);
  const abortBash = useStore((s) => s.abortBash);

  const run = () => {
    const command = cmd.trim();
    if (!command) return;
    setCmd("");
    void runBash(tabId, command);
  };

  return (
    <div className="border-t border-neutral-800">
      <button
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-neutral-500 hover:text-neutral-300"
        onClick={() => setOpen(!open)}
      >
        <span>{open ? "▾" : "▸"}</span> bash {(lines?.length ?? 0) > 0 && `(${lines!.length})`}
      </button>
      {open && (
        <div className="px-3 pb-2">
          <div className="max-h-40 overflow-y-auto rounded bg-neutral-950 p-2 font-mono text-[11px] text-neutral-400">
            {(lines ?? []).map((line, i) => (
              <pre key={i} className="whitespace-pre-wrap">
                {line}
              </pre>
            ))}
            {(lines ?? []).length === 0 && <span className="text-neutral-600">no output yet</span>}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded bg-neutral-800 px-2 py-1 font-mono text-[11px] outline-none"
              placeholder="! command…"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  run();
                }
              }}
            />
            <button
              className="shrink-0 rounded bg-neutral-700 px-2 py-1 text-[11px] hover:bg-neutral-600"
              onClick={run}
            >
              run
            </button>
            <button
              className="shrink-0 rounded bg-red-900/60 px-2 py-1 text-[11px] text-red-200 hover:bg-red-800"
              onClick={() => void abortBash(tabId)}
            >
              abort
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
