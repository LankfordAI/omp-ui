import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { projectKey } from "../lib/project-key";
import { repositoryMembers, type CheckoutEntry } from "../lib/repository-members";
import { modelFastTier } from "../lib/rpc-types";
import { thinkingLevelColor } from "../lib/thinking-colors";
import { useDismissal } from "../lib/use-dismissal";
import { findOwner, runningSessionTitleOnCheckout, useStore } from "../store";
import { AdvisorControl } from "./AdvisorControl";
import { BranchChip, type BranchChipExternalRequest } from "./BranchChip";
import { BuildPlanControl } from "./BuildPlanControl";
import { FastModeControl } from "./FastModeControl";
import { MachineChip } from "./MachineChip";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSlider } from "./ThinkingSlider";
import type { WorkspaceSelection } from "./WorktreeBranchFields";
import {
  Chevron,
  IconAdvisor,
  IconBuildMode,
  IconFast,
  IconModel,
  IconPlanMode,
  IconRefresh,
  IconThinking,
  Switch,
} from "./ui";
import { TONE_CHIP } from "./ui/tone";

/** Stable empty so the per-field selector doesn't fire on every store tick. */
const NO_EFFORTS: never[] = [];

/**
 * The desktop composer footer's **options pill** (issue #939): one trigger
 * reading mode · model · thinking · branch, opening a popover of menu rows
 * (issue #946) — model, thinking (level, auto switch, and the always-visible
 * ThinkingSlider), fast mode; a divider; mode (Build/Plan), advisor with its
 * *restarts* tag; and a footer strip with the branch and machine chips. The
 * current thinking level's ramp colour paints the row icon, the value text,
 * and the pill's thinking segment. Store-aware on `tabId` like ComposerSheet;
 * the Composer passes only the state it owns.
 *
 * The panel is always mounted and toggled with `hidden`: BranchChip loads and
 * refreshes branch info only while mounted, and AdvisorControl loads its
 * defaults on mount, so mounting on open would leave the pill's branch
 * segment absent (no info → no footer → no BranchChip) or stale.
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
  const commits = (count: number): string =>
    `${count} ${count === 1 ? t("composer.branch.commit") : t("composer.branch.commits")}`;
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
  const key = projectCwd === undefined ? undefined : projectKey(instanceId, projectCwd);
  const info = useStore((s) => (key === undefined ? undefined : s.branches[key]));
  const refreshing = useStore((s) => key !== undefined && s.branchActivity[key]?.refreshing === true);
  const pulling = useStore((s) => key !== undefined && s.branchActivity[key]?.pulling === true);
  const pushing = useStore((s) => key !== undefined && s.branchActivity[key]?.pushing === true);
  const pullGitBranch = useStore((s) => s.pullGitBranch);
  const busyTitle = useStore((s) => runningSessionTitleOnCheckout(s, projectCwd));
  // A number, so the selector stays stable across unrelated state ticks.
  const memberCount = useStore((s) => {
    const memberCwd = findOwner(s.state, tabId)?.record.projectCwd;
    return offerMachine && memberCwd != null
      ? repositoryMembers(s.state, instanceId, memberCwd).length
      : 0;
  });

  const [open, setOpen] = useState(false);
  const [branchRequest, setBranchRequest] = useState<BranchChipExternalRequest | null>(null);
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
  const ahead = resolvable ? info.ahead : 0;
  const diverged = resolvable && ahead > 0 && behind > 0;
  const mergeInProgress = info?.mergeInProgress === true;
  const showPullCap = branchVisible && (pulling || (resolvable && behind > 0));
  const pullCapDisabled = refreshing || pulling || pushing;

  const handlePullCapClick = async (): Promise<void> => {
    if (projectCwd === undefined || pullCapDisabled) return;
    if (diverged || mergeInProgress) {
      setOpen(true);
      setBranchRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 }));
      return;
    }
    if (busyTitle !== null) {
      setOpen(true);
      setBranchRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, confirmPull: true }));
      return;
    }
    const err = await pullGitBranch(projectCwd, instanceId);
    if (err !== null) {
      setOpen(true);
      setBranchRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, error: err }));
    }
  };
  const mode = planEnabled ? "plan" : "build";
  const autoTitle = t("composer.thinking.autoTitle", { level: thinkingLevel ?? "—" });
  const auto = thinkingConfigured === "auto";
  // The resolved level's colour, under auto too: the slider sits on it.
  const levelColour = thinkingLevelColor(efforts.indexOf(thinkingLevel ?? ""), efforts.length);
  const levelText = thinkingLevel ?? t("composer.thinking.fallback");
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
        className={cn(
          "inline-flex h-6 min-w-0 shrink items-center gap-1 border border-line px-2 text-[11px] text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink aria-expanded:bg-hover",
          showPullCap ? "rounded-l-full" : "rounded-full",
        )}
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
          title={auto ? autoTitle : undefined}
          className="shrink-0 font-mono tabular-nums text-iris"
          style={auto ? undefined : { color: levelColour }}
        >
          {auto ? t("composer.thinking.auto") : levelText}
        </span>
        {branchVisible && (
          <>
            {dot}
            <span data-pill-segment="branch" className="flex min-w-0 shrink items-center gap-1">
              <span className="max-w-32 truncate font-mono">
                ⎇ {workspace?.mode === "worktree" ? workspace.branch : info.current ?? t("composer.branch.detachedChip")}
              </span>
            </span>
          </>
        )}
        <Chevron open={false} className="rotate-90 text-ink-faint" />
      </button>
      {showPullCap && (
        <button
          type="button"
          data-pill-segment="pull"
          disabled={pullCapDisabled}
          aria-label={
            pulling
              ? t("composer.branch.pulling")
              : diverged && info?.upstreamRef != null
                ? t("composer.branch.diverged", { ahead, behind, upstream: info.upstreamRef })
                : t("composer.branch.pull", { commits: commits(behind) })
          }
          title={
            pulling
              ? t("composer.branch.pulling")
              : mergeInProgress
                ? t("composer.branch.mergeInProgress")
                : diverged && info?.upstreamRef != null
                  ? t("composer.branch.diverged", { ahead, behind, upstream: info.upstreamRef })
                  : info?.upstreamRef != null
                    ? `${t("composer.branch.pull", { commits: commits(behind) })} (${t("composer.branch.behind", { commits: commits(behind), upstream: info.upstreamRef })})`
                    : undefined
          }
          onClick={() => void handlePullCapClick()}
          className={cn(
            "inline-flex h-6 shrink-0 items-center rounded-r-full border border-l-0 border-line px-2 font-mono text-[11px] tabular-nums transition-colors duration-150 hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim",
            diverged || mergeInProgress ? "text-copper" : "text-ink-mid hover:text-ink",
          )}
        >
          {pulling && behind === 0 ? "…" : `↓ ${behind}`}
        </button>
      )}

      <div
        ref={panelRef}
        hidden={!open}
        role="dialog"
        aria-label={t("composer.options.title")}
        // No max-h/overflow clipping: the nested chip popovers are `absolute
        // bottom-full` children and a scrolling panel would clip them.
        className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-visible rounded-md border border-line-strong bg-overlay p-1"
      >
        <section aria-label={t("composer.options.groupModel")} className="flex flex-col">
          <OptionRow icon={<IconModel />} label={t("composer.options.groupModel")}>
            <ModelSelector tabId={tabId} disabled={disabled} />
          </OptionRow>
          {efforts.length > 0 && (
            <>
              <OptionRow icon={<IconThinking />} label={t("composer.thinking.label")} iconStyle={{ color: levelColour }}>
                {auto ? (
                  <span title={autoTitle} className="truncate text-[11px] text-ink-mid">
                    {t("composer.thinking.now", { level: "\u0000" })
                      .split("\u0000")
                      .map((part, i) =>
                        i === 0 ? (
                          part
                        ) : (
                          <span key={i}>
                            <span
                              className="font-mono transition-colors duration-300 motion-reduce:transition-none"
                              style={{ color: levelColour }}
                            >
                              {levelText}
                            </span>
                            {part}
                          </span>
                        ),
                      )}
                  </span>
                ) : (
                  <span
                    className="truncate font-mono transition-colors duration-300 motion-reduce:transition-none"
                    style={{ color: levelColour }}
                  >
                    {levelText}
                  </span>
                )}
                <Switch
                  on={auto}
                  label={t("composer.thinking.auto")}
                  title={autoTitle}
                  disabled={disabled}
                  onChange={(next) =>
                    void setThinkingLevel(
                      tabId,
                      next
                        ? "auto"
                        : thinkingLevel !== null && efforts.includes(thinkingLevel)
                          ? thinkingLevel
                          : efforts[efforts.length - 1]!,
                    )
                  }
                />
                <span aria-hidden className="text-[11px] text-ink">
                  {t("composer.thinking.auto")}
                </span>
              </OptionRow>
              <div className="pb-1.5 pl-[30px] pr-2">
                <ThinkingSlider tabId={tabId} disabled={disabled} />
              </div>
            </>
          )}
          {fastVisible && (
            <OptionRow icon={<IconFast />}>
              <FastModeControl tabId={tabId} layout="sheet" disabled={disabled} className="min-h-8 w-full" />
            </OptionRow>
          )}
        </section>

        <div aria-hidden className="mx-1.5 my-1 h-px bg-line" />

        <section aria-label={t("composer.options.groupSession")} className="flex flex-col">
          {/* A chat is Build-only: no mode control (#894). */}
          {!chat && (
            <OptionRow
              icon={planEnabled ? <IconPlanMode /> : <IconBuildMode />}
              label={t("composer.options.mode")}
            >
              <BuildPlanControl
                tabId={tabId}
                disabled={disabled}
                onSelected={() => {
                  close();
                  onModeSelected();
                }}
              />
            </OptionRow>
          )}
          <OptionRow icon={<IconAdvisor />}>
            <span className="mr-auto flex min-w-0">
              <AdvisorControl tabId={tabId} disabled={disabled} />
            </span>
            <span
              title={t("composer.options.advisorHint")}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px]",
                TONE_CHIP.copper,
              )}
            >
              <IconRefresh className="size-2.5" />
              {t("composer.options.restarts")}
            </span>
          </OptionRow>
        </section>

        <section
          aria-label={t("composer.options.groupWorkspace")}
          hidden={!(branchVisible || machineVisible)}
          className="-mx-1 -mb-1 mt-1 flex min-w-0 flex-wrap items-center gap-1.5 rounded-b-md border-t border-line bg-raised px-2 py-1.5"
        >
          {!chat && (
            <BranchChip
              projectCwd={projectCwd}
              instanceId={instanceId}
              workspace={workspace}
              onWorkspaceChange={onWorkspaceChange}
              workspaceDisabled={workspaceDisabled}
              onCreateWorktree={onCreateWorktree}
              finishTabId={finishTabId}
              externalRequest={branchRequest}
            />
          )}
          {offerMachine && <MachineChip tabId={tabId} disabled={machineDisabled} onPick={onPickMachine} />}
        </section>
      </div>
    </span>
  );
}

/** One popover menu row: icon, optional label, right-aligned controls. */
function OptionRow({
  icon,
  label,
  children,
  iconStyle,
}: {
  icon: ReactNode;
  label?: string;
  children: ReactNode;
  iconStyle?: CSSProperties;
}) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2.5 rounded-[5px] px-2 text-xs text-ink">
      <span
        aria-hidden
        className="shrink-0 text-ink-mid transition-colors duration-300 motion-reduce:transition-none"
        style={iconStyle}
      >
        {icon}
      </span>
      {label !== undefined && <span className="shrink-0">{label}</span>}
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</span>
    </div>
  );
}
