// PROTOTYPE (#527) — throwaway. The floating variant bar: ◀ / label / ▶ on
// row one, the active tab's pane state on row two (skill rule 5: surface the
// state). Bottom-LEFT — bottom-centre is the floating composer's, bottom-right
// is the update-card stack's.
import { useEffect, useState } from "react";
import { useStore } from "../../store";
import {
  PROTOTYPE_ACTIVE,
  VARIANT_NAMES,
  cycleVariant,
  latestFrame,
  useBrowserPane,
  usePrototypeVariant,
} from "./state";

const ARROW = "rounded px-1.5 py-0.5 text-ink-mid transition-colors hover:bg-hover hover:text-ink";

export function PrototypeSwitcher() {
  if (!PROTOTYPE_ACTIVE) return null;
  return <Switcher />;
}

function Switcher() {
  const variant = usePrototypeVariant() ?? "A";
  const activeTabId = useStore((s) => s.activeTabId);
  const pane = useBrowserPane(activeTabId ?? "");
  // Frame seq comes from the side table, polled at 1 Hz — never the reactive store.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const seq = activeTabId === null ? undefined : latestFrame.get(activeTabId)?.seq;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable ||
          el.getAttribute("role") === "separator") // ResizeHandle uses arrow keys
      ) {
        return;
      }
      cycleVariant(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed bottom-3 left-3 z-[70] max-w-[min(28rem,calc(100vw-1.5rem))] rounded-lg border border-line-strong bg-void px-2.5 py-1.5 font-mono text-[11px] text-ink shadow-lg">
      <div className="flex items-center gap-2">
        <button type="button" className={ARROW} aria-label="previous variant" onClick={() => cycleVariant(-1)}>
          ◀
        </button>
        <span className="min-w-0 flex-1 truncate">
          PROTOTYPE #527 · {variant} — {VARIANT_NAMES[variant]}
        </span>
        <button type="button" className={ARROW} aria-label="next variant" onClick={() => cycleVariant(1)}>
          ▶
        </button>
      </div>
      <div className="mt-1 truncate text-[10px] text-ink-faint">
        {activeTabId === null
          ? "no active tab"
          : `pane ${pane.open ? "open" : "closed"} · ${pane.url ?? "—"} · ${pane.loading ? "loading" : "idle"} · agent ${pane.agentConnected ? "connected" : "off"} · frame #${seq ?? "—"}`}
      </div>
    </div>
  );
}
