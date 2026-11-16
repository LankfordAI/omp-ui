import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import {
  deriveTheme,
  themeGateFailures,
  type Theme,
  type ThemeGateFailure,
  type ThemeSource,
  type ThemeSyntaxSeed,
} from "@omp-ui/core/theme";
import {
  BACKDROP_BLUR_MAX,
  BACKDROP_DEFAULT_BLUR,
  BACKDROP_IMAGE_BYTES_MAX,
  backdropFloors,
  checkBackdropBytes,
  type ThemeBackdropKind,
  type ThemeBackdropMime,
} from "@omp-ui/core/theme-backdrop";
import { sourceFromDraft, type DraftBackdrop, type SaveStoredThemeResult } from "@omp-ui/core/theme-file";
import { seedsOfTheme, type ThemeSeedAccent, type ThemeSeeds } from "@omp-ui/core/theme-seeds";
import { CURATED_THEME_SOURCES } from "@omp-ui/core/theme-sources";
import { displayMessage } from "../../backend";
import {
  backdropAssetFromBytes,
  loadBackdropAsset,
  releaseBackdropAsset,
  setDraftBackdropAsset,
  type BackdropAsset,
} from "../../lib/backdrop";
import { base64ToBytes, bytesToBase64 } from "../../lib/clipboard-image";
import { useT, type MessageKey } from "../../lib/i18n";
import { setThemePreview } from "../../lib/themes";
import { useStore } from "../../store";
import { Button, Disclosure, Switch } from "../ui";
import { FIELD } from "./rows";
import { ThemeSpecimen } from "./ThemeSpecimen";

/**
 * The seed editor (issue #1168, ADR-0094): a few colours in, a whole theme
 * out, gated live by the same check the host runs on save. Rendered inline in
 * the Appearance page; Settings is already the one modal.
 */

/** The curated themes' raw sources: "Start from" and New theme read seeds from them. */
export const CURATED_SOURCES: readonly ThemeSource[] = CURATED_THEME_SOURCES;

/** Placeholder hash for the draft theme's backdrop: the layer reads the draft asset, not the hash. */
const DRAFT_HASH = "0".repeat(64);
/** Trailing debounce for the in-app preview: each repaint re-themes terminals and the window chrome. */
const PREVIEW_DEBOUNCE_MS = 120;
const LABEL_MAX = 80;

const ACCENT_FIELDS: ReadonlyArray<{ accent: ThemeSeedAccent; label: MessageKey }> = [
  { accent: "signal", label: "settings.appearance.seedSignal" },
  { accent: "copper", label: "settings.appearance.seedCopper" },
  { accent: "rose", label: "settings.appearance.seedRose" },
  { accent: "iris", label: "settings.appearance.seedIris" },
];

const SYNTAX_FIELDS: ReadonlyArray<{ seed: ThemeSyntaxSeed; label: MessageKey }> = [
  { seed: "comment", label: "settings.appearance.seedComment" },
  { seed: "string", label: "settings.appearance.seedString" },
  { seed: "constant", label: "settings.appearance.seedConstant" },
  { seed: "function", label: "settings.appearance.seedFunction" },
  { seed: "type", label: "settings.appearance.seedType" },
  { seed: "property", label: "settings.appearance.seedProperty" },
];

/** The failing pairings, plane collapses and signal hue, one line each. */
export function GateFailureList({ failures }: { failures: readonly ThemeGateFailure[] }) {
  const t = useT();
  return (
    <ul className="mt-1 list-disc pl-4 font-mono text-xs text-ink-mid">
      {failures.map((failure) => (
        <li key={failure.kind === "signal" ? "signal" : failure.label}>
          {failure.kind === "contrast"
            ? t("settings.appearance.importContrastPair", {
                label: failure.label,
                ratio: failure.ratio.toFixed(2),
                min: String(failure.min),
              })
            : failure.kind === "planes"
              ? t("settings.appearance.importPlanes", { label: failure.label })
              : t("settings.appearance.gateSignal", { hue: String(Math.round(failure.hue)) })}
        </li>
      ))}
    </ul>
  );
}

