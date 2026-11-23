import { useEffect, useId, useRef, useState } from "react";
import { PLAN_TRANSCRIPT_COMMAND, type TranscriptPlanSelection } from "@omp-ui/core/plan";
import { type TranscriptPlanCandidate } from "../lib/transcript-plan-source";
import { findInstance, findOwner, useStore } from "../store";
import { peekTabRuntime } from "../store/slices/shared";
import { transcriptPlanReviewMatches, transcriptPlanSourceGeneration, transcriptPlanStatus, transcriptPlanUnavailable } from "../store/slices/plan-execution";
import { Button, Modal } from "./ui";

/** Local inspection only. The host owns the saved copy, diagnostics, and review gate. */
export function TranscriptPlanPicker({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const titleId = useId();
  const sourceId = useId();
  const titleInputId = useId();
  const radioName = useId();
  const tab = useStore((state) => state.rpc[tabId]);
  const owner = useStore((state) => findOwner(state.state, tabId));
  const loadSources = useStore((state) => state.loadTranscriptPlanSources);
  const refreshStatus = useStore((state) => state.refreshTranscriptPlanStatus);
  const adopt = useStore((state) => state.adoptTranscriptPlan);
  const unavailable = useStore((state) => transcriptPlanUnavailable(state, tabId));
  const runtime = peekTabRuntime(tabId);
  const advertised = tab?.commands.some((command) => command.name === PLAN_TRANSCRIPT_COMMAND) ?? false;
  const sessionId = tab?.session.sessionId;
  const instanceId = owner?.instanceId;
  const launchedAt = owner?.record.launchedAt;
  const lineageDir = owner?.record.lineageDir;
  const live = owner?.record.live;
  const generation = useRef(0);
  const [sources, setSources] = useState<{ sessionId: string; candidates: TranscriptPlanCandidate[] } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState(() => "Plan from transcript");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const currentSource = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    const sequence = ++generation.current;
    setSources(null);
    setSelected(null);
    setError(null);
    setLoading(true);
    setSubmitting(false);
    setRequestId(null);
    inFlight.current = false;
    const refresh = refreshStatus(tabId);
    const wantedRuntime = peekTabRuntime(tabId);
    let wantedGeneration = transcriptPlanSourceGeneration(tabId);
    const current = () => {
      const state = useStore.getState();
      const now = findOwner(state.state, tabId);
      return generation.current === sequence && peekTabRuntime(tabId) === wantedRuntime &&
        state.exited[tabId] === undefined && state.rpc[tabId]?.session.sessionId === sessionId &&
        now !== undefined && now.instanceId === instanceId && now.record.sessionId === sessionId &&
        now.record.launchedAt === launchedAt && now.record.lineageDir === lineageDir &&
        now.record.live === "live" && transcriptPlanSourceGeneration(tabId) === wantedGeneration &&
        (instanceId === null || (instanceId !== undefined && findInstance(state.state, instanceId)?.status === "joined"));
    };
    currentSource.current = current;
    void (async () => {
      try {
        await refresh;
        if (!current()) return;
        const pending = loadSources(tabId);
        wantedGeneration = transcriptPlanSourceGeneration(tabId);
        const result = await pending;
        if (!current()) return;
        if (result === null) {
          setError("The session or source changed. Close this picker and load the transcript again.");
          return;
        }
        // Preserve every occurrence. The final branch entry is shown first.
        setSources({ ...result, candidates: [...result.candidates].reverse() });
      } catch (error) {
        if (current()) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => {
      ++generation.current;
      currentSource.current = null;
    };
  }, [tabId, sessionId, instanceId, launchedAt, lineageDir, live, advertised, runtime, refreshStatus, loadSources]);

  const receipt = transcriptPlanStatus(useStore.getState(), tabId)?.result;
  useEffect(() => {
    if (!requestId || receipt?.requestId !== requestId || receipt.sessionId !== sources?.sessionId) return;
    if (receipt.status === "failed") {
      inFlight.current = false;
      setSubmitting(false);
      setError(receipt.message);
    } else if (receipt.status === "settled") {
      inFlight.current = false;
      setSubmitting(false);
    }
    // A captured receipt is not a gate. Do not dismiss for another client's review.
    if (transcriptPlanReviewMatches(useStore.getState(), tabId, requestId) && currentSource.current?.()) {
      ++generation.current;
      onClose();
    }
  }, [receipt, requestId, sources?.sessionId, tab?.planReview, onClose]);

  const sourceIsCurrent = currentSource.current?.() ?? true;
  const candidate = sourceIsCurrent && selected !== null ? sources?.candidates[selected] ?? null : null;
  const validTitle = title.trim().length > 0 && title.trim().length <= 200 && !/[\r\n\u2028\u2029]/.test(title);
  const close = () => {
    ++generation.current;
    onClose();
  };
  const submit = async () => {
    if (inFlight.current || candidate === null || sources === null || !validTitle) return;
    if (!currentSource.current?.()) {
      setError("The session or source changed. Close this picker and load the transcript again.");
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const sequence = generation.current;
    try {
      if (!globalThis.crypto?.subtle) throw new Error("Could not hash the source securely. No import was sent.");
      const encoder = new TextEncoder();
      const hashes = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(candidate.text)),
        crypto.subtle.digest("SHA-256", encoder.encode(candidate.text.slice(candidate.start, candidate.end))),
      ]);
      if (sequence !== generation.current || !currentSource.current?.()) return;
      const reason = transcriptPlanUnavailable(useStore.getState(), tabId);
      if (reason !== null) throw new Error(reason);
      const [contentHash, sourceHash] = hashes.map((hash) =>
        Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""));
      const selection: TranscriptPlanSelection = {
        version: 1,
        requestId: crypto.randomUUID(),
        sessionId: sources.sessionId,
        entryId: candidate.entryId,
        contentIndex: candidate.contentIndex,
        start: candidate.start,
        end: candidate.end,
        contentHash: contentHash!,
        sourceHash: sourceHash!,
        title: title.trim(),
      };
      setRequestId(selection.requestId);
      await adopt(tabId, selection);
      if (sequence !== generation.current || !currentSource.current?.()) return;
    } catch (error) {
      if (sequence !== generation.current || !currentSource.current?.()) return;
      inFlight.current = false;
      setSubmitting(false);
      setError(error instanceof Error ? error.message : "Could not hash the source securely. No import was sent.");
    }
  };

  return (
    <Modal labelledBy={titleId} onClose={close} width="w-[56rem]" className="flex h-[min(44rem,80dvh)] min-h-0 flex-col">
      <header className="shrink-0 border-b border-line px-4 py-3.5 pr-12">
        <h2 id={titleId} className="text-base font-semibold text-ink">Review HTML from the transcript</h2>
        <p className="mt-1 text-xs text-ink-muted">Choose the exact source to copy into a plan file. Validation and review do not approve or execute the plan.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {!sourceIsCurrent ? <p role="alert" className="text-sm text-rose">The session or source changed. Close this picker and load the transcript again.</p> : loading ? <p role="status" className="text-sm text-ink-muted">Reading original transcript entries…</p> : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <fieldset className="min-w-0" disabled={submitting}>
              <legend className="mb-2 text-xs font-semibold text-ink-muted">Original sources</legend>
              <div className="max-h-48 space-y-2 overflow-y-auto overscroll-contain sm:max-h-[26rem]">
                {sources?.candidates.length === 0 && <p className="text-sm text-ink-muted">No complete HTML documents on this transcript branch.</p>}
                {sources?.candidates.map((source, index) => (
                  <label key={`${source.entryId}:${source.contentIndex}:${source.start}:${source.end}`} className="flex cursor-pointer items-start gap-2 rounded-md border border-line bg-sunken p-2 text-xs has-[:checked]:border-copper">
                    <input type="radio" name={radioName} checked={selected === index} onChange={() => setSelected(index)} className="mt-0.5 shrink-0 accent-copper" />
                    <span className="min-w-0 break-words">
                      <span className="block font-medium text-ink">{source.role === "user" ? "User" : "Assistant"}</span>
                      <time className="block text-ink-muted">{source.timestamp}</time>
                      <span className="block break-all font-mono text-ink-faint">{source.entryId}</span>
                      <span className="block text-ink-muted">{source.contentIndex === null ? "message text" : `text part ${source.contentIndex}`}</span>
                      <span className="block text-ink-muted">{source.start === 0 && source.end === source.text.length ? "whole document" : `UTF-16 range ${source.start}–${source.end}`}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor={sourceId} className="text-xs font-semibold text-ink-muted">Exact HTML source</label>
              <textarea id={sourceId} readOnly wrap="soft" spellCheck={false} value={candidate?.text.slice(candidate.start, candidate.end) ?? ""} placeholder="Select a source to inspect its exact HTML." className="h-56 min-h-40 w-full resize-none overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-xs text-ink [overflow-wrap:anywhere] sm:h-80" />
              <label htmlFor={titleInputId} className="mt-1 text-xs font-semibold text-ink-muted">Plan title</label>
              <input id={titleInputId} type="text" maxLength={200} value={title} disabled={submitting} onChange={(event) => setTitle(event.target.value)} aria-invalid={!validTitle} className="min-w-0 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink" />
              {!validTitle && <p className="text-xs text-rose">Enter a nonempty, single-line title of at most 200 characters.</p>}
            </div>
          </div>
        )}
        {sourceIsCurrent && (error || (!submitting && unavailable)) && <p role="alert" className="mt-3 break-words text-xs text-rose">{error ?? unavailable}</p>}
        {sourceIsCurrent && submitting && <p role="status" className="mt-3 text-xs text-ink-muted">{receipt?.requestId === requestId && receipt.status === "captured" ? "Saved a copy. Waiting for its validated review." : "Copying and validating…"}</p>}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,var(--safe-bottom))]">
        <Button onClick={close}>Cancel</Button>
        <Button disabled={loading || submitting || candidate === null || !validTitle || unavailable !== null} onClick={() => void submit()}>Review as plan</Button>
      </footer>
    </Modal>
  );
}
