import { useEffect, useRef, useState } from "react";
import { useAndroidBack } from "../lib/android-back";
import { findOwner, findRecord, useStore } from "../store";
import { DirectoryPicker } from "./DirectoryPicker";
import { Button, Label } from "./ui";

/**
 * The project request card (#1228, ADR-0099): an agent asked omp-ui to
 * register an existing checkout, or clone a repository, on the session's
 * host. Main holds the agent's tool call until this card answers; only Allow
 * adds the project. The card reads the request from the session summary, so
 * every client sees it and the first answer wins. For a clone the user may
 * pick where to save it; main re-checks the destination after the answer.
 */
export function ProjectRequestCard({ tabId }: { tabId: string }) {
  const request = useStore((s) => findRecord(s.state, tabId)?.projectRequest ?? null);
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const answerProjectRequest = useStore((s) => s.answerProjectRequest);
  const promptId = request?.promptId ?? null;
  // Local state belongs to one request: a new promptId starts clean.
  const [picked, setPicked] = useState<{ promptId: string; parent: string } | null>(null);
  const [failure, setFailure] = useState<{ promptId: string; reason: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useAndroidBack({ open: request !== null, refs: root, kind: "blocker", onBack: "block" });

  const parent = picked !== null && picked.promptId === promptId ? picked.parent : null;
  const reason = failure !== null && failure.promptId === promptId ? failure.reason : null;

  const answer = async (decision: "allow" | "deny"): Promise<void> => {
    if (promptId === null) return;
    setBusy(true);
    try {
      const result = await answerProjectRequest(tabId, promptId, decision, decision === "allow" ? parent : null);
      if (!result.ok) setFailure({ promptId, reason: result.reason });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (promptId === null || picking) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      // The composer keeps Escape while the user is typing (ApprovalCard's rule).
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        void answerProjectRequest(tabId, promptId, "deny", null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promptId, picking, tabId, answerProjectRequest]);

  if (request === null) return null;
  const clone = request.verb === "clone";
  const destination = clone ? `${(parent ?? request.defaultParent ?? "").replace(/\/+$/, "")}/${request.name ?? ""}` : null;
  const title = clone ? "Clone and add project" : "Add project";
  return (
    <>
      <div
        ref={root}
        role="dialog"
        aria-modal="false"
        aria-label={title}
        data-project-request-card
        className="animate-rise pointer-events-auto mx-auto mb-2 w-full max-w-[var(--transcript-max)] rounded-md border border-line ambient glass-surface shadow-float"
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          <Label>{title}</Label>
        </div>
        <div className="space-y-1 px-4 pt-2 text-xs leading-snug text-ink-mid">
          <p className="text-ink-faint">Requested by the agent in this session.</p>
          {clone ? (
            <>
              <p data-selectable className="break-all font-mono text-ink">
                {`Repository: ${request.source}`}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <p data-selectable data-project-request-destination className="min-w-0 break-all font-mono text-ink">
                  {`Save to: ${destination ?? ""}`}
                </p>
                <Button variant="outline" disabled={busy} onClick={() => setPicking(true)}>
                  Choose folder…
                </Button>
              </div>
            </>
          ) : (
            <>
              <p data-selectable className="break-all font-mono text-ink">
                {`Folder: ${request.source}`}
              </p>
              <p data-selectable className="break-all font-mono">
                {request.origin === null
                  ? "Origin: none"
                  : `Origin: ${request.origin}`}
              </p>
            </>
          )}
          <p className="text-copper">Sessions started in this project run its .omp extensions, hooks, tools, and MCP servers with your user account and your provider keys.</p>
          {request.executableConfig.length > 0 && (
            <p data-selectable data-project-request-found className="font-mono">
              {`Found: ${request.executableConfig.join(", ")}`}
            </p>
          )}
          {reason !== null && (
            <p role="alert" className="text-rose">
              {reason}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 pb-3 pt-3">
          <Button variant="ghost" disabled={busy} onClick={() => void answer("deny")}>
            Deny
          </Button>
          <Button variant="solid" tone="signal" disabled={busy} onClick={() => void answer("allow")}>
            Allow
          </Button>
        </div>
      </div>
      {picking && promptId !== null && (
        <DirectoryPicker
          mode="clone-parent"
          instanceId={instanceId}
          banner={null}
          onClose={() => setPicking(false)}
          onSubmit={async (path) => {
            setPicked({ promptId, parent: path });
            setPicking(false);
          }}
        />
      )}
    </>
  );
}