/** Why a theme was not saved: shared by the VS Code import, the file import and the editor. */
export function GateFailures({ label, failures }: { label: string; failures: ThemeGateFailure[] }) {
  const t = useT();
  return (
    <div role="alert" className="mt-2 text-sm text-rose">
      <p>
        {t("settings.appearance.importContrastFailed", { name: label, count: String(failures.length) })}
      </p>
      <GateFailureList failures={failures} />
    </div>
  );
}

/** One seed colour: a native colour well with its hex beside it. */
function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-mid">
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-line bg-raised p-0.5"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-xs text-ink-dim">{value}</span>
    </label>
  );
}

/** The draft's backdrop as the editor holds it: picked bytes, or a stored asset by hash. */
type EditorBackdrop =
  | { from: "bytes"; bytes: Uint8Array; mime: ThemeBackdropMime; kind: ThemeBackdropKind }
  | { from: "asset"; assetHash: string };

function initialBackdrop(backdrop: DraftBackdrop | null): EditorBackdrop | null {
  if (backdrop === null) return null;
  if (backdrop.from === "asset") return { from: "asset", assetHash: backdrop.assetHash };
  const bytes = base64ToBytes(backdrop.data);
  const check = checkBackdropBytes(bytes);
  return check.ok ? { from: "bytes", bytes, mime: check.mime, kind: check.kind } : null;
}

