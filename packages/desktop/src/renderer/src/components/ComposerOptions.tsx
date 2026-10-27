import { useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { projectKey } from "../lib/project-key";
import { repositoryMembers, type CheckoutEntry } from "../lib/repository-members";
import { modelFastTier } from "../lib/rpc-types";
import { useDismissal } from "../lib/use-dismissal";
import { findOwner, useStore } from "../store";
import { AdvisorControl } from "./AdvisorControl";
import { BranchChip } from "./BranchChip";
import { BuildPlanControl } from "./BuildPlanControl";
import { FastModeControl } from "./FastModeControl";
import { MachineChip } from "./MachineChip";
import { ModelSelector } from "./ModelSelector";
import type { WorkspaceSelection } from "./WorktreeBranchFields";
import { Button, Capsule, Chevron, Label } from "./ui";

/** Stable empty so the per-field selector doesn't fire on every store tick. */
const NO_EFFORTS: never[] = [];

/**
 * The desktop composer footer's **options pill** (issue #939): one trigger
 * reading mode · model · thinking · branch, opening a grouped popover —
 * Model (model, thinking level, fast mode), Session (Build/Plan, advisor),
 * Workspace (branch chip, machine chip). Store-aware on `tabId` like
 * ComposerSheet; the Composer passes only the state it owns.
 *
 * The panel is always mounted and toggled with `hidden`: BranchChip loads and
 * refreshes branch info only while mounted, and AdvisorControl loads its
 * defaults on mount, so mounting on open would leave the pill's branch
 * segment absent (no info → no Workspace group → no BranchChip) or stale.
 */
export function ComposerOptions({
  tabId,
  disabled,
  chat,
  projectCwd,
  instanceId,
  workspace,
  onWorkspaceChange,
  workspaceDisabled,
  onCreateWorktree,
  finishTabId,
  offerMachine,
  machineDisabled,
  onPickMachine,
  onModeSelected,
}: {
  tabId: string;
  /** Composer `unavailable`: disables every process control inside, never the pill itself. */
  disabled: boolean;
  chat: boolean;
  /** Composer `cwd` (sessionCwd(record)) — the BranchChip projectCwd. */
  projectCwd: string | undefined;
  instanceId: string | null;
  /** Defined only while the Composer offers the pending workspace. */
  workspace: WorkspaceSelection | undefined;
  onWorkspaceChange:
    | ((next: WorkspaceSelection | ((prev: WorkspaceSelection) => WorkspaceSelection)) => void)
    | undefined;
  workspaceDisabled: boolean;
  onCreateWorktree: (() => Promise<boolean>) | undefined;
  finishTabId: string | undefined;
  offerMachine: boolean;
  machineDisabled: boolean;
  onPickMachine: (member: CheckoutEntry) => void;
  /** A Build/Plan pick: the Composer reclaims the caret. */
  onModeSelected: () => void;
}) {
  const t = useT();
  const planEnabled = useStore((s) => s.rpc[tabId]?.plan?.enabled ?? false);
  const defaultAgentMode = useStore((s) => s.state?.defaultAgentMode ?? "plan");
  const model = useStore((s) => s.rpc[tabId]?.model ?? null);
  // #932: a held session runs on omp's fallback, which the user never chose.
  const held = useStore((s) => (findOwner(s.state, tabId)?.record.modelHold ?? null) !== null);
  const thinkingLevel = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const thinkingConfigured = useStore((s) => s.rpc[tabId]?.session.thinkingConfigured ?? null);
  const efforts = useStore((s) => s.rpc[tabId]?.model?.thinking?.efforts ?? NO_EFFORTS);
  const fastEnabled = useStore((s) => s.rpc[tabId]?.session.fastModeEnabled ?? false);
  const fastActive = useStore((s) => s.rpc[tabId]?.session.fastModeActive ?? false);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const info = useStore((s) =>
    projectCwd === undefined ? undefined : s.branches[projectKey(instanceId, projectCwd)],
  );
  // A number, so the selector stays stable across unrelated state ticks.
  const memberCount = useStore((s) => {
    const memberCwd = findOwner(s.state, tabId)?.record.projectCwd;
    return offerMachine && memberCwd != null
      ? repositoryMembers(s.state, instanceId, memberCwd).length
      : 0;
  });

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = () => setOpen(false);
  useDismissal({
    open,
    refs: rootRef,
    onClose: close,
    // A nested surface (BranchChip / MachineChip / advisor level menu) owns
    // this Escape: its window listener registered after ours, so it still
    // sees the event and peels itself.
    onEscape: () => {
      if (panelRef.current?.querySelector('[aria-expanded="true"]') != null) return;
      close();
      triggerRef.current?.focus();
    },
    // ModelSelector's and AdvisorControl's palettes are portaled Modals: a
    // click in them must not close the panel mid-pick.
    exemptSelector: "[data-overlay-root]",
  });

  // Carried over verbatim from the old footer gate (issue #689).
  const fastVisible = modelFastTier(model) !== null || fastEnabled || fastActive;
  const branchVisible = !chat && info !== undefined && info.repoRoot !== null;
  const machineVisible = offerMachine && memberCount >= 2;
  const resolvable = info?.current != null && info.upstreamRef !== null && info.hasUpstream;
  const behind = resolvable ? info.behind : 0;
  const diverged = resolvable && info.ahead > 0 && info.behind > 0;
  const mode = planEnabled ? "plan" : "build";
  const autoTitle = t("composer.thinking.autoTitle", { level: thinkingLevel ?? "—" });
  const dot = <span aria-hidden className="text-ink-faint">·</span>;

  return (
    <span ref={rootRef} className="relative flex min-w-0 shrink">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("composer.options.title")}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-full border border-line px-2 text-[11px] text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink aria-expanded:bg-hover"
      >
        {!chat && (
          <>
            <span
              data-pill-segment="mode"
              className={cn("shrink-0", mode !== defaultAgentMode ? "text-iris" : "text-ink")}
            >
              {mode}
            </span>
            {dot}
          </>
        )}
        <span
          data-pill-segment="model"
          title={model !== null && !held ? `${model.provider}/${model.id}` : undefined}
          className={cn("min-w-0 truncate", held && "text-copper")}
        >
          {held ? t("composer.model.held") : model === null ? t("composer.model.fallback") : model.name || model.id}
        </span>
        {dot}
        <span
          data-pill-segment="thinking"
          title={thinkingConfigured === "auto" ? autoTitle : undefined}
          className="shrink-0 font-mono tabular-nums text-iris"
        >
          {thinkingConfigured === "auto"
            ? t("composer.thinking.auto")
            : thinkingLevel ?? t("composer.thinking.fallback")}
        </span>
        {branchVisible && (
          <>
            {dot}
            <span data-pill-segment="branch" className="flex min-w-0 shrink items-center gap-1">
              <span className="max-w-32 truncate font-mono">
                ⎇ {workspace?.mode === "worktree" ? workspace.branch : info.current ?? t("composer.branch.detachedChip")}
              </span>
              {behind > 0 && (
                <span aria-hidden className={cn("shrink-0 font-mono", diverged ? "text-copper" : "text-ink-dim")}>
                  ↓ {behind}
                </span>
              )}
            </span>
          </>
        )}
        <Chevron open={false} className="rotate-90 text-ink-faint" />
      </button>

      <div
        ref={panelRef}
        hidden={!open}
        role="dialog"
        aria-label={t("composer.options.title")}
        // No max-h/overflow: the nested chip popovers are `absolute bottom-full`
        // children and a scrolling panel would clip them.
        className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-md border border-line-strong bg-overlay p-2"
      >
        <section aria-label={t("composer.options.groupModel")} className="flex flex-col gap-1.5">
          <Label>{t("composer.options.groupModel")}</Label>
          <Capsule className="min-w-0 max-w-full self-start">
            <ModelSelector tabId={tabId} disabled={disabled} />
          </Capsule>
          {efforts.length > 0 && (
            <div role="group" aria-label={t("composer.thinking.label")} className="flex flex-wrap gap-1">
              {/* Under auto the effort rows un-highlight: the resolved level is not the user's choice. */}
              <Button
                size="xs"
                tone="iris"
                selected={thinkingConfigured === "auto"}
                disabled={disabled}
                title={autoTitle}
                onClick={() => void setThinkingLevel(tabId, "auto")}
                className="font-mono"
              >
                {t("composer.thinking.auto")}
              </Button>
              {efforts.map((effort) => (
                <Button
                  key={effort}
                  size="xs"
                  tone="iris"
                  disabled={disabled}
                  selected={thinkingConfigured !== "auto" && effort === thinkingLevel}
                  onClick={() => void setThinkingLevel(tabId, effort)}
                  className="font-mono"
                >
                  {effort}
                </Button>
              ))}
            </div>
          )}
          {fastVisible && <FastModeControl tabId={tabId} layout="sheet" disabled={disabled} className="min-h-0" />}
        </section>

        <section aria-label={t("composer.options.groupSession")} className="flex flex-col gap-1.5">
          <Label>{t("composer.options.groupSession")}</Label>
          {/* A chat is Build-only: no mode control (#894). */}
          {!chat && (
            <BuildPlanControl
              tabId={tabId}
              disabled={disabled}
              className="self-start"
              onSelected={() => {
                close();
                onModeSelected();
              }}
            />
          )}
          <div className="flex min-w-0 items-center gap-2">
            <AdvisorControl tabId={tabId} disabled={disabled} />
            <span className="shrink-0 text-[10px] text-ink-faint">{t("composer.options.advisorHint")}</span>
          </div>
        </section>

        <section
          aria-label={t("composer.options.groupWorkspace")}
          hidden={!(branchVisible || machineVisible)}
          className="flex flex-col gap-1.5"
        >
          <Label>{t("composer.options.groupWorkspace")}</Label>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {!chat && (
              <BranchChip
                projectCwd={projectCwd}
                instanceId={instanceId}
                workspace={workspace}
                onWorkspaceChange={onWorkspaceChange}
                workspaceDisabled={workspaceDisabled}
                onCreateWorktree={onCreateWorktree}
                finishTabId={finishTabId}
              />
            )}
            {offerMachine && <MachineChip tabId={tabId} disabled={machineDisabled} onPick={onPickMachine} />}
          </div>
        </section>
      </div>
    </span>
  );
}
