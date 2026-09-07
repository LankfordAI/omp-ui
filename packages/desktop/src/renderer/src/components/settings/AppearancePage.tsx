import type { GlassChrome, TranscriptWidth } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { FONT_FAMILIES, resolveFontFamily } from "../../lib/font-families";
import { GLASS_CHROME_STEPS, resolveGlassChrome } from "../../lib/glass-chrome";
import { useT, type MessageKey } from "../../lib/i18n";
import { resolveTheme, THEMES } from "../../lib/themes";
import {
  TRANSCRIPT_WIDTHS,
  resolveTranscriptWidth,
} from "../../lib/transcript-width";
import { useStore } from "../../store";
import { Chip } from "../ui";

/** Label and mini-column bar each transcript-width card paints (issue #391). */
const WIDTH_CARDS: Record<TranscriptWidth, { label: MessageKey; bar: string }> = {
  comfortable: { label: "settings.appearance.widthComfortable", bar: "w-1/2" },
  wide: { label: "settings.appearance.widthWide", bar: "w-3/4" },
  full: { label: "settings.appearance.widthFull", bar: "w-full" },
};

/** Label and one-line hint each glass-chrome card paints (issue #393). */
const GLASS_CARDS: Record<GlassChrome, { label: MessageKey; hint: MessageKey }> = {
  off: { label: "settings.appearance.glassOff", hint: "settings.appearance.glassOffHint" },
  subtle: {
    label: "settings.appearance.glassSubtle",
    hint: "settings.appearance.glassSubtleHint",
  },
  frosted: {
    label: "settings.appearance.glassFrosted",
    hint: "settings.appearance.glassFrostedHint",
  },
};

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
  const transcriptWidth = useStore((s) => s.state?.transcriptWidth);
  const setTranscriptWidth = useStore((s) => s.setTranscriptWidth);
  const glassChrome = useStore((s) => s.state?.glassChrome);
  const setGlassChrome = useStore((s) => s.setGlassChrome);
  const t = useT();
  const activeId = resolveTheme(themeId).id;
  const activeFamilyId = resolveFontFamily(fontFamilyId).id;
  const activeWidthId = resolveTranscriptWidth(transcriptWidth).id;
  const activeGlassId = resolveGlassChrome(glassChrome).id;

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

      <div className="mt-4 border-t border-line-soft pt-3">
        <h3 className="text-xs font-medium text-ink">
          {t("settings.appearance.transcriptWidth")}
        </h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          {t("settings.appearance.transcriptWidthHint")}
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {TRANSCRIPT_WIDTHS.map((w) => {
            const active = w.id === activeWidthId;
            const card = WIDTH_CARDS[w.id];
            return (
              <button
                key={w.id}
                type="button"
                aria-label={t("settings.appearance.transcriptWidthAria", {
                  name: t(card.label),
                })}
                aria-pressed={active}
                onClick={() => void setTranscriptWidth(w.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors duration-150",
                  active
                    ? "border-line-strong bg-hover"
                    : "border-line bg-raised hover:border-line-strong",
                )}
              >
                <span className="text-xs font-medium text-ink">{t(card.label)}</span>
                <span className={cn("mt-2 block h-1.5 rounded bg-line-strong", card.bar)} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <h3 className="text-xs font-medium text-ink">{t("settings.appearance.glassChrome")}</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          {t("settings.appearance.glassChromeHint")}
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {GLASS_CHROME_STEPS.map((g) => {
            const active = g.id === activeGlassId;
            const card = GLASS_CARDS[g.id];
            return (
              <button
                key={g.id}
                type="button"
                aria-label={t("settings.appearance.glassChromeAria", { name: t(card.label) })}
                aria-pressed={active}
                onClick={() => void setGlassChrome(g.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors duration-150",
                  active
                    ? "border-line-strong bg-hover"
                    : "border-line bg-raised hover:border-line-strong",
                )}
              >
                <span className="text-xs font-medium text-ink">{t(card.label)}</span>
                <span className="mt-1 block text-[11px] leading-4 text-ink-dim">{t(card.hint)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
