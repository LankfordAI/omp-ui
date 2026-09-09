import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { branchNameFromPlanPath } from "../lib/branch-name";
import { cn } from "../lib/cn";
import { useT, type MessageKey } from "../lib/i18n";
import { keywordColors, type MagicKeyword } from "../lib/magic-keywords";
import type { PlanExecutionContext, PlanExecutionOptions } from "../lib/plan-concerns";
import { usePreparedPlanDocument } from "../lib/plan-document";
import { useCompactShell } from "../lib/responsive";
import type { ModelInfo } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { useDismissal } from "../lib/use-dismissal";
import { useImageDraft } from "../lib/use-image-draft";
import { shortLabel, splitRole } from "./AdvisorControl";
import { ExecutionBranchSetup, useExecutionBranch } from "./ExecutionBranchSetup";
import { Markdown } from "./Markdown";
import { ModelPalette } from "./ModelSelector";
import { PlanDiagnostics, PlanFallback } from "./PlanFallback";
import { AttachmentButton, Button, CopyButton, IconButton, IconClose, Label, Switch } from "./ui";
import { TONE_CHIP } from "./ui/tone";
import {
  baseBranchSegment,
  composeWorktreeBranch,
  mintBranchName,
  PLACEHOLDER_BRANCH_RE,
  remintForBase,
  WorktreeBranchFields,
} from "./WorktreeBranchFields";

/**
 * The plan approval gate. omp's agent is *blocked* inside its `xd://propose`
 * call while this docked, non-modal panel is open in the session's tab. It has
 * no scrim, app-wide inert state, or focus trap: execute lands a verdict and
 * lets the renderer dispatch the implementation into a chosen context (same
 * session, same session after compacting, a fresh session, or a fresh
 * worktree session), while refine
 * sends the agent back to revise the draft. "Not now" or the close button
 * defers the decision without answering the gate: the agent stays paused and
 * the plan stays pending in the rail's plans tab until the user returns. Both
 * defer and refine keep the working tree read-only.
 *
 * The plan is rendered from the file on disk rather than from the proposal
 * frame: the frame carries only the slug, and the file is the artifact the
 * implementer will actually execute.
 */

/** Execution contexts offered to the user, with one-line descriptions. */
const CONTEXTS: ReadonlyArray<{
  id: PlanExecutionContext;
  labelKey: MessageKey;
  hintKey: MessageKey;
}> = [
  { id: "existing", labelKey: "plan.context.sameSession", hintKey: "plan.context.sameSessionHint" },
  { id: "compacted", labelKey: "plan.context.compactedSession", hintKey: "plan.context.compactedSessionHint" },
  { id: "fresh", labelKey: "plan.context.freshSession", hintKey: "plan.context.freshSessionHint" },
  { id: "worktree", labelKey: "plan.context.worktreeSession", hintKey: "plan.context.worktreeSessionHint" },
];

/** Stable empty array so the selector doesn't resubscribe on every store tick. */
const EMPTY_MODELS: ModelInfo[] = [];
type CompactReviewStep = "review" | "refine" | "setup";

/** The aside's keyword rows, in omp's notice-push order. */
const KEYWORD_ROWS: ReadonlyArray<{ keyword: MagicKeyword; hintKey: MessageKey }> = [
  {
    keyword: "ultrathink",
    hintKey: "plan.keyword.ultrathink",
  },
  {
    keyword: "orchestrate",
    hintKey: "plan.keyword.orchestrate",
  },
  {
    keyword: "workflowz",
    hintKey: "plan.keyword.workflowz",
  },
];

/** A magic keyword painted with its own gradient, as the composer paints it (static phase). */
function KeywordLabel({ keyword }: { keyword: MagicKeyword }) {
  return (
    <span className="font-mono text-[11px] font-medium" aria-label={keyword}>
      {keywordColors(keyword, 0).map((color, i) => (
        <span key={i} aria-hidden style={{ color }}>
          {keyword[i]}
        </span>
      ))}
    </span>
  );
}

function DispatchSummary({
  contextLabel,
  model,
  ultrathink,
  orchestrate,
  workflowz,
  branch,
  className,
}: {
  contextLabel: string;
  model: ModelInfo | null;
  ultrathink: boolean;
  orchestrate: boolean;
  workflowz: boolean;
  branch: string | null;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("min-w-0", className)}>
      <Label>{t("plan.review.dispatchReady")}</Label>
      <p className="mt-0.5 truncate text-[11px] text-ink-dim">
        {contextLabel}
        {model !== null && <>{" · "}{model.name || model.id}</>}
        {ultrathink && " · ultrathink"}
        {orchestrate && " · orchestrate"}
        {workflowz && " · workflowz"}
        {branch !== null && <>{" · "}{branch}</>}
      </p>
    </div>
  );
}

function ExecutePlanButton({
  contextLabel,
  checkingOut,
  disabled,
  onExecute,
}: {
  contextLabel: string;
  checkingOut: boolean;
  disabled: boolean;
  onExecute: () => void;
}) {
  const t = useT();
  return (
    <Button
      variant="solid"
      tone="signal"
      disabled={disabled}
      onClick={onExecute}
    >
      {checkingOut ? t("plan.review.switchingBranch") : t("plan.review.executeIn", { contextLabel })}
    </Button>
  );
}

