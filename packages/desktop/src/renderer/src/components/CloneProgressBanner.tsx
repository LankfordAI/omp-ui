import { findRecord, useStore } from "../store";

/**
 * Live git progress while this session's project request is cloning (#1395).
 * The card is already answered, so this is the user's only window into the
 * transfer; it disappears with the summary field when the clone settles.
 */
export function CloneProgressBanner({ tabId }: { tabId: string }) {
  const line = useStore((s) => findRecord(s.state, tabId)?.cloneProgress ?? null);
  if (line === null) return null;
  return (
    <div
      data-clone-progress
      className="animate-rise pointer-events-auto mx-auto mb-2 w-full max-w-[var(--transcript-max)] rounded-md border border-line ambient glass-surface px-4 py-2 text-xs"
    >
      <p className="text-ink-faint">Cloning project…</p>
      <p data-selectable className="min-w-0 break-all font-mono text-ink">
        {line}
      </p>
    </div>
  );
}
