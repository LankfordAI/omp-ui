import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { ImageAttachment } from "@omp-ui/core/types";
import { branchNameFromPlanPath } from "../lib/branch-name";
import { cn } from "../lib/cn";
import { hasClipboardImage, readClipboardImages, readImageFiles } from "../lib/clipboard-image";
import { keywordColors, type MagicKeyword } from "../lib/magic-keywords";
import type { PlanExecutionContext, PlanExecutionOptions } from "../lib/plan-concerns";
import { usePreparedPlanDocument } from "../lib/plan-document";
import { useCompactShell } from "../lib/responsive";
import { planSeedText } from "../lib/plan-seed";
import type { ModelInfo } from "../lib/rpc-types";
import { findRecord, runningSessionTitleOnCheckout, useStore } from "../store";
import { useDismissal } from "../lib/use-dismissal";
import { shortLabel, splitRole } from "./AdvisorControl";
import { Markdown } from "./Markdown";
import { ModelPalette } from "./ModelSelector";
import { AttachmentButton, Button, CopyButton, IconButton, IconClose, Label, Switch } from "./ui";

/**
 * The plan approval gate. omp's agent is *blocked* inside its `xd://propose`
 * call while this docked, non-modal panel is open in the session's tab. It has
 * no scrim, app-wide inert state, or focus trap: execute lands a verdict and
 * lets the renderer dispatch the implementation into a chosen context (same
 * session, same session after compacting, or a fresh session), while refine
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
const CONTEXTS: Array<{
  id: PlanExecutionContext;
  label: string;
  hint: string;
}> = [
  { id: "existing", label: "this session", hint: "implement in the same chat" },
  { id: "compacted", label: "this session, compacted", hint: "compact context, then implement here" },
  { id: "fresh", label: "fresh session", hint: "a new chat seeded with the plan" },
];

/** Stable empty array so the selector doesn't resubscribe on every store tick. */
const EMPTY_MODELS: ModelInfo[] = [];
type CompactReviewStep = "review" | "refine" | "setup";