export function ThemeEditor(props: {
  initial: { id?: string; label: string; seeds: Required<ThemeSeeds>; backdrop: DraftBackdrop | null };
  onClose: () => void;
}): ReactElement {
  const { initial, onClose } = props;
  const t = useT();
  const saveStoredTheme = useStore((s) => s.saveStoredTheme);
  const storedSources = useStore((s) => s.state?.storedThemes);
  const [label, setLabel] = useState(initial.label);
  const [seeds, setSeeds] = useState<Required<ThemeSeeds>>(initial.seeds);
  const [backdrop, setBackdrop] = useState<EditorBackdrop | null>(() => initialBackdrop(initial.backdrop));
  const [blur, setBlur] = useState(initial.backdrop?.blur ?? BACKDROP_DEFAULT_BLUR);
  const [asset, setAsset] = useState<BackdropAsset | null>(null);
  const [backdropError, setBackdropError] = useState<string | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveStoredThemeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const startFrom = useMemo(() => [...CURATED_SOURCES, ...(storedSources ?? [])], [storedSources]);

  // The source gates the draft; the theme paints the sample and the in-app preview.
  const source = useMemo(() => sourceFromDraft(initial.id ?? "custom-draft", label.trim() || "Draft", seeds), [
    initial.id,
    label,
    seeds,
  ]);
  const failures = useMemo(() => themeGateFailures(source), [source]);
  const assetKind = backdrop === null ? null : backdrop.from === "bytes" ? backdrop.kind : (asset?.kind ?? "image");
  const draftTheme = useMemo<Theme>(() => {
    const derived = deriveTheme(source);
    if (assetKind === null) return { ...derived, backdrop: null };
    return {
      ...derived,
      backdrop: {
        assetHash: DRAFT_HASH,
        kind: assetKind,
        mime: assetKind === "scene" ? "image/svg+xml" : "image/png",
        blur,
      },
    };
  }, [source, assetKind, blur]);

  // Leaving the editor (Save, Cancel, closing Settings, Escape) always restores the saved theme.
  useEffect(
    () => () => {
      setThemePreview(null);
      setDraftBackdropAsset(null);
    },
    [],
  );

  // The draft's backdrop asset: built from picked bytes (released when replaced), or loaded by hash.
  useEffect(() => {
    if (backdrop === null) {
      setAsset(null);
      return;
    }
    if (backdrop.from === "bytes") {
      const built = backdropAssetFromBytes(backdrop.bytes, backdrop.mime);
      setAsset(built);
      return () => releaseBackdropAsset(built);
    }
    let live = true;
    loadBackdropAsset(backdrop.assetHash).then(
      (loaded) => {
        if (live) setAsset(loaded);
      },
      () => {
        if (live) setAsset(null);
      },
    );
    return () => {
      live = false;
    };
  }, [backdrop]);

  const previewActive = previewOn && failures.length === 0;
  useEffect(() => {
    if (!previewActive) {
      setThemePreview(null);
      setDraftBackdropAsset(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setThemePreview(draftTheme);
      setDraftBackdropAsset(asset);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [previewActive, draftTheme, asset]);

  const setAccent = (accent: ThemeSeedAccent, hex: string): void =>
    setSeeds((prev) => ({ ...prev, accents: { ...prev.accents, [accent]: hex } }));
  const setSyntax = (seed: ThemeSyntaxSeed, hex: string): void =>
    setSeeds((prev) => ({ ...prev, syntax: { ...prev.syntax, [seed]: hex } }));

  const pickStart = (id: string): void => {
    const from = startFrom.find((candidate) => candidate.id === id);
    if (from !== undefined) setSeeds(seedsOfTheme(from));
  };

  const pickBackdrop = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Clearing lets the same file be picked again.
    event.target.value = "";
    if (file === undefined) return;
    setBackdropError(null);
    if (file.size > BACKDROP_IMAGE_BYTES_MAX) {
      setBackdropError(t("settings.appearance.backdropTooLarge"));
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkBackdropBytes(bytes);
    if (!check.ok) {
      setBackdropError(t("settings.appearance.backdropRefused", { message: check.message }));
      return;
    }
    setBackdrop({ from: "bytes", bytes, mime: check.mime, kind: check.kind });
  };

  const draftBackdrop = (): DraftBackdrop | null => {
    if (backdrop === null) return null;
    return backdrop.from === "bytes"
      ? { from: "bytes", data: bytesToBase64(backdrop.bytes), blur }
      : { from: "asset", assetHash: backdrop.assetHash, blur };
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const saved = await saveStoredTheme({
        ...(initial.id !== undefined ? { id: initial.id } : {}),
        label: label.trim(),
        seeds,
        backdrop: draftBackdrop(),
      });
      if (saved.ok) {
        // Saving never switches the active theme: drop the preview and close.
        setThemePreview(null);
        setDraftBackdropAsset(null);
        onClose();
        return;
      }
      setResult(saved);
    } catch (err) {
      setError(displayMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const floors = backdropFloors(draftTheme.tokens);
  const canSave = !busy && failures.length === 0 && label.trim() !== "";

  return (
    <div data-testid="theme-editor" className="mt-4 border-t border-line-soft pt-3">
      <h3 className="text-base font-semibold text-ink">
        {initial.id !== undefined
          ? t("settings.appearance.editorTitleEdit", { name: initial.label })
          : t("settings.appearance.newTheme")}
      </h3>

      <div className="mt-2 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-ink-mid">
          {t("settings.appearance.editorName")}
          <input
            type="text"
            maxLength={LABEL_MAX}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className={FIELD}
          />
        </label>
        {initial.id === undefined && (
          <label className="flex flex-col gap-1 text-sm text-ink-mid">
            {t("settings.appearance.editorStartFrom")}
            <select value="" onChange={(event) => pickStart(event.target.value)} className={FIELD}>
              <option value="" disabled>
                {t("settings.appearance.editorStartFromPick")}
              </option>
              {startFrom.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <ColourField
          label={t("settings.appearance.seedCanvas")}
          value={seeds.canvas}
          onChange={(hex) => setSeeds((prev) => ({ ...prev, canvas: hex }))}
        />
        <ColourField
          label={t("settings.appearance.seedInk")}
          value={seeds.ink}
          onChange={(hex) => setSeeds((prev) => ({ ...prev, ink: hex }))}
        />
      </div>

      <h4 className="mt-3 text-sm font-semibold text-ink">{t("settings.appearance.editorAccents")}</h4>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2">
        {ACCENT_FIELDS.map(({ accent, label: key }) => (
          <div key={accent}>
            <ColourField
              label={t(key)}
              value={seeds.accents[accent] ?? "#000000"}
              onChange={(hex) => setAccent(accent, hex)}
            />
            {accent === "signal" && (
              <p className="mt-0.5 text-xs leading-snug text-ink-faint">{t("settings.appearance.seedSignalHint")}</p>
            )}
          </div>
        ))}
      </div>

      <Disclosure
        className="mt-3"
        summary={<span className="text-sm font-semibold">{t("settings.appearance.seedSyntax")}</span>}
      >
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2">
          {SYNTAX_FIELDS.map(({ seed, label: key }) => (
            <ColourField
              key={seed}
              label={t(key)}
              value={seeds.syntax[seed] ?? "#000000"}
              onChange={(hex) => setSyntax(seed, hex)}
            />
          ))}
        </div>
      </Disclosure>

      <h4 className="mt-3 text-sm font-semibold text-ink">{t("settings.appearance.editorBackdrop")}</h4>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button onClick={() => picker.current?.click()}>{t("settings.appearance.backdropChoose")}</Button>
        {backdrop !== null && (
          <Button variant="ghost" onClick={() => setBackdrop(null)}>
            {t("settings.appearance.backdropRemove")}
          </Button>
        )}
      </div>
      <input
        ref={picker}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.svg"
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        data-testid="theme-backdrop-picker"
        onChange={(event) => void pickBackdrop(event)}
      />
      {backdropError !== null && (
        <p role="alert" className="mt-1.5 text-sm text-rose">
          {backdropError}
        </p>
      )}
      {backdrop !== null && (
        <div className="mt-2 grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm text-ink-mid">
            <span>
              {t("settings.appearance.backdropBlur")} <span className="font-mono text-xs text-ink-dim">{blur}px</span>
            </span>
            <input
              type="range"
              min={0}
              max={BACKDROP_BLUR_MAX}
              step={2}
              value={blur}
              onChange={(event) => setBlur(Number(event.target.value))}
            />
            <span className="text-xs leading-snug text-ink-faint">
              {t("settings.appearance.backdropFloorNote", {
                reading: String(floors.reading),
                sunken: String(floors.sunken),
              })}
            </span>
          </label>
        </div>
      )}

      <h4 className="mt-3 text-sm font-semibold text-ink">{t("settings.appearance.editorPreview")}</h4>
      <div data-testid="theme-editor-sample" className="mt-1.5">
        <ThemeSpecimen theme={draftTheme} variant="card" asset={asset} />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="min-w-0 flex-1 text-sm text-ink-mid">
          {t("settings.appearance.previewInApp")}
          {failures.length > 0 && (
            <span className="block text-xs text-ink-faint">{t("settings.appearance.previewBlocked")}</span>
          )}
        </span>
        <Switch
          on={previewActive}
          disabled={failures.length > 0}
          onChange={setPreviewOn}
          label={t("settings.appearance.previewInApp")}
        />
      </div>

      {failures.length > 0 && (
        <div data-testid="theme-editor-problems" className="mt-2 text-sm text-rose">
          <p>{t("settings.appearance.editorProblems", { count: String(failures.length) })}</p>
          <GateFailureList failures={failures} />
        </div>
      )}
      {result?.ok === false && result.reason === "gate" && (
        <GateFailures label={result.label} failures={result.failures} />
      )}
      {result?.ok === false && result.reason === "invalid" && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {t("settings.appearance.saveFailed", { message: result.message })}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {t("settings.appearance.saveFailed", { message: error })}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("settings.appearance.cancel")}
        </Button>
        <Button variant="solid" disabled={!canSave} onClick={() => void save()}>
          {t("settings.appearance.save")}
        </Button>
      </div>
    </div>
  );
}
