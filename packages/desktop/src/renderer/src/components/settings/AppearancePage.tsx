import { cn } from "../../lib/cn";
import { resolveTheme, THEMES } from "../../lib/themes";
import { useStore } from "../../store";
import { Chip } from "../ui";

/** The planes and accents each swatch strip paints, in strip order. */
const SWATCH_TOKENS = [
  "--color-void",
  "--color-surface",
  "--color-raised",
  "--color-signal",
  "--color-copper",
  "--color-rose",
  "--color-iris",
] as const;

export function AppearancePage() {
  const themeId = useStore((s) => s.state?.themeId);
  const setThemeId = useStore((s) => s.setThemeId);
  const activeId = resolveTheme(themeId).id;

  return (
    <div className="px-4 py-3">
      <div className="grid grid-cols-2 gap-2">
        {THEMES.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={active}
              onClick={() => void setThemeId(t.id)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors duration-150",
                active
                  ? "border-line-strong bg-hover"
                  : "border-line bg-raised hover:border-line-strong",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-ink">{t.label}</span>
                <Chip>{t.dark ? "dark" : "light"}</Chip>
              </span>
              {/* Inline styles are the one sanctioned exception here: these
                  swatches paint a theme that is NOT the active one, so the
                  live CSS tokens cannot express them. */}
              <span className="mt-2 flex h-4 overflow-hidden rounded border border-line">
                {SWATCH_TOKENS.map((token) => (
                  <span
                    key={token}
                    className="flex-1"
                    style={{ background: t.tokens[token] }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-ink-faint">
        Every theme keeps mint reserved for agent liveness (ADR-0004).
      </p>
    </div>
  );
}
