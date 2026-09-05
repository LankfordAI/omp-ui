import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { useDismissal } from "../lib/use-dismissal";
import type { ModelInfo } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, Dot, Label } from "./ui";
import { TONE_CHIP } from "./ui/tone";
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
 *
 * When this app instance carries a dev/test advisor override (the spawn
 * gate, issue #372), the gate decides which model the advisor actually runs
 * and wins over any saved choice at spawn. The control then reports the
 * gated configuration honestly: model and effort editing are read-only while
 * the gate is present, but the on/off switch keeps operating on the session's
 * own saved tuple. Saved choices are never rewritten by the gate.
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
  const t = useT();
  const record = useStore((s) => findRecord(s.state, tabId));
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY);
  const setSessionAdvisor = useStore((s) => s.setSessionAdvisor);
  const setAdvisorModel = useStore((s) => s.setAdvisorModel);
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const projectCwd = record?.projectCwd;
  const setProjectDefaultAdvisorModel = useStore((s) => s.setProjectDefaultAdvisorModel);
  // The instance's dev/test advisor override (issue #372): identical in the
  // desktop and remote renderers because both read the same backend state.
  const gateAdvisor = useStore((s) => s.state?.spawnGate.advisorModel ?? null);
  // The project's advisor pin (issue #257): undefined when the tab has no
  // registered project, null when the project simply has no pin yet.
  const projectAdvisorPin = useStore((s) => {
    if (projectCwd === undefined) return undefined;
    const group = s.state?.projects.find((g) => g.project.path === projectCwd);
    return group === undefined ? null : (group.project.defaultAdvisorModel ?? null);
  });
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
  // A gate arriving through hydration or a broadcast retargets the row: a
  // picker or level menu opened against the saved choice must not survive it.
  useEffect(() => {
    if (gateAdvisor !== null) {
      setPicking(false);
      setLevelMenu(false);
    }
  }, [gateAdvisor]);
  useDismissal({
    open: levelMenu,
    refs: levelAnchor,
    onClose: () => setLevelMenu(false),
  });

  if (record === undefined) return null;

  const on = record.advisor;
  const live = record.live === "live";
  const gated = gateAdvisor !== null;
  /** Display precedence (issue #372): the instance's gate wins over every
   *  saved choice; nothing here writes back. This reports the configured
   *  selection, not a runtime observation — lineage overlays and the
   *  advisor-stats extension remain the runtime evidence. */
  const effective = gateAdvisor ?? record.advisorModel ?? defaults?.model ?? null;
  const inherited = !gated && record.advisorModel === null;

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
    if (gated || effectiveModelSelector === null) return;
    // Pinning the level pins the whole selector — the same relaunch path as the
    // model picker, so a deliberate pick is always one restart. An empty level
    // clears back to omp's default: a bare selector, never a trailing `:`.
    const selector = level === "" ? effectiveModelSelector : `${effectiveModelSelector}:${level}`;
    void setAdvisorModel(tabId, selector);
  };

  const toggle = () => {
    if (disabled === true) return;
    // The switch owns the enabled flag only: it persists the session's SAVED
    // selector, never the displayed gate (issue #372).
    void setSessionAdvisor(tabId, !on, record.advisorModel);
  };

  const pinNote =
    projectAdvisorPin !== undefined && projectAdvisorPin !== null
      ? t("composer.advisor.projectDefault", { selector: projectAdvisorPin })
      : "";
  /** Honest provenance for the gated selector (issue #372): active on a live
   *  session, pending on a dormant one, and worded as not-yet-running while
   *  the advisor is off. */
  const gatedSentence = !live
    ? t("advisor.override.resume", { selector: gateAdvisor ?? "" })
    : on
      ? t("advisor.override.active", { selector: gateAdvisor ?? "" })
      : t("advisor.override.inactive", { selector: gateAdvisor ?? "" });
  const title = gated
    ? on
      ? `${t("composer.advisor.on")} — ${effective} · ${gatedSentence}${t("composer.advisor.turnOff")}${pinNote}${t("composer.advisor.restarts")}`
      : `${gatedSentence}${t("composer.advisor.turnOn")}${pinNote}${t("composer.advisor.restarts")}`
    : on
      ? `${t("composer.advisor.on")}${
          effective === null
            ? t("composer.advisor.ompPicks")
            : ` — ${effective}`
        }${inherited && effective !== null ? t("composer.advisor.fromOmpConfig") : ""}${t("composer.advisor.turnOff")}${pinNote}${t("composer.advisor.restarts")}`
      : `${t("composer.advisor.turnOn")}${
          defaults?.model === null || defaults?.model === undefined
            ? ""
            : t("composer.advisor.withConfig", { selector: defaults.model })
        }${pinNote}${t("composer.advisor.restarts")}`;

  return (
    <>
      <span className={cn("flex min-w-0 shrink items-center gap-1", layout === "sheet" && "w-full")}>
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
                {t("composer.advisor.label")}
              </>
            ) : (
              t("composer.advisor.offLabel")
            )}
          </button>

          {/* The model only matters while the advisor runs, so the picker only
              appears then — an always-visible dropdown for a disabled feature
              invites setting a model that does nothing. While the gate is on,
              the row is a read-only statement of what this instance runs. */}
          {on && (
            <button
              type="button"
              disabled={disabled || gated}
              title={
                gated
                  ? `${t("advisor.override.label")}: ${effective}`
                  : effective === null
                    ? t("composer.advisor.noModel")
                    : t("composer.advisor.modelTitle", {
                        selector: effective,
                        source: inherited
                          ? t("composer.advisor.fromOmpConfig")
                          : t("composer.advisor.pinned"),
                      })
              }
              onClick={() => {
                if (gated) return;
                setPicking(true);
              }}
              className={cn(
                CAPSULE_SEGMENT,
                layout === "sheet" ? "min-w-0 flex-1 justify-center px-3 text-[11px]" : "max-w-40 text-[11px]",
                gated ? "text-ink-mid" : inherited ? "text-ink-faint" : "text-ink-mid",
              )}
            >
              <span className="min-w-0 truncate">
                {effective === null
                  ? t("composer.advisor.pickModel")
                  : effectiveModel?.name || effectiveModel?.id || shortLabel(effective)}
              </span>
            </button>
          )}

          {/* The thinking level is omp's `:level` suffix on the advisor role, so
              it needs a running model to attach to and only makes sense when the
              model advertises efforts. Like the model picker, choosing one is a
              deliberate pick — every change restarts the session. While gated,
              the gated selector's own level renders read-only even with no
              catalog; a gated selector without a level shows no value at all,
              so no stored/default effort is ever implied (issue #372). */}
          {on && gated && effectiveLevel !== null && (
            <span ref={levelAnchor} className="relative flex">
              <button
                type="button"
                disabled
                title={`${t("advisor.override.label")}: ${effective}`}
                className={cn(
                  CAPSULE_SEGMENT,
                  "shrink-0 rounded-r-[5px] text-[11px] tabular-nums text-ink-mid",
                  layout === "sheet" && "px-3",
                )}
              >
                {effectiveLevel}
              </button>
            </span>
          )}
          {on && !gated && effectiveModelSelector !== null && efforts.length > 0 && (
            <span ref={levelAnchor} className="relative flex">
              <button
                type="button"
                disabled={disabled}
                title={t("composer.advisor.levelTitle", { efforts: efforts.join(", ") })}
                onClick={() => setLevelMenu((m) => !m)}
                className={cn(
                  CAPSULE_SEGMENT,
                  "shrink-0 rounded-r-[5px] text-[11px] tabular-nums text-iris",
                  layout === "sheet" && "px-3",
                )}
              >
                {effectiveLevel ?? t("composer.thinking.fallback")}
              </button>
              {levelMenu && (
                <div className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                  <span className="px-1.5 pb-1 pt-0.5">
                    <Label>{t("composer.advisor.thinkingLabel")}</Label>
                  </span>
                  {effectiveLevel !== null && (
                    <button
                      type="button"
                      onClick={() => setLevel("")}
                      className="rounded px-1.5 py-0.5 text-left text-[11px] text-ink-faint hover:bg-hover"
                      title={t("composer.advisor.defaultLevel")}
                    >
                      {t("composer.advisor.defaultLevelChoice")}
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
        {/* The compact source label: neutral/copper by design — this is
            instance provenance, never a user choice (issue #372). */}
        {gated && (
          <span
            title={t("advisor.override.label")}
            className={cn("shrink-0 rounded border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide", TONE_CHIP.neutral)}
          >
            {t("advisor.override.badge")}
          </span>
        )}
      </span>

      {picking && !gated && (
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
          projectPin={projectAdvisorPin}
          onPinChange={
            projectCwd === undefined
              ? undefined
              : (selector) => void setProjectDefaultAdvisorModel(projectCwd, selector)
          }
        />
      )}
    </>
  );
}
