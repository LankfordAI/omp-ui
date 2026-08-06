import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { filterModelsForTab } from "../lib/model-filter";
import { fuzzyBest } from "../lib/fuzzy";
import type { ModelInfo } from "../lib/rpc-types";
import { useStore } from "../store";
import { CAPSULE_SEGMENT, Chevron, Chip, Dot, Label, Modal, StarIcon } from "./ui";
import { ModelRail } from "./ModelRail";

/**
 * omp offers 414 models. A `<select>` cannot be navigated, so this is a
 * searchable palette: type to narrow, arrows to move, Enter to pick.
 */

/**
 * omp reports `cost` in USD per million tokens, so it is shown as-is. Two
 * significant figures is the most that ever distinguishes two models, and
 * trailing zeros just make the chip wider.
 */
function priceLabel(cost: ModelInfo["cost"]): string | null {
  const input = cost?.input;
  const output = cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (input === 0 && output === 0) return "free";
  const money = (n: number) => `$${Number(n.toFixed(n < 1 ? 2 : n < 10 ? 1 : 0))}`;
  return `${money(input)}/${money(output)}`;
}

function windowLabel(window: number | undefined): string | null {
  if (typeof window !== "number" || window <= 0) return null;
  return window >= 1_000_000
    ? `${Math.round(window / 100_000) / 10}M`.replace(".0M", "M")
    : `${Math.round(window / 1000)}K`;
}

/** Stable empty array so the selector doesn't resubscribe on every store tick. */
const EMPTY: ModelInfo[] = [];
/** Stable empty array for favorites so the useMemo dependency is referentially stable. */
const EMPTY_FAVORITES: string[] = [];

export function ModelSelector({ tabId, disabled }: { tabId: string; disabled?: boolean }) {
  const model = useStore((s) => s.rpc[tabId]?.model ?? null);
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY);
  const setModel = useStore((s) => s.setModel);
  const openSettings = useStore((s) => s.openSettings);
  const [open, setOpen] = useState(false);

  // Either `get_available_models` failed, or omp has no authenticated provider
  // at all — the common cause of the latter is a GUI launch that inherited no
  // API keys, so this doubles as the entry point to the providers page.
  if (models.length === 0) {
    return (
      <button
        type="button"
        disabled={disabled}
        title={model?.id ?? "no models available — add a provider key"}
        onClick={() => openSettings("providers")}
        className="flex items-center px-1.5 font-mono text-[11px] text-ink-mid hover:text-ink"
      >
        {model === null ? "no models" : model.id}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        title={model === null ? "pick a model" : `${model.provider}/${model.id}`}
        onClick={() => setOpen(true)}
        className={cn(CAPSULE_SEGMENT, "max-w-56 text-xs font-medium text-ink-mid")}
      >
        <span className="truncate">{model === null ? "no model" : model.name || model.id}</span>
        <Chevron open={false} className="rotate-90 text-ink-faint" />
      </button>
      {open && (
        <ModelPalette
          models={models}
          current={model}
          onClose={() => setOpen(false)}
          onPick={(picked) => {
            setOpen(false);
            void setModel(tabId, picked);
          }}
        />
      )}
    </>
  );
}

/** Rendering 414 rows costs more than it informs; the palette pages by search. */
const VISIBLE_LIMIT = 120;

