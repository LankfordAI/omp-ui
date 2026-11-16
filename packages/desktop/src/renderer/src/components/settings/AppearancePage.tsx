import { useRef, useState, type ChangeEvent } from "react";
import { effectiveThemeId, storedThemeKind, type ThemeMode, type ThemeSource } from "@omp-ui/core/theme";
import {
  parseThemeFile,
  THEME_FILE_FORMAT,
  type DraftBackdrop,
  type SaveStoredThemeResult,
  type ThemeFile,
} from "@omp-ui/core/theme-file";
import { seedsOfTheme, type ThemeSeeds } from "@omp-ui/core/theme-seeds";
import type { GlassChrome, TranscriptWidth } from "@omp-ui/core/types";
import type { VsCodeImportResult } from "@omp-ui/core/vscode-theme";
import { backend, displayMessage } from "../../backend";
import { downloadBlob, safeDownloadName } from "../../lib/artifact-parts";
import { cn } from "../../lib/cn";
import { FONT_FAMILIES, resolveFontFamily } from "../../lib/font-families";
import { GLASS_CHROME_STEPS, resolveGlassChrome } from "../../lib/glass-chrome";
import { useT, type MessageKey } from "../../lib/i18n";
import { resolveTheme, storedThemes, THEMES, usePrefersDarkScheme, type Theme } from "../../lib/themes";
import {
  TRANSCRIPT_WIDTHS,
  resolveTranscriptWidth,
} from "../../lib/transcript-width";
import { useStore } from "../../store";
import { Button, ChoiceCapsule, Chip, Switch } from "../ui";
import { Row } from "./rows";
import { CURATED_SOURCES, GateFailures, ThemeEditor } from "./ThemeEditor";

/**
 * Label each transcript-width card paints (issue #391). The old mini-column
 * bar is gone: the WidthMock below now shows column cap vs prose measure
 * honestly (issue #1059).
 */
const WIDTH_CARDS: Record<TranscriptWidth, { label: MessageKey }> = {
  comfortable: { label: "settings.appearance.widthComfortable" },
  wide: { label: "settings.appearance.widthWide" },
  full: { label: "settings.appearance.widthFull" },
};

/** Column cap (as a share of card width) each transcript-width mock draws. */
const WIDTH_CARD_MOCKS: Record<TranscriptWidth, number> = {
  comfortable: 50,
  wide: 64,
  full: 100,
};

/**
 * Two-plane preview for a transcript-width card (issue #1059): the bright
 * outline is the centred column cap, the faint wash inside it is the prose
 * measure, flush-left with the column. Stretches with the card like the old
 * single bar did, so the mock promises only what the CSS now delivers.
 */
function WidthMock({ col }: { col: number }) {
  const x = (100 - col) / 2;
  return (
    <svg
      className="block h-4 w-full"
      viewBox="0 0 100 16"
      preserveAspectRatio="none"
      width="100%"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x={x}
        y={4}
        width={col}
        height={8}
        rx={1.5}
        fill="currentColor"
        fillOpacity={0.28}
        stroke="currentColor"
        strokeOpacity={0.6}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <rect
        x={x}
        y={4}
        width={col * 0.78}
        height={8}
        rx={1.5}
        fill="currentColor"
        fillOpacity={0.12}
      />
    </svg>
  );
}

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
  // A stored theme may reuse a curated theme's label (VS Code's own Dark
  // Modern), so its accessible name says which kind it is.
  const kind = storedThemeKind(theme.id);
  const kindLabel =
    kind === "imported"
      ? t("settings.appearance.themeImported")
      : kind === "authored"
        ? t("settings.appearance.themeAuthored")
        : null;
  const name = kindLabel !== null ? `${theme.label} (${kindLabel})` : theme.label;
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
        <span className="truncate text-sm font-medium text-ink">{theme.label}</span>
        <Chip>{theme.dark ? t("settings.appearance.themeDark") : t("settings.appearance.themeLight")}</Chip>
        {kindLabel !== null && <Chip>{kindLabel}</Chip>}
        {theme.backdrop !== null && <Chip>{t("settings.appearance.themeBackdrop")}</Chip>}
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

