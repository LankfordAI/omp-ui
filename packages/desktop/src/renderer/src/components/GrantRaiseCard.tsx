import { useEffect, useRef, useState } from "react";
import { useAndroidBack } from "../lib/android-back";
import { findRecord, useStore } from "../store";
import { Button, Label } from "./ui";
import { RUNG_LABEL } from "./settings/RemoteInstancesPage";

/**
 * The grant raise card (#1393): an agent asked a joined fleet member for a
 * higher access rung. Main holds the agent's tool call until this card
 * answers; the user types THAT member's join secret into the card, and the
 * secret rides once to the member — never stored, never shown to the agent.
 * The card reads the request from the session summary, so every client sees
 * it and the first answer wins. Two cards of different kinds may be open on
 * one tab; each gate settles independently.
 */
export function GrantRaiseCard({ tabId }: { tabId: string }) {
  const request = useStore((s) => findRecord(s.state, tabId)?.grantRaiseRequest ?? null);
  const answerGrantRaise = useStore((s) => s.answerGrantRaise);
  const promptId = request?.promptId ?? null;
  // Local state belongs to one request: a new promptId starts clean, and the
  // secret is never prefilled.
  const [secret, setSecret] = useState<{ promptId: string; value: string } | null>(null);
  const [failure, setFailure] = useState<{ promptId: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useAndroidBack({ open: request !== null, refs: root, kind: "blocker", onBack: "block" });

  const value = secret !== null && secret.promptId === promptId ? secret.value : "";
  const reason = failure !== null && failure.promptId === promptId ? failure.reason : null;

  const answer = async (decision: "allow" | "deny"): Promise<void> => {
    if (promptId === null) return;
    setBusy(true);
    try {
      const result = await answerGrantRaise(tabId, promptId, decision, decision === "allow" ? value : null);
      if (!result.ok) setFailure({ promptId, reason: result.reason });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (promptId === null) return;
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
        void answerGrantRaise(tabId, promptId, "deny", null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promptId, tabId, answerGrantRaise]);

  if (request === null) return null;
  const title = `Fleet access: ${request.machine}`;
  const current = request.currentRung === null ? null : RUNG_LABEL[request.currentRung];
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      data-grant-raise-card
      className="animate-rise pointer-events-auto mx-auto mb-2 w-full max-w-[var(--transcript-max)] rounded-md border border-line ambient glass-surface shadow-float"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <Label>{title}</Label>
      </div>
      <div className="space-y-1 px-4 pt-2 text-xs leading-snug text-ink-mid">
        <p className="text-ink-faint">Requested by the agent in this session.</p>
        <p data-selectable className="font-mono text-ink">
          Access: {current === null ? "unknown" : current} → {RUNG_LABEL[request.rung]}
        </p>
        <p>
          Type that member's join password or access token below; it rides once to the member and is
          never stored or shown to the agent.
        </p>
        <input
          data-grant-raise-secret
          data-selectable
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Member password or access token"
          value={value}
          disabled={busy}
          onChange={(e) => setSecret({ promptId: request.promptId, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim() !== "" && !busy) void answer("allow");
          }}
          className="w-full rounded-sm border border-line bg-surface px-2 py-1.5 font-mono text-ink outline-none focus:border-ink-mid"
        />
        {reason !== null && (
          <p role="alert" className="text-rose">
            {reason}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-4 pb-3 pt-3">
        <Button variant="ghost" disabled={busy} onClick={() => void answer("deny")}>
          Don't grant
        </Button>
        <Button variant="solid" tone="signal" disabled={busy || value.trim() === ""} onClick={() => void answer("allow")}>
          Grant
        </Button>
      </div>
    </div>
  );
}
