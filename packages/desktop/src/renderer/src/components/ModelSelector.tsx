import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { filterModelsForTab } from "../lib/model-filter";
import { fuzzyBest } from "../lib/fuzzy";
import type { ModelInfo } from "../lib/rpc-types";
import { useStore } from "../store";
import { CAPSULE_SEGMENT, Chevron, Chip, Dot, IconButton, Label, Modal, StarIcon } from "./ui";
import { ModelRail } from "./ModelRail";
import { usePaletteNav } from "./palette";

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
        <span className="min-w-0 truncate">{model === null ? "no model" : model.name || model.id}</span>
        <Chevron open={false} className="rotate-90 text-ink-faint" />
      </button>
      {open && (
        <ModelPalette
          variant="main"
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

type ModelPaletteProps = {
  models: ModelInfo[];
  onClose(): void;
} & (
  | {
      variant: "main";
      current: ModelInfo | null;
      onPick(model: ModelInfo): void;
    }
  | {
      variant: "advisor";
      current: string | null;
      inherited: boolean;
      defaultModel: string | null;
      onPick(model: string | null): void;
    }
);

type ModelPaletteRow =
  | { kind: "configured-advisor" }
  | { kind: "model"; model: ModelInfo };

function selectorFor(model: ModelInfo): string {
  return `${model.provider}/${model.id}`;
}

export function ModelPalette(props: ModelPaletteProps) {
  const { models, onClose } = props;
  const favoriteKeys = useStore((s) => s.state?.modelFavorites ?? EMPTY_FAVORITES);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const openSettings = useStore((s) => s.openSettings);
  const favorites = useMemo(() => new Set(favoriteKeys), [favoriteKeys]);

  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement | null>(null);

  const providers = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const model of models) {
      if (!seen.has(model.provider)) {
        seen.add(model.provider);
        result.push(model.provider);
      }
    }
    return result.sort((a, b) => a.localeCompare(b));
  }, [models]);

  const currentSelector = props.variant === "main"
    ? props.current === null ? null : selectorFor(props.current)
    : props.current;
  const currentProvider = useMemo(() => {
    if (currentSelector === null) return null;
    const slash = currentSelector.indexOf("/");
    return slash > 0 ? currentSelector.slice(0, slash) : null;
  }, [currentSelector]);

  // Main model selection always opens at Favorites. Advisor selection opens
  // where its effective model lives, preserving the provider-first workflow.
  const [tab, setTab] = useState(() => {
    if (props.variant === "advisor") {
      if (currentProvider !== null && providers.includes(currentProvider)) return currentProvider;
      return providers[0] ?? "favorites";
    }
    return "favorites";
  });
  const tabOrder = useMemo(() => ["favorites", ...providers], [providers]);

  useEffect(() => {
    search.current?.focus();
  }, []);

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
      const currentBonus = selectorFor(model) === currentSelector ? 0.5 : 0;
      scored.push({ model, score: best.score + currentBonus });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.model.provider.localeCompare(b.model.provider) ||
        a.model.name.localeCompare(b.model.name),
    );
    return {
      shown: scored.slice(0, VISIBLE_LIMIT).map(({ model }) => model),
      matched: scored.length,
    };
  }, [models, query, currentSelector, tab, favorites]);

  const isFavoritesTab = tab === "favorites";
  const rows = useMemo<ModelPaletteRow[]>(() => {
    const modelRows: ModelPaletteRow[] = shown.map((model) => ({ kind: "model", model }));
    return props.variant === "advisor" && !isFavoritesTab
      ? [{ kind: "configured-advisor" }, ...modelRows]
      : modelRows;
  }, [shown, props.variant, isFavoritesTab]);

  const pickRow = (row: ModelPaletteRow) => {
    if (row.kind === "configured-advisor") {
      if (props.variant === "advisor") props.onPick(null);
      return;
    }
    if (props.variant === "main") props.onPick(row.model);
    else props.onPick(selectorFor(row.model));
  };

  const { active, setActive, activeRef, handleKey } = usePaletteNav({
    items: rows,
    resetKey: `${tab}\u0000${query}`,
    onPick: pickRow,
    onClose,
  });

  const cycleTab = (forward: boolean) => {
    const index = tabOrder.indexOf(tab);
    if (index === -1) return;
    const next = forward
      ? (index + 1) % tabOrder.length
      : (index - 1 + tabOrder.length) % tabOrder.length;
    setTab(tabOrder[next]!);
  };

  const tabTotal = isFavoritesTab
    ? models.filter((model) => favorites.has(selectorFor(model))).length
    : models.filter((model) => model.provider === tab).length;
  const placeholder = isFavoritesTab ? "search favorites…" : `search ${tabTotal} models…`;

  return (
    <Modal onClose={onClose} width="w-[40rem]">
      <div className="model-palette flex max-h-[70vh]">
        <ModelRail activeTab={tab} onTabChange={setTab} providers={providers} />
        <div className="min-h-0 min-w-0 flex flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            {props.variant === "advisor" ? (
              <Label>advisor model</Label>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-4 text-ink-faint">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" />
                <path d="M10.5 10.5 14 14" stroke="currentColor" strokeLinecap="round" />
              </svg>
            )}
            <input
              ref={search}
              value={query}
              placeholder={placeholder}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.ctrlKey && (event.key === "]" || event.code === "BracketRight")) {
                  event.preventDefault();
                  cycleTab(true);
                } else if (event.ctrlKey && (event.key === "[" || event.code === "BracketLeft")) {
                  event.preventDefault();
                  cycleTab(false);
                } else {
                  handleKey(event);
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-sans text-sm outline-none placeholder:text-ink-faint"
            />
            <Label>
              {matched === tabTotal ? tabTotal : `${matched}/${tabTotal}`}
              {shown.length < matched && ` · top ${shown.length}`}
            </Label>
          </div>

          {props.variant === "advisor" && (
            <p className="border-b border-line px-3 py-1.5 text-[11px] text-ink-dim">
              omp binds the advisor model at startup, so picking one restarts this session and resumes it.
            </p>
          )}

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

            {rows.map((row, index) => {
              if (row.kind === "configured-advisor") {
                const inherited = props.variant === "advisor" && props.inherited;
                return (
                  <button
                    key="configured-advisor"
                    type="button"
                    ref={index === active ? activeRef : null}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pickRow(row)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                      index === active ? "bg-hover" : inherited ? "bg-raised" : "hover:bg-raised",
                    )}
                  >
                    <span className="grid w-2 shrink-0 place-items-center">
                      {inherited && <Dot tone="signal" title="in use" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm text-ink">
                        use omp&apos;s configured advisor
                      </span>
                      <span className="block truncate font-mono text-[10px] text-ink-faint">
                        {props.variant === "advisor" && (props.defaultModel ?? "modelRoles.advisor is unset — omp resolves its slow model chain")}
                      </span>
                    </span>
                  </button>
                );
              }

              const { model } = row;
              const modelKey = selectorFor(model);
              const isFavorite = favorites.has(modelKey);
              const isCurrent = modelKey === currentSelector;
              const price = priceLabel(model.cost);
              const window = windowLabel(model.contextWindow);
              return (
                <div
                  key={modelKey}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex w-full items-stretch",
                    index === active ? "bg-hover" : isCurrent ? "bg-raised" : "hover:bg-raised",
                  )}
                >
                  <button
                    type="button"
                    ref={index === active ? activeRef : null}
                    onClick={() => pickRow(row)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
                  >
                    <span className="grid w-2 shrink-0 place-items-center">
                      {isCurrent && (props.variant === "main" || !props.inherited) && (
                        <Dot
                          tone="signal"
                          title={props.variant === "main" ? "current model" : "pinned to this session"}
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm text-ink">{model.name}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-faint">{modelKey}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {model.reasoning === true && <Chip tone="iris">reasoning</Chip>}
                      {props.variant === "main" && model.input?.includes("image") === true && (
                        <Chip tone="signal">vision</Chip>
                      )}
                      {props.variant === "main" && window !== null && (
                        <Chip mono title={`${model.contextWindow} token context window`}>{window}</Chip>
                      )}
                      {props.variant === "main" && price !== null && (
                        <Chip mono title="USD per million tokens (input/output)">{price}</Chip>
                      )}
                    </span>
                  </button>
                  <IconButton
                    label={isFavorite ? "remove from favorites" : "add to favorites"}
                    tone="copper"
                    onClick={() => void toggleFavorite(modelKey)}
                    className="mr-2 self-center"
                  >
                    <StarIcon filled={isFavorite} className={cn("size-3.5", isFavorite && "text-copper")} />
                  </IconButton>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
            <span>↑↓ move</span>
            <span>enter pick</span>
            <span>esc close</span>
            <span>ctrl+[ ] tabs</span>
            {props.variant === "main" && (
              <>
                <span className="flex-1" />
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
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
