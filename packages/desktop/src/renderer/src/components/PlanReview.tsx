import { useState, type KeyboardEvent } from "react";
import type { ImageAttachment } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { hasClipboardImage, readClipboardImages } from "../lib/clipboard-image";
import type { PlanExecutionContext } from "../lib/plan-concerns";
import { useStore } from "../store";
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

  if (!review || deferred) return null;
  const { request } = review;

  const refine = () => {
    const notes = { text: changes, images: images.length ? images : undefined };
    refinePlan(tabId, changes.trim() !== "" || images.length > 0 ? notes : undefined);
  };
  // Escape/scrim: defer, matching "not now" — never answer the gate with notes
  // the user did not finish writing. The plan stays pending in the plans tab.
  const dismiss = () => deferPlanReview(tabId);
  const execute = () => executePlan(tabId, context, addressAdvisor);

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
    <Modal onClose={dismiss} width="w-[56rem]">
      <div className="flex max-h-[80vh] flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <Label>plan review</Label>
            <h2 className="mt-1 truncate text-sm text-ink" title={request.title}>
              {request.title}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
              {request.planFilePath}
            </p>
          </div>
          {planText && <CopyButton text={planText} label="copy plan" />}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {planText ? (
            <Markdown text={planText} />
          ) : (
            <p className="text-sm text-ink-dim">
              The plan file could not be read. Execute only if you know what it contains —
              otherwise refine and let the agent rewrite it.
            </p>
          )}

          <fieldset className="mt-4 border-t border-line pt-3">
            <legend className="sr-only">Where to run the implementation</legend>
            <Label>execute where</Label>
            <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              {CONTEXTS.map((option) => {
                const active = context === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setContext(option.id)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-line-strong bg-hover"
                        : "border-line bg-transparent hover:border-line-strong",
                    )}
                  >
                    <span className="block text-xs font-medium text-ink">{option.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                      {option.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-4">
            <div className="flex items-baseline justify-between">
              <Label>request changes</Label>
              <span className="text-[10px] text-ink-faint">refined back to the planner</span>
            </div>
            <div className="mt-1.5 rounded-lg border border-line bg-raised focus-within:border-line-strong">
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
                rows={2}
                value={changes}
                placeholder="Optional: changes to make to the plan before it's finalized…  (paste an image to attach it)"
                spellCheck={false}
                onChange={(e) => setChanges(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={(e) => void onPaste(e)}
                className="block w-full resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
              />
            </div>
            {pasteError && <p className="mt-1 text-[11px] text-rose">{pasteError}</p>}
          </div>
        </div>

        {advisorConfigured && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-4 py-3">
            <div className="min-w-0">
              <span className="block text-[11px] font-medium text-ink">address advisor concerns</span>
              <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">
                The advisor reviews the plan after you answer; on execute its concerns ride the
                implementation prompt. Refine stays immediate — the planner revises here.
              </span>
            </div>
            <Switch
              on={addressAdvisor}
              onChange={setAddressAdvisor}
              label="address advisor concerns in the implementation prompt"
            />
          </div>
        )}

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="text-[11px] text-ink-faint">
            The agent is waiting. Executing restores write access and starts implementation;
            "not now" leaves the plan pending in the plans tab.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              title="Leave the plan pending — the agent stays paused until you answer here"
              onClick={() => deferPlanReview(tabId)}
            >
              not now
            </Button>
            <Button onClick={refine}>refine</Button>
            <Button variant="solid" tone="signal" onClick={execute}>
              execute in {CONTEXTS.find((c) => c.id === context)?.label}
            </Button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