/** A grid of every curated and stored theme, one of them pressed. */
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

/** An omp-ui theme file larger than this cannot hold a valid one (a 4 MiB backdrop as base64, plus seeds). */
const THEME_FILE_BYTES_MAX = 6 * 1024 * 1024;

/** What the editor opens with: the seeds, label, optional id to replace, and backdrop. */
type EditorInitial = { id?: string; label: string; seeds: Required<ThemeSeeds>; backdrop: DraftBackdrop | null };

/** A stored source in the editor, reusing its stored backdrop asset. */
function editorInitialOf(source: ThemeSource, label: string, id?: string): EditorInitial {
  const backdrop = source.backdrop;
  return {
    ...(id !== undefined ? { id } : {}),
    label,
    seeds: seedsOfTheme(source),
    backdrop:
      backdrop === undefined
        ? null
        : { from: "asset", assetHash: backdrop.assetHash, dim: backdrop.dim, blur: backdrop.blur },
  };
}

/** A stored theme as an omp-ui theme file; the backdrop rides along when its bytes are still stored. */
async function themeFileOf(source: ThemeSource): Promise<ThemeFile> {
  const file: ThemeFile = {
    format: THEME_FILE_FORMAT,
    version: 1,
    label: source.label,
    seeds: seedsOfTheme(source),
  };
  if (source.backdrop !== undefined) {
    const bytes = await backend.readThemeBackdrop(source.backdrop.assetHash);
    if (bytes !== null) {
      file.backdrop = { mime: bytes.mime, data: bytes.data, dim: source.backdrop.dim, blur: source.backdrop.blur };
    }
  }
  return file;
}

/** A save verdict from the host: saved, refused by the gate, or invalid. */
function SaveVerdict({ result }: { result: SaveStoredThemeResult }) {
  const t = useT();
  if (result.ok) {
    return (
      <p role="status" className="mt-2 text-sm text-ink-mid">
        {t("settings.appearance.fileSaved", { name: result.source.label })}
      </p>
    );
  }
  if (result.reason === "gate") return <GateFailures label={result.label} failures={result.failures} />;
  return (
    <p role="alert" className="mt-2 text-sm text-rose">
      {t("settings.appearance.importParseFailed", { message: result.message })}
    </p>
  );
}

/**
 * Your themes (issues #999, #1168): make one from seeds, import an omp-ui
 * theme file or a VS Code theme, and edit, duplicate, export or remove the
 * stored ones. The editor replaces this section while open.
 */
