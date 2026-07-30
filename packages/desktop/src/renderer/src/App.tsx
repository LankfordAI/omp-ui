import { useEffect } from "react";
import { RpcTab } from "./components/RpcTab";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalTab } from "./components/TerminalTab";
import { useStore } from "./store";

export default function App() {
  const init = useStore((s) => s.init);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const addProject = useStore((s) => s.addProject);

  useEffect(() => {
    void init();
  }, [init]);

  const visibleTabs = tabs.filter((t) => !t.hidden);

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-900 text-neutral-200">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <div className="relative min-h-0 flex-1">
          {tabs.map((t) => (
            <div
              key={t.tabId}
              className="absolute inset-0"
              style={{ display: t.tabId === activeTabId && !t.hidden ? "block" : "none" }}
            >
              {t.mode === "rpc-ui" ? (
                <RpcTab tabId={t.tabId} active={t.tabId === activeTabId && !t.hidden} />
              ) : (
                <TerminalTab tabId={t.tabId} active={t.tabId === activeTabId && !t.hidden} />
              )}
            </div>
          ))}
          {visibleTabs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
              <p>No open sessions.</p>
              <button
                className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
                onClick={() => void addProject()}
              >
                Add project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
