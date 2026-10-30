import { useRef, useState, type ChangeEvent } from "react";
import { effectiveThemeId, IMPORTED_THEME_ID_PREFIX, type ThemeMode } from "@omp-ui/core/theme";
import type { GlassChrome, TranscriptWidth } from "@omp-ui/core/types";
import type { VsCodeImportResult } from "@omp-ui/core/vscode-theme";
import { cn } from "../../lib/cn";
import { FONT_FAMILIES, resolveFontFamily } from "../../lib/font-families";
import { GLASS_CHROME_STEPS, resolveGlassChrome } from "../../lib/glass-chrome";
import { useT, type MessageKey } from "../../lib/i18n";
import { importedThemes, resolveTheme, THEMES, usePrefersDarkScheme, type Theme } from "../../lib/themes";
import {
  TRANSCRIPT_WIDTHS,
  resolveTranscriptWidth,
} from "../../lib/transcript-width";
import { useStore } from "../../store";
import { Button, ChoiceCapsule, Chip } from "../ui";

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

/** One theme card: label, scheme chip, and a swatch strip of that theme's planes and accents. */
function ThemeCard({
  theme,
  active,
  onPick,
}: {
  theme: Theme;
  active: boolean;
  onPick: () => void;
}) {
  const t = useT();
  // An import may reuse a curated theme's label (VS Code's own Dark Modern),
  // so its accessible name says it is the imported one.
  const imported = theme.id.startsWith(IMPORTED_THEME_ID_PREFIX);
  const name = imported ? `${theme.label} (${t("settings.appearance.themeImported")})` : theme.label;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={t("settings.appearance.themeAria", { name })}
      onClick={onPick}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors duration-150",
        active ? "border-line-strong bg-hover" : "border-line bg-raised hover:border-line-strong",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-medium text-ink">{theme.label}</span>
        <Chip>{theme.dark ? t("settings.appearance.themeDark") : t("settings.appearance.themeLight")}</Chip>
        {imported && <Chip>{t("settings.appearance.themeImported")}</Chip>}
      </span>
      {/* Inline styles are the one sanctioned exception here: these
          swatches paint a theme that is NOT the active one, so the
          live CSS tokens cannot express them. */}
      <span className="mt-2 flex h-4 overflow-hidden rounded border border-line">
        {SWATCH_TOKENS.map((token) => (
          <span key={token} className="flex-1" style={{ background: theme.tokens[token] }} />
        ))}
      </span>
    </button>
  );
}

/** A grid of every curated and imported theme, one of them pressed. */
function ThemeGrid({
  themes,
  activeId,
  onPick,
}: {
  themes: readonly Theme[];
  activeId: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {themes.map((theme) => (
        <ThemeCard key={theme.id} theme={theme} active={theme.id === activeId} onPick={() => onPick(theme.id)} />
      ))}
    </div>
  );
}

/** Reads every picked file as UTF-8, the theme first (the picker's own order). */
async function readPicked(list: FileList): Promise<{ name: string; text: string }[]> {
  return await Promise.all([...list].map(async (file) => ({ name: file.name, text: await file.text() })));
}

