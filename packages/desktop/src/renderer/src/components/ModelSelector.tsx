import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { filterModelsForTab } from "../lib/model-filter";
import { t, useT } from "../lib/i18n";
import { fuzzyBest } from "../lib/fuzzy";
import type { ModelInfo } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
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
  if (input === 0 && output === 0) return t("composer.model.free");
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
  const t = useT();
  const model = useStore((s) => s.rpc[tabId]?.model ?? null);
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY);
  const running = useStore((s) => s.rpc[tabId]?.status === "running");
  const setModel = useStore((s) => s.setModel);
  const openSettings = useStore((s) => s.openSettings);
  const setProjectDefaultModel = useStore((s) => s.setProjectDefaultModel);
  // The project pin for the composer footer (issue #257): undefined when the
  // tab has no registered project (no footer), null when the project simply
  // has no pin yet ("not set").
  const projectPin = useStore((s) => {
    const rec = findRecord(s.state, tabId);
    if (rec === undefined) return undefined;
    const group = s.state?.projects.find((g) => g.project.path === rec.projectCwd);
    return group === undefined ? null : (group.project.defaultModel ?? null);
  });
  const projectCwd = useStore((s) => findRecord(s.state, tabId)?.projectCwd ?? null);
  const [open, setOpen] = useState(false);
  // Keep one user-selected main model for the duration of a turn. Internal
  // staged-model changes still use the store method directly.
  const locked = disabled === true || running;

  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);

  // Either `get_available_models` failed, or omp has no authenticated provider
  // at all — the common cause of the latter is a GUI launch that inherited no
  // API keys, so this doubles as the entry point to the providers page.
  if (models.length === 0) {
    return (
      <button
        type="button"
        disabled={locked}
        title={running ? t("composer.model.afterTurn") : (model?.id ?? t("composer.model.noModelsTitle"))}
        onClick={() => openSettings("providers")}
        className="flex items-center px-1.5 font-mono text-[11px] text-ink-mid hover:text-ink"
      >
        {model === null ? t("composer.model.none") : model.id}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={locked}
        title={
          running
            ? t("composer.model.afterTurn")
            : model === null
              ? t("composer.model.pick")
              : `${model.provider}/${model.id}`
        }
        onClick={() => setOpen(true)}
        className={cn(CAPSULE_SEGMENT, "max-w-56 text-xs font-medium text-ink-mid")}
      >
        <span className="min-w-0 truncate">{model === null ? t("composer.model.fallback") : model.name || model.id}</span>
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
          projectPin={projectPin}
          onPinChange={
            projectCwd === null
              ? undefined
              : (selector) => void setProjectDefaultModel(projectCwd, selector)
          }
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
  /** The project's pin for this variant (issue #257); omit to hide the footer. */
  projectPin?: string | null;
  /** Apply (selector) or clear (null) the project pin. */
  onPinChange?: (selector: string | null) => void;
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
  const t = useT();
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
  // Both model pickers open at Favorites. The advisor's effective model keeps
  // its current-model dot on its row, one tab click away.
  const [tab, setTab] = useState("favorites");
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

  // The pin footer (issue #257) targets the row under the cursor through the
  // same path onPick uses; the configured-advisor row resolves to the
  // configured selector — or null, defer to config, when omp has none.
  const pinTarget = (() => {
    const row = rows[active];
    if (row === undefined) return null;
    if (row.kind === "model") return selectorFor(row.model);
    return props.variant === "advisor" ? (props.defaultModel ?? null) : null;
  })();

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
  const placeholder =
    isFavoritesTab ? t("composer.model.searchFavorites") : t("composer.model.searchCount", { n: tabTotal });

  return (
    <Modal onClose={onClose} width="w-[40rem]">
      <div className="model-palette flex max-h-[70vh]">
        <ModelRail activeTab={tab} onTabChange={setTab} providers={providers} />
        <div className="min-h-0 min-w-0 flex flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            {props.variant === "advisor" ? (
              <Label>{t("composer.model.advisorModel")}</Label>
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
              {shown.length < matched && t("composer.model.topN", { n: shown.length })}
            </Label>
          </div>

          {props.variant === "advisor" && (
            <p className="border-b border-line px-3 py-1.5 text-[11px] text-ink-dim">
              {t("composer.model.advisorRestart")}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {isFavoritesTab && tabTotal === 0 && (
              <p className="px-3 py-3 text-xs text-ink-dim">
                {t("composer.model.noFavorites")}
              </p>
            )}
            {shown.length === 0 && tabTotal === 0 && !isFavoritesTab && (
              <p className="px-3 py-3 text-xs text-ink-dim">{t("composer.model.noneForProvider")}</p>
            )}
            {shown.length === 0 && tabTotal > 0 && (
              <p className="px-3 py-3 text-xs text-ink-dim">{t("composer.model.noMatch")}</p>
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
                      {inherited && <Dot tone="signal" title={t("composer.model.inUse")} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm text-ink">
                        {t("composer.model.useConfigured")}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-ink-faint">
                        {props.variant === "advisor" && (props.defaultModel ?? t("composer.model.advisorUnset"))}
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
                          title={props.variant === "main" ? t("composer.model.current") : t("composer.model.pinned")}
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm text-ink">{model.name}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-faint">{modelKey}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {model.reasoning === true && <Chip tone="iris">{t("composer.model.reasoning")}</Chip>}
                      {props.variant === "main" && model.input?.includes("image") === true && (
                        <Chip tone="signal">{t("composer.model.vision")}</Chip>
                      )}
                      {props.variant === "main" && window !== null && (
                        <Chip mono title={t("composer.model.contextWindow", { n: model.contextWindow ?? "" })}>{window}</Chip>
                      )}
                      {props.variant === "main" && price !== null && (
                        <Chip mono title={t("composer.model.priceTitle")}>{price}</Chip>
                      )}
                    </span>
                  </button>
                  <IconButton
                    label={isFavorite ? t("composer.model.unfavorite") : t("composer.model.favorite")}
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
            <span>{t("composer.model.kbdMove")}</span>
            <span>{t("composer.model.kbdPick")}</span>
            <span>{t("composer.model.kbdClose")}</span>
            <span>{t("composer.model.kbdTabs")}</span>
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
                  {t("composer.model.providerKeys")}
                </button>
                <span>{t("composer.model.pricesNote")}</span>
              </>
            )}
          </div>

          {props.projectPin !== undefined && (
            <div className="flex items-center gap-2 border-t border-line px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px]">
                <span className="text-ink-faint">{t("composer.model.projectDefault")}</span>{" "}
                <span className={cn("font-mono", props.projectPin === null ? "text-ink-faint" : "text-ink")}>
                  {props.projectPin ?? t("composer.model.notSet")}
                </span>
                <span className="text-ink-faint">{t("composer.model.newSessionsOnly")}</span>
              </span>
              <button
                type="button"
                disabled={pinTarget === null}
                onClick={() => props.onPinChange?.(pinTarget)}
                className="rounded px-1.5 py-0.5 text-[10px] text-ink-mid hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                {t("composer.model.setDefault")}
              </button>
              {props.projectPin !== null && (
                <button
                  type="button"
                  onClick={() => props.onPinChange?.(null)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-ink-mid hover:bg-hover hover:text-ink"
                >
                  {t("composer.model.clear")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
