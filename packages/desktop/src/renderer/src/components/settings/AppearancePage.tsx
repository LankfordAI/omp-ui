import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { effectiveThemeId, type ThemeMode, type ThemeSource } from "@omp-ui/core/theme";
import {
  parseThemeFile,
  THEME_FILE_FORMAT,
  type DraftBackdrop,
  type SaveStoredThemeResult,
  type ThemeFile,
  THEME_FILE_BYTES_MAX,
} from "@omp-ui/core/theme-file";
import { seedsOfTheme, type ThemeSeeds } from "@omp-ui/core/theme-seeds";
import type { GlassChrome, TranscriptWidth } from "@omp-ui/core/types";
import type { VsCodeImportResult } from "@omp-ui/core/vscode-theme";
import { backend, displayMessage } from "../../backend";
import { downloadBlob, safeDownloadName } from "../../lib/artifact-parts";
import { cn } from "../../lib/cn";
import { FONT_FAMILIES, resolveFontFamily } from "../../lib/font-families";
import { GLASS_CHROME_STEPS, resolveGlassChrome } from "../../lib/glass-chrome";
import { resolveTheme, usePrefersDarkScheme } from "../../lib/themes";
import {
  TRANSCRIPT_WIDTHS,
  resolveTranscriptWidth,
} from "../../lib/transcript-width";
import { useStore } from "../../store";
import { Switch } from "../ui";
import { Row } from "./rows";
import { CURATED_SOURCES, GateFailures, ThemeEditor } from "./ThemeEditor";
import { ThemeSharePanel } from "./ThemeSharePanel";
import { ThemeWall } from "./ThemeWall";

/**
 * Label each transcript-width card paints (issue #391). The old mini-column
 * bar is gone: the WidthMock below now shows column cap vs prose measure
 * honestly (issue #1059).
 */
const WIDTH_CARDS: Record<TranscriptWidth, { label: string }> = {
  comfortable: { label: "Comfortable" },
  wide: { label: "Wide" },
  full: { label: "Full" },
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
const GLASS_CARDS: Record<GlassChrome, { label: string; hint: string }> = {
  off: { label: "Off", hint: "Opaque planes, as before." },
  subtle: {
    label: "Subtle",
    hint: "A hint of depth; light blur.",
  },
  frosted: {
    label: "Frosted",
    hint: "Stronger blur and wash; costs a little GPU.",
  },
};

/** Reads every picked file as UTF-8, the theme first (the picker's own order). */
async function readPicked(list: FileList): Promise<{ name: string; text: string }[]> {
  return await Promise.all([...list].map(async (file) => ({ name: file.name, text: await file.text() })));
}

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
        : { from: "asset", assetHash: backdrop.assetHash, blur: backdrop.blur },
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
      file.backdrop = { mime: bytes.mime, data: bytes.data, blur: source.backdrop.blur };
    }
  }
  return file;
}

/** A save verdict from the host: saved, refused by the gate, or invalid. */
function SaveVerdict({ result }: { result: SaveStoredThemeResult }) {
  if (result.ok) {
    return (
      <p role="status" className="mt-2 text-sm text-ink-mid">
        {`Saved ${result.source.label}.`}
      </p>
    );
  }
  if (result.reason === "gate") return <GateFailures label={result.label} failures={result.failures} />;
  return (
    <p role="alert" className="mt-2 text-sm text-rose">
      {`Could not import: ${result.message}`}
    </p>
  );
}

/**
 * The Themes tab: the theme wall, plus what it hands back up: the editor
 * (issue #1168), the omp-ui theme file and VS Code imports (issue #999), and
 * their verdicts. The editor or the Share panel (#1212) replaces the wall
 * while open; the wall stays mounted, hidden, so Show, filters and an open
 * listing survive the edit.
 */
