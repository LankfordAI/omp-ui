import { findRecord, useStore } from "../store";

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const state = useStore((s) => s.state);
  const exited = useStore((s) => s.exited);
  const focusTab = useStore((s) => s.focusTab);
  const hideTab = useStore((s) => s.hideTab);
  const terminate = useStore((s) => s.terminate);
  const switchMode = useStore((s) => s.switchMode);
  const resumeDead = useStore((s) => s.resumeDead);

  const visible = tabs.filter((t) => !t.hidden);
  if (visible.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 bg-neutral-950 px-2 py-1">
      {visible.map((t) => {
        const rec = findRecord(state, t.tabId);
        const exitCode = exited[t.tabId];
        const dead = exitCode !== undefined;
        return (
          <div
            key={t.tabId}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
              t.tabId === activeTabId ? "bg-neutral-800" : "text-neutral-400 hover:bg-neutral-800/50"
            }`}
          >
            <button className="max-w-48 truncate" onClick={() => focusTab(t.tabId)}>
              {rec?.title ?? "New session"}
            </button>
            <button
              className="rounded border border-neutral-700 px-1 text-[10px] uppercase hover:border-neutral-500"
              title="switch mode"
              onClick={() => void switchMode(t.tabId, t.mode === "pty" ? "rpc-ui" : "pty")}
            >
              {t.mode === "pty" ? "term" : "rpc"}
            </button>
            {dead ? (
              <>
                <span className="text-[10px] text-red-400">exited ({exitCode})</span>
                <button
                  className="rounded bg-neutral-700 px-1 text-[10px] hover:bg-neutral-600"
                  onClick={() => void resumeDead(t.tabId)}
                >
                  resume
                </button>
              </>
            ) : (
              <button
                className="text-[10px] text-neutral-500 hover:text-amber-400"
                title="terminate the agent (session stays resumable)"
                onClick={() => void terminate(t.tabId)}
              >
                ⏻
              </button>
            )}
            <button
              className="text-[10px] text-neutral-500 hover:text-neutral-200"
              title="hide tab (keeps running)"
              onClick={() => hideTab(t.tabId)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
