import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { isCouncilPlanPath } from "@omp-ui/core/council";
import { parseModelRole } from "@omp-ui/core/model-role";
import { isHtmlPlanPath } from "@omp-ui/core/plan";
import { branchNameFromPlanPath } from "../lib/branch-name";
import { cn } from "../lib/cn";
import { useAndroidBack } from "../lib/android-back";
import { copyFallback } from "../lib/clipboard";
import { normalizeAnnotationQuote } from "../lib/annotations";
import { backend, backendFor, displayMessage } from "../backend";
import type { DocumentRef } from "../lib/document-context";
import { keywordColors } from "../lib/keyword-colors";
import { goalDisabledInCatalog, keywordsOffInSettings } from "../lib/magic-keyword-gate";
import { goalOwnsSession as coreGoalOwnsSession } from "@omp-ui/core/goal";
import type { PlanExecutionContext, PlanExecutionOptions, StagedKeyword } from "../lib/plan-concerns";
import type { ToolsAtScope } from "@omp-ui/core/types";
import { usePreparedPlanDocument } from "../lib/use-prepared-plan-document";
import { shortModelLabel } from "../lib/format";
import { projectKey } from "../lib/project-key";
import { NATIVE_LIVE_MIN_OMP, supportsNativeLive } from "../lib/live-voice";
import { useCompactShell } from "../lib/responsive";
import type { ModelInfo } from "../lib/rpc-types";
import { checkoutOccupant, effectiveWorkspacePolicy, findInstance, findOwner, findRecord, useStore } from "../store";
import type { PlanRevisionNotes } from "../store/types";
import { useDismissal } from "../lib/use-dismissal";
import { useImageDraft } from "../lib/use-image-draft";
import { usePlanDispatchStaging } from "../lib/use-plan-dispatch-staging";
import { useSessionCouncilMembers } from "../lib/use-session-council";
import { ExecutionBranchSetup, useExecutionBranch } from "./ExecutionBranchSetup";
import { LiveVoiceControl } from "./LiveVoiceControl";
import { LiveVoiceStrip } from "./LiveVoiceStrip";
import { Markdown } from "./Markdown";
import { ModelPalette } from "./ModelSelector";
import { PreparedPlanView } from "./PlanDocumentView";
import { AnnotationChips } from "./AnnotationChips";
import { SelectionContextMenu } from "./SelectionContextMenu";
import {
  SelectionCommentButton,
  SelectionCommentPopover,
  selectionInside,
  useFrameSelection,
  useSelectionCommentButton,
  type SelectionAnchor,
} from "./SelectionComment";
import { AttachmentButton, Button, Chip, CopyButton, IconButton, IconClose, Label, Switch } from "./ui";
import { TONE_CHIP } from "./ui/tone";
import { isMintedWorktreeBranch, mintBranchName, worktreeBranchPrefix } from "@omp-ui/core/worktree-branch";
import { WorktreeBranchFields } from "./WorktreeBranchFields";

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
 * defer and refine keep the working tree read-only. Council review is a
 * refine whose follow-up asks the planner to run the session's council on the
 * plan first. It shows only when this process can launch a council.
 *
 * The plan is rendered from the file on disk rather than from the proposal
 * frame: the frame carries only the slug, and the file is the artifact the
 * implementer will actually execute.
 */

/** Execution contexts offered to the user, with one-line descriptions. */
const CONTEXTS: ReadonlyArray<{
  id: PlanExecutionContext;
  label: string;
  hint: string;
}> = [
  { id: "existing", label: "this session", hint: "implement in the same chat" },
  { id: "compacted", label: "this session, compacted", hint: "compact context, then implement here" },
  { id: "fresh", label: "fresh session", hint: "a new chat seeded with the plan" },
  { id: "worktree", label: "worktree session", hint: "a new chat in a dedicated checkout and branch" },
];

/** Stable empty array so the selector doesn't resubscribe on every store tick. */
const EMPTY_MODELS: ModelInfo[] = [];
type CompactReviewStep = "review" | "refine" | "setup";

/** The aside's keyword rows, in omp's notice-push order. */
const KEYWORD_ROWS: ReadonlyArray<{ keyword: StagedKeyword; hint: (keyword: StagedKeyword) => string }> = [
  {
    keyword: "ultrathink",
    hint: () => "Careful multi-step reasoning — leads the prompt; under auto-thinking the turn also jumps to the model's highest level.",
  },
  {
    keyword: "orchestrate",
    hint: (keyword) => `Fan the implementation out to subagents — omp's ${keyword} keyword leads the prompt.`,
  },
  {
    keyword: "workflowz",
    hint: (keyword) => `Drive the implementation as a deterministic multi-subagent workflow — omp's ${keyword} keyword leads the prompt.`,
  },
];