/**
 * The one base-follow rule (issue #405, extended by issue #422): an untouched
 * mint follows the base with its hash; an untouched suggestion-named branch
 * follows with its name; anything a human typed is never touched.
 */
function followBase(
  prev: { branch: string; suggested: string | null; namedBranch: string | null },
  baseBranch: string | null,
  baseRef: string | null,
): string {
  const segment = baseBranchSegment(baseBranch, baseRef);
  if (prev.namedBranch !== null && prev.suggested !== null && prev.branch === prev.namedBranch) {
    return composeWorktreeBranch(segment, prev.suggested);
  }
  return remintForBase(prev.branch, segment);
}

export function PlanReview({ tabId, fill = false }: { tabId: string; fill?: boolean }) {
  const review = useStore((s) => s.rpc[tabId]?.planReview);
  const planText = useStore((s) => s.rpc[tabId]?.planText);
  /** Present only when the session planned in html format and the file read. */
  const planHtml = useStore((s) => s.rpc[tabId]?.planHtml);
  // The hook is told WHICH source identity it prepares (§6): a previous
  // plan's ready state can never enable a new proposal, and the readiness
  // rides into the store's execution guard below.
  const prepared = usePreparedPlanDocument(planHtml ?? null, review?.request.sourceHash);
  const setPlanReadiness = useStore((s) => s.setPlanReadiness);
  useEffect(() => {
    if (planHtml === null) {
      setPlanReadiness(tabId, null);
      return;
    }
    setPlanReadiness(tabId, {
      status: prepared.status,
      ...(prepared.status !== "pending" ? { identity: prepared.identity } : {}),
    });
  }, [planHtml, prepared, tabId, setPlanReadiness]);
  const advisorConfigured = useStore((s) => s.rpc[tabId]?.advisorStats?.configured === true);
  const executePlan = useStore((s) => s.executePlan);
  const refinePlan = useStore((s) => s.refinePlan);
  const deferPlanReview = useStore((s) => s.deferPlanReview);
  /** True after "not now": the pane is dismissed but the gate is unanswered. */
  const deferred = useStore((s) => s.rpc[tabId]?.planDeferred === true);
  const t = useT();
  const compact = useCompactShell();
  const [compactStep, setCompactStep] = useState<CompactReviewStep>("review");

  const [context, setContext] = useState<PlanExecutionContext>("existing");
  /**
   * The worktree context's dedicated checkout (issue #313): branch + base,
   * minted once on first pick of the worktree row. Persists across context
   * switches within a review; a new proposal re-seeds it to null.
   */
  const [worktreeSel, setWorktreeSel] = useState<{
    branch: string;
    /** True once the user edited this field; mechanical recomposition — the
     * base-following (#405) and the plan's naming (#422) — never sets it. */
    branchTouched: boolean;
    baseRef: string | null;
    baseBranch: string | null;
    baseTouched: boolean;
    /** The applied suggestion; null until the one-time apply runs. */
    suggested: string | null;
    /** The branch string the suggestion named (cut-from mode); equality
     * means "still mine" — base changes recompose it, typing opts out. */
    namedBranch: string | null;
  } | null>(null);
  /** Change notes for the planner; text + optional images ride a steer prompt. */
  const [changes, setChanges] = useState("");
  const { images, pasteError, onPaste, pickImages, dropImage, clearImages } = useImageDraft();
  /**
   * Fold the advisor's review of the plan turn (it lands only after an execute
   * verdict lets the turn end) into the implementation prompt. Inert on
   * sessions with no configured advisor. Refine stays immediate: the planner
   * revises in this same session, where the advisor's notes already land.
   */
  const [addressAdvisor, setAddressAdvisor] = useState(true);

  const projectCwd = useStore((s) => s.tabs.find((t) => t.tabId === tabId)?.projectCwd);
  const planFilePath = useStore((s) => s.rpc[tabId]?.planReview?.request.planFilePath);
  const planTitle = useStore((s) => s.rpc[tabId]?.planReview?.request.title);

  /** The paperclip's hidden file input; picked images ride the same draft path as paste. */
  const imagePicker = useRef<HTMLInputElement>(null);
  const branch = useExecutionBranch({
    tabId,
    proposalKey: review,
    projectCwd,
    planFilePath,
    planText: planText ?? null,
    planTitle: planTitle ?? null,
  });

  // The degraded-path name: the plan's slug, as the checkout fieldset uses it.
  const baseFallback = planFilePath === undefined ? "" : branchNameFromPlanPath(planFilePath);
  // One model call per proposal, made by the checkout-side hook; the worktree
  // fields consume its resolved value instead of re-calling it.
  const suggestion = branch.suggestion;

  const currentModel = useStore((s) => s.rpc[tabId]?.model ?? null);
  const currentThinking = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const availableModels = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY_MODELS);
  const sessionRecord = useStore((s) => findRecord(s.state, tabId));
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const advisorDefaults = useStore((s) => (projectCwd ? s.advisorDefaults[projectCwd] : undefined));
  // This instance's dev/test advisor override (issue #372): the same backend
  // state both renderers hydrate from; display precedence only.
  const gateAdvisor = useStore((s) => s.state?.spawnGate.advisorModel ?? null);

  /**
   * The planning session's own dedicated checkout (issue #316): when set, a
   * fresh dispatch is pinned to it, and a worktree dispatch that keeps the
   * planning branch reuses it instead of minting a second checkout. Hoisted
   * above the render's early return because the naming effect reads it.
   */
  const sourceWorktree = sessionRecord?.worktree ?? null;

  const [stagedModel, setStagedModel] = useState<ModelInfo | null>(currentModel);
  const [stagedThinking, setStagedThinking] = useState<string | null>(currentThinking);
  const [stagedAdvisor, setStagedAdvisor] = useState(sessionRecord?.advisor ?? false);
  const [stagedAdvisorModel, setStagedAdvisorModel] = useState<string | null>(
    sessionRecord?.advisorModel ?? null,
  );
  const [orchestrate, setOrchestrate] = useState(false);
  const [ultrathink, setUltrathink] = useState(false);
  const [workflowz, setWorkflowz] = useState(false);
  const [pickingModel, setPickingModel] = useState(false);
  const [pickingAdvisorModel, setPickingAdvisorModel] = useState(false);
  const [levelMenu, setLevelMenu] = useState<"main" | "advisor" | null>(null);

  // A new proposal re-seeds the staged parameters from the session's current
  // values (React's adjust-state-during-render pattern). Defer/reopen keeps the
  // user's staging because the review object is unchanged; the keyword switches
  // always reset to off (decided: never remembered).
  const [seededFor, setSeededFor] = useState<unknown>(null);
  if (review !== seededFor) {
    setSeededFor(review);
    setContext("existing");
    setStagedModel(currentModel);
    setStagedThinking(currentThinking);
    setStagedAdvisor(sessionRecord?.advisor ?? false);
    setStagedAdvisorModel(sessionRecord?.advisorModel ?? null);
    setUltrathink(false);
    setOrchestrate(false);
    setCompactStep("review");
    setWorkflowz(false);
    setWorktreeSel(null);
  }

  // omp's config supplies the inherited advisor default, read in main.
  useEffect(() => {
    if (projectCwd !== undefined) void loadAdvisorDefaults(projectCwd);
  }, [projectCwd, loadAdvisorDefaults]);

  /** Anchors for the two thinking-level popovers. */
  const mainLevelAnchor = useRef<HTMLSpanElement | null>(null);
  const advisorLevelAnchor = useRef<HTMLSpanElement | null>(null);

  // Outside pointerdown closes an open level menu (AdvisorControl's pattern).
  useDismissal({
    open: levelMenu !== null,
    refs: [mainLevelAnchor, advisorLevelAnchor],
    onClose: () => setLevelMenu(null),
  });

  // The plan names the worktree destination once per selection (issue #422):
  // the new base's prefill while in create-base mode, else the mint's hash
  // segment (#389's rule, moved forward to review time). Typed text and the
  // #316 planning branch are never touched; the `suggested` latch makes the
  // apply run once, so a later clear-to-empty never refills — and the
  // selection in the deps only carries the naming to a row picked after the
  // model had already answered.
  useEffect(() => {
    if (suggestion === null) return;
    setWorktreeSel((prev) => {
      if (prev === null || prev.suggested !== null) return prev;
      if (sourceWorktree !== null && prev.branch.trim() === sourceWorktree.branch.trim()) {
        return { ...prev, suggested: suggestion };
      }
      if (prev.baseBranch !== null) {
        const baseBranch =
          prev.baseBranch === "" || prev.baseBranch === baseFallback ? suggestion : prev.baseBranch;
        const named = { ...prev, baseBranch, suggested: suggestion };
        return { ...named, branch: followBase(named, baseBranch, prev.baseRef) };
      }
      if (!prev.branchTouched && PLACEHOLDER_BRANCH_RE.test(prev.branch)) {
        const namedBranch = `${prev.branch.slice(0, prev.branch.lastIndexOf("/") + 1)}${suggestion}`;
        return { ...prev, suggested: suggestion, namedBranch, branch: namedBranch };
      }
      return { ...prev, suggested: suggestion };
    });
  }, [suggestion, sourceWorktree, baseFallback, worktreeSel]);

  if (!review || deferred) return null;
  const { request } = review;
  const reusingWorktree =
    sourceWorktree !== null &&
    worktreeSel !== null &&
    worktreeSel.branch.trim() === sourceWorktree.branch.trim();
  // What the advisor row shows (issue #372): the instance's gate wins over
  // the staged pin and omp's configured default — for display. Staging,
  // re-seeding, and the options bag submitted by execute() keep the session's
  // own saved/staged choice; the gate never enters a record. The level rides
  // omp's `:level` suffix on the selector.
  const gatedAdvisor = gateAdvisor !== null;
  const effectiveAdvisor = gateAdvisor ?? stagedAdvisorModel ?? advisorDefaults?.model ?? null;
  const advisorInherited = !gatedAdvisor && stagedAdvisorModel === null;
  const advisorSplit = effectiveAdvisor === null ? null : splitRole(effectiveAdvisor);
  const advisorModelInfo =
    availableModels.find((m) => `${m.provider}/${m.id}` === advisorSplit?.model) ?? null;
  const advisorEfforts = advisorModelInfo?.thinking?.efforts ?? [];
  const mainEfforts = stagedModel?.thinking?.efforts ?? [];

  const contextKey = CONTEXTS.find((candidate) => candidate.id === context)?.labelKey;
  const contextLabel = contextKey === undefined ? context : t(contextKey);
  const branchApplies = sourceWorktree === null && context !== "worktree";
  const dispatchBranch =
    context === "worktree" && worktreeSel !== null
      ? worktreeSel.branch.trim() || t("plan.review.newBranch")
      : sourceWorktree !== null
        ? sourceWorktree.branch
        : branch.summary;
  // §6: for an HTML plan, execute waits for the local preparation too —
  // pending, failed, unavailable, or a preparation made for a DIFFERENT
  // source identity all keep execute disabled. Refine and defer stay live.
  const htmlNotReady =
    planHtml !== null &&
    (prepared.status !== "ready" ||
      (review?.request.sourceHash !== undefined &&
        prepared.identity !== review.request.sourceHash));
  const executeDisabled =
    htmlNotReady ||
    (context === "worktree"
      ? worktreeSel === null ||
        worktreeSel.branch.trim() === "" ||
        (worktreeSel.baseBranch !== null && worktreeSel.baseBranch.trim() === "")
      : branchApplies && (branch.checkingOut || branch.branchInvalid));

  const refine = () => {
    const notes = { text: changes, images: images.length ? images : undefined };
    refinePlan(tabId, changes.trim() !== "" || images.length > 0 ? notes : undefined);
    // The draft has been spent. RpcTab keeps this pane mounted for the whole
    // life of an active tab, so refine → revised proposal never unmounts it and
    // nothing else would ever clear these — the stale notes would reappear on
    // the next review, re-submittable by accident (issue #113). "Not now" keeps
    // its draft on purpose: deferring asks for no revision.
    setChanges("");
    clearImages();
  };
  // Close (X) / "not now": defer without answering the gate with notes the
  // user did not finish writing. The plan stays pending in the plans tab.
  const dismiss = () => {
    setCompactStep("review");
    deferPlanReview(tabId);
  };

  const execute = async (): Promise<void> => {
    const destination =
      context === "worktree" && worktreeSel !== null
        ? { kind: "worktree" as const, branch: worktreeSel.branch.trim() }
        : sourceWorktree !== null
          ? { kind: "worktree" as const, branch: sourceWorktree.branch }
          : { kind: "project-checkout" as const, branch: branch.targetBranch };
    // Staged parameters ride as one options bag; the store applies them to
    // whichever session receives the implementation.
    const options: PlanExecutionOptions = {
      addressAdvisor,
      destination,
      ultrathink,
      orchestrate,
      workflowz,
      model: stagedModel,
      thinkingLevel: stagedThinking,
      advisor: stagedAdvisor,
      advisorModel: stagedAdvisorModel,
      // A "worktree" dispatch carries its dedicated-checkout spec in the bag;
      // every other context leaves it null (ignored on the spawn side).
      worktree:
        context === "worktree" && worktreeSel !== null
          ? {
              branch: worktreeSel.branch.trim(),
              baseRef: worktreeSel.baseRef,
              // A reused planning checkout has no base to create (#405);
              // its own branch name is kept as-is by the reuse arm.
              baseBranch: reusingWorktree ? null : worktreeSel.baseBranch,
            }
          : null,
    };
    // Only a project-checkout destination may move the registered project's checkout.
    if (branchApplies && !(await branch.resolve())) return;
    executePlan(tabId, context, options);
  };


  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter in the notes box submits the refinement — the box feeds the
    // planner, so hitting Enter mid-change should send them, never execute
    // (which would silently drop them). Shift+Enter keeps a true newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      refine();
    }
  };

  return (
    <>
    <div
      role="region"
      aria-labelledby="plan-review-title"
      className={cn(
        // A flex column, not a plain block: the inner .plan-review column must
        // shrink inside the wrapper (min-h-0 + flex-shrink) so the actions
        // footer stays visible and the plan/setup panes scroll internally. A
        // block child would render at natural height and overflow-hidden would
        // clip the footer away.
        "animate-rise mx-auto mb-2 flex w-full flex-col overflow-hidden rounded-xl border border-line ambient plane-lit shadow-float",
        fill
          ? "min-h-0 flex-1" // issue #277: owns the chat-history slot, uncapped
          : "shrink-0",
        !fill &&
          (compact
            ? "max-h-[min(70dvh,var(--app-viewport-height,70dvh))]"
            : "max-h-[min(52dvh,var(--app-viewport-height,52dvh))]"),
      )}
    >
      <div
        className={cn("plan-review flex min-h-0 flex-col", fill && "flex-1")}
        data-plan-review-step={compact ? compactStep : undefined}
      >
        <header className="plan-review-header flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <Label>
              {compact
                ? compactStep === "review"
                  ? t("plan.review.stepReview")
                  : compactStep === "refine"
                    ? t("plan.review.stepRefine")
                    : t("plan.review.stepSetup")
                : t("plan.review.ready")}
            </Label>
            <h2 id="plan-review-title" className="mt-1 truncate font-display text-base font-medium text-ink" title={request.title}>
              {request.title}
            </h2>
            <p className="plan-review-artifact mt-0.5 truncate font-mono text-[10px] text-ink-faint">
              {request.planFilePath}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {planText && (!compact || compactStep === "review") && <CopyButton text={planText} label={t("plan.review.copyPlan")} />}
            <IconButton label={t("plan.review.leavePending")} onClick={dismiss}>
              <IconClose />
            </IconButton>
          </div>
        </header>

        <div className={cn(
          "plan-review-layout grid min-h-0 flex-1 overflow-hidden",
          compact ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_21rem]",
        )}>
          {(!compact || compactStep !== "setup") && (
          <section
            className={cn(
              "plan-review-document min-h-0 px-5 py-4",
              // The iframe scrolls its own content (unreachable for parent
              // measurement under an empty sandbox), so the section stops being
              // the scroll container and just hands it the leftover height.
              planHtml ? "flex flex-col overflow-hidden" : "overflow-y-auto",
            )}
            aria-label={t("plan.review.proposedPlan")}
          >
            {(!compact || compactStep === "review") && (
              <div className={cn("plan-review-preview min-h-0 flex-1", planHtml && "flex flex-col")}>
                {planHtml ? (
                  prepared.status === "failed" ||
                  (prepared.status === "unavailable" && prepared.doc === null) ? (
                    <PlanFallback
                      diagnostics={
                        prepared.status === "failed"
                          ? prepared.diagnostics
                          : prepared.status === "unavailable"
                            ? prepared.diagnostics
                            : []
                      }
                      source={planText ?? planHtml}
                      className="min-h-0 flex-1"
                    />
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-2">
                      {prepared.status === "unavailable" && prepared.doc !== null && (
                        // The prepared document IS displayed below: the probe
                        // could not conclude (an application failure), so the
                        // heading says verification was incomplete — never
                        // that display failed (issue #415).
                        <PlanDiagnostics
                          diagnostics={prepared.diagnostics}
                          mode="verification-incomplete"
                          className="shrink-0 rounded-md border border-line bg-sunken px-3 py-2 text-xs"
                        />
                      )}
                      <iframe
                        title={t("plan.review.proposedPlan")}
                        sandbox=""
                        srcDoc={
                          prepared.status === "ready"
                            ? prepared.doc
                            : prepared.status === "unavailable"
                              ? (prepared.doc ?? "")
                              : ""
                        }
                        className="min-h-0 w-full flex-1 rounded-md border border-line bg-surface"
                      />
                    </div>
                  )
                ) : planText ? (
                  <Markdown text={planText} />
                ) : (
                  <p className="text-sm text-ink-dim">{t("plan.review.fileUnreadable")}</p>
                )}
              </div>
            )}

            {(!compact || compactStep === "refine") && (
            <div className={cn("plan-review-refine mt-6 border-t border-line pt-4", planHtml && "shrink-0")}>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <Label>{t("plan.review.sendBack")}</Label>
                  <p className="mt-1 text-xs text-ink-dim">{t("plan.review.refineHint")}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[10px] text-ink-faint">{t("plan.review.refineKeys")}</span>
                  <AttachmentButton disabled={false} label={t("common.button.attachImages")} onClick={() => imagePicker.current?.click()} />
                </div>
              </div>
              <div className="mt-2 rounded-lg border border-line bg-raised focus-within:border-line-strong">
                {images.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 pt-2 pb-1.5">
                    {images.map((image, i) => (
                      <span key={i} className="group/att relative">
                        <img
                          src={`data:${image.mimeType};base64,${image.data}`}
                          alt={t("plan.review.changeNote", { n: i + 1 })}
                          title={image.mimeType}
                          className="size-12 rounded border border-line-strong bg-sunken object-cover"
                        />
                        <span className="absolute -right-1 -top-1 opacity-0 transition-opacity group-hover/att:opacity-100 focus-within:opacity-100">
                          <IconButton
                            label={t("plan.review.removeChangeNote", { n: i + 1 })}
                            tone="rose"
                            onClick={() => dropImage(i)}
                            className="size-4 rounded-full border border-line-strong bg-overlay"
                          >
                            <IconClose />
                          </IconButton>
                        </span>
                      </span>
                    ))}
                    <Label className="ml-0.5">
                      {images.length === 1
                        ? t("plan.review.attachment", { n: images.length })
                        : t("plan.review.attachments", { n: images.length })}
                    </Label>
                  </div>
                )}
                <textarea
                  rows={3}
                  value={changes}
                  placeholder={t("plan.review.refinePlaceholder")}
                  spellCheck={false}
                  onChange={(e) => setChanges(e.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={(e) => void onPaste(e)}
                  className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
                />
                <input
                  ref={imagePicker}
                  type="file"
                  accept="image/*"
                  multiple
                  tabIndex={-1}
                  aria-hidden
                  className="sr-only"
                  onChange={(event) => void pickImages(event)}
                />
              </div>
              {pasteError && <p className="mt-1 text-[11px] text-rose">{pasteError}</p>}
            </div>
            )}
          </section>
          )}

          {(!compact || compactStep === "setup") && (
          <aside className="plan-review-setup min-h-0 overflow-y-auto border-l border-line bg-sunken/70 px-4 py-4" aria-label={t("plan.review.stepSetup")}>
            <div className="mb-4">
              <Label>{t("plan.review.stepSetup")}</Label>
              <p className="mt-1 text-xs leading-relaxed text-ink-dim">{t("plan.review.setupHint")}</p>
            </div>

            <fieldset>
              <legend className="text-[11px] font-medium text-ink">{t("plan.review.session")}</legend>
              <div className="mt-2 space-y-1.5">
                {CONTEXTS.map((option, index) => {
                  const active = context === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={active}
                      disabled={option.id === "worktree" && !branch.isRepo}
                      title={
                        option.id === "worktree" && !branch.isRepo
                          ? t("plan.review.notGitRepo")
                          : undefined
                      }
                      onClick={() => {
                        // Prefill the planning branch when this session plans
                        // in a worktree (issue #316); otherwise mint. Re-picking
                        // the active selection keeps the current value and any
                        // edits (issue #225 semantics, as in the composer's
                        // branch chip).
                        if (option.id === "worktree" && worktreeSel === null) {
                          const mint = sourceWorktree?.branch ?? mintBranchName();
                          setWorktreeSel({
                            branch: mint,
                            branchTouched: false,
                            baseRef: null,
                            baseBranch: null,
                            baseTouched: false,
                            suggested: null,
                            namedBranch: null,
                          });
                        }
                        setContext(option.id);
                      }}
                      className={cn(
                        "group flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-[background-color,border-color]",
                        active
                          ? "edge-lit border-line-strong bg-raised"
                          : "border-transparent hover:border-line hover:bg-raised/60",
                        option.id === "worktree" &&
                          !branch.isRepo &&
                          "cursor-not-allowed opacity-50",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                          active ? "border-ink-mid" : "border-line-strong",
                        )}
                      >
                        {active && <span className="size-1.5 rounded-full bg-ink-mid" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-ink">{t(option.labelKey)}</span>
                          <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">0{index + 1}</span>
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                          {option.id === "fresh" && sourceWorktree !== null
                            ? t("plan.context.freshWorktreeHint")
                            : option.id === "worktree" && sourceWorktree !== null
                              ? t("plan.context.worktreeExistingHint")
                              : t(option.hintKey)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="mt-5 border-t border-line pt-4">
              <legend className="text-[11px] font-medium text-ink">{t("plan.review.model")}</legend>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">{t("plan.review.modelHint")}</p>

              <span className="mt-3 block text-[10px] text-ink-faint">{t("plan.review.modelLabel")}</span>
              {availableModels.length === 0 ? (
                <button
                  type="button"
                  disabled
                  title={t("plan.review.noModels")}
                  className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                >
                  {stagedModel === null ? t("plan.review.sessionDefault") : stagedModel.name || stagedModel.id}
                </button>
              ) : (
                <button
                  type="button"
                  title={
                    stagedModel === null
                      ? t("plan.review.keepsCurrentModel")
                      : `${stagedModel.provider}/${stagedModel.id}`
                  }
                  onClick={() => setPickingModel(true)}
                  className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                >
                  {stagedModel === null ? t("plan.review.sessionDefault") : stagedModel.name || stagedModel.id}
                </button>
              )}

              {mainEfforts.length > 0 && (
                <>
                  <span className="mt-3 block text-[10px] text-ink-faint">{t("plan.review.thinking")}</span>
                  <span ref={mainLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      title={t("plan.review.thinkingTitle")}
                      onClick={() => setLevelMenu((m) => (m === "main" ? null : "main"))}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                    >
                      {stagedThinking ?? t("plan.review.thinkFallback")}
                    </button>
                    {levelMenu === "main" && (
                      <div className="animate-rise edge-lit absolute left-0 top-full z-20 mt-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                        <span className="px-1.5 pb-1 pt-0.5">
                          <Label>{t("plan.review.thinking")}</Label>
                        </span>
                        {mainEfforts.map((effort) => (
                          <button
                            key={effort}
                            type="button"
                            onClick={() => {
                              setLevelMenu(null);
                              setStagedThinking(effort);
                            }}
                            className={cn(
                              "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                              effort === stagedThinking ? "text-iris" : "text-ink-mid",
                            )}
                          >
                            {effort}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                </>
              )}

              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-ink">{t("plan.review.advisor")}</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">{t("plan.review.advisorHint")}</span>
                </div>
                <Switch on={stagedAdvisor} onChange={setStagedAdvisor} label={t("plan.review.advisorSwitch")} />
              </div>

              {/* Gated provenance stays visible with the advisor off — worded
                  as applying if it is enabled (issue #372). */}
              {gatedAdvisor && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md border border-line bg-raised px-2.5 py-2 text-[10px] leading-snug text-ink-mid">
                  <span
                    title={t("advisor.override.label")}
                    className={cn("mt-px shrink-0 rounded border px-1 font-mono text-[9px] uppercase tracking-wide", TONE_CHIP.neutral)}
                  >
                    {t("advisor.override.badge")}
                  </span>
                  <span>
                    {t(stagedAdvisor ? "advisor.override.active" : "advisor.override.inactive", {
                      selector: gateAdvisor ?? "",
                    })}
                  </span>
                </p>
              )}

              {stagedAdvisor && (
                <>
                  <span className="mt-3 block text-[10px] text-ink-faint">{t("plan.review.advisorModel")}</span>
                  <button
                    type="button"
                    disabled={gatedAdvisor || availableModels.length === 0}
                    title={
                      gatedAdvisor
                        ? `${t("advisor.override.label")}: ${effectiveAdvisor}`
                        : availableModels.length === 0
                          ? t("plan.review.noModels")
                          : (effectiveAdvisor ?? t("plan.review.advisorModelDefault"))
                    }
                    onClick={() => {
                      if (gatedAdvisor) return;
                      setPickingAdvisorModel(true);
                    }}
                    className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                  >
                    {effectiveAdvisor === null
                      ? t("plan.review.ompDefault")
                      : advisorModelInfo?.name || shortLabel(effectiveAdvisor)}
                  </button>
                </>
              )}

              {stagedAdvisor && gatedAdvisor && advisorSplit !== null && advisorSplit.level !== undefined && (
                <>
                  <span className="mt-3 block text-[10px] text-ink-faint">{t("plan.review.advisorThinking")}</span>
                  <span ref={advisorLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      disabled
                      title={`${t("advisor.override.label")}: ${effectiveAdvisor}`}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink"
                    >
                      {advisorSplit.level}
                    </button>
                  </span>
                </>
              )}

              {stagedAdvisor && !gatedAdvisor && advisorSplit !== null && advisorEfforts.length > 0 && (
                <>
                  <span className="mt-3 block text-[10px] text-ink-faint">{t("plan.review.advisorThinking")}</span>
                  <span ref={advisorLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      title={t("plan.review.advisorThinkingTitle")}
                      onClick={() => setLevelMenu((m) => (m === "advisor" ? null : "advisor"))}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                    >
                      {advisorSplit?.level ?? t("plan.review.thinkFallback")}
                    </button>
                    {levelMenu === "advisor" && (
                      <div className="animate-rise edge-lit absolute left-0 top-full z-20 mt-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                        <span className="px-1.5 pb-1 pt-0.5">
                          <Label>{t("plan.review.advisorThinking")}</Label>
                        </span>
                        {advisorSplit?.level !== undefined && (
                          <button
                            type="button"
                            onClick={() => {
                              setLevelMenu(null);
                              setStagedAdvisorModel(advisorSplit!.model);
                            }}
                            className="rounded px-1.5 py-0.5 text-left text-[11px] text-ink-faint hover:bg-hover"
                            title={t("plan.review.advisorDefaultThinking")}
                          >
                            {t("plan.review.defaultLevel")}
                          </button>
                        )}
                        {advisorEfforts.map((effort) => (
                          <button
                            key={effort}
                            type="button"
                            onClick={() => {
                              setLevelMenu(null);
                              // Pinning the level pins the whole selector
                              // (AdvisorControl's setLevel contract).
                              setStagedAdvisorModel(`${advisorSplit!.model}:${effort}`);
                            }}
                            className={cn(
                              "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                              effort === advisorSplit?.level ? "text-iris" : "text-ink-mid",
                            )}
                          >
                            {effort}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                </>
              )}
            </fieldset>

            {branch.isRepo && sourceWorktree === null && context !== "worktree" && (
              <ExecutionBranchSetup branch={branch} onExecute={() => void execute()} />
            )}
            {sourceWorktree !== null && context !== "worktree" && (
              <fieldset className="mt-5 border-t border-line pt-4">
                <legend className="text-[11px] font-medium text-ink">
                  {t("plan.review.lockedWorktreeBranch")}
                </legend>
                <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
                  {t("plan.review.lockedWorktreeHint")}
                </p>
                <div className="mt-3 rounded-lg border border-line bg-raised/70 p-3">
                  <span className="block truncate font-mono text-xs text-ink" title={sourceWorktree.branch}>
                    {sourceWorktree.branch}
                  </span>
                </div>
              </fieldset>
            )}
            {context === "worktree" && worktreeSel !== null && projectCwd !== undefined && (
              <fieldset className="mt-5 border-t border-line pt-4">
                <legend className="text-[11px] font-medium text-ink">{t("plan.review.worktree")}</legend>
                {reusingWorktree && sourceWorktree !== null ? (
                  <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">{t("plan.review.worktreeReuse")}</p>
                ) : (
                  <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">{t("plan.review.worktreeDedicated")}</p>
                )}
                <div className="mt-3 rounded-lg border border-line bg-raised/70 p-3">
                  <WorktreeBranchFields
                    projectCwd={projectCwd}
                    branch={worktreeSel.branch}
                    onBranchChange={(b) =>
                      setWorktreeSel((prev) => (prev === null ? prev : { ...prev, branch: b, branchTouched: true }))
                    }
                    baseRef={worktreeSel.baseRef}
                    onBaseRefChange={(baseRef) =>
                      // Recompose the minted branch to name its cut point
                      // (#405) — except while the selection still IS the
                      // planning checkout, where the #316 reuse contract
                      // keys on exact branch equality.
                      setWorktreeSel((prev) =>
                        prev === null
                          ? prev
                          : {
                              ...prev,
                              baseRef,
                              branch:
                                sourceWorktree !== null &&
                                prev.branch.trim() === sourceWorktree.branch.trim()
                                  ? prev.branch
                                  : followBase(prev, prev.baseBranch, baseRef),
                            },
                      )
                    }
                    baseBranch={worktreeSel.baseBranch}
                    onBaseBranchChange={(value) =>
                      setWorktreeSel((prev) => {
                        if (prev === null) return prev;
                        // The reveal transition is null to empty; a later
                        // clear-to-empty keeps the empty string the user typed
                        // it to be (issue #422).
                        const next =
                          value === "" && prev.baseBranch === null ? suggestion ?? baseFallback : value;
                        if (
                          sourceWorktree !== null &&
                          prev.branch.trim() === sourceWorktree.branch.trim()
                        ) {
                          return { ...prev, baseBranch: next };
                        }
                        return {
                          ...prev,
                          baseBranch: next,
                          branch: followBase(prev, next, prev.baseRef),
                        };
                      })
                    }
                    baseTouched={worktreeSel.baseTouched}
                    onBaseTouchedChange={(baseTouched) =>
                      setWorktreeSel((prev) => (prev === null ? prev : { ...prev, baseTouched }))
                    }
                    showBase={!reusingWorktree}
                    idPrefix="plan-worktree"
                  />
                  {reusingWorktree && sourceWorktree !== null && (
                    <p className="mt-2 truncate font-mono text-[10px] text-ink-faint" title={sourceWorktree.path}>
                      {sourceWorktree.path}
                    </p>
                  )}
                </div>
              </fieldset>
            )}

            <fieldset className="mt-5 border-t border-line pt-4">
              <legend className="text-[11px] font-medium text-ink">{t("plan.review.magicKeywords")}</legend>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">{t("plan.review.magicKeywordsHint")}</p>
              <div className="mt-3 space-y-3">
                {KEYWORD_ROWS.map(({ keyword, hintKey }) => {
                  const armed =
                    keyword === "ultrathink" ? ultrathink : keyword === "orchestrate" ? orchestrate : workflowz;
                  const setArmed =
                    keyword === "ultrathink" ? setUltrathink : keyword === "orchestrate" ? setOrchestrate : setWorkflowz;
                  return (
                    <div key={keyword} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <KeywordLabel keyword={keyword} />
                        <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">{t(hintKey, { keyword })}</span>
                      </div>
                      <Switch on={armed} onChange={setArmed} label={t("plan.review.armKeyword", { keyword })} />
                    </div>
                  );
                })}
              </div>
            </fieldset>

            {advisorConfigured && (
              <div className="mt-5 flex items-start justify-between gap-3 border-t border-line pt-4">
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-ink">{t("plan.review.addressAdvisor")}</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">{t("plan.review.addressAdvisorHint")}</span>
                </div>
                <Switch
                  on={addressAdvisor}
                  onChange={setAddressAdvisor}
                  label={t("plan.review.addressAdvisorSwitch")}
                />
              </div>
            )}
          </aside>
          )}
        </div>

        {compact ? (
          <footer className="plan-review-actions plan-review-actions-compact flex shrink-0 items-center justify-between gap-3 border-t border-line bg-overlay px-4 py-3">
            {compactStep === "setup" && (
              <DispatchSummary
                contextLabel={contextLabel}
                model={stagedModel}
                ultrathink={ultrathink}
                orchestrate={orchestrate}
                workflowz={workflowz}
                branch={dispatchBranch}
                className="flex-1"
              />
            )}
            <div className="plan-review-action-buttons ml-auto flex shrink-0 items-center gap-2">
              {compactStep === "review" ? (
                <>
                  <Button title={t("plan.review.notNowTitle")} variant="ghost" onClick={dismiss}>
                    {t("plan.review.notNow")}
                  </Button>
                  <Button onClick={() => setCompactStep("refine")}>{t("plan.review.refine")}</Button>
                  <Button variant="solid" tone="signal" onClick={() => setCompactStep("setup")}>
                    {t("plan.review.execute")}
                  </Button>
                </>
              ) : compactStep === "refine" ? (
                <>
                  <Button variant="ghost" onClick={() => setCompactStep("review")}>{t("plan.review.backToPlan")}</Button>
                  <Button variant="solid" tone="signal" onClick={() => void refine()}>{t("plan.review.sendChanges")}</Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => setCompactStep("review")}>{t("plan.review.backToPlan")}</Button>
                  <ExecutePlanButton
                    contextLabel={contextLabel}
                    checkingOut={branch.checkingOut}
                    disabled={executeDisabled}
                    onExecute={() => void execute()}
                  />
                </>
              )}
            </div>
          </footer>
        ) : (
          <footer className="plan-review-actions flex shrink-0 items-center justify-between gap-4 border-t border-line bg-overlay px-5 py-3">
            <DispatchSummary
              contextLabel={contextLabel}
              model={stagedModel}
              ultrathink={ultrathink}
              orchestrate={orchestrate}
              workflowz={workflowz}
              branch={dispatchBranch}
            />
            <div className="flex shrink-0 items-center gap-2">
              <Button title={t("plan.review.notNowTitle")} variant="ghost" onClick={dismiss}>{t("plan.review.notNow")}</Button>
              <Button onClick={() => void refine()}>{t("plan.review.refine")}</Button>
              <ExecutePlanButton
                contextLabel={contextLabel}
                checkingOut={branch.checkingOut}
                disabled={executeDisabled}
                onExecute={() => void execute()}
              />
            </div>
          </footer>
        )}
      </div>
    </div>

    {pickingModel && (
      <ModelPalette
        variant="main"
        models={availableModels}
        current={stagedModel}
        onClose={() => setPickingModel(false)}
        // Composer parity: picking a model keeps the staged thinking level —
        // omp clamps an invalid one.
        onPick={(picked) => {
          setPickingModel(false);
          setStagedModel(picked);
        }}
      />
    )}
    {pickingAdvisorModel && !gatedAdvisor && (
      <ModelPalette
        variant="advisor"
        models={availableModels}
        current={effectiveAdvisor}
        inherited={advisorInherited}
        defaultModel={advisorDefaults?.model ?? null}
        onClose={() => setPickingAdvisorModel(false)}
        onPick={(selector) => {
          setPickingAdvisorModel(false);
          setStagedAdvisorModel(selector);
        }}
      />
    )}
    </>
  );
}
