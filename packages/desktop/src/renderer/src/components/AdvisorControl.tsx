import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { parseModelRole } from "@omp-ui/core/model-role";
import { cn } from "../lib/cn";
import { shortModelLabel } from "../lib/format";
import { useDismissal } from "../lib/use-dismissal";
import type { ModelInfo } from "../lib/rpc-types";
import { projectKey } from "../lib/project-key";
import { findInstance, findOwner, useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, Label, Switch } from "./ui";
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


export function AdvisorControl({
  tabId,
  disabled,
  placement = "float",
  density = "desktop",
}: {
  tabId: string;
  disabled?: boolean;
  placement?: "float" | "flow";
  density?: "desktop" | "touch";
}) {
  // The session's owning instance (issue #416): its project pins and advisor
  // defaults live on that host, keyed by projectKey in the store.
  const {
    recordPresent,
    projectCwd,
    isChat,
    advisorOn,
    recordLive,
    advisorModel,
    instanceId,
  } = useStore(
    useShallow((s) => {
      const owner = findOwner(s.state, tabId);
      const rec = owner?.record;
      return {
        recordPresent: rec !== undefined,
        projectCwd: rec?.projectCwd,
        isChat: rec?.chat === true,
        advisorOn: rec?.advisor === true,
        recordLive: rec?.live === "live",
        advisorModel: rec?.advisorModel ?? null,
        instanceId: owner?.instanceId ?? null,
      };
    }),
  );
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY);
  const setSessionAdvisor = useStore((s) => s.setSessionAdvisor);
  const setAdvisorModel = useStore((s) => s.setAdvisorModel);
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const setProjectDefaultAdvisorModel = useStore((s) => s.setProjectDefaultAdvisorModel);
  // The instance's dev/test advisor override (issue #372): identical in the
  // desktop and remote renderers because both read the same backend state.
  const gateAdvisor = useStore((s) => s.state?.spawnGate.advisorModel ?? null);
  // The project's advisor pin (issue #257): undefined when the tab has no
  // registered project, null when the project simply has no pin yet.
  const projectAdvisorPin = useStore((s) => {
    if (projectCwd === undefined || isChat) return undefined;
    const groups = instanceId === null ? s.state?.projects : findInstance(s.state, instanceId)?.projects;
    const group = groups?.find((g) => g.project.path === projectCwd);
    return group === undefined ? null : (group.project.defaultAdvisorModel ?? null);
  });
  const defaults = useStore((s) => (projectCwd ? s.advisorDefaults[projectKey(instanceId, projectCwd)] : undefined));
  const [picking, setPicking] = useState(false);
  const [levelMenu, setLevelMenu] = useState(false);
  const levelAnchor = useRef<HTMLSpanElement | null>(null);

  // omp's config is the source of the default, and it is read in main.
  useEffect(() => {
    if (projectCwd !== undefined) void loadAdvisorDefaults(projectCwd, instanceId);
  }, [projectCwd, instanceId, loadAdvisorDefaults]);

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

  if (!recordPresent) return null;

  const on = advisorOn;
  const live = recordLive;
  const gated = gateAdvisor !== null;
  /** Display precedence (issue #372): the instance's gate wins over every
   *  saved choice; nothing here writes back. This reports the configured
   *  selection, not a runtime observation — lineage overlays and the
   *  advisor-stats extension remain the runtime evidence. */
  const effective = gateAdvisor ?? advisorModel ?? defaults?.model ?? null;
  const inherited = !gated && advisorModel === null;

  /** The effective model and its thinking level, split apart (omp encodes the
   * level as a `:level` suffix on the selector). */
  const effectiveSplit = effective === null ? null : parseModelRole(effective);
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
    void setSessionAdvisor(tabId, !on, advisorModel);
  };

  const pinNote =
    projectAdvisorPin !== undefined && projectAdvisorPin !== null
      ? ` · project default ${projectAdvisorPin} applies to new sessions`
      : "";
  /** Honest provenance for the gated selector (issue #372): active on a live
   *  session, pending on a dormant one, and worded as not-yet-running while
   *  the advisor is off. */
  const gatedSentence = !live
    ? `On resume, this app instance overrides the advisor model with ${gateAdvisor ?? ""}. Saved choices are unchanged.`
    : on
      ? `This app instance overrides the advisor model with ${gateAdvisor ?? ""}. Saved session and project choices are unchanged.`
      : `When the advisor is enabled, this app instance uses ${gateAdvisor ?? ""}. Saved choices are unchanged.`;
  const title = gated
    ? on
      ? `${"advisor on"} — ${effective} · ${gatedSentence}${" · click to turn off"}${pinNote}${" · restarts the session"}`
      : `${gatedSentence}${"advisor off · click to turn on"}${pinNote}${" · restarts the session"}`
    : on
      ? `${"advisor on"}${
          effective === null
            ? " (omp picks the model)"
            : ` — ${effective}`
        }${inherited && effective !== null ? " (from omp config)" : ""}${" · click to turn off"}${pinNote}${" · restarts the session"}`
      : `${"advisor off · click to turn on"}${
          defaults?.model === null || defaults?.model === undefined
            ? ""
            : ` with ${defaults.model} from omp config`
        }${pinNote}${" · restarts the session"}`;

  return (
    <>
      <span className={cn("flex min-w-0 shrink items-center gap-1.5", density === "touch" && "flex-1 justify-end")}>
        {/* The model only matters while the advisor runs, so the capsule only
            appears then — an always-visible dropdown for a disabled feature
            invites setting a model that does nothing. It stays neutral: the
            switch beside it carries the on state (issue #1138). While the gate
            is on, the capsule is a read-only statement of what this instance
            runs. */}
        {on && (
          <Capsule
            className={cn(
              density === "touch" && "h-auto min-h-11 min-w-0 flex-1 flex-wrap",
              density === "desktop" && "min-w-0 shrink",
              placement === "flow" && "flex-wrap",
            )}
          >
            <button
              type="button"
              disabled={disabled || gated}
              title={
                gated
                  ? `${"Dev/test advisor override"}: ${effective}`
                  : effective === null
                    ? "no advisor model configured — omp falls back to its `slow` model chain"
                    : `advisor model: ${effective}${inherited
                          ? " (from omp config)"
                          : " (pinned to this session)"} · click to change`
              }
              onClick={() => {
                if (gated) return;
                setPicking(true);
              }}
              className={cn(
                CAPSULE_SEGMENT,
                density === "touch" ? "min-w-0 flex-1 justify-center px-3 text-xs" : "max-w-40 text-xs",
                gated ? "text-ink-mid" : inherited ? "text-ink-faint" : "text-ink-mid",
              )}
            >
              <span className="min-w-0 truncate">
                {effective === null
                  ? "pick model"
                  : effectiveModel?.name || effectiveModel?.id || shortModelLabel(effective)}
              </span>
            </button>

            {/* The thinking level is omp's `:level` suffix on the advisor role, so
                it needs a running model to attach to and only makes sense when the
                model advertises efforts. Like the model picker, choosing one is a
                deliberate pick — every change restarts the session. While gated,
                the gated selector's own level renders read-only even with no
                catalog; a gated selector without a level shows no value at all,
                so no stored/default effort is ever implied (issue #372). */}
            {gated && effectiveLevel !== null && (
              <span ref={levelAnchor} className="relative flex">
                <button
                  type="button"
                  disabled
                  title={`${"Dev/test advisor override"}: ${effective}`}
                  className={cn(
                    CAPSULE_SEGMENT,
                    "shrink-0 rounded-r-md text-xs tabular-nums text-ink-mid",
                    density === "touch" && "px-3",
                  )}
                >
                  {effectiveLevel}
                </button>
              </span>
            )}
            {!gated && effectiveModelSelector !== null && efforts.length > 0 && (
              <span ref={levelAnchor} className={cn("relative flex", placement === "flow" && levelMenu && "contents")}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-expanded={levelMenu}
                  title={`advisor thinking level — click to pick (${efforts.join(", ")}) · restarts the session`}
                  onClick={() => setLevelMenu((m) => !m)}
                  className={cn(
                    CAPSULE_SEGMENT,
                    "shrink-0 rounded-r-md text-xs tabular-nums text-iris",
                    density === "touch" && "px-3",
                  )}
                >
                  {effectiveLevel ?? "think —"}
                </button>
                {levelMenu && (
                  <div className={cn(
                    "animate-rise edge-lit z-20 flex flex-col rounded-md border border-line-strong bg-overlay p-1",
                    // The capsule sits at the row's right edge, so the menu
                    // opens leftward and stays inside the popover.
                    placement === "flow" ? "mt-1 w-full basis-full" : "absolute bottom-full right-0 mb-1 w-32",
                  )}>
                    <span className="px-1.5 pb-1 pt-0.5">
                      <Label>advisor thinking</Label>
                    </span>
                    {effectiveLevel !== null && (
                      <button
                        type="button"
                        onClick={() => setLevel("")}
                        className="rounded px-1.5 py-0.5 text-left text-xs text-ink-faint hover:bg-hover"
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
                          "rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover",
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
        )}
        {/* The compact source label: neutral/copper by design — this is
            instance provenance, never a user choice (issue #372). */}
        {gated && (
          <span
            title="Dev/test advisor override"
            className={cn("shrink-0 rounded border px-1 py-0.5 font-mono text-xs uppercase tracking-wide", TONE_CHIP.neutral)}
          >
            dev/test
          </span>
        )}
        <Switch on={on} label="advisor" title={title} disabled={disabled} onChange={toggle} />
      </span>

      {picking && !gated && (
        <ModelPalette
          variant="advisor"
          instanceId={instanceId}
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
            projectCwd === undefined || isChat
              ? undefined
              : (selector) => void setProjectDefaultAdvisorModel(projectCwd, selector, instanceId)
          }
        />
      )}
    </>
  );
}
