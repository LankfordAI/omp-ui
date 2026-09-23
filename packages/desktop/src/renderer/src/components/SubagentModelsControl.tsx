import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OmpSettingValue } from "@omp-ui/core/types";
import { OMP_SUBAGENT_MODELS_KEY } from "@omp-ui/core/omp-settings-keys";
import { SUBAGENT_MODEL_INHERIT, type SubagentModelMap } from "@omp-ui/core/subagent-model";
import { backendFor, displayMessage } from "../backend";
import { useT } from "../lib/i18n";
import type { ModelInfo } from "../lib/rpc-types";
import { useDismissal } from "../lib/use-dismissal";
import { findOwner, findRecord, sessionCwd, useStore } from "../store";
import { ModelPalette } from "./ModelSelector";
import { Chip, IconTune } from "./ui";

const EMPTY_MODELS: ModelInfo[] = [];

const EMPTY_ROSTER: string[] = [];

/** Nominal popover width; narrower only when the viewport itself cannot hold it. */
const POPOVER_WIDTH = 288;
/** Gap between the trigger's bottom edge and the popover. */
const POPOVER_GAP = 4;
/** Breathing room kept between the popover and every viewport edge. */
const VIEWPORT_EDGE = 8;

interface PopoverGeometry {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** The record value of one settings entry, or {} when unset/not a record. */
function recordOf(value: OmpSettingValue | undefined): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * The Agents pane's session-scope subagent model control (ADR-0031): one row
 * per roster agent showing the session's own choice and the layer that
 * currently wins. Writes go to `session:setSubagentModels`, which rewrites
 * the session's overlay in place — omp re-reads it before every spawn, so the
 * change is live for the NEXT spawn; running agents keep their model.
 *
 * The popover shows configured values and winning layers, never a claimed
 * actual: `get_subagents` does not report the resolved model.
 *
 * The popover is portaled to `document.body` and fixed-positioned (issue #634):
 * the Agents pane body is an `overflow-y-auto` scroll box, which computes
 * `overflow-x` to `auto` too, so an in-tree popover wider than the room left
 * of its trigger was clipped at the pane edge.
 */
export function SubagentModelsControl({ tabId }: { tabId: string }) {
  const t = useT();
  const record = useStore((s) => findRecord(s.state, tabId));
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const roster = useStore((s) => s.state?.agentRoster ?? EMPTY_ROSTER);
  const inheritByDefault = useStore((s) => s.state?.subagentModelInheritByDefault ?? true);
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY_MODELS);
  const [open, setOpen] = useState(false);
  const [paletteAgent, setPaletteAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<{
    effective: Record<string, unknown>;
    project: Record<string, string>;
    /** False for remote sessions: their global layer cannot be read from here. */
    globalKnown: boolean;
  } | null>(null);
  const [geometry, setGeometry] = useState<PopoverGeometry | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cwd = sessionCwd(record);

  // Layer reads run on open, never while the popover is closed. A remote
  // session's project layer rides the proxy; its global layer is refused
  // there, so only the local case reads the settings snapshot.
  useEffect(() => {
    if (!open || cwd === undefined) return;
    let stale = false;
    const settingsRead =
      instanceId === null
        ? backendFor(null).readOmpSettings(cwd).then((snap) => snap, () => null)
        : Promise.resolve(null);
    const projectRead = backendFor(instanceId)
      .getProjectSubagentModels(cwd)
      .then((result) => result, () => null);
    void Promise.all([settingsRead, projectRead]).then(([snap, project]) => {
      if (stale) return;
      const entry = snap?.entries.find((e) => e.key === OMP_SUBAGENT_MODELS_KEY);
      setLayers({
        effective: recordOf(entry?.value),
        project: project?.map ?? {},
        globalKnown: instanceId === null && snap !== null,
      });
    });
    return () => {
      stale = true;
    };
  }, [open, cwd, instanceId]);

  // Anchored before paint: below the trigger, right-aligned to it, clamped
  // inside the visual viewport. Re-anchored on resize and on any scroll
  // (capture phase — scroll does not bubble), so the popover follows the
  // trigger when the pane body scrolls under it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      // The visual viewport is the honest one under a compact keyboard or a
      // pinch-zoom; inner{Width,Height} is the fallback where it is unsupported.
      const visualViewport = window.visualViewport;
      const viewportLeft = visualViewport?.offsetLeft ?? 0;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportWidth = visualViewport?.width ?? window.innerWidth;
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      const width = Math.min(POPOVER_WIDTH, Math.max(0, viewportWidth - VIEWPORT_EDGE * 2));
      const minLeft = viewportLeft + VIEWPORT_EDGE;
      const maxLeft = viewportLeft + viewportWidth - VIEWPORT_EDGE - width;
      const top = Math.max(viewportTop + VIEWPORT_EDGE, rect.bottom + POPOVER_GAP);
      setGeometry({
        left: Math.max(minLeft, Math.min(rect.right - width, maxLeft)),
        top,
        width,
        maxHeight: Math.max(0, viewportTop + viewportHeight - VIEWPORT_EDGE - top),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Once per opening: at the end of <body> the portal is otherwise the last
  // stop in Tab order, so focus moves into it.
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Fail closed: a press outside the trigger and the portaled panel dismisses.
  // Suspended while the model palette is up — its Modal is portaled outside
  // both refs, and its own overlay owns Escape until it closes.
  useDismissal({
    open: open && paletteAgent === null,
    refs: [triggerRef, panelRef],
    onClose: () => setOpen(false),
    onEscape: () => setOpen(false),
    restoreFocus: () => triggerRef.current?.focus(),
  });

  if (record === undefined) return null;

  const pick = (agent: string, selector: string | null): void => {
    const next: SubagentModelMap = { ...(record.subagentModels ?? {}) };
    if (selector === null) delete next[agent];
    else next[agent] = selector;
    // Keep an explicit empty map distinct from null: `{}` means "this session
    // chooses omp defaults and disables the umbrella"; null means untouched,
    // so the inherit-by-default preference may fill every roster key.
    backendFor(instanceId)
      .setSessionSubagentModels(tabId, next)
      .catch((err: unknown) => setError(displayMessage(err)));
  };

  const refreshRoster = (): void => {
    backendFor(null)
      .refreshAgentRoster()
      .catch((err: unknown) => setError(displayMessage(err)));
  };

  const sessionModels = record.subagentModels;

  return (
    <span>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("rail.agents.modelsLabel")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("rail.agents.modelsLabel")}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line bg-transparent px-1.5 text-[11px] font-medium text-ink-mid transition-colors hover:border-line-strong hover:text-ink"
      >
        <IconTune className="size-3" />
        <span>{t("rail.agents.modelsButton")}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("rail.agents.modelsTitle")}
            tabIndex={-1}
            className="fixed z-[70] overflow-y-auto rounded-lg border border-line bg-raised p-2.5 shadow-xl"
            style={{
              left: geometry?.left ?? 0,
              top: geometry?.top ?? 0,
              width: geometry?.width ?? POPOVER_WIDTH,
              maxHeight: geometry?.maxHeight,
            }}
          >
            <p className="text-[11px] font-medium text-ink">{t("rail.agents.modelsTitle")}</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-ink-faint">
              {sessionModels === null
                ? inheritByDefault
                  ? t("rail.agents.modelsUmbrella")
                  : t("rail.agents.modelsNoUmbrella")
                : t("rail.agents.modelsExplicit")}
            </p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-ink-faint">
              {t("rail.agents.modelsTiming")}
            </p>
            {error !== null && (
              <p className="mt-1 rounded-md border border-rose-dim/50 bg-rose-wash px-2 py-1 text-[10px] text-rose">
                {error}
              </p>
            )}
            <div className="mt-1.5 divide-y divide-line-soft">
              {roster.length === 0 && (
                <p className="py-1.5 text-[10px] text-ink-faint">{t("rail.agents.modelsEmpty")}</p>
              )}
              {roster.map((agent) => {
                const sessionValue =
                  sessionModels?.[agent] ??
                  (sessionModels === null && inheritByDefault ? SUBAGENT_MODEL_INHERIT : undefined);
                const layer =
                  sessionValue !== undefined
                    ? "session"
                    : layers?.project[agent] !== undefined
                      ? "project"
                      : layers !== null && layers.globalKnown && layers.effective[agent] !== undefined
                        ? "global"
                        : "default";
                return (
                  <div key={agent} className="flex items-center gap-1.5 py-1">
                    <span className="w-24 shrink-0 truncate font-mono text-[10px] text-ink-mid">
                      {agent}
                    </span>
                    {layer === "session" && <Chip tone="signal">{t("rail.agents.modelsLayerSession")}</Chip>}
                    {layer === "project" && <Chip tone="copper">{t("rail.agents.modelsLayerProject")}</Chip>}
                    {layer === "global" && <Chip>{t("rail.agents.modelsLayerGlobal")}</Chip>}
                    <button
                      type="button"
                      onClick={() => setPaletteAgent(agent)}
                      className="ml-auto max-w-32 truncate rounded-md border border-line bg-hover px-1.5 py-0.5 font-mono text-[10px] text-ink-mid transition-colors hover:text-ink"
                    >
                      {sessionValue === undefined
                        ? t("rail.agents.modelsDefault")
                        : sessionValue === SUBAGENT_MODEL_INHERIT
                          ? t("composer.model.subagentSessionModel")
                          : sessionValue}
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={refreshRoster}
              className="mt-1.5 text-[10px] text-ink-faint transition-colors hover:text-ink-mid"
            >
              {t("rail.agents.modelsRefresh")}
            </button>
          </div>,
          document.body,
        )}
      {paletteAgent !== null && (
        <ModelPalette
          variant="subagent"
          instanceId={instanceId}
          models={models}
          current={
            sessionModels?.[paletteAgent] ??
            (sessionModels === null && inheritByDefault ? SUBAGENT_MODEL_INHERIT : null)
          }
          allowInherit
          onClose={() => setPaletteAgent(null)}
          onPick={(selector) => {
            const agent = paletteAgent;
            setPaletteAgent(null);
            pick(agent, selector);
          }}
        />
      )}
    </span>
  );
}
