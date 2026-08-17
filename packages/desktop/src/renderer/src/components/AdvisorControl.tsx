import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import type { ModelInfo } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, Dot, Label } from "./ui";
import { ModelPalette } from "./ModelSelector";

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

/** The tail of a selector, which is all that fits on a chip. */
export function shortLabel(selector: string): string {
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
export function splitRole(selector: string): { model: string; level?: string } {
  const colon = selector.lastIndexOf(":");
  if (colon !== -1) {
    const tail = selector.slice(colon + 1);
    if (LEVEL_RE.test(tail)) return { model: selector.slice(0, colon), level: tail };
  }
  return { model: selector };
}

export function AdvisorControl({ tabId, disabled, layout = "inline" }: { tabId: string; disabled?: boolean; layout?: "inline" | "sheet" }) {
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

  // A disabled session can't be reconfigured, and menus left open behind a
  // process handoff would target a successor with stale choices.
  useEffect(() => {
    if (disabled === true) {
      setPicking(false);
      setLevelMenu(false);
    }
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
      <Capsule
        tone={on ? "signal" : "neutral"}
        className={cn(
          "font-mono",
          layout === "sheet" && "h-11 w-full",
          layout === "inline" && "min-w-0 shrink",
        )}
      >
        <button
          type="button"
          disabled={disabled}
          aria-pressed={on}
          title={title}
          onClick={toggle}
          className={cn(CAPSULE_SEGMENT, "shrink-0 text-[10px]", layout === "sheet" && (on ? "px-3" : "flex-1 justify-center px-3"), on ? "text-signal" : "text-ink-mid")}
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
              layout === "sheet" ? "min-w-0 flex-1 justify-center px-3 text-[11px]" : "max-w-40 text-[11px]",
              inherited ? "text-ink-faint" : "text-ink-mid",
            )}
          >
            <span className="min-w-0 truncate">
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
                "shrink-0 rounded-r-[5px] text-[11px] tabular-nums text-iris",
                layout === "sheet" && "px-3",
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
        <ModelPalette
          variant="advisor"
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

