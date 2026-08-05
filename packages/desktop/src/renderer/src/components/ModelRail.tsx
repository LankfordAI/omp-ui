import { cn } from "../lib/cn";
import { StarIcon } from "./ui";

/**
 * Narrow vertical rail with a Favorites tab followed by text provider tabs.
 * Active tab gets a right accent bar and raised background.
 */
export function ModelRail({
  activeTab,
  onTabChange,
  providers,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  providers: string[];
}) {
  return (
    <div className="model-provider-rail flex w-16 shrink-0 flex-col overflow-y-auto border-r border-line bg-sunken py-1">
      {/* Favorites tab */}
      <button
        type="button"
        title="Favorites"
        aria-pressed={activeTab === "favorites"}
        onClick={() => onTabChange("favorites")}
        className={cn(
          "grid place-items-center px-1 py-1.5 transition-colors",
          activeTab === "favorites"
            ? "border-r-2 border-signal bg-raised text-ink"
            : "text-ink-faint hover:bg-hover hover:text-ink-mid",
        )}
      >
        <StarIcon filled={activeTab === "favorites"} />
      </button>

      {/* Provider tabs */}
      {providers.map((provider) => {
        const on = activeTab === provider;
        return (
          <button
            key={provider}
            type="button"
            title={provider}
            aria-pressed={on}
            onClick={() => onTabChange(provider)}
            className={cn(
              "truncate px-1.5 py-1 font-mono text-[10px] transition-colors",
              on
                ? "border-r-2 border-signal bg-raised text-ink"
                : "text-ink-faint hover:bg-hover hover:text-ink-mid",
            )}
          >
            {provider}
          </button>
        );
      })}
    </div>
  );
}
