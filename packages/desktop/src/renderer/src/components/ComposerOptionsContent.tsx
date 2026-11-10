import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { projectKey } from "../lib/project-key";
import { repositoryMembers, type CheckoutEntry } from "../lib/repository-members";
import { modelFastTier } from "../lib/rpc-types";
import { thinkingLevelColor } from "../lib/thinking-colors";
import { findOwner, findRecord, useStore } from "../store";
import { AdvisorControl } from "./AdvisorControl";
import { BranchChip, type BranchChipExternalRequest } from "./BranchChip";
import { BuildPlanControl } from "./BuildPlanControl";
import { FastModeControl } from "./FastModeControl";
import { MachineChip } from "./MachineChip";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSlider } from "./ThinkingSlider";
import type { WorkspaceSelection } from "./WorktreeBranchFields";
import {
  IconAdvisor,
  IconBuildMode,
  IconFast,
  IconModel,
  IconPlanMode,
  IconRefresh,
  IconThinking,
  Switch,
} from "./ui";

const NO_EFFORTS: never[] = [];

export interface ComposerOptionsContentProps {
  tabId: string;
  disabled: boolean;
  chat: boolean;
  projectCwd: string | undefined;
  instanceId: string | null;
  workspace: WorkspaceSelection | undefined;
  onWorkspaceChange:
    | ((next: WorkspaceSelection | ((prev: WorkspaceSelection) => WorkspaceSelection)) => void)
    | undefined;
  workspaceDisabled: boolean;
  onCreateWorktree: (() => Promise<boolean>) | undefined;
  finishTabId: string | undefined;
  offerMachine: boolean;
  machineDisabled: boolean;
  onPickMachine: ((member: CheckoutEntry) => void) | undefined;
  onModeSelected: () => void;
}

/** The pill and both containers use the same capability and visibility rules. */
export function useComposerOptionsState({
  tabId,
  chat,
  projectCwd,
  instanceId,
  offerMachine,
}: Pick<ComposerOptionsContentProps, "tabId" | "chat" | "projectCwd" | "instanceId" | "offerMachine">) {
  const planEnabled = useStore((s) => s.rpc[tabId]?.plan?.enabled ?? false);
  const defaultAgentMode = useStore((s) => s.state?.defaultAgentMode ?? "plan");
  const model = useStore((s) => s.rpc[tabId]?.model ?? null);
  // A held session runs on omp's fallback, which the user never chose (#932).
  const held = useStore((s) => (findOwner(s.state, tabId)?.record.modelHold ?? null) !== null);
  const thinkingLevel = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const thinkingConfigured = useStore((s) => s.rpc[tabId]?.session.thinkingConfigured ?? null);
  const efforts = useStore((s) => s.rpc[tabId]?.model?.thinking?.efforts ?? NO_EFFORTS);
  const fastEnabled = useStore((s) => s.rpc[tabId]?.session.fastModeEnabled ?? false);
  const fastActive = useStore((s) => s.rpc[tabId]?.session.fastModeActive ?? false);
  const key = projectCwd === undefined ? undefined : projectKey(instanceId, projectCwd);
  const info = useStore((s) => (key === undefined ? undefined : s.branches[key]));
  const memberCount = useStore((s) => {
    const memberCwd = findOwner(s.state, tabId)?.record.projectCwd;
    return offerMachine && memberCwd != null
      ? repositoryMembers(s.state, instanceId, memberCwd).length
      : 0;
  });
  return {
    planEnabled,
    defaultAgentMode,
    model,
    held,
    thinkingLevel,
    efforts,
    auto: thinkingConfigured === "auto",
    levelColour: thinkingLevelColor(efforts.indexOf(thinkingLevel ?? ""), efforts.length),
    fastVisible: modelFastTier(model) !== null || fastEnabled || fastActive,
    branchVisible: !chat && info !== undefined && info.repoRoot !== null,
    machineVisible: offerMachine && memberCount >= 2,
    info,
  };
}