function StoredSection({
  stored,
  sources,
  showing,
}: {
  stored: readonly Theme[];
  sources: readonly ThemeSource[];
  showing: Theme;
}) {
  const t = useT();
  const importVsCodeTheme = useStore((s) => s.importVsCodeTheme);
  const saveStoredTheme = useStore((s) => s.saveStoredTheme);
  const removeStoredTheme = useStore((s) => s.removeStoredTheme);
  const vsCodePicker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<EditorInitial | null>(null);
  const [busy, setBusy] = useState(false);
  const [vsCodeResult, setVsCodeResult] = useState<VsCodeImportResult | null>(null);
  const [fileResult, setFileResult] = useState<SaveStoredThemeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearVerdicts = (): void => {
    setVsCodeResult(null);
    setFileResult(null);
    setError(null);
  };
  const openEditor = (initial: EditorInitial): void => {
    clearVerdicts();
    setEditing(initial);
  };

  const pickVsCode = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const list = event.target.files;
    if (list === null || list.length === 0) return;
    setBusy(true);
    clearVerdicts();
    try {
      setVsCodeResult(await importVsCodeTheme(await readPicked(list)));
    } catch (err) {
      setError(t("settings.appearance.importParseFailed", { message: displayMessage(err) }));
    } finally {
      setBusy(false);
      // Clearing lets the same file be picked again after editing it.
      event.target.value = "";
    }
  };

  const pickThemeFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    clearVerdicts();
    try {
      if (file.size > THEME_FILE_BYTES_MAX) {
        setError(t("settings.appearance.fileTooLarge"));
        return;
      }
      setBusy(true);
      const parsed = parseThemeFile(await file.text());
      if (!parsed.ok) {
        setError(t("settings.appearance.importParseFailed", { message: parsed.message }));
        return;
      }
      setFileResult(await saveStoredTheme(parsed.draft));
    } catch (err) {
      setError(t("settings.appearance.saveFailed", { message: displayMessage(err) }));
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };

  const exportTheme = async (source: ThemeSource): Promise<void> => {
    clearVerdicts();
    try {
      const file = await themeFileOf(source);
      downloadBlob(safeDownloadName(source.label, "json"), "application/json", JSON.stringify(file, null, 2));
    } catch (err) {
      setError(t("settings.appearance.exportFailed", { message: displayMessage(err) }));
    }
  };

  if (editing !== null) {
    return <ThemeEditor initial={editing} onClose={() => setEditing(null)} />;
  }

  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <h3 className="text-base font-semibold text-ink">{t("settings.appearance.storedTitle")}</h3>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">{t("settings.appearance.storedHint")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            openEditor({
              label: t("settings.appearance.editorDefaultName"),
              // Seeds read the showing theme's raw source; the derived Theme has no syntax seeds.
              seeds: seedsOfTheme(
                [...CURATED_SOURCES, ...sources].find((candidate) => candidate.id === showing.id) ??
                  CURATED_SOURCES[0]!,
              ),
              backdrop: null,
            })
          }
        >
          {t("settings.appearance.newTheme")}
        </Button>
        <Button disabled={busy} onClick={() => filePicker.current?.click()}>
          {busy ? t("settings.appearance.importBusy") : t("settings.appearance.importFile")}
        </Button>
        <Button disabled={busy} onClick={() => vsCodePicker.current?.click()}>
          {busy ? t("settings.appearance.importBusy") : t("settings.appearance.importVsCode")}
        </Button>
      </div>
      <input
        ref={filePicker}
        type="file"
        accept=".json,application/json"
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        data-testid="theme-file-picker"
        onChange={(event) => void pickThemeFile(event)}
      />
      <input
        ref={vsCodePicker}
        type="file"
        multiple
        accept=".json,.jsonc,application/json"
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        data-testid="vscode-theme-picker"
        onChange={(event) => void pickVsCode(event)}
      />
      {vsCodeResult?.ok === true && (
        <p role="status" className="mt-2 text-sm text-ink-mid">
          {t("settings.appearance.importSaved", { name: vsCodeResult.source.label })}
        </p>
      )}
      {vsCodeResult?.ok === false && vsCodeResult.reason === "parse" && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {t("settings.appearance.importParseFailed", { message: vsCodeResult.message })}
        </p>
      )}
      {vsCodeResult?.ok === false && vsCodeResult.reason === "contrast" && (
        <GateFailures label={vsCodeResult.label} failures={vsCodeResult.failures} />
      )}
      {fileResult !== null && <SaveVerdict result={fileResult} />}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {error}
        </p>
      )}
      {stored.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {stored.map((theme) => {
            const authored = storedThemeKind(theme.id) === "authored";
            // Duplicate, Edit and Export read the stored source, never the derived Theme.
            const source = sources.find((candidate) => candidate.id === theme.id);
            return (
              <li key={theme.id} className="flex items-center gap-2 text-sm text-ink-mid">
                <span className="min-w-0 flex-1 truncate">{theme.label}</span>
                <Chip>
                  {authored ? t("settings.appearance.themeAuthored") : t("settings.appearance.themeImported")}
                </Chip>
                {authored && source !== undefined && (
                  <Button
                    variant="ghost"
                    aria-label={t("settings.appearance.editAria", { name: theme.label })}
                    onClick={() => openEditor(editorInitialOf(source, source.label, source.id))}
                  >
                    {t("settings.appearance.edit")}
                  </Button>
                )}
                {source !== undefined && (
                  <Button
                    variant="ghost"
                    aria-label={t("settings.appearance.duplicateAria", { name: theme.label })}
                    onClick={() =>
                      openEditor(
                        editorInitialOf(source, t("settings.appearance.duplicateName", { name: source.label })),
                      )
                    }
                  >
                    {t("settings.appearance.duplicate")}
                  </Button>
                )}
                {authored && source !== undefined && (
                  <Button
                    variant="ghost"
                    aria-label={t("settings.appearance.exportAria", { name: theme.label })}
                    onClick={() => void exportTheme(source)}
                  >
                    {t("settings.appearance.export")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  aria-label={t("settings.appearance.removeAria", { name: theme.label })}
                  onClick={() => void removeStoredTheme(theme.id)}
                >
                  {t("settings.appearance.remove")}
                </Button>
              </li>
            );
          })}
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
  const backdropMotion = useStore((s) => s.state?.backdropMotion);
  const setBackdropMotion = useStore((s) => s.setBackdropMotion);
  const prefersDark = usePrefersDarkScheme();
  const t = useT();
  const storedSources = state?.storedThemes ?? [];
  const stored = storedThemes(storedSources);
  const allThemes = [...THEMES, ...stored];
  const themeMode: ThemeMode = state?.themeMode ?? "fixed";
  const preference = {
    themeMode,
    themeId: resolveTheme(state?.themeId, storedSources).id,
    lightThemeId: resolveTheme(state?.lightThemeId ?? "light", storedSources).id,
    darkThemeId: resolveTheme(state?.darkThemeId, storedSources).id,
  };
  const showing = resolveTheme(effectiveThemeId(preference, prefersDark), storedSources);
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
        optionClassName="tab-label px-2"
      />
      {themeMode === "fixed" ? (
        <div className="mt-3">
          <ThemeGrid themes={allThemes} activeId={preference.themeId} onPick={(id) => void setThemeId(id)} />
        </div>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed text-ink-faint">
            {t("settings.appearance.themeModeSystemHint")}
          </p>
          <p data-testid="theme-now-showing" className="mt-1 text-sm text-ink-mid">
            {t("settings.appearance.nowShowing", { name: showing.label })}
          </p>
          <h3 className="mt-3 text-base font-semibold text-ink">{t("settings.appearance.lightTheme")}</h3>
          <div className="mt-2" role="group" aria-label={t("settings.appearance.lightTheme")}>
            <ThemeGrid
              themes={allThemes}
              activeId={preference.lightThemeId}
              onPick={(id) => void setLightThemeId(id)}
            />
          </div>
          <h3 className="mt-3 text-base font-semibold text-ink">{t("settings.appearance.darkTheme")}</h3>
          <div className="mt-2" role="group" aria-label={t("settings.appearance.darkTheme")}>
            <ThemeGrid
              themes={allThemes}
              activeId={preference.darkThemeId}
              onPick={(id) => void setDarkThemeId(id)}
            />
          </div>
        </>
      )}
      <p className="mt-3 text-sm text-ink-faint">
        {t("settings.appearance.mintNote")}
      </p>

      <StoredSection stored={stored} sources={storedSources} showing={showing} />

      <div className="mt-4 border-t border-line-soft pt-3">
        <h3 className="text-base font-semibold text-ink">{t("settings.appearance.fontFamily")}</h3>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
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
                <span className="text-sm font-medium text-ink">{f.label}</span>
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
                  className="mt-0.5 block truncate text-xs leading-4 text-ink-dim"
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
        <h3 className="text-base font-semibold text-ink">
          {t("settings.appearance.transcriptWidth")}
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
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
                <span className="text-sm font-medium text-ink">{t(card.label)}</span>
                <span className="mt-2 block text-ink-dim">
                  <WidthMock col={WIDTH_CARD_MOCKS[w.id]} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <h3 className="text-base font-semibold text-ink">{t("settings.appearance.glassChrome")}</h3>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
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
                <span className="text-sm font-medium text-ink">{t(card.label)}</span>
                <span className="mt-1 block text-sm leading-snug text-ink-dim">{t(card.hint)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft">
        <Row
          title={t("settings.appearance.backdropMotion")}
          hint={t("settings.appearance.backdropMotionHint")}
        >
          <Switch
            on={backdropMotion !== false}
            onChange={(next) => void setBackdropMotion(next)}
            label={t("settings.appearance.backdropMotion")}
          />
        </Row>
      </div>
    </div>
  );
}
