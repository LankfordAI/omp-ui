import { useRef, type KeyboardEvent, type RefObject } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { useCompactShell } from "../lib/responsive";
import { StarIcon } from "./ui";

/**
 * Rail with a Favorites tab followed by text provider tabs: a vertical strip
 * on desktop, a horizontal strip in the compact shell (style.css compact
 * block). Active tab gets an accent bar and raised background.
 * A tablist: step arrows move focus and activate (follow-focus, also on Tab
 * entry via onFocus); the orthogonal arrow/Enter/printable hand focus back
 * to the palette's search input.
 */
export function ModelRail({
  activeTab,
  onTabChange,
  providers,
  railRef,
  onReturnToSearch,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  providers: string[];
  /** The palette's handle on the rail container, for the input's ArrowLeft hop. */
  railRef: RefObject<HTMLDivElement | null>;
  /** Focus the search input; a printable key from the rail appends itself. */
  onReturnToSearch: (append?: string) => void;
}) {
  const t = useT();
  const compact = useCompactShell();
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const tabs = ["favorites", ...providers];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME composition (Korean locale, issue #363) and modifier chords belong
    // to the input/browser, never to pane navigation. Shift+printable stays
    // printable; shifted multi-char keys (Shift+arrows, Shift+Enter) do nothing.
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.shiftKey && event.key.length > 1) return;
    // Navigate from the focused button, not from state: native Tab can focus
    // a tab before onFocus reconciliation settles (D3).
    const focused =
      (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-rail-tab]")?.dataset.railTab ??
      activeTab;
    // A catalog refresh can drop the active provider while open; clamp to 0.
    const index = Math.max(0, tabs.indexOf(focused));
    const go = (next: string) => {
      onTabChange(next);
      buttons.current.get(next)?.focus();
    };
    const step = (delta: number) => {
      event.preventDefault();
      go(tabs[(index + delta + tabs.length) % tabs.length]!);
    };
    const back = () => {
      event.preventDefault();
      onReturnToSearch();
    };
    switch (event.key) {
      case "ArrowDown":
        if (compact) back();
        else step(1);
        return;
      case "ArrowUp":
        if (!compact) step(-1);
        return;
      case "ArrowRight":
        if (compact) step(1);
        else back();
        return;
      case "ArrowLeft":
        if (compact) step(-1);
        return;
      case "Home":
        event.preventDefault();
        go(tabs[0]!);
        return;
      case "End":
        event.preventDefault();
        go(tabs[tabs.length - 1]!);
        return;
      case "Enter":
        back();
        return;
      default:
        // Typing from the rail resumes the search instead of dying on a
        // button. Space is excluded so native button activation runs onClick.
        if (event.key.length === 1 && event.key !== " ") {
          event.preventDefault();
          onReturnToSearch(event.key);
        }
    }
  };

  const tabButton = (tab: string, label: string, favorite: boolean) => {
    const on = activeTab === tab;
    return (
      <button
        key={tab}
        ref={(node) => {
          buttons.current.set(tab, node);
        }}
        type="button"
        role="tab"
        data-rail-tab={tab}
        title={label}
        aria-label={label}
        aria-selected={on}
        onFocus={() => onTabChange(tab)}
        onClick={() => {
          onTabChange(tab);
          onReturnToSearch();
        }}
        className={cn(
          favorite
            ? "grid place-items-center px-1 py-1.5 transition-colors"
            : "truncate px-1.5 py-1 font-mono text-xs transition-colors",
          on
            ? "border-r-2 border-signal bg-raised text-ink"
            : "text-ink-faint hover:bg-hover hover:text-ink-mid",
        )}
      >
        {favorite ? <StarIcon filled={on} /> : tab}
      </button>
    );
  };

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-orientation={compact ? "horizontal" : "vertical"}
      aria-label={t("composer.model.providerRail")}
      onKeyDown={onKeyDown}
      className="model-provider-rail flex w-16 shrink-0 flex-col overflow-y-auto border-r border-line bg-sunken py-1"
    >
      {tabButton("favorites", t("composer.model.favorites"), true)}
      {providers.map((provider) => tabButton(provider, provider, false))}
    </div>
  );
}