/** Shared option groups; only sizing and nested-menu placement adapt to a sheet. */
export function ComposerOptionsContent({
  compact = false,
  scrollable = false,
  branchRequest,
  modelExtras,
  sessionExtras,
  ...props
}: ComposerOptionsContentProps & {
  compact?: boolean;
  /** Constrained desktop popovers need the same in-flow menus as sheets. */
  scrollable?: boolean;
  branchRequest?: BranchChipExternalRequest | null;
  modelExtras?: ReactNode;
  sessionExtras?: ReactNode;
}) {
  const {
    tabId, disabled, chat, projectCwd, instanceId, workspace, onWorkspaceChange,
    workspaceDisabled, onCreateWorktree, finishTabId, offerMachine,
    machineDisabled, onPickMachine, onModeSelected,
  } = props;
  const t = useT();
  const { planEnabled, thinkingLevel, efforts, auto, levelColour, fastVisible, branchVisible, machineVisible } = useComposerOptionsState(props);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const advisorOn = useStore((s) => findRecord(s.state, tabId)?.advisor ?? false);
  const autoTitle = t("composer.thinking.autoTitle", { level: thinkingLevel ?? "—" });
  const levelText = thinkingLevel ?? t("composer.thinking.fallback");
  const sheetMenus = compact || scrollable;
  const fastRow = (
    <OptionRow compact={compact} icon={<IconFast />}>
      <FastModeControl tabId={tabId} layout="sheet" disabled={disabled} className={cn("w-full", compact ? "min-h-11" : "min-h-8")} />
    </OptionRow>
  );

  return (
    <>
      <section aria-label={t("composer.options.groupModel")} className="flex flex-col">
        <OptionRow compact={compact} icon={<IconModel />} label={t("composer.options.groupModel")}>
          <ModelSelector tabId={tabId} disabled={disabled} />
        </OptionRow>
        {efforts.length > 0 && (
          <>
            {/* The readout sits beside the label; the right side holds only
                the auto switch and its caption (issue #1138). */}
            <OptionRow compact={compact} icon={<IconThinking />} label={t("composer.thinking.label")} iconStyle={{ color: levelColour }}>
              {auto ? (
                <span title={autoTitle} className="mr-auto min-w-0 truncate text-xs text-ink-dim">
                  {t("composer.thinking.now", { level: "\u0000" })
                    .split("\u0000")
                    .map((part, i) => i === 0 ? part : (
                      <span key={i}>
                        <span className="transition-colors duration-300 motion-reduce:transition-none" style={{ color: levelColour }}>{levelText}</span>
                        {part}
                      </span>
                    ))}
                </span>
              ) : (
                <span className="mr-auto min-w-0 truncate transition-colors duration-300 motion-reduce:transition-none" style={{ color: levelColour }}>{levelText}</span>
              )}
              <span aria-hidden className="shrink-0 text-xs text-ink-dim">{t("composer.thinking.auto")}</span>
              <Switch
                on={auto}
                label={t("composer.thinking.auto")}
                title={autoTitle}
                disabled={disabled}
                onChange={(next) => void setThinkingLevel(tabId, next ? "auto" : thinkingLevel !== null && efforts.includes(thinkingLevel) ? thinkingLevel : efforts[efforts.length - 1]!)}
              />
            </OptionRow>
            <div className={cn("pb-1.5 pl-[30px] pr-2", compact && "py-2")}>
              <ThinkingSlider tabId={tabId} disabled={disabled} />
            </div>
          </>
        )}
        {fastVisible && fastRow}
        {modelExtras}
      </section>

      <div aria-hidden className="mx-1.5 my-1 h-px bg-line" />

      <section aria-label={t("composer.options.groupSession")} className="flex flex-col">
        {!chat && (
          <OptionRow compact={compact} icon={planEnabled ? <IconPlanMode /> : <IconBuildMode />} label={t("composer.options.mode")}>
            <BuildPlanControl tabId={tabId} disabled={disabled} onSelected={onModeSelected} />
          </OptionRow>
        )}
        <OptionRow compact={compact} icon={<IconAdvisor />} label={t("composer.advisor.label")}>
          {/* A quiet hint, not a chip: nothing here is clickable. While the
              advisor is on it drops to its icon so the model name fits. */}
          <span title={t("composer.options.advisorHint")} className="mr-auto inline-flex shrink-0 items-center gap-1 text-ink-faint">
            <IconRefresh className="size-2.5" />
            <span className={cn(advisorOn && "sr-only")}>{t("composer.options.restarts")}</span>
          </span>
          <AdvisorControl tabId={tabId} disabled={disabled} layout={sheetMenus ? "sheet" : "inline"} />
        </OptionRow>
        {/* Preserve the compact sheet's always-available session toggle. */}
        {compact && !fastVisible && fastRow}
        {sessionExtras}
      </section>

      <section
        aria-label={t("composer.options.groupWorkspace")}
        hidden={!(branchVisible || (machineVisible && onPickMachine !== undefined))}
        className={cn(
          "-mx-1 -mb-1 mt-1 flex min-w-0 flex-wrap items-center gap-1.5 rounded-b-md border-t border-line bg-raised px-2 py-1.5",
          compact && "gap-2 py-2",
        )}
      >
        {!chat && (
          <BranchChip projectCwd={projectCwd} instanceId={instanceId} workspace={workspace} onWorkspaceChange={onWorkspaceChange} workspaceDisabled={workspaceDisabled} onCreateWorktree={onCreateWorktree} finishTabId={finishTabId} externalRequest={branchRequest} layout={sheetMenus ? "sheet" : "inline"} />
        )}
        {offerMachine && onPickMachine !== undefined && <MachineChip tabId={tabId} disabled={machineDisabled} onPick={onPickMachine} layout={sheetMenus ? "sheet" : "inline"} />}
      </section>
    </>
  );
}

function OptionRow({
  icon, label, children, iconStyle, compact,
}: {
  icon: ReactNode;
  label?: string;
  children: ReactNode;
  iconStyle?: CSSProperties;
  compact: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5 rounded-md px-2 text-xs text-ink", compact ? "min-h-11 py-1.5" : "min-h-8")}>
      <span aria-hidden className="shrink-0 text-ink-mid transition-colors duration-300 motion-reduce:transition-none" style={iconStyle}>{icon}</span>
      {label !== undefined && <span className="shrink-0">{label}</span>}
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</span>
    </div>
  );
}
