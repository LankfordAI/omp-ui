import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { filterModelsForTab } from "../lib/model-filter";
import { fuzzyBest } from "../lib/fuzzy";
import type { ModelInfo } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, Chip, Dot, Label, Modal, StarIcon } from "./ui";
import { ModelRail } from "./ModelRail";

/**
 * The advisor switch, in the composer next to the model it affects.
 *
 * omp gives this no runtime surface at all (v17.1.8): `get_state` reports no
 * advisor field, `/advisor` accepts only on/off/status/dump/configure, and
 * `--advisor=<model>` discards its value. Both the enable flag and the
 * `advisor` role are bound when the process starts. So flipping either one
 * relaunches the session with `--resume` — the same relaunch a mode switch
 * does, and lossless for the same reason: the transcript is on disk.
 *
 * That cost is why this control is explicit about restarting rather than
 * pretending the change applied in place.
 */

/** Stable empty so the per-field selector doesn't fire on every store tick. */
const EMPTY: ModelInfo[] = [];
/** Stable empty array for favorites so the useMemo dependency is referentially stable. */
const EMPTY_FAVORITES: string[] = [];

/** omp's selector form is `provider/id`; that is what `modelRoles.advisor` holds. */
function selectorFor(model: ModelInfo): string {
  return `${model.provider}/${model.id}`;
}

/** The tail of a selector, which is all that fits on a chip. */
function shortLabel(selector: string): string {
  const slash = selector.lastIndexOf("/");
  const tail = slash === -1 ? selector : selector.slice(slash + 1);
  // Drop omp's `:level` suffix — the level is the advisor's, not the user's pick.
  const colon = tail.lastIndexOf(":");
  return colon > 0 ? tail.slice(0, colon) : tail;
}

/**
 * Splits omp's role selector into model and thinking level, mirroring core's
 * parseModelRole. Only a final bare `[a-z]+` segment is a level: model ids may
 * themselves contain colons (OpenRouter's `model:exacto`), so an id tail is
 * never mistaken for a level.
 */
const LEVEL_RE = /^[a-z]+$/;
function splitRole(selector: string): { model: string; level?: string } {
  const colon = selector.lastIndexOf(":");
  if (colon !== -1) {
    const tail = selector.slice(colon + 1);
    if (LEVEL_RE.test(tail)) return { model: selector.slice(0, colon), level: tail };
  }
  return { model: selector };
}

