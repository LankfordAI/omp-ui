import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { fuzzyBest } from "../lib/fuzzy";
import type { ModelInfo } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { Chip, Dot, Label, Modal } from "./ui";

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

export function AdvisorControl({ tabId, disabled }: { tabId: string; disabled?: boolean }) {
  const record = useStore((s) => findRecord(s.state, tabId));
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY);
  const setSessionAdvisor = useStore((s) => s.setSessionAdvisor);
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const projectCwd = record?.projectCwd;
  const defaults = useStore((s) => (projectCwd ? s.advisorDefaults[projectCwd] : undefined));
  const [picking, setPicking] = useState(false);

  // omp's config is the source of the default, and it is read in main.
  useEffect(() => {
    if (projectCwd !== undefined) void loadAdvisorDefaults(projectCwd);
  }, [projectCwd, loadAdvisorDefaults]);

  if (record === undefined) return null;

  const on = record.advisor;
  /** The session's own pin, else omp's config — what this session actually runs. */
  const effective = record.advisorModel ?? defaults?.model ?? null;
  const inherited = record.advisorModel === null;

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
      <span className="flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={on}
          title={title}
          onClick={toggle}
          className="rounded disabled:pointer-events-none disabled:opacity-35"
        >
          <Chip mono tone={on ? "signal" : "neutral"}>
            {on && <Dot tone="signal" />}
            advisor {on ? "on" : "off"}
          </Chip>
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
              "min-w-0 max-w-40 truncate rounded px-1 text-left font-mono text-[11px]",
              "hover:bg-hover disabled:pointer-events-none disabled:opacity-35",
              inherited ? "text-ink-faint" : "text-ink-mid",
            )}
          >
            {effective === null ? "pick model" : shortLabel(effective)}
          </button>
        )}
      </span>

      {picking && (
        <AdvisorModelPalette
          models={models}
          current={effective}
          inherited={inherited}
          defaultModel={defaults?.model ?? null}
          onClose={() => setPicking(false)}
          onPick={(selector) => {
            setPicking(false);
            void setSessionAdvisor(tabId, true, selector);
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
  /** The selector in effect, pinned or inherited. */
  current: string | null;
  inherited: boolean;
  /** omp's own `modelRoles.advisor`, offered as the "use the default" row. */
  defaultModel: string | null;
  /** null resets the session to omp's configured advisor model. */
  onPick(selector: string | null): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const activeRow = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const scored: { model: ModelInfo; score: number }[] = [];
    for (const model of models) {
      const best = fuzzyBest(query, [
        { text: model.name, weight: 1 },
        { text: model.id, weight: 0.95 },
        { text: model.provider, weight: 0.6 },
      ]);
      if (best === null) continue;
      // With no query every score ties, so the advisor's model leads the list.
      const isCurrent = selectorFor(model) === current;
      // Reasoning models are what an advisor wants — omp's own fallback for the
      // role is the `slow` chain — so they sort above the rest on a tie.
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
  }, [models, query, current]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  /**
   * Row 0 resets to omp's config; the models follow. Kept in the same keyboard
   * ring as the models so Enter on it means "use the default" rather than
   * needing a separate mouse target.
   */
  const rows = shown.length + 1;
  const active = Math.min(index, rows - 1);

  return (
    <Modal onClose={onClose} width="w-[34rem]">
      <div className="flex max-h-[70vh] flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Label>advisor model</Label>
          <input
            ref={search}
            value={query}
            placeholder={`search ${models.length} models…`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
                e.preventDefault();
                setIndex((active + 1) % rows);
              } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
                e.preventDefault();
                setIndex((active - 1 + rows) % rows);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (active === 0) {
                  onPick(null);
                  return;
                }
                const picked = shown[active - 1];
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

          {shown.length === 0 && query !== "" && (
            <p className="px-3 py-3 text-xs text-ink-dim">nothing matches that search</p>
          )}

          {shown.map((model, i) => {
            const selector = selectorFor(model);
            const isCurrent = selector === current;
            const row = i + 1;
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
                {model.reasoning === true && <Chip tone="iris">reasoning</Chip>}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
          <span>↑↓ move</span>
          <span>enter pick</span>
          <span>esc close</span>
        </div>
      </div>
    </Modal>
  );
}