/** A magic keyword painted with its own gradient, as the composer paints it (static phase). */
function KeywordLabel({ keyword }: { keyword: StagedKeyword }) {
  return (
    <span className="font-mono text-xs font-medium" aria-label={keyword}>
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
  goal,
  branch,
  className,
}: {
  contextLabel: string;
  model: ModelInfo | null;
  ultrathink: boolean;
  orchestrate: boolean;
  workflowz: boolean;
  goal: boolean;
  branch: string | null;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <Label>ready to dispatch</Label>
      <p className="mt-0.5 truncate text-xs text-ink-dim">
        {contextLabel}
        {model !== null && <>{" · "}{model.name || model.id}</>}
        {ultrathink && " · ultrathink"}
        {orchestrate && " · orchestrate"}
        {workflowz && " · workflowz"}
        {goal && " · goal"}
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
  return (
    <Button
      variant="solid"
      tone="signal"
      disabled={disabled}
      onClick={onExecute}
    >
      {checkingOut ? "switching branch…" : `execute in ${contextLabel}`}
    </Button>
  );
}

export function PlanReview({
  tabId,
  fill = false,
  dictationActive = false,
}: {
  tabId: string;
  fill?: boolean;
  dictationActive?: boolean;
}) {
  const review = useStore((s) => s.rpc[tabId]?.planReview);
  const backRoot = useRef<HTMLDivElement>(null);
  useAndroidBack({ open: review != null, refs: backRoot, kind: "blocker", onBack: "block" });
  const planText = useStore((s) => s.rpc[tabId]?.planText);
  /** Present only when the session planned in html format and the file read. */
  const planHtml = useStore((s) => s.rpc[tabId]?.planHtml ?? null);
  const planSourceKey = useStore((s) => s.rpc[tabId]?.planSourceKey ?? null);
  const planIsHtml = isHtmlPlanPath(review?.request.planFilePath);
  const prepared = usePreparedPlanDocument(
    planHtml,
    review?.request.sourceHash,
    planSourceKey ?? undefined,
  );
  const setPlanReadiness = useStore((s) => s.setPlanReadiness);
  useEffect(() => {
    if (planSourceKey === null) {
      setPlanReadiness(tabId, null);
      return;
    }
    if (!planIsHtml || prepared.sourceKey === undefined) return;
    setPlanReadiness(tabId, {
      status: prepared.status,
      sourceKey: prepared.sourceKey,
      ...(prepared.status !== "pending" ? { identity: prepared.identity } : {}),
    });
  }, [planSourceKey, planIsHtml, prepared, tabId, setPlanReadiness]);
  const voiceReady = useStore((s) => s.rpc[tabId]?.planVoice.ready === true);
  const voiceBusy = useStore((s) => s.rpc[tabId]?.planVoice.busy === true);
  const voiceError = useStore((s) => s.rpc[tabId]?.planVoice.error ?? null);
  const explainPlanVoice = useStore((s) => s.explainPlanVoice);
  const liveActive = useStore((s) => {
    const live = s.rpc[tabId]?.live;
    return live != null && !live.ended;
  });
  const liveArmed = useStore((s) => s.liveVoice[tabId]?.armed === true);
  const rpcStatus = useStore((s) => s.rpc[tabId]?.status);
  const exited = useStore((s) => s.exited[tabId] !== undefined);
  const advisorConfigured = useStore((s) => s.rpc[tabId]?.advisorStats?.configured === true);
  const councilCount = useSessionCouncilMembers(tabId);
  const executePlan = useStore((s) => s.executePlan);
  const refinePlan = useStore((s) => s.refinePlan);
  const deferPlanReview = useStore((s) => s.deferPlanReview);
  const dismissPlanReview = useStore((s) => s.dismissPlanReview);
  const sendPlanToCouncil = useStore((s) => s.sendPlanToCouncil);
  /** True after "not now": the pane is dismissed but the gate is unanswered. */
  const deferred = useStore((s) => s.rpc[tabId]?.planDeferred === true);
  const compact = useCompactShell();
  const [compactStep, setCompactStep] = useState<CompactReviewStep>("review");

  const [context, setContext] = useState<PlanExecutionContext>("existing");
  const [contextTouched, setContextTouched] = useState(false);
  /**
   * The worktree context's dedicated checkout (issue #313): branch + base,
   * minted once on first pick of the worktree row. Persists across context
   * switches within a review; a new proposal re-seeds it to null.
   */
  const [worktreeSel, setWorktreeSel] = useState<{
    branch: string;
    baseRef: string | null;
    baseBranch: string | null;
    baseTouched: boolean;
    /** The applied suggestion; null until the one-time apply runs. */
    suggested: string | null;
  } | null>(null);
  /** Change notes for the planner; text + optional images ride a steer prompt. */
  const [changes, setChanges] = useState("");
  const {
    images,
    documents,
    annotations,
    pasteError,
    onPaste,
    pickFiles,
    dropImage,
    dropDocument,
    addAnnotations,
    dropAnnotation,
    clearDraft,
    setPasteError,
  } = useImageDraft();
  // Comment… on the plan (issue #983, ADR-0077): a selection in the plan
  // document becomes an annotation chip in the refine box. Markdown plans
  // select in this DOM; HTML plans select inside the review frame.
  const planDocRef = useRef<HTMLDivElement>(null);
  const [planFrame, setPlanFrame] = useState<HTMLIFrameElement | null>(null);
  const onPlanFrame = useCallback((frame: HTMLIFrameElement | null) => setPlanFrame(frame), []);
  const [planMenu, setPlanMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [planComment, setPlanComment] = useState<SelectionAnchor | null>(null);
  const surfaceIdle = planMenu === null && planComment === null;
  const markdownButton = useSelectionCommentButton(planDocRef, surfaceIdle && review != null && !deferred);
  const frameSelection = useFrameSelection(planFrame, surfaceIdle && review != null && !deferred);
  const commentAnchor = markdownButton.anchor ?? frameSelection.anchor;
  const activeMenu = planMenu ?? frameSelection.menu;
  const closeMenu = (): void => {
    setPlanMenu(null);
    frameSelection.closeMenu();
  };
  const onPlanContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    const sel = window.getSelection();
    if (planDocRef.current === null || sel === null || !selectionInside(planDocRef.current, sel)) return;
    event.preventDefault();
    markdownButton.clear();
    setPlanMenu({ x: event.clientX, y: event.clientY, text: sel.toString() });
  };
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
  const filePicker = useRef<HTMLInputElement>(null);
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
  // Stage the SELECTOR, not the resolved value: under auto the concrete
  // thinkingLevel drifts every turn, and staging it would silently convert
  // the dispatch (and the receiving session's record) to a pinned level.
  const currentThinking = useStore(
    (s) =>
      s.rpc[tabId]?.session.thinkingConfigured ?? s.rpc[tabId]?.session.thinkingLevel ?? null,
  );
  const availableModels = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY_MODELS);
  const sessionRecord = useStore((s) => findRecord(s.state, tabId));
  // The session's owning instance (issue #416): its advisor defaults live on
  // that host, keyed by projectKey in the store.
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const instanceDown = useStore(
    (s) => instanceId !== null && findInstance(s.state, instanceId)?.status !== "joined",
  );
  const voiceDisabled = sessionRecord?.live !== "live" || rpcStatus === "starting" ||
    rpcStatus === "error" || exited || instanceDown || dictationActive;
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const advisorDefaults = useStore((s) => (projectCwd ? s.advisorDefaults[projectKey(instanceId, projectCwd)] : undefined));
  // This instance's dev/test advisor override (issue #372): the same backend
  // state both renderers hydrate from; display precedence only.
  const gateAdvisor = useStore((s) => s.state?.spawnGate.advisorModel ?? null);

  /**
   * The planning session's own dedicated checkout (issue #316): when set, a
   * fresh dispatch is pinned to it, and a worktree dispatch that keeps the
   * planning branch reuses it instead of minting a second checkout.
   */
  const sourceWorktree = sessionRecord?.worktree ?? null;

  const {
    stagedModel,
    setStagedModel,
    stagedThinking,
    setStagedThinking,
    stagedAdvisor,
    setStagedAdvisor,
    stagedAdvisorModel,
    setStagedAdvisorModel,
    switches,
    setSwitch,
    pickingModel,
    setPickingModel,
    pickingAdvisorModel,
    setPickingAdvisorModel,
  } = usePlanDispatchStaging(review, sessionRecord, currentModel, currentThinking);
  // omp's `magicKeywords.*` settings, from the capabilities bridge: a keyword
  // omp has switched off is shown disabled and never dispatched or summarized.
  // The settings apply to the whole project (global config plus .omp/config.yml,
  // which worktree sessions link), so the planning session's gate also holds
  // for fresh and worktree receivers; tool gating is deliberately not applied
  // here — the receiving roster differs from this one.
  const capabilities = useStore((s) => s.rpc[tabId]?.capabilities ?? null);
  // The section stays mounted when the version gate closes it: controls inert,
  // the required version in the section's title (floor plan §6).
  const nativeLive = supportsNativeLive(capabilities?.ompVersion ?? null);
  const off = useMemo(() => keywordsOffInSettings(capabilities), [capabilities]);
  const ultrathink = switches.ultrathink && !off.has("ultrathink");
  const orchestrate = switches.orchestrate && !off.has("orchestrate");
  const workflowz = switches.workflowz && !off.has("workflowz");
  // The goal switch's honesty gates: omp's `goal.enabled` setting read as
  // config truth through the scoped catalog (issue #846), NOT the session's
  // tool roster — plan mode detaches the goal tool from the roster while the
  // setting stays on, and every review opens in plan mode. A catalog read
  // that failed or says nothing leaves the switch honest-on. The second
  // gate: a source session already carrying an unfinished goal (omp refuses
  // a second create). Force-cleared for dispatch exactly like the keyword
  // rows above.
  const [goalCatalog, setGoalCatalog] = useState<
    ToolsAtScope | { status: "error"; message: string } | null
  >(null);
  useEffect(() => {
    let live = true;
    backendFor(instanceId)
      .getScopedCapabilities(projectCwd ?? null)
      .then((result) => {
        if (live) setGoalCatalog(result.tools);
      })
      .catch(() => {
        // An unreadable catalog is "cannot tell": not off, same fallback as
        // the keyword gate's unknown section.
      });
    return () => {
      live = false;
    };
  }, [instanceId, projectCwd]);
  const goalOff = useMemo(() => goalDisabledInCatalog(goalCatalog), [goalCatalog]);
  const goalBusy = coreGoalOwnsSession(useStore((s) => s.rpc[tabId]?.goal ?? null));
  const goal = switches.goal && !goalOff && !goalBusy;
  const [levelMenu, setLevelMenu] = useState<"main" | "advisor" | null>(null);

  // A new proposal resets navigation and checkout staging. Dispatch parameters
  // are re-seeded by usePlanDispatchStaging.
  const [seededFor, setSeededFor] = useState<unknown>(null);
  if (review !== seededFor) {
    setSeededFor(review);
    setContext("existing");
    setContextTouched(false);
    setCompactStep("review");
    setWorktreeSel(null);
  }
  // omp's config supplies the inherited advisor default, read on the owning
  // instance's host.
  useEffect(() => {
    if (projectCwd !== undefined) void loadAdvisorDefaults(projectCwd, instanceId);
  }, [projectCwd, instanceId, loadAdvisorDefaults]);

  /** Anchors for the two thinking-level popovers. */
  const mainLevelAnchor = useRef<HTMLSpanElement | null>(null);
  const advisorLevelAnchor = useRef<HTMLSpanElement | null>(null);

  // Outside pointerdown closes an open level menu (AdvisorControl's pattern).
  useDismissal({
    open: levelMenu !== null,
    refs: [mainLevelAnchor, advisorLevelAnchor],
    onClose: () => setLevelMenu(null),
  });

  // The plan names the new base once per selection (issue #422), never the
  // session's own branch (issue #428): in create-base mode the suggestion
  // lands in the base field, and the mint follows it with its hash intact
  // (#405). Typed text is never touched; the `suggested` latch makes the
  // apply run once, so a later clear-to-empty never refills — and the
  // selection in the deps only carries the name to a row picked after the
  // model had already answered.
  const branchInfo = useStore((s) =>
    projectCwd === undefined ? undefined : s.branches[projectKey(instanceId, projectCwd)],
  );
  const workspacePolicy = useStore((s) =>
    effectiveWorkspacePolicy(s.state, projectCwd, instanceId),
  );
  const checkoutBusy = useStore((s) =>
    checkoutOccupant(s, projectCwd, tabId, instanceId) !== null,
  );

  const buildInitialWorktreeSel = useCallback((): {
    branch: string;
    baseRef: string | null;
    baseBranch: string | null;
    baseTouched: boolean;
    suggested: string | null;
  } => {
    if (sourceWorktree !== null) {
      return {
        branch: sourceWorktree.branch,
        baseRef: null,
        baseBranch: null,
        baseTouched: false,
        suggested: null,
      };
    }
    const preferred =
      suggestion ??
      (baseFallback !== "" ? baseFallback : mintBranchName(worktreeBranchPrefix(projectCwd ?? "")));
    const defaultUsable =
      branchInfo !== undefined &&
      branchInfo.defaultBranch !== null &&
      branchInfo.branches.includes(branchInfo.defaultBranch);
    const baseRef =
      branchInfo === undefined
        ? null
        : defaultUsable
          ? branchInfo.defaultBranch
          : branchInfo.current;
    return {
      branch: preferred,
      baseRef,
      baseBranch: null,
      baseTouched: false,
      suggested: suggestion,
    };
  }, [sourceWorktree, suggestion, baseFallback, projectCwd, branchInfo]);

  // Default PlanReview context based on workspacePolicy when the planning
  // session is on the shared project checkout in a git repo.
  useEffect(() => {
    if (review == null || contextTouched || sourceWorktree !== null || !branch.isRepo) return;
    const onDefault =
      branchInfo !== undefined &&
      branchInfo.current !== null &&
      branchInfo.defaultBranch !== null &&
      branchInfo.current === branchInfo.defaultBranch;
    const shouldUseWorktree =
      workspacePolicy === "worktree" ||
      (workspacePolicy === "auto" && (checkoutBusy || onDefault));
    if (shouldUseWorktree) {
      setContext("worktree");
      setWorktreeSel((prev) => prev ?? buildInitialWorktreeSel());
    } else {
      setContext("existing");
    }
  }, [review, contextTouched, sourceWorktree, branch.isRepo, workspacePolicy, checkoutBusy, branchInfo, buildInitialWorktreeSel]);

  useEffect(() => {
    if (suggestion === null) return;
    setWorktreeSel((prev) => {
      if (prev === null || prev.suggested !== null) return prev;
      if (prev.baseBranch !== null) {
        const baseBranch =
          prev.baseBranch === "" || prev.baseBranch === baseFallback ? suggestion : prev.baseBranch;
        return { ...prev, baseBranch, suggested: suggestion };
      }
      // When sourceWorktree === null, apply the async suggestion into the
      // worktree branch field if the user hasn't typed a custom name yet.
      const prefix = worktreeBranchPrefix(projectCwd ?? "");
      const untouchedBranch =
        sourceWorktree === null &&
        (prev.branch === baseFallback || isMintedWorktreeBranch(prev.branch, prefix));
      return {
        ...prev,
        branch: untouchedBranch ? suggestion : prev.branch,
        suggested: suggestion,
      };
    });
  }, [suggestion, baseFallback, worktreeSel, sourceWorktree, projectCwd]);
  if (!review || deferred) return null;
  const { request } = review;
  // The council review needs a launchable council in THIS process and an
  // omp-shaped plan path the bridge accepts.
  const councilMembers = councilCount !== null && isCouncilPlanPath(request.planFilePath) ? councilCount : null;
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
  const advisorSplit = effectiveAdvisor === null ? null : parseModelRole(effectiveAdvisor);
  const advisorModelInfo =
    availableModels.find((m) => `${m.provider}/${m.id}` === advisorSplit?.model) ?? null;
  const advisorEfforts = advisorModelInfo?.thinking?.efforts ?? [];
  const mainEfforts = stagedModel?.thinking?.efforts ?? [];

  const contextLabel = CONTEXTS.find((candidate) => candidate.id === context)?.label ?? context;
  const branchApplies = sourceWorktree === null && context !== "worktree";
  const dispatchBranch =
    context === "worktree" && worktreeSel !== null
      ? worktreeSel.branch.trim() || "new branch"
      : sourceWorktree !== null
        ? sourceWorktree.branch
        : branch.summary;
  // §6: for an HTML plan, execute waits for the local preparation too —
  // pending, failed, unavailable, or a preparation made for a DIFFERENT
  // source identity all keep execute disabled. Refine and defer stay live.
  const htmlNotReady =
    planIsHtml &&
    (planSourceKey === null ||
      prepared.sourceKey !== planSourceKey ||
      prepared.status !== "ready" ||
      (review.request.sourceHash !== undefined &&
        prepared.identity !== review.request.sourceHash));
  const executeDisabled =
    htmlNotReady ||
    (context === "worktree"
      ? worktreeSel === null ||
        worktreeSel.branch.trim() === "" ||
        (worktreeSel.baseBranch !== null && worktreeSel.baseBranch.trim() === "")
      : branchApplies && (branch.checkingOut || branch.branchInvalid));

  /** Materializes the notes draft (ADR-0044); null = a PDF was refused and the draft stays intact. */
  const draftNotes = async (): Promise<PlanRevisionNotes | undefined | null> => {
    // Materialize the PDFs before the draft is spent (ADR-0044): a refusal
    // keeps the notes draft intact, the same keep-draft shape as Composer.
    let docRefs: DocumentRef[] = [];
    if (documents.length > 0) {
      try {
        const paths = await backend.attachDocument(tabId, documents);
        docRefs = documents.map((document, i) => ({ name: document.name, path: paths[i]! }));
      } catch (err) {
        setPasteError(displayMessage(err));
        return null;
      }
    }
    const any = changes.trim() !== "" || images.length > 0 || docRefs.length > 0 || annotations.length > 0;
    return any
      ? {
          text: changes,
          images: images.length ? images : undefined,
          documents: docRefs.length ? docRefs : undefined,
          annotations: annotations.length ? annotations : undefined,
        }
      : undefined;
  };
  // The draft has been spent. RpcTab keeps this pane mounted for the whole
  // life of an active tab, so refine → revised proposal never unmounts it and
  // nothing else would ever clear these — the stale notes would reappear on
  // the next review, re-submittable by accident (issue #113). "Not now" keeps
  // its draft on purpose: deferring asks for no revision.
  const spendDraft = (): void => {
    setChanges("");
    clearDraft();
  };
  const refine = async () => {
    const notes = await draftNotes();
    if (notes === null) return;
    refinePlan(tabId, notes);
    spendDraft();
  };
  const sendToCouncil = async () => {
    const notes = await draftNotes();
    if (notes === null) return;
    sendPlanToCouncil(tabId, notes);
    spendDraft();
  };
  const councilButton = councilMembers !== null && (
    <Button title={`Send this plan to your ${councilMembers}-model council for a read-only review. The planner then revises it if they report blockers or major issues, and proposes it again. Your change notes go with it.`} onClick={() => void sendToCouncil()}>
      council review
    </Button>
  );
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
      goal,
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
      void refine();
    }
  };

  return (
    <>
    <div
      ref={backRoot}
      role="region"
      aria-labelledby="plan-review-title"
      className={cn(
        // A flex column, not a plain block: the inner .plan-review column must
        // shrink inside the wrapper (min-h-0 + flex-shrink) so the actions
        // footer stays visible and the plan/setup panes scroll internally. A
        // block child would render at natural height and overflow-hidden would
        // clip the footer away.
        "animate-rise mx-auto mb-2 flex w-full flex-col overflow-hidden rounded-md border border-line ambient plane-lit shadow-float",
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
                  ? "review plan"
                  : compactStep === "refine"
                    ? "request changes"
                    : "implementation setup"
                : "plan ready"}
            </Label>
            <h2 id="plan-review-title" className="mt-1 truncate text-base font-semibold text-ink" title={request.title}>
              {request.title}
            </h2>
            <p className="plan-review-artifact mt-0.5 truncate font-mono text-xs text-ink-faint">
              {request.planFilePath}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {planText && (!compact || compactStep === "review") && <CopyButton text={planText} label="copy plan" />}
            <IconButton label="leave plan pending" onClick={dismiss}>
              <IconClose />
            </IconButton>
          </div>
        </header>
        <section
          aria-label="Live voice"
          title={nativeLive ? undefined : `this omp has no live voice — update omp to ${NATIVE_LIVE_MIN_OMP} or later`}
          className="flex min-w-0 shrink-0 flex-col gap-2 border-b border-line px-5 py-3"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Label>Live voice</Label>
            <LiveVoiceControl
              tabId={tabId}
              disabled={voiceDisabled || !nativeLive}
              startDisabled={!voiceReady || voiceBusy || !nativeLive}
            />
            <Button
              variant="ghost"
              disabled={!voiceReady || voiceBusy || voiceDisabled || !nativeLive}
              onClick={() => void explainPlanVoice(tabId)}
              className="h-auto min-w-0 whitespace-normal text-left"
            >
              {liveActive || liveArmed ? "Explain this plan" : "Start live voice and explain"}
            </Button>
          </div>
          <p className="min-w-0 [overflow-wrap:anywhere] text-xs text-ink-dim">
            Discuss here; use the review controls to send changes or execute.
          </p>
          {!voiceReady && (
            <p role="status" className="min-w-0 [overflow-wrap:anywhere] text-xs text-ink-dim">
              {planIsHtml && prepared.status === "pending" ? "Preparing plan context…" : "The reviewed plan is not available to live voice."}
            </p>
          )}
          {voiceError !== null && (
            <p role="alert" className="min-w-0 [overflow-wrap:anywhere] text-xs text-copper">
              {voiceError}
            </p>
          )}
          <LiveVoiceStrip tabId={tabId} layout="review" />
        </section>

        <div className={cn(
          "plan-review-layout grid min-h-0 min-w-0 flex-1 overflow-hidden",
          compact ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_21rem]",
        )}>
          {(!compact || compactStep !== "setup") && (
          <section
            className={cn(
              "plan-review-document min-h-0 min-w-0 px-5 py-4",
              // The iframe scrolls its own content (unreachable for parent
              // measurement under an empty sandbox), so the section stops being
              // the scroll container and just hands it the leftover height.
              planIsHtml ? "flex flex-col overflow-hidden" : "overflow-y-auto",
            )}
            aria-label="proposed plan"
          >
            {(!compact || compactStep === "review") && (
              <div
                ref={planDocRef}
                onContextMenu={planIsHtml ? undefined : onPlanContextMenu}
                className={cn("plan-review-preview min-h-0 min-w-0 flex-1", planIsHtml && "flex flex-col")}
              >
                {planIsHtml ? (
                  <PreparedPlanView
                    prepared={prepared}
                    source={planText ?? planHtml ?? ""}
                    title="proposed plan"
                    className="min-h-0 flex-1"
                    onFrame={onPlanFrame}
                  />
                ) : planText ? (
                  <Markdown text={planText} />
                ) : (
                  <p className="text-sm text-ink-dim">The plan file could not be read. Execute only if you know what it contains — otherwise refine and let the agent rewrite it.</p>
                )}
              </div>
            )}

            {(!compact || compactStep === "refine") && (
            <div className={cn("plan-review-refine mt-6 border-t border-line pt-4", planIsHtml && "shrink-0")}>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <Label>send it back</Label>
                  <p className="mt-1 text-xs text-ink-dim">Describe what the planner should revise.</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-xs text-ink-faint">Enter to refine · Shift+Enter for a line break</span>
                  <AttachmentButton disabled={false} label="attach files" onClick={() => filePicker.current?.click()} />
                </div>
              </div>
              <div className="mt-2 rounded-lg border border-line bg-raised focus-within:border-line-strong">
                {images.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 pt-2 pb-1.5">
                    {images.map((image, i) => (
                      <span key={i} className="group/att relative">
                        <img
                          src={`data:${image.mimeType};base64,${image.data}`}
                          alt={`change note ${i + 1}`}
                          title={image.mimeType}
                          className="size-12 rounded border border-line-strong bg-sunken object-cover"
                        />
                        <span className="absolute -right-1 -top-1 opacity-0 transition-opacity group-hover/att:opacity-100 focus-within:opacity-100">
                          <IconButton
                            label={`remove change note ${i + 1}`}
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
                        ? `${images.length} attachment`
                        : `${images.length} attachments`}
                    </Label>
                  </div>
                )}
                {documents.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 pt-2 pb-1.5">
                    {documents.map((document, i) => (
                      <Chip key={i} tone="iris" mono truncate title={document.path ?? document.mimeType}>
                        <span className="min-w-0 truncate">{document.name}</span>
                        <IconButton
                          label={`remove document ${i + 1}`}
                          tone="rose"
                          onClick={() => dropDocument(i)}
                          className="size-4 rounded-full border border-line-strong bg-overlay"
                        >
                          <IconClose />
                        </IconButton>
                      </Chip>
                    ))}
                    <Label className="ml-0.5">
                      {documents.length === 1
                        ? "document"
                        : "documents"}
                    </Label>
                  </div>
                )}
                {annotations.length > 0 && (
                  <AnnotationChips
                    annotations={annotations}
                    onRemove={dropAnnotation}
                    className="border-b border-line px-2 pt-2 pb-1.5"
                  />
                )}
                <textarea
                  rows={3}
                  value={changes}
                  placeholder="What should change before implementation?"
                  spellCheck={false}
                  onChange={(e) => setChanges(e.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={(e) => void onPaste(e)}
                  className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
                />
                <input
                  ref={filePicker}
                  type="file"
                  accept="image/*,application/pdf,video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
                  multiple
                  tabIndex={-1}
                  aria-hidden
                  className="sr-only"
                  onChange={(event) => void pickFiles(event)}
                />
              </div>
              {pasteError && <p className="mt-1 text-xs text-rose">{pasteError}</p>}
            </div>
            )}
          </section>
          )}

          {(!compact || compactStep === "setup") && (
          <aside className="plan-review-setup min-h-0 overflow-y-auto border-l border-line bg-sunken/70 px-4 py-4" aria-label="implementation setup">
            <div className="mb-4">
              <Label>implementation setup</Label>
              <p className="mt-1 text-xs leading-relaxed text-ink-dim">Choose the context and working tree the implementer receives.</p>
            </div>

            <fieldset>
              <legend className="text-xs font-medium text-ink">Session</legend>
              <div className="mt-2 space-y-1.5">
                {CONTEXTS.map((option) => {
                  const active = context === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={active}
                      disabled={option.id === "worktree" && !branch.isRepo}
                      title={
                        option.id === "worktree" && !branch.isRepo
                          ? "the project isn't a git repo"
                          : undefined
                      }
                      onClick={() => {
                        setContextTouched(true);
                        if (option.id === "worktree" && worktreeSel === null) {
                          setWorktreeSel(buildInitialWorktreeSel());
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
                        <span className="block text-xs font-medium text-ink">{option.label}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-ink-faint">
                          {option.id === "fresh" && sourceWorktree !== null
                            ? "a new chat seeded with the plan, in this session's worktree"
                            : option.id === "worktree" && sourceWorktree !== null
                              ? "this session's worktree, or a new checkout and branch"
                              : option.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="mt-5 border-t border-line pt-4">
              <legend className="text-xs font-medium text-ink">Model</legend>
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">Staged for the session that receives the implementation — nothing changes until execute.</p>

              <span className="mt-3 block text-xs text-ink-faint">model</span>
              {availableModels.length === 0 ? (
                <button
                  type="button"
                  disabled
                  title="no models available"
                  className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink hover:border-line-strong"
                >
                  {stagedModel === null ? "session default" : stagedModel.name || stagedModel.id}
                </button>
              ) : (
                <button
                  type="button"
                  title={
                    stagedModel === null
                      ? "the session keeps its current model"
                      : `${stagedModel.provider}/${stagedModel.id}`
                  }
                  onClick={() => setPickingModel(true)}
                  className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink hover:border-line-strong"
                >
                  {stagedModel === null ? "session default" : stagedModel.name || stagedModel.id}
                </button>
              )}

              {mainEfforts.length > 0 && (
                <>
                  <span className="mt-3 block text-xs text-ink-faint">thinking</span>
                  <span ref={mainLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      title="the session's thinking level for the implementation"
                      onClick={() => setLevelMenu((m) => (m === "main" ? null : "main"))}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink hover:border-line-strong"
                    >
                      {stagedThinking ?? "think —"}
                    </button>
                    {levelMenu === "main" && (
                      <div className="animate-rise edge-lit absolute left-0 top-full z-20 mt-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                        <span className="px-1.5 pb-1 pt-0.5">
                          <Label>thinking</Label>
                        </span>
                        {/* omp's automatic selector, above the ladder. The
                            advisor menu gets no such row: the advisor binds
                            one model[:level] selector at process start and
                            `auto` is not a suffix — it keeps omp's default. */}
                        <button
                          type="button"
                          onClick={() => {
                            setLevelMenu(null);
                            setStagedThinking("auto");
                          }}
                          className={cn(
                            "rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover",
                            stagedThinking === "auto" ? "text-iris" : "text-ink-mid",
                          )}
                        >
                          auto
                        </button>
                        {mainEfforts.map((effort) => (
                          <button
                            key={effort}
                            type="button"
                            onClick={() => {
                              setLevelMenu(null);
                              setStagedThinking(effort);
                            }}
                            className={cn(
                              "rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover",
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
                  <span className="block text-xs font-medium text-ink">Advisor</span>
                  <span className="mt-0.5 block text-xs leading-snug text-ink-faint">A change restarts a same-session implementation at execute time.</span>
                </div>
                <Switch on={stagedAdvisor} onChange={setStagedAdvisor} label="advisor for the implementation" />
              </div>

              {/* Gated provenance stays visible with the advisor off — worded
                  as applying if it is enabled (issue #372). */}
              {gatedAdvisor && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md border border-line bg-raised px-2.5 py-2 text-xs leading-snug text-ink-mid">
                  <span
                    title="Dev/test advisor override"
                    className={cn("mt-px shrink-0 rounded border px-1 font-mono text-xs uppercase tracking-wide", TONE_CHIP.neutral)}
                  >
                    dev/test
                  </span>
                  <span>
                    {stagedAdvisor ? `This app instance overrides the advisor model with ${gateAdvisor ?? ""}. Saved session and project choices are unchanged.` : `When the advisor is enabled, this app instance uses ${gateAdvisor ?? ""}. Saved choices are unchanged.`}
                  </span>
                </p>
              )}

              {stagedAdvisor && (
                <>
                  <span className="mt-3 block text-xs text-ink-faint">advisor model</span>
                  <button
                    type="button"
                    disabled={gatedAdvisor || availableModels.length === 0}
                    title={
                      gatedAdvisor
                        ? `${"Dev/test advisor override"}: ${effectiveAdvisor}`
                        : availableModels.length === 0
                          ? "no models available"
                          : (effectiveAdvisor ?? "omp's modelRoles.advisor")
                    }
                    onClick={() => {
                      if (gatedAdvisor) return;
                      setPickingAdvisorModel(true);
                    }}
                    className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink hover:border-line-strong"
                  >
                    {effectiveAdvisor === null
                      ? "omp default"
                      : advisorModelInfo?.name || shortModelLabel(effectiveAdvisor)}
                  </button>
                </>
              )}

              {stagedAdvisor && gatedAdvisor && advisorSplit !== null && advisorSplit.level !== undefined && (
                <>
                  <span className="mt-3 block text-xs text-ink-faint">advisor thinking</span>
                  <span ref={advisorLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      disabled
                      title={`${"Dev/test advisor override"}: ${effectiveAdvisor}`}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink"
                    >
                      {advisorSplit.level}
                    </button>
                  </span>
                </>
              )}

              {stagedAdvisor && !gatedAdvisor && advisorSplit !== null && advisorEfforts.length > 0 && (
                <>
                  <span className="mt-3 block text-xs text-ink-faint">advisor thinking</span>
                  <span ref={advisorLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      title="the advisor's thinking level for the implementation"
                      onClick={() => setLevelMenu((m) => (m === "advisor" ? null : "advisor"))}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink hover:border-line-strong"
                    >
                      {advisorSplit?.level ?? "think —"}
                    </button>
                    {levelMenu === "advisor" && (
                      <div className="animate-rise edge-lit absolute left-0 top-full z-20 mt-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                        <span className="px-1.5 pb-1 pt-0.5">
                          <Label>advisor thinking</Label>
                        </span>
                        {advisorSplit?.level !== undefined && (
                          <button
                            type="button"
                            onClick={() => {
                              setLevelMenu(null);
                              setStagedAdvisorModel(advisorSplit!.model);
                            }}
                            className="rounded px-1.5 py-0.5 text-left text-xs text-ink-faint hover:bg-hover"
                            title="return to omp's default thinking level for this model"
                          >
                            default —
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
                              "rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover",
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
                <legend className="text-xs font-medium text-ink">
                  Worktree branch
                </legend>
                <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                  This context stays in the planning session's worktree. The branch is a fixed execution target.
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
                <legend className="text-xs font-medium text-ink">Worktree</legend>
                {reusingWorktree && sourceWorktree !== null ? (
                  <p className="mt-1 text-xs leading-relaxed text-ink-faint">This is this session's worktree branch — the implementation reuses this checkout in place. Change the branch to cut a fresh checkout instead.</p>
                ) : (
                  <p className="mt-1 text-xs leading-relaxed text-ink-faint">The implementation runs in a dedicated checkout under the app's worktrees root; the project's working tree is untouched.</p>
                )}
                <div className="mt-3 rounded-lg border border-line bg-raised/70 p-3">
                  <WorktreeBranchFields
                    projectCwd={projectCwd}
                    instanceId={instanceId}
                    branch={worktreeSel.branch}
                    onBranchChange={(b) =>
                      setWorktreeSel((prev) => (prev === null ? prev : { ...prev, branch: b }))
                    }
                    baseRef={worktreeSel.baseRef}
                    onBaseRefChange={(baseRef) =>
                      // WorktreeBranchFields owns recomposing the minted
                      // branch (issue #438); the #316 reuse case never
                      // recomposes because it renders showBase={false}.
                      setWorktreeSel((prev) => (prev === null ? prev : { ...prev, baseRef }))
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
                        return { ...prev, baseBranch: next };
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
                    <p className="mt-2 truncate font-mono text-xs text-ink-faint" title={sourceWorktree.path}>
                      {sourceWorktree.path}
                    </p>
                  )}
                </div>
              </fieldset>
            )}

            <fieldset className="mt-5 border-t border-line pt-4">
              <legend className="text-xs font-medium text-ink">Magic keywords</legend>
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">Armed words lead the implementation prompt, in this order — omp appends each one's hidden notice.</p>
              <div className="mt-3 space-y-3">
                {KEYWORD_ROWS.map(({ keyword, hint }) => (
                  <div key={keyword} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <KeywordLabel keyword={keyword} />
                      <span className="mt-0.5 block text-xs leading-snug text-ink-faint">
                        {hint(keyword)}
                      </span>
                    </div>
                    <Switch
                      on={switches[keyword] && !off.has(keyword)}
                      disabled={off.has(keyword)}
                      title={off.has(keyword) ? "Off in omp's magicKeywords settings — omp would ignore it." : undefined}
                      onChange={(armed) => setSwitch(keyword, armed)}
                      label={`${keyword} the implementation`}
                    />
                  </div>
                ))}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="block text-xs font-medium text-ink">Run as goal</span>
                    <span className="mt-0.5 block text-xs leading-snug text-ink-faint">
                      After dispatch, set the plan as this session's goal — omp keeps working until it is complete. Auto-continue follows omp's goal.continuationModes setting; keeping the interactive default carries it into rpc-ui.
                    </span>
                  </div>
                  <Switch
                    on={goal}
                    disabled={goalOff || goalBusy}
                    title={goalOff ? "Off in omp's goal.enabled setting — omp would refuse it." : goalBusy ? "This session already has a goal — drop it before running one." : undefined}
                    onChange={(armed) => setSwitch("goal", armed)}
                    label="run the implementation as a goal"
                  />
                </div>
              </div>
            </fieldset>

            {advisorConfigured && (
              <div className="mt-5 flex items-start justify-between gap-3 border-t border-line pt-4">
                <div className="min-w-0">
                  <span className="block text-xs font-medium text-ink">Address advisor concerns</span>
                  <span className="mt-0.5 block text-xs leading-snug text-ink-faint">Fold the advisor's plan review into the implementation prompt.</span>
                </div>
                <Switch
                  on={addressAdvisor}
                  onChange={setAddressAdvisor}
                  label="address advisor concerns in the implementation prompt"
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
                goal={goal}
                branch={dispatchBranch}
                className="flex-1"
              />
            )}
            <div className="plan-review-action-buttons ml-auto flex shrink-0 items-center gap-2">
              {compactStep === "review" ? (
                <>
                  <Button title="Leave the plan pending — the agent stays paused until you answer here" variant="ghost" onClick={dismiss}>
                    not now
                  </Button>
                  <Button
                    title="Decline this plan — the planner's turn ends without executing or revising it; the file stays on disk"
                    variant="ghost"
                    onClick={() => void dismissPlanReview(tabId)}
                  >
                    dismiss
                  </Button>
                  <Button onClick={() => setCompactStep("refine")}>refine</Button>
                  <Button variant="solid" tone="signal" onClick={() => setCompactStep("setup")}>
                    execute…
                  </Button>
                </>
              ) : compactStep === "refine" ? (
                <>
                  <Button variant="ghost" onClick={() => setCompactStep("review")}>back to plan</Button>
                  {councilButton}
                  <Button variant="solid" tone="signal" onClick={() => void refine()}>send changes</Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => setCompactStep("review")}>back to plan</Button>
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
              goal={goal}
              branch={dispatchBranch}
            />

            <div className="flex shrink-0 items-center gap-2">
              <Button title="Leave the plan pending — the agent stays paused until you answer here" variant="ghost" onClick={dismiss}>not now</Button>
              <Button
                title="Decline this plan — the planner's turn ends without executing or revising it; the file stays on disk"
                variant="ghost"
                onClick={() => void dismissPlanReview(tabId)}
              >
                dismiss
              </Button>
              {councilButton}
              <Button onClick={() => void refine()}>refine</Button>
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
        instanceId={instanceId}
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
        instanceId={instanceId}
        inherited={advisorInherited}
        defaultModel={advisorDefaults?.model ?? null}
        onClose={() => setPickingAdvisorModel(false)}
        onPick={(selector) => {
          setPickingAdvisorModel(false);
          setStagedAdvisorModel(selector);
        }}
      />
    )}
    {activeMenu !== null && (
      <SelectionContextMenu
        x={activeMenu.x}
        y={activeMenu.y}
        markdown={null}
        onCopy={() => void copyFallback(activeMenu.text)}
        onCopyMarkdown={null}
        onComment={
          normalizeAnnotationQuote(activeMenu.text) === ""
            ? null
            : () =>
                setPlanComment({
                  quote: normalizeAnnotationQuote(activeMenu.text),
                  x: activeMenu.x,
                  y: activeMenu.y,
                })
        }
        onClose={closeMenu}
      />
    )}
    {commentAnchor !== null && (
      <SelectionCommentButton
        anchor={commentAnchor}
        onComment={() => {
          setPlanComment(commentAnchor);
          markdownButton.clear();
          frameSelection.clear();
        }}
      />
    )}
    {planComment !== null && (
      <SelectionCommentPopover
        anchor={planComment}
        onSave={(annotation) => {
          addAnnotations([annotation]);
          // The compact shell shows one step at a time: land on the refine box.
          if (compact) setCompactStep("refine");
          window.getSelection()?.removeAllRanges();
          planFrame?.contentDocument?.getSelection()?.removeAllRanges();
        }}
        onClose={() => setPlanComment(null)}
      />
    )}
    </>
  );
}
