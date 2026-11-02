import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import type { ProjectOpenAvailability, ProjectOpenTarget } from "@omp-ui/core/types";
import { backend } from "../backend";
import { currentLocaleId, useT } from "../lib/i18n";
import {
  checkoutEntries,
  groupByRepository,
  projectIdentitySeed,
  type CheckoutEntry,
} from "../lib/repository-members";
import { useCompactShell } from "../lib/responsive";
import { remoteVsCodeRow, useRemoteVsCodeTarget } from "../lib/remote-vscode";
import { useDismissal } from "../lib/use-dismissal";
import { isChatTab, useStore } from "../store";
import { MenuRow } from "./MenuRow";
import { ProjectMonogram } from "./ProjectMonogram";
import { IconOpenIn, IconPlus, IconTune, Panel } from "./ui";

/**
 * The title bar's corner tools card (issue #1021): a quiet icon button at the
 * right end — left of the caption-button inset — that drops a compact card for
 * the focused project: identity header, New session, the host-local open
 * targets (or Open in VS Code over Remote-SSH for a remote checkout), and
 * Project settings. It is the quick-open's project page distilled to the four
 * actions people reach for without opening a palette: the target-pair rule,
 * the subline rules, the asked-once availability probe, and the
 * close-before-run pick contract all mirror ProjectQuickOpen so the two can
 * never disagree about which checkout a click acts on.
 *
 * Interaction: hover (200ms dwell) previews the card, a click pins it open so
 * it survives mouse-outs, and leaving either box starts a 400ms grace close —
 * unless the pointer merely crossed the trigger→card gap (the prototype-found
 * trap: the leave event's coordinates already inside the panel's rect expanded
 * by a few px keep the card open). Click-outside and Escape dismiss with focus
 * restored to the trigger, per the WorktreeChip portal convention.
 */

/** Hover dwell before the card previews. */
const HOVER_OPEN_MS = 200;
/** Grace period after the pointer leaves before an unpinned card closes. */
const LEAVE_GRACE_MS = 400;
/** Slack around the panel's rect that counts as "still heading for the card". */
const GAP_SLACK = 8;

const UNAVAILABLE: ProjectOpenAvailability = { vsCode: false, terminal: false };

/** The card's subject: one repository group plus the pair every row acts on. */
interface Face {
  name: string;
  icon: string | null;
  seed: string;
  sub: string;
  title: string | undefined;
  projectCwd: string;
  instanceId: string | null;
}

