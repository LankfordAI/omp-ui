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

const ACCENT_FIELDS: ReadonlyArray<{ accent: ThemeSeedAccent; label: string }> = [
  { accent: "signal", label: "Agent activity (green)" },
  { accent: "copper", label: "Attention" },
  { accent: "rose", label: "Error" },
  { accent: "iris", label: "Your messages" },
];

const SYNTAX_FIELDS: ReadonlyArray<{ seed: ThemeSyntaxSeed; label: string }> = [
  { seed: "comment", label: "Comment" },
  { seed: "string", label: "String" },
  { seed: "constant", label: "Constant" },
  { seed: "function", label: "Function" },
  { seed: "type", label: "Type" },
  { seed: "property", label: "Property" },
];

/** The failing pairings, plane collapses and signal hue, one line each. */
export function GateFailureList({ failures }: { failures: readonly ThemeGateFailure[] }) {
  return (
    <ul className="mt-1 list-disc pl-4 font-mono text-xs text-ink-mid">
      {failures.map((failure) => (
        <li key={failure.kind === "signal" ? "signal" : failure.label}>
          {failure.kind === "contrast"
            ? `${failure.label}: ${failure.ratio.toFixed(2)}:1 (needs ${String(failure.min)}:1)`
            : failure.kind === "planes"
              ? `${failure.label}: the two planes are the same colour`
              : `Agent activity colour must be a green (its hue is ${String(Math.round(failure.hue))}°; 100° to 200° is allowed).`}
        </li>
      ))}
    </ul>
  );
}

/** Why a theme was not saved: shared by the VS Code import, the file import and the editor. */
export function GateFailures({ label, failures }: { label: string; failures: ThemeGateFailure[] }) {
  return (
    <div role="alert" className="mt-2 text-sm text-rose">
      <p>
        {`${label} was not saved: ${String(failures.length)} colour checks are below the floor.`}
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
      setBackdropError("Cannot use that file: backdrops can be at most 4 MiB.");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkBackdropBytes(bytes);
    if (!check.ok) {
      setBackdropError(`Cannot use that file: ${check.message}`);
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
          ? `Edit ${initial.label}`
          : "New theme"}
      </h3>

      <div className="mt-2 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-ink-mid">
          Name
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
            Start from
            <select value="" onChange={(event) => pickStart(event.target.value)} className={FIELD}>
              <option value="" disabled>
                Choose a theme…
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
          label="Canvas"
          value={seeds.canvas}
          onChange={(hex) => setSeeds((prev) => ({ ...prev, canvas: hex }))}
        />
        <ColourField
          label="Ink"
          value={seeds.ink}
          onChange={(hex) => setSeeds((prev) => ({ ...prev, ink: hex }))}
        />
      </div>

      <h4 className="mt-3 text-sm font-semibold text-ink">Accents</h4>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2">
        {ACCENT_FIELDS.map(({ accent, label: fieldLabel }) => (
          <div key={accent}>
            <ColourField
              label={fieldLabel}
              value={seeds.accents[accent] ?? "#000000"}
              onChange={(hex) => setAccent(accent, hex)}
            />
            {accent === "signal" && (
              <p className="mt-0.5 text-xs leading-snug text-ink-faint">Must stay a green: it is the only colour that means the agent is working.</p>
            )}
          </div>
        ))}
      </div>

      <Disclosure
        className="mt-3"
        summary={<span className="text-sm font-semibold">Code colours</span>}
      >
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2">
          {SYNTAX_FIELDS.map(({ seed, label: fieldLabel }) => (
            <ColourField
              key={seed}
              label={fieldLabel}
              value={seeds.syntax[seed] ?? "#000000"}
              onChange={(hex) => setSyntax(seed, hex)}
            />
          ))}
        </div>
      </Disclosure>

      <h4 className="mt-3 text-sm font-semibold text-ink">Backdrop</h4>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button onClick={() => picker.current?.click()}>Choose image or scene…</Button>
        {backdrop !== null && (
          <Button variant="ghost" onClick={() => setBackdrop(null)}>
            Remove backdrop
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
              Blur <span className="font-mono text-xs text-ink-dim">{blur}px</span>
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
              {`Text panels stay at least ${String(floors.reading)}% solid; sidebar ${String(floors.sunken)}%.`}
            </span>
          </label>
        </div>
      )}

      <h4 className="mt-3 text-sm font-semibold text-ink">Preview</h4>
      <div data-testid="theme-editor-sample" className="mt-1.5">
        <ThemeSpecimen theme={draftTheme} variant="card" asset={asset} />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="min-w-0 flex-1 text-sm text-ink-mid">
          Preview in app
          {failures.length > 0 && (
            <span className="block text-xs text-ink-faint">Fix the problems below to preview the theme in the app.</span>
          )}
        </span>
        <Switch
          on={previewActive}
          disabled={failures.length > 0}
          onChange={setPreviewOn}
          label="Preview in app"
        />
      </div>

      {failures.length > 0 && (
        <div data-testid="theme-editor-problems" className="mt-2 text-sm text-rose">
          <p>{`Not ready to save: ${String(failures.length)} colour checks fail.`}</p>
          <GateFailureList failures={failures} />
        </div>
      )}
      {result?.ok === false && result.reason === "gate" && (
        <GateFailures label={result.label} failures={result.failures} />
      )}
      {result?.ok === false && result.reason === "invalid" && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {`Could not save: ${result.message}`}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {`Could not save: ${error}`}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="solid" disabled={!canSave} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
