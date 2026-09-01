import { cn } from "../../lib/cn";
import { FONT_FAMILIES, resolveFontFamily } from "../../lib/font-families";
import { resolveTheme, THEMES } from "../../lib/themes";
import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
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
  const fontFamilyId = useStore((s) => s.state?.fontFamilyId);
  const setFontFamilyId = useStore((s) => s.setFontFamilyId);
  const t = useT();
  const activeId = resolveTheme(themeId).id;
  const activeFamilyId = resolveFontFamily(fontFamilyId).id;

  return (
    <div className="px-4 py-3">
      <div className="grid grid-cols-2 gap-2">
        {THEMES.map((theme) => {
          const active = theme.id === activeId;
          return (
            <button
              key={theme.id}
              type="button"
              aria-pressed={active}
              onClick={() => void setThemeId(theme.id)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors duration-150",
                active
                  ? "border-line-strong bg-hover"
                  : "border-line bg-raised hover:border-line-strong",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-ink">{theme.label}</span>
                <Chip>{theme.dark ? t("settings.appearance.themeDark") : t("settings.appearance.themeLight")}</Chip>
              </span>
              {/* Inline styles are the one sanctioned exception here: these
                  swatches paint a theme that is NOT the active one, so the
                  live CSS tokens cannot express them. */}
              <span className="mt-2 flex h-4 overflow-hidden rounded border border-line">
                {SWATCH_TOKENS.map((token) => (
                  <span
                    key={token}
                    className="flex-1"
                    style={{ background: theme.tokens[token] }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-ink-faint">
        {t("settings.appearance.mintNote")}
      </p>

      <div className="mt-4 border-t border-line-soft pt-3">
        <h3 className="text-xs font-medium text-ink">{t("settings.appearance.fontFamily")}</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          {t("settings.appearance.fontFamilyHint")}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {FONT_FAMILIES.map((f) => {
            const active = f.id === activeFamilyId;
            return (
              <button
                key={f.id}
                type="button"
                aria-label={t("settings.appearance.fontFamilyAria", { name: f.label })}
                aria-pressed={active}
                onClick={() => void setFontFamilyId(f.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors duration-150",
                  active
                    ? "border-line-strong bg-hover"
                    : "border-line bg-raised hover:border-line-strong",
                )}
              >
                <span className="text-xs font-medium text-ink">{f.label}</span>
                {/* Inline styles are the one sanctioned exception here: these
                    samples paint a family that is NOT the active one, so the
                    live CSS tokens cannot express them. */}
                <span
                  className="mt-2 block truncate text-base leading-5 text-ink"
                  style={{ fontFamily: f.sans }}
                >
                  Aa Bb Cc 0123
                </span>
                <span
                  className="mt-0.5 block truncate text-[11px] leading-4 text-ink-dim"
                  style={{ fontFamily: f.mono }}
                >
                  0123456789 abcdef
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
