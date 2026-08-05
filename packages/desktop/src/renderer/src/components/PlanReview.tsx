import { useEffect, useState, type KeyboardEvent } from "react";
import type { ImageAttachment } from "@omp-ui/core/types";
import { branchNameFromPlanPath } from "../lib/branch-name";
import { cn } from "../lib/cn";
import { hasClipboardImage, readClipboardImages } from "../lib/clipboard-image";
import type { PlanExecutionContext } from "../lib/plan-concerns";
import { findRecord, useStore } from "../store";
import { Markdown } from "./Markdown";
import { Button, CopyButton, IconButton, Label, Modal, Switch } from "./ui";

/**
 * The plan approval gate. omp's agent is *blocked* inside its `xd://propose`
 * call while this is open: execute lands a verdict and lets the renderer
 * dispatch the implementation into a chosen context (same session, same
 * session after compacting, or a fresh session), while refine sends the agent
 * back to revise the draft. "Not now" — Escape, scrim-click, or the button —
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

export function PlanReview({ tabId }: { tabId: string }) {
  const review = useStore((s) => s.rpc[tabId]?.planReview);
  const planText = useStore((s) => s.rpc[tabId]?.planText);
  const advisorConfigured = useStore((s) => s.rpc[tabId]?.advisorStats?.configured === true);
  const executePlan = useStore((s) => s.executePlan);
  const refinePlan = useStore((s) => s.refinePlan);
  const deferPlanReview = useStore((s) => s.deferPlanReview);
  /** True after "not now": the pane is dismissed but the gate is unanswered. */
  const deferred = useStore((s) => s.rpc[tabId]?.planDeferred === true);

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
  // A session mid-turn on this project (other than this gate-blocked tab): a
  // plain checkout would move the working tree out from under it.
  const busyTitle = useStore((s) => {
    const other = s.tabs.find(
      (t) =>
        t.tabId !== tabId && t.projectCwd === projectCwd && s.rpc[t.tabId]?.status === "running",
    );
    return other ? (findRecord(s.state, other.tabId)?.title ?? "a session") : null;
  });

  const [branchChoice, setBranchChoice] = useState<"current" | "new" | "existing">("current");
  const [newName, setNewName] = useState("");
  const [existingName, setExistingName] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);

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
    const planContext = `${planTitle ?? planFilePath}\n\n${planText.slice(0, 2000)}`;
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

  const refine = () => {
    const notes = { text: changes, images: images.length ? images : undefined };
    refinePlan(tabId, changes.trim() !== "" || images.length > 0 ? notes : undefined);
  };
  // Escape/scrim: defer, matching "not now" — never answer the gate with notes
  // the user did not finish writing. The plan stays pending in the plans tab.
  const dismiss = () => deferPlanReview(tabId);

  const branchInvalid =
    isRepo &&
    ((branchChoice === "new" && newName.trim() === "") ||
      (branchChoice === "existing" && existingName === null));

  const execute = async (): Promise<void> => {
    if (!isRepo || branchChoice === "current") {
      executePlan(tabId, context, addressAdvisor);
      return;
    }
    const name = branchChoice === "new" ? newName.trim() : existingName;
    if (name === null || name === "") return; // unreachable — the button is disabled
    if (branchChoice === "existing" && name === branchInfo!.current) {
      executePlan(tabId, context, addressAdvisor);
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
    executePlan(tabId, context, addressAdvisor);
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!hasClipboardImage(e.clipboardData)) return;
    e.preventDefault();
    const { images: pasted, rejected } = await readClipboardImages(e.clipboardData);
    if (pasted.length > 0) setImages((prev) => [...prev, ...pasted]);
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
    <Modal onClose={dismiss} width="w-[68rem]">
      <div className="plan-review flex max-h-[80vh] flex-col">
        <header className="plan-review-header flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <Label>plan ready</Label>
            <h2 className="mt-1 truncate font-display text-base font-medium text-ink" title={request.title}>
              {request.title}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
              {request.planFilePath}
            </p>
          </div>
          {planText && <CopyButton text={planText} label="copy plan" />}
        </header>

        <div className="plan-review-layout grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_21rem] overflow-hidden">
          <section className="plan-review-document min-h-0 overflow-y-auto px-5 py-4" aria-label="proposed plan">
            {planText ? (
              <Markdown text={planText} />
            ) : (
              <p className="text-sm text-ink-dim">
                The plan file could not be read. Execute only if you know what it contains —
                otherwise refine and let the agent rewrite it.
              </p>
            )}

            <div className="mt-6 border-t border-line pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <Label>send it back</Label>
                  <p className="mt-1 text-xs text-ink-dim">Describe what the planner should revise.</p>
                </div>
                <span className="shrink-0 text-[10px] text-ink-faint">Enter to refine · Shift+Enter for a line break</span>
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
                            <svg viewBox="0 0 16 16" fill="none" strokeWidth={2} className="size-2.5">
                              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
                            </svg>
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
                  placeholder="What should change before implementation? Paste an image to attach it."
                  spellCheck={false}
                  onChange={(e) => setChanges(e.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={(e) => void onPaste(e)}
                  className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
                />
              </div>
              {pasteError && <p className="mt-1 text-[11px] text-rose">{pasteError}</p>}
            </div>
          </section>

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
        </div>

        <footer className="plan-review-actions flex shrink-0 items-center justify-between gap-4 border-t border-line bg-overlay px-5 py-3">
          <div className="min-w-0">
            <Label>ready to dispatch</Label>
            <p className="mt-0.5 truncate text-[11px] text-ink-dim">
              {CONTEXTS.find((c) => c.id === context)?.label}
              {isRepo && (
                <>
                  {" · "}
                  {branchChoice === "current"
                    ? (branchInfo!.current ?? "detached HEAD")
                    : branchChoice === "new"
                      ? (newName.trim() || "new branch")
                      : (existingName ?? "choose a branch")}
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              title="Leave the plan pending — the agent stays paused until you answer here"
              variant="ghost"
              onClick={() => deferPlanReview(tabId)}
            >
              not now
            </Button>
            <Button onClick={refine}>refine</Button>
            <Button
              variant="solid"
              tone="signal"
              disabled={checkingOut || branchInvalid}
              onClick={() => void execute()}
            >
              {checkingOut ? "switching branch…" : `execute in ${CONTEXTS.find((c) => c.id === context)?.label}`}
            </Button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