function ThemesTab() {
  const state = useStore((s) => s.state);
  const importVsCodeTheme = useStore((s) => s.importVsCodeTheme);
  const saveStoredTheme = useStore((s) => s.saveStoredTheme);
  const prefersDark = usePrefersDarkScheme();
  const vsCodePicker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<EditorInitial | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vsCodeResult, setVsCodeResult] = useState<VsCodeImportResult | null>(null);
  const [fileResult, setFileResult] = useState<SaveStoredThemeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sources = state?.storedThemes ?? [];
  const themeMode: ThemeMode = state?.themeMode ?? "fixed";
  const preference = {
    themeMode,
    themeId: resolveTheme(state?.themeId, sources).id,
    lightThemeId: resolveTheme(state?.lightThemeId ?? "light", sources).id,
    darkThemeId: resolveTheme(state?.darkThemeId, sources).id,
  };
  const showing = resolveTheme(effectiveThemeId(preference, prefersDark), sources);
  // Closes by itself when the theme is removed, from this window or another.
  const sharing = sharingId === null ? null : (sources.find((s) => s.id === sharingId) ?? null);

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
      setError(`Could not import: ${displayMessage(err)}`);
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
        setError("That file is too large to be a theme file (6 MiB at most).");
        return;
      }
      setBusy(true);
      const parsed = parseThemeFile(await file.text());
      if (!parsed.ok) {
        setError(`Could not import: ${parsed.message}`);
        return;
      }
      setFileResult(await saveStoredTheme(parsed.draft));
    } catch (err) {
      setError(`Could not save: ${displayMessage(err)}`);
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
      setError(`Could not export: ${displayMessage(err)}`);
    }
  };

  const verdict = (
    <>
      {vsCodeResult?.ok === true && (
        <p role="status" className="mt-2 text-sm text-ink-mid">
          {`Imported ${vsCodeResult.source.label}.`}
        </p>
      )}
      {vsCodeResult?.ok === false && vsCodeResult.reason === "parse" && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {`Could not import: ${vsCodeResult.message}`}
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
    </>
  );

  return (
    <>
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
      {editing !== null && <ThemeEditor initial={editing} onClose={() => setEditing(null)} />}
      {sharing !== null && (
        <ThemeSharePanel source={sharing} themeFile={themeFileOf} onClose={() => setSharingId(null)} />
      )}
      <div hidden={editing !== null || sharing !== null}>
        <ThemeWall
          sources={sources}
          pick={preference}
          showing={showing}
          busy={busy}
          verdict={verdict}
          onNewTheme={() =>
            openEditor({
              label: "My theme",
              // Seeds read the showing theme's raw source; the derived Theme has no syntax seeds.
              seeds: seedsOfTheme(
                [...CURATED_SOURCES, ...sources].find((candidate) => candidate.id === showing.id) ??
                  CURATED_SOURCES[0]!,
              ),
              backdrop: null,
            })
          }
          onImportFile={() => filePicker.current?.click()}
          onImportVsCode={() => vsCodePicker.current?.click()}
          onEdit={(source) => openEditor(editorInitialOf(source, source.label, source.id))}
          onDuplicate={(source) =>
            openEditor(editorInitialOf(source, `${source.label} copy`))
          }
          onExport={(source) => void exportTheme(source)}
          onShare={(source) => {
            clearVerdicts();
            setSharingId(source.id);
          }}
        />
      </div>
    </>
  );
}

