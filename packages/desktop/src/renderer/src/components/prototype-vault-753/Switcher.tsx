// PROTOTYPE (#753): throwaway.
// Floating variant switcher. Portaled to document.body, outside #root, because
// useOverlay sets `inert` on #root while a modal is open and the switcher must
// stay usable over Settings and Project settings.
import { useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import { Chevron } from "../ui";
import { addVaultWrite } from "./fixtures";
import {
  CHOICES,
  PROTOTYPE_753,
  resetPrototype,
  setChoice,
  usePrototype753,
  type ChoiceKey,
  type ChoiceValue,
  type Prototype753,
} from "./state";

const ROWS: { key: ChoiceKey; label: string; field: Exclude<keyof Prototype753, "active"> }[] = [
  { key: "p753_reg", label: "Registry", field: "reg" },
  { key: "p753_chip", label: "Chip", field: "chip" },
  { key: "p753_card", label: "Card", field: "card" },
  { key: "p753_mark", label: "Marker", field: "mark" },
  { key: "p753_touched", label: "Notes touched", field: "touched" },
  { key: "p753_det", label: "Detection", field: "det" },
];

const COLLAPSED_KEY = "omp-ui:prototype-753:switcher-collapsed";

function readCollapsed(): boolean {
  try {
    return sessionStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

const ACTION = "rounded-md border border-line px-1.5 py-0.5 text-ink-mid transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-35";

function SwitcherBody() {
  const proto = usePrototype753();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const openSettings = useStore((s) => s.openSettings);
  const openProjectSettings = useStore((s) => s.openProjectSettings);
  const firstProject = useStore((s) => s.state?.projects[0]?.project.path ?? null);

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      sessionStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage refused: the state stays component-local.
    }
  };

  return (
    <div
      data-p753-switcher
      className="fixed bottom-3 left-3 z-[80] max-w-[min(30rem,calc(100vw-1.5rem))] rounded-lg border border-line-strong bg-void px-2.5 py-1.5 font-mono text-[11px] text-ink shadow-lg"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-left uppercase tracking-[0.14em] text-ink-mid hover:text-ink"
      >
        <Chevron open={!collapsed} />
        PROTOTYPE #753
      </button>
      {!collapsed && (
        <div className="mt-1.5 space-y-1">
          {ROWS.map(({ key, label, field }) => (
            <div key={key} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="w-24 shrink-0 text-ink-faint">{label}</span>
              <span className="flex flex-wrap items-center gap-0.5" role="group" aria-label={label}>
                {(CHOICES[key] as readonly ChoiceValue<ChoiceKey>[]).map((value) => {
                  const selected = proto[field] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      data-p753-choice={`${key}:${value}`}
                      onClick={() => setChoice(key, value as never)}
                      className={cn(
                        "rounded-md px-1.5 py-0.5 transition-colors",
                        selected ? "bg-raised text-ink" : "text-ink-faint hover:text-ink-mid",
                      )}
                    >
                      {value}
                    </button>
                  );
                })}
              </span>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-1 border-t border-line pt-1.5">
            <button type="button" className={ACTION} onClick={() => addVaultWrite()}>
              Add write
            </button>
            <button
              type="button"
              className={ACTION}
              onClick={() => openSettings(proto.reg === "page" ? "vaults" : "memory")}
            >
              Open Settings
            </button>
            <button
              type="button"
              className={ACTION}
              disabled={firstProject === null}
              title={firstProject === null ? "No project yet" : firstProject}
              onClick={() => {
                if (firstProject === null) return;
                openProjectSettings(firstProject, null, proto.chip === "tab" ? "knowledge" : undefined);
              }}
            >
              Project settings
            </button>
            <button type="button" className={cn(ACTION, "hover:text-rose")} onClick={() => resetPrototype()}>
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Prototype753Switcher() {
  if (!PROTOTYPE_753) return null;
  return createPortal(<SwitcherBody />, document.body);
}