export function CornerTools() {
  const t = useT();
  const localeId = currentLocaleId();
  const compact = useCompactShell();
  const state = useStore((s) => s.state);
  const focused = useStore((s) => s.tabs.find((tab) => tab.tabId === s.activeTabId) ?? null);
  const newSession = useStore((s) => s.newSession);
  const openProjectSettings = useStore((s) => s.openProjectSettings);
  const reportError = useStore((s) => s.reportError);

  const [open, setOpen] = useState(false);
  /** The panel's anchor, captured from the trigger at open time. */
  const [pos, setPos] = useState<{ right: number; y: number } | null>(null);
  /** Click-pinned open: survives pointer-outs until a second click. */
  const [pinned, setPinnedState] = useState(false);
  const [availability, setAvailability] = useState<ProjectOpenAvailability | null>(null);
  /** null = never asked; asked once per mount, like the quick-open probe. */
  const availabilityAsked = useRef(false);
  const mounted = useRef(false);
  /** Latest `pinned`, read by the grace timer without re-arming it. */
  const pinnedRef = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** The trigger's wrapper; the portaled panel is tracked separately. */
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * useDismissal tests DOM containment and the panel lives under document.body
   * — outside rootRef — so it must be its own ref; otherwise every pointerdown
   * on a row dismisses the card before the click can land (WorktreeChip's rule).
   */
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(graceTimer.current);
    },
    [],
  );

  const nicknames = useMemo(
    () => new Map((state?.remoteInstances ?? []).map((instance) => [instance.id, instance.nickname])),
    [state],
  );

  // The focused project's repository leads; otherwise the first group with a
  // local checkout (the card is primarily this computer's toolbox), else
  // registry order. Membership match, like quick-open's lead row.
  const face = useMemo<Face | null>(() => {
    const groups = groupByRepository(checkoutEntries(state));
    if (groups.length === 0) return null;
    const focusedInstanceId = focused?.instanceId ?? null;
    const leadCwd = focused !== null && !isChatTab(state, focused.tabId) ? focused.projectCwd : null;
    const group =
      (leadCwd !== null ? groups.find((g) => g.members.some((m) => m.projectCwd === leadCwd)) : undefined) ??
      groups.find((g) => g.members.some((m) => m.instanceId === null)) ??
      groups[0]!;
    // Target pair (the Q3 rule, mirrored from quick-open): the local checkout
    // wins, else the instance holding the focused tab, else registry order.
    const target =
      group.members.find((m) => m.instanceId === null) ??
      (focusedInstanceId !== null ? group.members.find((m) => m.instanceId === focusedInstanceId) : undefined) ??
      group.members[0]!;
    // The subline names every machine holding a checkout (#936): local first,
    // then member order, each machine once (twins collapse).
    const machineList = (members: readonly CheckoutEntry[]): string => {
      const ids = [...new Set(members.map((m) => m.instanceId))].sort(
        (a, b) => Number(a !== null) - Number(b !== null),
      );
      return ids
        .map((id) => (id === null ? t("quickopen.host.local") : (nicknames.get(id) ?? id)))
        .join(" · ");
    };
    return {
      name: target.name,
      // The target names the card, so its icon leads; a merged group falls
      // back to any member's icon (#1000).
      icon: target.icon ?? group.members.find((m) => m.icon !== null)?.icon ?? null,
      seed: projectIdentitySeed({
        repositoryKey: group.key,
        instanceId: target.instanceId,
        projectCwd: target.projectCwd,
      }),
      sub:
        group.members.length === 1
          ? target.instanceId === null
            ? t("quickopen.host.local")
            : `${nicknames.get(target.instanceId) ?? target.instanceId} · ${target.projectCwd}`
          : machineList(group.members),
      title: group.members.length === 1 ? target.title : group.members.map((m) => m.projectCwd).join("\n"),
      projectCwd: target.projectCwd,
      instanceId: target.instanceId,
    };
  }, [state, focused, nicknames, t, localeId]);

  const p = face?.projectCwd ?? "";
  const i = face?.instanceId ?? null;
  const remoteVsCodeEnabled = state?.remoteVsCodeEnabled === true;
  const remoteVsCode = useRemoteVsCodeTarget(i, remoteVsCodeEnabled && !compact && open && i !== null);

  const clearOpenTimer = (): void => {
    clearTimeout(openTimer.current);
    openTimer.current = undefined;
  };

  const clearGrace = (): void => {
    clearTimeout(graceTimer.current);
    graceTimer.current = undefined;
  };

  /** Stop every pending transition and unpin — the one way out of the card. */
  const close = useCallback((): void => {
    clearOpenTimer();
    clearGrace();
    pinnedRef.current = false;
    setPinnedState(false);
    setOpen(false);
  }, []);

  /** The open targets are asked once per mount, and only for a local pair. */
  const askAvailability = (): void => {
    if (face === null || face.instanceId !== null || availability !== null || availabilityAsked.current) return;
    availabilityAsked.current = true;
    backend.getProjectOpenAvailability().then(
      (answer) => {
        if (mounted.current) setAvailability(answer);
      },
      () => {
        // A failed discovery channel reads as "optional integrations
        // unavailable"; Files stays usable.
        if (mounted.current) setAvailability(UNAVAILABLE);
      },
    );
  };

  const measureAndOpen = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setPos(rect === undefined ? null : { right: rect.right, y: rect.bottom + 4 });
    setOpen(true);
    askAvailability();
  };

  const armGrace = (): void => {
    clearGrace();
    graceTimer.current = setTimeout(() => {
      graceTimer.current = undefined;
      if (!pinnedRef.current) setOpen(false);
    }, LEAVE_GRACE_MS);
  };

  /**
   * The gap guard: a pointerout whose coordinates already sit inside the
   * panel's rect (plus slack) is the mouse crossing the trigger→card gap, not
   * leaving the card — never arm the grace close for it.
   */
  const insidePanel = (x: number, y: number): boolean => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect === undefined) return false;
    return (
      x >= rect.left - GAP_SLACK && x <= rect.right + GAP_SLACK && y >= rect.top - GAP_SLACK && y <= rect.bottom + GAP_SLACK
    );
  };

  const onTriggerEnter = (): void => {
    clearGrace();
    if (!open && openTimer.current === undefined) {
      openTimer.current = setTimeout(() => {
        openTimer.current = undefined;
        measureAndOpen();
      }, HOVER_OPEN_MS);
    }
  };

  const onTriggerLeave = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (insidePanel(event.clientX, event.clientY)) return;
    clearOpenTimer();
    armGrace();
  };

  const onTriggerClick = (): void => {
    clearOpenTimer();
    clearGrace();
    if (open && pinned) {
      close();
      return;
    }
    pinnedRef.current = true;
    setPinnedState(true);
    measureAndOpen();
  };

  /** Close first, run after: the card never outlives the pick it committed. */
  const pick = (run: () => void): void => {
    close();
    run();
  };

  useDismissal({
    open: open && !compact && face !== null,
    refs: [rootRef, panelRef],
    onClose: close,
    onEscape: close,
    restoreFocus: () => triggerRef.current?.focus(),
  });

  if (compact || face === null) return null;

  const openRow = (targetKind: ProjectOpenTarget, label: string): ReactElement => (
    <MenuRow
      key={targetKind}
      glyph={<IconOpenIn className="size-3" />}
      label={label}
      onClick={() => pick(() => void backend.openProject(p, targetKind).catch(reportError))}
    />
  );

  const remoteRow =
    i !== null && remoteVsCodeEnabled
      ? remoteVsCodeRow(remoteVsCode, nicknames.get(i) ?? i, t)
      : ({ show: false } as const);

  return (
    <span
      ref={rootRef}
      className="inline-flex shrink-0 [app-region:no-drag]"
      onPointerEnter={onTriggerEnter}
      onPointerLeave={onTriggerLeave}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("cornertools.trigger")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("cornertools.trigger")}
        onClick={onTriggerClick}
        className={
          "grid size-6 shrink-0 place-items-center rounded-md text-ink-dim " +
          "transition-colors duration-150 hover:bg-hover hover:text-ink"
        }
      >
        <IconOpenIn className="size-4" />
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={t("cornertools.header", { name: face.name })}
            className="fixed z-40"
            style={{ left: pos.right, top: pos.y }}
            onPointerEnter={clearGrace}
            onPointerLeave={armGrace}
          >
            <Panel className="edge-lit animate-rise w-64 max-w-[calc(100vw-1rem)] p-1 -translate-x-full">
              <div className="flex items-center gap-2 px-1.5 py-1.5">
                <ProjectMonogram seed={face.seed} name={face.name} icon={face.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-ink" title={face.title}>
                    {face.name}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-ink-faint">{face.sub}</span>
                </span>
              </div>
              <MenuRow
                glyph={<IconPlus className="size-3" />}
                label={t("project.actions.newSession")}
                onClick={() => pick(() => void newSession(p, undefined, i))}
              />
              {i === null && (
                <>
                  {availability?.vsCode === true &&
                    openRow("vscode", t("quickopen.action.openIn", { target: "VS Code" }))}
                  {/* Files never waits on the probe; it needs no discovery. */}
                  {openRow("files", t("quickopen.action.openIn", { target: t("project.open.files") }))}
                  {availability?.terminal === true &&
                    openRow("terminal", t("quickopen.action.openIn", { target: t("project.open.terminal") }))}
                </>
              )}
              {i !== null &&
                remoteRow.show &&
                (
                  <MenuRow
                    glyph={<IconOpenIn className="size-3" />}
                    label={t("quickopen.action.openIn", { target: "VS Code" })}
                    hint={remoteRow.reason === null ? t("remotevscode.sub") : undefined}
                    title={remoteRow.reason ?? undefined}
                    disabled={remoteRow.reason !== null}
                    onClick={() => pick(() => void backend.openRemoteVsCode(i, p).catch(reportError))}
                  />
                )}
              <div className="my-1 border-t border-line-soft" />
              <MenuRow
                glyph={<IconTune className="size-3" />}
                label={t("project.actions.settings")}
                onClick={() => pick(() => openProjectSettings(p, i))}
              />
            </Panel>
          </div>,
          document.body,
        )}
    </span>
  );
}