/** The Display tab: font family, transcript width, glass chrome and backdrop motion. */
function DisplaySection() {
  const fontFamilyId = useStore((s) => s.state?.fontFamilyId);
  const setFontFamilyId = useStore((s) => s.setFontFamilyId);
  const transcriptWidth = useStore((s) => s.state?.transcriptWidth);
  const setTranscriptWidth = useStore((s) => s.setTranscriptWidth);
  const glassChrome = useStore((s) => s.state?.glassChrome);
  const setGlassChrome = useStore((s) => s.setGlassChrome);
  const backdropMotion = useStore((s) => s.state?.backdropMotion);
  const setBackdropMotion = useStore((s) => s.setBackdropMotion);
  const activeFamilyId = resolveFontFamily(fontFamilyId).id;
  const activeWidthId = resolveTranscriptWidth(transcriptWidth).id;
  const activeGlassId = resolveGlassChrome(glassChrome).id;

  return (
    <>
      <div className="pt-2">
        <h3 className="text-base font-semibold text-ink">Font family</h3>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
          Default is the app's own typeface — Bricolage Grotesque, Instrument Sans, and JetBrains Mono. Ubuntu swaps the whole set, code and terminals included.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {FONT_FAMILIES.map((f) => {
            const active = f.id === activeFamilyId;
            return (
              <button
                key={f.id}
                type="button"
                aria-label={`${f.label} font family`}
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
          Transcript width
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
          How wide the transcript column and composer card may grow. Prose keeps a readable measure at every step; tool cards, code, tables, and diffs take the whole column — and Full lets the column take the pane.
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {TRANSCRIPT_WIDTHS.map((w) => {
            const active = w.id === activeWidthId;
            const card = WIDTH_CARDS[w.id];
            return (
              <button
                key={w.id}
                type="button"
                aria-label={`${card.label} transcript width`}
                aria-pressed={active}
                onClick={() => void setTranscriptWidth(w.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors duration-150",
                  active
                    ? "border-line-strong bg-hover"
                    : "border-line bg-raised hover:border-line-strong",
                )}
              >
                <span className="text-sm font-medium text-ink">{card.label}</span>
                <span className="mt-2 block text-ink-dim">
                  <WidthMock col={WIDTH_CARD_MOCKS[w.id]} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <h3 className="text-base font-semibold text-ink">Glass chrome</h3>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
          Lets the sidebar, rail, title bar, composer card, and dialogs show a soft backdrop through them. Text is never blurred; terminals stay opaque.
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {GLASS_CHROME_STEPS.map((g) => {
            const active = g.id === activeGlassId;
            const card = GLASS_CARDS[g.id];
            return (
              <button
                key={g.id}
                type="button"
                aria-label={`${card.label} glass chrome`}
                aria-pressed={active}
                onClick={() => void setGlassChrome(g.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors duration-150",
                  active
                    ? "border-line-strong bg-hover"
                    : "border-line bg-raised hover:border-line-strong",
                )}
              >
                <span className="text-sm font-medium text-ink">{card.label}</span>
                <span className="mt-1 block text-sm leading-snug text-ink-dim">{card.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft">
        <Row
          title="Animate backdrops"
          hint="Lets a theme's scene move. Costs some GPU while the window is visible; pauses when it is hidden or when the system asks for reduced motion. Backdrops show beside the transcript, so a full-width transcript leaves little room for them."
        >
          <Switch
            on={backdropMotion !== false}
            onChange={(next) => void setBackdropMotion(next)}
            label="Animate backdrops"
          />
        </Row>
      </div>
    </>
  );
}

type AppearanceTab = "themes" | "display";
const APPEARANCE_TABS: ReadonlyArray<{ id: AppearanceTab; label: string }> = [
  { id: "themes", label: "Themes" },
  { id: "display", label: "Display" },
];

export function AppearancePage() {
  const [tab, setTab] = useState<AppearanceTab>("themes");
  const tabRefs = useRef<Partial<Record<AppearanceTab, HTMLButtonElement | null>>>({});

  // WAI-ARIA tabs: roving tabindex, arrows/Home/End move selection AND focus
  // (ProjectSettings.tsx onTabListKeyDown).
  const onTabListKeyDown = (event: KeyboardEvent): void => {
    const index = APPEARANCE_TABS.findIndex((candidate) => candidate.id === tab);
    const count = APPEARANCE_TABS.length;
    const target =
      event.key === "ArrowRight" ? (index + 1) % count
        : event.key === "ArrowLeft" ? (index + count - 1) % count
          : event.key === "Home" ? 0
            : event.key === "End" ? count - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = APPEARANCE_TABS[target]!;
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <div className="px-4 pb-3">
      <div
        role="tablist"
        aria-label="Appearance sections"
        onKeyDown={onTabListKeyDown}
        className="-mx-4 mb-1 flex gap-1 border-b border-line px-4 py-2"
      >
        {APPEARANCE_TABS.map((candidate) => {
          const selected = candidate.id === tab;
          return (
            <button
              key={candidate.id}
              ref={(node) => {
                tabRefs.current[candidate.id] = node;
              }}
              type="button"
              role="tab"
              id={`appearance-tab-${candidate.id}`}
              aria-selected={selected}
              aria-controls={`appearance-panel-${candidate.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(candidate.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                selected ? "bg-hover text-ink" : "text-ink-mid hover:text-ink",
              )}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`appearance-panel-${tab}`} aria-labelledby={`appearance-tab-${tab}`}>
        {tab === "themes" ? <ThemesTab /> : <DisplaySection />}
      </div>
    </div>
  );
}