/** VS Code import: pick, gate on the host, report the verdict, list and remove imports (issue #999). */
function ImportSection({ imported }: { imported: readonly Theme[] }) {
  const t = useT();
  const importVsCodeTheme = useStore((s) => s.importVsCodeTheme);
  const removeImportedTheme = useStore((s) => s.removeImportedTheme);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VsCodeImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const list = event.target.files;
    if (list === null || list.length === 0) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      setResult(await importVsCodeTheme(await readPicked(list)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      // Clearing lets the same file be picked again after editing it.
      event.target.value = "";
    }
  };

  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <h3 className="text-xs font-medium text-ink">{t("settings.appearance.importTitle")}</h3>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.appearance.importHint")}</p>
      <div className="mt-2 flex items-center gap-2">
        <Button disabled={busy} onClick={() => picker.current?.click()}>
          {busy ? t("settings.appearance.importBusy") : t("settings.appearance.importChoose")}
        </Button>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        accept=".json,.jsonc,application/json"
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        data-testid="vscode-theme-picker"
        onChange={(event) => void pick(event)}
      />
      {result?.ok === true && (
        <p role="status" className="mt-2 text-xs text-ink-mid">
          {t("settings.appearance.importSaved", { name: result.source.label })}
        </p>
      )}
      {result?.ok === false && result.reason === "parse" && (
        <p role="alert" className="mt-2 text-xs text-rose">
          {t("settings.appearance.importParseFailed", { message: result.message })}
        </p>
      )}
      {result?.ok === false && result.reason === "contrast" && (
        <div role="alert" className="mt-2 text-xs text-rose">
          <p>
            {t("settings.appearance.importContrastFailed", {
              name: result.label,
              count: String(result.failures.length),
            })}
          </p>
          <ul className="mt-1 list-disc pl-4 font-mono text-[11px] text-ink-mid">
            {result.failures.map((failure) => (
              <li key={failure.label}>
                {failure.kind === "contrast"
                  ? t("settings.appearance.importContrastPair", {
                      label: failure.label,
                      ratio: failure.ratio.toFixed(2),
                      min: String(failure.min),
                    })
                  : t("settings.appearance.importPlanes", { label: failure.label })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-rose">
          {t("settings.appearance.importParseFailed", { message: error })}
        </p>
      )}
      {imported.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {imported.map((theme) => (
            <li key={theme.id} className="flex items-center justify-between gap-2 text-xs text-ink-mid">
              <span className="truncate">{theme.label}</span>
              <Button
                variant="ghost"
                aria-label={t("settings.appearance.importRemoveAria", { name: theme.label })}
                onClick={() => void removeImportedTheme(theme.id)}
              >
                {t("settings.appearance.importRemove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AppearancePage() {
  const state = useStore((s) => s.state);
  const setThemeId = useStore((s) => s.setThemeId);
  const setThemeMode = useStore((s) => s.setThemeMode);
  const setLightThemeId = useStore((s) => s.setLightThemeId);
  const setDarkThemeId = useStore((s) => s.setDarkThemeId);
  const fontFamilyId = useStore((s) => s.state?.fontFamilyId);
  const setFontFamilyId = useStore((s) => s.setFontFamilyId);
  const transcriptWidth = useStore((s) => s.state?.transcriptWidth);
  const setTranscriptWidth = useStore((s) => s.setTranscriptWidth);
  const glassChrome = useStore((s) => s.state?.glassChrome);
  const setGlassChrome = useStore((s) => s.setGlassChrome);
  const prefersDark = usePrefersDarkScheme();
  const t = useT();
  const importedSources = state?.importedThemes ?? [];
  const imported = importedThemes(importedSources);
  const allThemes = [...THEMES, ...imported];
  const themeMode: ThemeMode = state?.themeMode ?? "fixed";
  const preference = {
    themeMode,
    themeId: resolveTheme(state?.themeId, importedSources).id,
    lightThemeId: resolveTheme(state?.lightThemeId ?? "light", importedSources).id,
    darkThemeId: resolveTheme(state?.darkThemeId, importedSources).id,
  };
  const showing = resolveTheme(effectiveThemeId(preference, prefersDark), importedSources);
  const activeFamilyId = resolveFontFamily(fontFamilyId).id;
  const activeWidthId = resolveTranscriptWidth(transcriptWidth).id;
  const activeGlassId = resolveGlassChrome(glassChrome).id;

  return (
    <div className="px-4 py-3">
      <ChoiceCapsule
        label={t("settings.appearance.themeMode")}
        value={themeMode}
        options={[
          { value: "fixed", label: t("settings.appearance.themeModeFixed") },
          { value: "system", label: t("settings.appearance.themeModeSystem") },
        ]}
        onChange={(mode) => void setThemeMode(mode)}
      />
      {themeMode === "fixed" ? (
        <div className="mt-3">
          <ThemeGrid themes={allThemes} activeId={preference.themeId} onPick={(id) => void setThemeId(id)} />
        </div>
      ) : (
        <>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            {t("settings.appearance.themeModeSystemHint")}
          </p>
          <p data-testid="theme-now-showing" className="mt-1 text-[11px] text-ink-mid">
            {t("settings.appearance.nowShowing", { name: showing.label })}
          </p>
          <h3 className="mt-3 text-xs font-medium text-ink">{t("settings.appearance.lightTheme")}</h3>
          <div className="mt-2" role="group" aria-label={t("settings.appearance.lightTheme")}>
            <ThemeGrid
              themes={allThemes}
              activeId={preference.lightThemeId}
              onPick={(id) => void setLightThemeId(id)}
            />
          </div>
          <h3 className="mt-3 text-xs font-medium text-ink">{t("settings.appearance.darkTheme")}</h3>
          <div className="mt-2" role="group" aria-label={t("settings.appearance.darkTheme")}>
            <ThemeGrid
              themes={allThemes}
              activeId={preference.darkThemeId}
              onPick={(id) => void setDarkThemeId(id)}
            />
          </div>
        </>
      )}
      <p className="mt-3 text-[11px] text-ink-faint">
        {t("settings.appearance.mintNote")}
      </p>

      <ImportSection imported={imported} />

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