export function ModelPalette({
  models,
  current,
  onPick,
  onClose,
}: {
  models: ModelInfo[];
  current: ModelInfo | null;
  onPick(model: ModelInfo): void;
  onClose(): void;
}) {
  const favoriteKeys = useStore((s) => s.state?.modelFavorites ?? EMPTY_FAVORITES);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const openSettings = useStore((s) => s.openSettings);
  const favorites = useMemo(() => new Set(favoriteKeys), [favoriteKeys]);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const activeRow = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  // Derive unique providers sorted alphabetically
  const providers = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const m of models) {
      if (!seen.has(m.provider)) {
        seen.add(m.provider);
        result.push(m.provider);
      }
    }
    return result.sort((a, b) => a.localeCompare(b));
  }, [models]);

  // Every palette mount starts from the stable Favorites entry point.
  const [tab, setTab] = useState("favorites");

  // Build ordered tab list for keyboard cycling
  const tabOrder = useMemo(
    () => ["favorites", ...providers],
    [providers],
  );

  useEffect(() => {
    search.current?.focus();
  }, []);

  // Filter by tab, then fuzzy search
  const { shown, matched } = useMemo(() => {
    const filtered = filterModelsForTab(models, tab, favorites);

    const scored: { model: ModelInfo; score: number }[] = [];
    for (const model of filtered) {
      const best = fuzzyBest(query, [
        { text: model.name, weight: 1 },
        { text: model.id, weight: 0.95 },
        { text: model.provider, weight: 0.6 },
      ]);
      if (best === null) continue;
      const isCurrent =
        current !== null && model.id === current.id && model.provider === current.provider;
      scored.push({ model, score: best.score + (isCurrent ? 0.5 : 0) });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.model.provider.localeCompare(b.model.provider) ||
        a.model.name.localeCompare(b.model.name),
    );
    return { shown: scored.slice(0, VISIBLE_LIMIT).map((s) => s.model), matched: scored.length };
  }, [models, query, current, tab, favorites]);

  useEffect(() => {
    setIndex(0);
  }, [query, tab]);

  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const active = shown.length === 0 ? 0 : Math.min(index, shown.length - 1);

  // Cycle tabs via Ctrl+Tab / Ctrl+Shift+Tab
  const cycleTab = (forward: boolean) => {
    const idx = tabOrder.indexOf(tab);
    if (idx === -1) return;
    const next = forward
      ? (idx + 1) % tabOrder.length
      : (idx - 1 + tabOrder.length) % tabOrder.length;
    setTab(tabOrder[next]!);
  };

  const isFavoritesTab = tab === "favorites";
  const tabTotal = isFavoritesTab
    ? models.filter((m) => favorites.has(`${m.provider}/${m.id}`)).length
    : models.filter((m) => m.provider === tab).length;
  const placeholder = isFavoritesTab
    ? "search favorites…"
    : `search ${tabTotal} models…`;

  return (
    <Modal onClose={onClose} width="w-[40rem]">
      <div className="model-palette flex max-h-[70vh]">
        <ModelRail activeTab={tab} onTabChange={setTab} providers={providers} />
        <div className="min-w-0 flex flex-1 flex-col">
          {/* Search bar */}
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-4 text-ink-faint">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" />
              <path d="M10.5 10.5 14 14" stroke="currentColor" strokeLinecap="round" />
            </svg>
            <input
              ref={search}
              value={query}
              placeholder={placeholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.ctrlKey && (e.key === "]" || e.code === "BracketRight")) {
                  e.preventDefault();
                  cycleTab(true);
                } else if (e.ctrlKey && (e.key === "[" || e.code === "BracketLeft")) {
                  e.preventDefault();
                  cycleTab(false);
                } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
                  e.preventDefault();
                  if (shown.length > 0) setIndex((active + 1) % shown.length);
                } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
                  e.preventDefault();
                  if (shown.length > 0) setIndex((active - 1 + shown.length) % shown.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const picked = shown[active];
                  if (picked !== undefined) onPick(picked);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-sans text-sm outline-none placeholder:text-ink-faint"
            />
            <Label>
              {matched === tabTotal ? tabTotal : `${matched}/${tabTotal}`}
              {shown.length < matched && ` · top ${shown.length}`}
            </Label>
          </div>

          {/* Model list */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {isFavoritesTab && tabTotal === 0 && (
              <p className="px-3 py-3 text-xs text-ink-dim">
                No favorites yet. Star models from any provider tab to see them here.
              </p>
            )}
            {shown.length === 0 && tabTotal === 0 && !isFavoritesTab && (
              <p className="px-3 py-3 text-xs text-ink-dim">no models for this provider</p>
            )}
            {shown.length === 0 && tabTotal > 0 && (
              <p className="px-3 py-3 text-xs text-ink-dim">nothing matches that search</p>
            )}
            {shown.map((model, i) => {
              const isCurrent = current !== null && model.id === current.id && model.provider === current.provider;
              const modelKey = `${model.provider}/${model.id}`;
              const isFav = favorites.has(modelKey);
              const price = priceLabel(model.cost);
              const window = windowLabel(model.contextWindow);
              return (
                <button
                  key={modelKey}
                  type="button"
                  ref={i === active ? activeRow : null}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => onPick(model)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                    i === active ? "bg-hover" : isCurrent ? "bg-raised" : "hover:bg-raised",
                  )}
                >
                  <span className="grid w-2 shrink-0 place-items-center">
                    {isCurrent && <Dot tone="signal" title="current model" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-sm text-ink">{model.name}</span>
                    <span className="block truncate font-mono text-[10px] text-ink-faint">
                      {model.provider}/{model.id}
                    </span>
                  </span>
                  {/* Star toggle — span, not button, to avoid nested button HTML */}
                  <span
                    role="button"
                    tabIndex={-1}
                    title={isFav ? "remove from favorites" : "add to favorites"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleFavorite(modelKey);
                    }}
                    className="cursor-pointer text-ink-faint hover:text-copper"
                  >
                    <StarIcon filled={isFav} className={cn("size-3.5", isFav && "text-copper")} />
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {model.reasoning === true && <Chip tone="iris">reasoning</Chip>}
                    {model.input?.includes("image") === true && <Chip tone="signal">vision</Chip>}
                    {window !== null && (
                      <Chip mono title={`${model.contextWindow} token context window`}>
                        {window}
                      </Chip>
                    )}
                    {price !== null && (
                      <Chip mono title="USD per million tokens (input/output)">
                        {price}
                      </Chip>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Help footer */}
          <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
            <span>↑↓ move</span>
            <span>enter pick</span>
            <span>esc close</span>
            <span>ctrl+[ ] tabs</span>
            <span className="flex-1" />
            {/* The one place a missing provider is actually noticed — the fix is
                a click away rather than a support thread. */}
            <button
              type="button"
              onClick={() => {
                onClose();
                openSettings("providers");
              }}
              className="text-ink-faint underline decoration-dotted hover:text-ink-mid"
            >
              provider keys
            </button>
            <span>prices are USD per Mtok</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