export function AdvisorControl({ tabId, disabled }: { tabId: string; disabled?: boolean }) {
  const record = useStore((s) => findRecord(s.state, tabId));
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY);
  const setSessionAdvisor = useStore((s) => s.setSessionAdvisor);
  const setAdvisorModel = useStore((s) => s.setAdvisorModel);
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const projectCwd = record?.projectCwd;
  const defaults = useStore((s) => (projectCwd ? s.advisorDefaults[projectCwd] : undefined));
  const [picking, setPicking] = useState(false);
  const [levelMenu, setLevelMenu] = useState(false);
  const levelAnchor = useRef<HTMLSpanElement | null>(null);

  // omp's config is the source of the default, and it is read in main.
  useEffect(() => {
    if (projectCwd !== undefined) void loadAdvisorDefaults(projectCwd);
  }, [projectCwd, loadAdvisorDefaults]);

  // A disabled session can't be reconfigured, and a menu left open behind a
  // click elsewhere is a stuck menu — both close it.
  useEffect(() => {
    if (disabled === true) setLevelMenu(false);
  }, [disabled]);
  useEffect(() => {
    if (!levelMenu) return;
    const dismiss = (e: PointerEvent) => {
      const anchor = levelAnchor.current;
      if (anchor !== null && e.target instanceof Node && anchor.contains(e.target)) return;
      setLevelMenu(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [levelMenu]);

  if (record === undefined) return null;

  const on = record.advisor;
  /** The session's own pin, else omp's config — what this session actually runs. */
  const effective = record.advisorModel ?? defaults?.model ?? null;
  const inherited = record.advisorModel === null;

  /** The effective model and its thinking level, split apart (omp encodes the
   * level as a `:level` suffix on the selector). */
  const effectiveSplit = effective === null ? null : splitRole(effective);
  const effectiveModelSelector = effectiveSplit?.model ?? null;
  const effectiveLevel = effectiveSplit?.level ?? null;
  // The level selector offers only the model's own valid efforts.
  const effectiveModel = models.find((m) => `${m.provider}/${m.id}` === effectiveModelSelector) ?? null;
  const efforts = effectiveModel?.thinking?.efforts ?? [];

  const setLevel = (level: string) => {
    setLevelMenu(false);
    if (effectiveModelSelector === null) return;
    // Pinning the level pins the whole selector — the same relaunch path as the
    // model picker, so a deliberate pick is always one restart. An empty level
    // clears back to omp's default: a bare selector, never a trailing `:`.
    const selector = level === "" ? effectiveModelSelector : `${effectiveModelSelector}:${level}`;
    void setAdvisorModel(tabId, selector);
  };

  const toggle = () => {
    if (disabled === true) return;
    void setSessionAdvisor(tabId, !on, record.advisorModel);
  };

  const title = on
    ? `advisor on${effective === null ? " (omp picks the model)" : ` — ${effective}`}${
        inherited && effective !== null ? " (from omp config)" : ""
      } · click to turn off · restarts the session`
    : `advisor off · click to turn on${
        defaults?.model === null || defaults?.model === undefined
          ? ""
          : ` with ${defaults.model} from omp config`
      } · restarts the session`;

  return (
    <>
      <Capsule tone={on ? "signal" : "neutral"} className="font-mono">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={on}
          title={title}
          onClick={toggle}
          className={cn(CAPSULE_SEGMENT, "text-[10px]", on ? "text-signal" : "text-ink-mid")}
        >
          {on ? (
            <>
              <Dot tone="signal" />
              advisor
            </>
          ) : (
            "advisor off"
          )}
        </button>

        {/* The model only matters while the advisor runs, so the picker only
            appears then — an always-visible dropdown for a disabled feature
            invites setting a model that does nothing. */}
        {on && (
          <button
            type="button"
            disabled={disabled}
            title={
              effective === null
                ? "no advisor model configured — omp falls back to its `slow` model chain"
                : `advisor model: ${effective}${inherited ? " (from omp config)" : " (pinned to this session)"} · click to change`
            }
            onClick={() => setPicking(true)}
            className={cn(
              CAPSULE_SEGMENT,
              "max-w-40 text-[11px]",
              inherited ? "text-ink-faint" : "text-ink-mid",
            )}
          >
            <span className="truncate">
              {effective === null
                ? "pick model"
                : effectiveModel?.name || effectiveModel?.id || shortLabel(effective)}
            </span>
          </button>
        )}

        {/* The thinking level is omp's `:level` suffix on the advisor role, so
            it needs a running model to attach to and only makes sense when the
            model advertises efforts. Like the model picker, choosing one is a
            deliberate pick — every change restarts the session. */}
        {on && effectiveModelSelector !== null && efforts.length > 0 && (
          <span ref={levelAnchor} className="relative flex">
            <button
              type="button"
              disabled={disabled}
              title={`advisor thinking level — click to pick (${efforts.join(", ")}) · restarts the session`}
              onClick={() => setLevelMenu((m) => !m)}
              className={cn(
                CAPSULE_SEGMENT,
                "rounded-r-[5px] text-[11px] tabular-nums text-iris",
              )}
            >
              {effectiveLevel ?? "think —"}
            </button>
            {levelMenu && (
              <div className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                <span className="px-1.5 pb-1 pt-0.5">
                  <Label>advisor thinking</Label>
                </span>
                {effectiveLevel !== null && (
                  <button
                    type="button"
                    onClick={() => setLevel("")}
                    className="rounded px-1.5 py-0.5 text-left text-[11px] text-ink-faint hover:bg-hover"
                    title="return to omp's default thinking level for this model"
                  >
                    default —
                  </button>
                )}
                {efforts.map((effort) => (
                  <button
                    key={effort}
                    type="button"
                    onClick={() => setLevel(effort)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                      effort === effectiveLevel ? "text-iris" : "text-ink-mid",
                    )}
                  >
                    {effort}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
      </Capsule>

      {picking && (
        <AdvisorModelPalette
          models={models}
          current={effective}
          inherited={inherited}
          defaultModel={defaults?.model ?? null}
          onClose={() => setPicking(false)}
          onPick={(selector) => {
            setPicking(false);
            void setAdvisorModel(tabId, selector);
          }}
        />
      )}
    </>
  );
}

/** Same paging rule as the main model palette: search, don't scroll 414 rows. */
const VISIBLE_LIMIT = 120;

function AdvisorModelPalette({
  models,
  current,
  inherited,
  defaultModel,
  onPick,
  onClose,
}: {
  models: ModelInfo[];
  current: string | null;
  inherited: boolean;
  defaultModel: string | null;
  onPick(selector: string | null): void;
  onClose(): void;
}) {
  const favoriteKeys = useStore((s) => s.state?.modelFavorites ?? EMPTY_FAVORITES);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
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

  // Default tab: prefer current advisor model's provider
  const currentProvider = useMemo(() => {
    if (!current) return null;
    const slash = current.lastIndexOf("/");
    return slash > 0 ? current.slice(0, slash) : null;
  }, [current]);

  const [tab, setTab] = useState<string>(() => {
    if (currentProvider && providers.includes(currentProvider)) return currentProvider;
    return providers[0] ?? "favorites";
  });

  const tabOrder = useMemo(() => ["favorites", ...providers], [providers]);

  useEffect(() => {
    search.current?.focus();
  }, []);

  // Filter by tab, then fuzzy search
  const shown = useMemo(() => {
    const filtered = filterModelsForTab(models, tab, favorites);

    const scored: { model: ModelInfo; score: number }[] = [];
    for (const model of filtered) {
      const best = fuzzyBest(query, [
        { text: model.name, weight: 1 },
        { text: model.id, weight: 0.95 },
        { text: model.provider, weight: 0.6 },
      ]);
      if (best === null) continue;
      const isCurrent = selectorFor(model) === current;
      const bonus = (isCurrent ? 0.5 : 0) + (model.reasoning === true ? 0.05 : 0);
      scored.push({ model, score: best.score + bonus });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.model.provider.localeCompare(b.model.provider) ||
        a.model.name.localeCompare(b.model.name),
    );
    return scored.slice(0, VISIBLE_LIMIT).map((s) => s.model);
  }, [models, query, current, tab, favorites]);

  useEffect(() => {
    setIndex(0);
  }, [query, tab]);

  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  // Row offset: 1 when "use default" row is shown (not on Favorites tab), 0 otherwise
  const isFavoritesTab = tab === "favorites";
  const tabTotal = isFavoritesTab
    ? models.filter((m) => favorites.has(`${m.provider}/${m.id}`)).length
    : models.filter((m) => m.provider === tab).length;
  const offset = isFavoritesTab ? 0 : 1;
  const rows = shown.length + offset;
  const active = rows === 0 ? 0 : Math.min(index, rows - 1);

  const cycleTab = (forward: boolean) => {
    const idx = tabOrder.indexOf(tab);
    if (idx === -1) return;
    const next = forward
      ? (idx + 1) % tabOrder.length
      : (idx - 1 + tabOrder.length) % tabOrder.length;
    setTab(tabOrder[next]!);
  };

  const placeholder = isFavoritesTab ? "search favorites…" : `search ${tabTotal} models…`;

  return (
    <Modal onClose={onClose} width="w-[40rem]">
      <div className="model-palette flex max-h-[70vh]">
        <ModelRail activeTab={tab} onTabChange={setTab} providers={providers} />
        <div className="min-w-0 flex flex-1 flex-col">
          {/* Search bar */}
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Label>advisor model</Label>
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
                  if (rows > 0) setIndex((active + 1) % rows);
                } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
                  e.preventDefault();
                  if (rows > 0) setIndex((active - 1 + rows) % rows);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (rows === 0) return;
                  // Reset to default only when "use default" row exists and is active
                  if (offset === 1 && active === 0) {
                    onPick(null);
                    return;
                  }
                  const picked = shown[active - offset];
                  if (picked !== undefined) onPick(selectorFor(picked));
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-sans text-sm outline-none placeholder:text-ink-faint"
            />
          </div>

          <p className="border-b border-line px-3 py-1.5 text-[11px] text-ink-dim">
            omp binds the advisor model at startup, so picking one restarts this
            session and resumes it.
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {/* "use default" row — only when NOT on Favorites tab */}
            {!isFavoritesTab && (
              <button
                type="button"
                ref={active === 0 ? activeRow : null}
                onMouseEnter={() => setIndex(0)}
                onClick={() => onPick(null)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                  active === 0 ? "bg-hover" : inherited ? "bg-raised" : "hover:bg-raised",
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
                    {defaultModel ?? "modelRoles.advisor is unset — omp resolves its slow model chain"}
                  </span>
                </span>
              </button>
            )}

            {isFavoritesTab && models.filter((m) => favorites.has(`${m.provider}/${m.id}`)).length === 0 && (
              <p className="px-3 py-3 text-xs text-ink-dim">
                No favorites yet. Star models from any provider tab to see them here.
              </p>
            )}

            {shown.length === 0 && !isFavoritesTab && query !== "" && (
              <p className="px-3 py-3 text-xs text-ink-dim">nothing matches that search</p>
            )}

            {shown.map((model, i) => {
              const selector = selectorFor(model);
              const modelKey = `${model.provider}/${model.id}`;
              const isFav = favorites.has(modelKey);
              const isCurrent = selector === current;
              const row = i + offset;
              return (
                <button
                  key={selector}
                  type="button"
                  ref={row === active ? activeRow : null}
                  onMouseEnter={() => setIndex(row)}
                  onClick={() => onPick(selector)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                    row === active ? "bg-hover" : isCurrent ? "bg-raised" : "hover:bg-raised",
                  )}
                >
                  <span className="grid w-2 shrink-0 place-items-center">
                    {isCurrent && !inherited && <Dot tone="signal" title="pinned to this session" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-sm text-ink">{model.name}</span>
                    <span className="block truncate font-mono text-[10px] text-ink-faint">
                      {selector}
                    </span>
                  </span>
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
                  {model.reasoning === true && <Chip tone="iris">reasoning</Chip>}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
            <span>↑↓ move</span>
            <span>enter pick</span>
            <span>esc close</span>
            <span>ctrl+[ ] tabs</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