/** The aside's keyword rows, in omp's notice-push order. */
const KEYWORD_ROWS: ReadonlyArray<{ keyword: MagicKeyword; hint: string }> = [
  {
    keyword: "ultrathink",
    hint: "Careful multi-step reasoning — leads the prompt; under auto-thinking the turn also jumps to the model's highest level.",
  },
  {
    keyword: "orchestrate",
    hint: "Fan the implementation out to subagents — omp's orchestrate keyword leads the prompt.",
  },
  {
    keyword: "workflowz",
    hint: "Drive the implementation as a deterministic multi-subagent workflow — omp's workflowz keyword leads the prompt.",
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

export function PlanReview({ tabId, fill = false }: { tabId: string; fill?: boolean }) {
  const review = useStore((s) => s.rpc[tabId]?.planReview);
  const planText = useStore((s) => s.rpc[tabId]?.planText);
  /** Present only when the session planned in html format and the file read. */
  const planHtml = useStore((s) => s.rpc[tabId]?.planHtml);
  const preparedPlanHtml = usePreparedPlanDocument(planHtml ?? null);
  const advisorConfigured = useStore((s) => s.rpc[tabId]?.advisorStats?.configured === true);
  const executePlan = useStore((s) => s.executePlan);
  const refinePlan = useStore((s) => s.refinePlan);
  const deferPlanReview = useStore((s) => s.deferPlanReview);
  /** True after "not now": the pane is dismissed but the gate is unanswered. */
  const deferred = useStore((s) => s.rpc[tabId]?.planDeferred === true);
  const compact = useCompactShell();
  const [compactStep, setCompactStep] = useState<CompactReviewStep>("review");

  const [context, setContext] = useState<PlanExecutionContext>("existing");
  /** Change notes for the planner; text + optional images ride a steer prompt. */
  const [changes, setChanges] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  /**
   * Fold the advisor's review of the plan turn (it lands only after an execute
   * verdict lets the turn end) into the implementation prompt. Inert on
   * sessions with no configured advisor. Refine stays immediate: the planner
   * revises in this same session, where the advisor's notes already land.
   */
  const [addressAdvisor, setAddressAdvisor] = useState(true);

  const projectCwd = useStore((s) => s.tabs.find((t) => t.tabId === tabId)?.projectCwd);
  const branchInfo = useStore((s) => (projectCwd ? s.branches[projectCwd] : undefined));
  const planFilePath = useStore((s) => s.rpc[tabId]?.planReview?.request.planFilePath);
  const planTitle = useStore((s) => s.rpc[tabId]?.planReview?.request.title);
  const refreshBranches = useStore((s) => s.refreshBranches);
  const checkoutGitBranch = useStore((s) => s.checkoutGitBranch);
  const suggestBranchName = useStore((s) => s.suggestBranchName);
  // A session mid-turn on this checkout (other than this gate-blocked tab): a
  // plain checkout would move the working tree out from under it.
  const busyTitle = useStore((s) => runningSessionTitleOnCheckout(s, projectCwd, tabId));

  /** The paperclip's hidden file input; picked images ride the same draft path as paste. */
  const imagePicker = useRef<HTMLInputElement>(null);

  const [branchChoice, setBranchChoice] = useState<"current" | "new" | "existing">("current");
  const [newName, setNewName] = useState("");
  const [existingName, setExistingName] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);

  const currentModel = useStore((s) => s.rpc[tabId]?.model ?? null);
  const currentThinking = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const availableModels = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY_MODELS);
  const sessionRecord = useStore((s) => findRecord(s.state, tabId));
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const advisorDefaults = useStore((s) => (projectCwd ? s.advisorDefaults[projectCwd] : undefined));

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
    setStagedModel(currentModel);
    setStagedThinking(currentThinking);
    setStagedAdvisor(sessionRecord?.advisor ?? false);
    setStagedAdvisorModel(sessionRecord?.advisorModel ?? null);
    setUltrathink(false);
    setOrchestrate(false);
    setCompactStep("review");
    setWorkflowz(false);
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

  const isRepo =
    projectCwd !== undefined && branchInfo !== undefined && branchInfo.repoRoot !== null;

  // Branch list on open — another client may have switched branches.
  useEffect(() => {
    if (projectCwd !== undefined && branchInfo === undefined) void refreshBranches(projectCwd);
  }, [projectCwd, branchInfo, refreshBranches]);

  // Mechanical prefill as soon as the review exists.
  useEffect(() => {
    if (planFilePath !== undefined) {
      setNewName((cur) => (cur === "" ? branchNameFromPlanPath(planFilePath) : cur));
    }
  }, [planFilePath]);

  // The model's suggestion replaces the fallback only while the field is
  // untouched (the current value still IS the fallback) — it never overwrites
  // typing. Fires only once planText has loaded; when the plan file is
  // unreadable the fallback prefill alone carries the flow.
  useEffect(() => {
    if (!isRepo || projectCwd === undefined || planFilePath === undefined || planText == null) {
      return;
    }
    const fallback = branchNameFromPlanPath(planFilePath);
    const planContext = `${planTitle ?? planFilePath}\n\n${(planSeedText(planText) ?? "").slice(0, 2000)}`;
    let live = true;
    void suggestBranchName(projectCwd, planContext).then((suggested) => {
      if (!live || suggested === null) return;
      setNewName((cur) => (cur === fallback ? suggested : cur));
    });
    return () => {
      live = false;
    };
  }, [isRepo, projectCwd, planFilePath, planText, planTitle, suggestBranchName]);

  if (!review || deferred) return null;
  const { request } = review;

  // What the advisor row shows: the staged pin, else omp's configured default
  // (AdvisorControl's effective/inherited logic). omp encodes the level as a
  // `:level` suffix on the selector.
  const effectiveAdvisor = stagedAdvisorModel ?? advisorDefaults?.model ?? null;
  const advisorInherited = stagedAdvisorModel === null;
  const advisorSplit = effectiveAdvisor === null ? null : splitRole(effectiveAdvisor);
  const advisorModelInfo =
    availableModels.find((m) => `${m.provider}/${m.id}` === advisorSplit?.model) ?? null;
  const advisorEfforts = advisorModelInfo?.thinking?.efforts ?? [];
  const mainEfforts = stagedModel?.thinking?.efforts ?? [];

  const refine = () => {
    const notes = { text: changes, images: images.length ? images : undefined };
    refinePlan(tabId, changes.trim() !== "" || images.length > 0 ? notes : undefined);
    // The draft has been spent. RpcTab keeps this pane mounted for the whole
    // life of an active tab, so refine → revised proposal never unmounts it and
    // nothing else would ever clear these — the stale notes would reappear on
    // the next review, re-submittable by accident (issue #113). "Not now" keeps
    // its draft on purpose: deferring asks for no revision.
    setChanges("");
    setImages([]);
    setPasteError(null);
  };
  // Close (X) / "not now": defer without answering the gate with notes the
  // user did not finish writing. The plan stays pending in the plans tab.
  const dismiss = () => {
    setCompactStep("review");
    deferPlanReview(tabId);
  };

  const branchInvalid =
    isRepo &&
    ((branchChoice === "new" && newName.trim() === "") ||
      (branchChoice === "existing" && existingName === null));

  const execute = async (): Promise<void> => {
    // Staged parameters ride as one options bag; the store applies them to
    // whichever session receives the implementation.
    const options: PlanExecutionOptions = {
      addressAdvisor,
      ultrathink,
      orchestrate,
      workflowz,
      model: stagedModel,
      thinkingLevel: stagedThinking,
      advisor: stagedAdvisor,
      advisorModel: stagedAdvisorModel,
    };
    if (!isRepo || branchChoice === "current") {
      executePlan(tabId, context, options);
      return;
    }
    const name = branchChoice === "new" ? newName.trim() : existingName;
    if (name === null || name === "") return; // unreachable — the button is disabled
    if (branchChoice === "existing" && name === branchInfo!.current) {
      executePlan(tabId, context, options);
      return;
    }
    // Switching branches moves the working tree — a session mid-turn on this
    // project earns a confirm first (creating one does not move the tree).
    if (branchChoice === "existing" && busyTitle !== null && !confirmBusy) {
      setConfirmBusy(true);
      return;
    }
    setCheckingOut(true);
    setBranchError(null);
    const err = await checkoutGitBranch(
      projectCwd!,
      name,
      branchChoice === "new" ? { create: true } : undefined,
    );
    setCheckingOut(false);
    // A refused checkout leaves the gate blocked — the agent must not execute
    // on the wrong branch. git's stderr is the message (branches.ts contract).
    if (err !== null) {
      setBranchError(err);
      setConfirmBusy(false);
      return;
    }
    executePlan(tabId, context, options);
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!hasClipboardImage(e.clipboardData)) return;
    e.preventDefault();
    const { images: pasted, rejected } = await readClipboardImages(e.clipboardData);
    if (pasted.length > 0) setImages((prev) => [...prev, ...pasted]);
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  };

  /** Adds picker-selected Attachments through the same draft path as paste. */
  const pickImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // Clear before reading, including rejected selections, so selecting the
    // same file again always produces another change event.
    input.value = "";
    const { images: picked, rejected } = await readImageFiles(files);
    if (picked.length > 0) setImages((prev) => [...prev, ...picked]);
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
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
                  ? "review plan"
                  : compactStep === "refine"
                    ? "request changes"
                    : "implementation setup"
                : "plan ready"}
            </Label>
            <h2 id="plan-review-title" className="mt-1 truncate font-display text-base font-medium text-ink" title={request.title}>
              {request.title}
            </h2>
            <p className="plan-review-artifact mt-0.5 truncate font-mono text-[10px] text-ink-faint">
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
            aria-label="proposed plan"
          >
            {(!compact || compactStep === "review") && (
              <div className={cn("plan-review-preview min-h-0 flex-1", planHtml && "flex flex-col")}>
                {planHtml ? (
                  // sandbox="" is the empty token list: no scripts, no same-origin
                  // access, no forms, no popups, no navigation. srcDoc keeps the
                  // read on the confined plan:read channel rather than a file:// URL.
                  <iframe
                    title="proposed plan"
                    sandbox=""
                    srcDoc={preparedPlanHtml ?? ""}
                    className="min-h-0 w-full flex-1 rounded-md border border-line bg-white"
                  />
                ) : planText ? (
                  <Markdown text={planText} />
                ) : (
                  <p className="text-sm text-ink-dim">
                    The plan file could not be read. Execute only if you know what it contains —
                    otherwise refine and let the agent rewrite it.
                  </p>
                )}
              </div>
            )}

            {(!compact || compactStep === "refine") && (
            <div className={cn("plan-review-refine mt-6 border-t border-line pt-4", planHtml && "shrink-0")}>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <Label>send it back</Label>
                  <p className="mt-1 text-xs text-ink-dim">Describe what the planner should revise.</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[10px] text-ink-faint">Enter to refine · Shift+Enter for a line break</span>
                  <AttachmentButton disabled={false} onClick={() => imagePicker.current?.click()} />
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
                            onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                            className="size-4 rounded-full border border-line-strong bg-overlay"
                          >
                            <IconClose />
                          </IconButton>
                        </span>
                      </span>
                    ))}
                    <Label className="ml-0.5">
                      {images.length} attachment{images.length === 1 ? "" : "s"}
                    </Label>
                  </div>
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
          <aside className="plan-review-setup min-h-0 overflow-y-auto border-l border-line bg-sunken/70 px-4 py-4" aria-label="implementation setup">
            <div className="mb-4">
              <Label>implementation setup</Label>
              <p className="mt-1 text-xs leading-relaxed text-ink-dim">
                Choose the context and working tree the implementer receives.
              </p>
            </div>

            <fieldset>
              <legend className="text-[11px] font-medium text-ink">Session</legend>
              <div className="mt-2 space-y-1.5">
                {CONTEXTS.map((option, index) => {
                  const active = context === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setContext(option.id)}
                      className={cn(
                        "group flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-[background-color,border-color]",
                        active
                          ? "edge-lit border-line-strong bg-raised"
                          : "border-transparent hover:border-line hover:bg-raised/60",
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
                          <span className="text-xs font-medium text-ink">{option.label}</span>
                          <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">0{index + 1}</span>
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                          {option.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="mt-5 border-t border-line pt-4">
              <legend className="text-[11px] font-medium text-ink">Model</legend>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
                Staged for the session that receives the implementation — nothing changes until execute.
              </p>

              <span className="mt-3 block text-[10px] text-ink-faint">model</span>
              {availableModels.length === 0 ? (
                <button
                  type="button"
                  disabled
                  title="no models available"
                  className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
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
                  className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                >
                  {stagedModel === null ? "session default" : stagedModel.name || stagedModel.id}
                </button>
              )}

              {mainEfforts.length > 0 && (
                <>
                  <span className="mt-3 block text-[10px] text-ink-faint">thinking</span>
                  <span ref={mainLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      title="the session's thinking level for the implementation"
                      onClick={() => setLevelMenu((m) => (m === "main" ? null : "main"))}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                    >
                      {stagedThinking ?? "think —"}
                    </button>
                    {levelMenu === "main" && (
                      <div className="animate-rise edge-lit absolute left-0 top-full z-20 mt-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                        <span className="px-1.5 pb-1 pt-0.5">
                          <Label>thinking</Label>
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
                  <span className="block text-[11px] font-medium text-ink">Advisor</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">
                    A change restarts a same-session implementation at execute time.
                  </span>
                </div>
                <Switch on={stagedAdvisor} onChange={setStagedAdvisor} label="advisor for the implementation" />
              </div>

              {stagedAdvisor && (
                <>
                  <span className="mt-3 block text-[10px] text-ink-faint">advisor model</span>
                  {availableModels.length === 0 ? (
                    <button
                      type="button"
                      disabled
                      title="no models available"
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                    >
                      {effectiveAdvisor === null
                        ? "omp default"
                        : advisorModelInfo?.name || shortLabel(effectiveAdvisor)}
                    </button>
                  ) : (
                    <button
                      type="button"
                      title={effectiveAdvisor ?? "omp's modelRoles.advisor"}
                      onClick={() => setPickingAdvisorModel(true)}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
                    >
                      {effectiveAdvisor === null
                        ? "omp default"
                        : advisorModelInfo?.name || shortLabel(effectiveAdvisor)}
                    </button>
                  )}
                </>
              )}

              {stagedAdvisor && advisorSplit !== null && advisorEfforts.length > 0 && (
                <>
                  <span className="mt-3 block text-[10px] text-ink-faint">advisor thinking</span>
                  <span ref={advisorLevelAnchor} className="relative flex">
                    <button
                      type="button"
                      title="the advisor's thinking level for the implementation"
                      onClick={() => setLevelMenu((m) => (m === "advisor" ? null : "advisor"))}
                      className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink hover:border-line-strong"
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
                            className="rounded px-1.5 py-0.5 text-left text-[11px] text-ink-faint hover:bg-hover"
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

            {isRepo && (
              <fieldset className="mt-5 border-t border-line pt-4">
                <legend className="text-[11px] font-medium text-ink">Git branch</legend>
                <div className="mt-2 grid grid-cols-3 rounded-lg border border-line bg-void/40 p-1">
                  {(
                    [
                      { id: "current", label: "current branch", shortLabel: "current" },
                      { id: "new", label: "new branch", shortLabel: "new" },
                      { id: "existing", label: "existing branch", shortLabel: "switch" },
                    ] as const
                  ).map((option) => {
                    const active = branchChoice === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-label={option.label}
                        aria-pressed={active}
                        onClick={() => {
                          setBranchChoice(option.id);
                          setBranchError(null);
                          setConfirmBusy(false);
                        }}
                        className={cn(
                          "rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors",
                          active ? "bg-overlay text-ink edge-lit" : "text-ink-faint hover:text-ink-mid",
                        )}
                      >
                        {option.shortLabel}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-2.5 rounded-lg border border-line bg-raised/70 p-3">
                  {branchChoice === "current" && (
                    <div>
                      <span className="block text-[10px] text-ink-faint">Implement on</span>
                      <span className="mt-1 block truncate font-mono text-xs text-ink" title={branchInfo!.current ?? "detached HEAD"}>
                        {branchInfo!.current ?? "detached HEAD"}
                      </span>
                      <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">No checkout. Existing working-tree changes stay in place.</p>
                    </div>
                  )}

                  {branchChoice === "new" && (
                    <div>
                      <label htmlFor="plan-new-branch" className="block text-[10px] text-ink-faint">Create and switch to</label>
                      <input
                        id="plan-new-branch"
                        value={newName}
                        placeholder="new-branch-name"
                        aria-label="new branch name"
                        onChange={(e) => setNewName(e.target.value)}
                        className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
                      />
                      <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">Uncommitted work carries into the new branch.</p>
                    </div>
                  )}

                  {branchChoice === "existing" && (
                    <div>
                      <input
                        value={branchFilter}
                        placeholder="filter branches…"
                        aria-label="filter branches"
                        onChange={(e) => setBranchFilter(e.target.value)}
                        className="w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
                      />
                      <div className="mt-1.5 flex max-h-36 flex-col overflow-y-auto">
                        {branchInfo!.branches
                          .filter((b) => b.toLowerCase().includes(branchFilter.toLowerCase()))
                          .map((branch) => (
                            <button
                              key={branch}
                              type="button"
                              disabled={branch === branchInfo!.current}
                              onClick={() => setExistingName(branch)}
                              className={cn(
                                "flex items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-hover",
                                "disabled:pointer-events-none",
                                branch === branchInfo!.current ? "text-iris" : "text-ink-mid",
                                branch === existingName && "bg-hover text-ink",
                              )}
                            >
                              <span className={cn("size-1 rounded-full", branch === existingName ? "bg-ink-mid" : "bg-line-strong")} />
                              <span className="truncate">{branch}</span>
                              {branch === branchInfo!.current && <span className="ml-auto font-sans text-[9px] text-ink-faint">current</span>}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>

                {confirmBusy && (
                  <div className="mt-2 rounded-lg border border-copper-dim/50 bg-copper-wash px-3 py-2.5">
                    <p className="text-[11px] leading-snug text-copper">
                      “{busyTitle}” is mid-turn. Switching changes its working tree.
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <Button size="xs" tone="copper" onClick={() => void execute()}>
                        switch anyway
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmBusy(false)}>
                        cancel
                      </Button>
                    </div>
                  </div>
                )}

                {branchError !== null && <p className="mt-2 text-[11px] leading-snug text-rose">{branchError}</p>}
              </fieldset>
            )}

            <fieldset className="mt-5 border-t border-line pt-4">
              <legend className="text-[11px] font-medium text-ink">Magic keywords</legend>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
                Armed words lead the implementation prompt, in this order — omp appends each one's hidden notice.
              </p>
              <div className="mt-3 space-y-3">
                {KEYWORD_ROWS.map(({ keyword, hint }) => {
                  const armed =
                    keyword === "ultrathink" ? ultrathink : keyword === "orchestrate" ? orchestrate : workflowz;
                  const setArmed =
                    keyword === "ultrathink" ? setUltrathink : keyword === "orchestrate" ? setOrchestrate : setWorkflowz;
                  return (
                    <div key={keyword} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <KeywordLabel keyword={keyword} />
                        <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">{hint}</span>
                      </div>
                      <Switch on={armed} onChange={setArmed} label={`${keyword} the implementation`} />
                    </div>
                  );
                })}
              </div>
            </fieldset>

            {advisorConfigured && (
              <div className="mt-5 flex items-start justify-between gap-3 border-t border-line pt-4">
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-ink">Address advisor concerns</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">
                    Fold the advisor's plan review into the implementation prompt.
                  </span>
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
              <div className="min-w-0 flex-1">
                <Label>ready to dispatch</Label>
                <p className="mt-0.5 truncate text-[11px] text-ink-dim">
                  {CONTEXTS.find((c) => c.id === context)?.label}
                  {stagedModel !== null && <>{" · "}{stagedModel.name || stagedModel.id}</>}
                  {ultrathink && " · ultrathink"}
                  {orchestrate && " · orchestrate"}
                  {workflowz && " · workflowz"}
                </p>
              </div>
            )}
            <div className="plan-review-action-buttons ml-auto flex shrink-0 items-center gap-2">
              {compactStep === "review" ? (
                <>
                  <Button title="Leave the plan pending — the agent stays paused until you answer here" variant="ghost" onClick={dismiss}>
                    not now
                  </Button>
                  <Button onClick={() => setCompactStep("refine")}>refine</Button>
                  <Button variant="solid" tone="signal" onClick={() => setCompactStep("setup")}>
                    execute…
                  </Button>
                </>
              ) : compactStep === "refine" ? (
                <>
                  <Button variant="ghost" onClick={() => setCompactStep("review")}>back to plan</Button>
                  <Button variant="solid" tone="signal" onClick={() => void refine()}>send changes</Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => setCompactStep("review")}>back to plan</Button>
                  <Button
                    variant="solid"
                    tone="signal"
                    disabled={checkingOut || branchInvalid}
                    onClick={() => void execute()}
                  >
                    {checkingOut ? "switching branch…" : `execute in ${CONTEXTS.find((c) => c.id === context)?.label}`}
                  </Button>
                </>
              )}
            </div>
          </footer>
        ) : (
          <footer className="plan-review-actions flex shrink-0 items-center justify-between gap-4 border-t border-line bg-overlay px-5 py-3">
            <div className="min-w-0">
              <Label>ready to dispatch</Label>
              <p className="mt-0.5 truncate text-[11px] text-ink-dim">
                {CONTEXTS.find((c) => c.id === context)?.label}
                {stagedModel !== null && <>{" · "}{stagedModel.name || stagedModel.id}</>}
                {ultrathink && " · ultrathink"}
                {orchestrate && " · orchestrate"}
                {workflowz && " · workflowz"}
                {isRepo && <> {" · "}{branchChoice === "current" ? (branchInfo!.current ?? "detached HEAD") : branchChoice === "new" ? (newName.trim() || "new branch") : (existingName ?? "choose a branch")}</>}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button title="Leave the plan pending — the agent stays paused until you answer here" variant="ghost" onClick={dismiss}>not now</Button>
              <Button onClick={() => void refine()}>refine</Button>
              <Button variant="solid" tone="signal" disabled={checkingOut || branchInvalid} onClick={() => void execute()}>
                {checkingOut ? "switching branch…" : `execute in ${CONTEXTS.find((c) => c.id === context)?.label}`}
              </Button>
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
    {pickingAdvisorModel && (
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
