import { useEffect } from "react";
import type { ApprovalPrompt } from "@omp-ui/core/approval";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { Button, Chip, Label } from "./ui";

/**
 * The approval card (issue #681, ADR-0038): the dedicated answer surface for
 * omp's tool-approval select — an `Allow tool: <name>` frame whose options are
 * exactly Approve/Deny, routed here by the frame reducer instead of the
 * generic dialog queue. The agent is *blocked* on the reply: the runner
 * compares only against `"Approve"`, and a dropped dialog must read as a
 * refusal, never a silent approval — Escape and Deny both answer `"Deny"`,
 * which lands the clean "denied by user" transcript path.
 *
 * Non-modal by design, mounted in the floating dialog stack above the
 * composer: the transcript keeps streaming around it while the single tool
 * call waits.
 */
export function ApprovalCard({ tabId }: { tabId: string }) {
  const t = useT();
  const held = useStore((s) => s.rpc[tabId]?.approvalPrompt ?? null);
  const answerApprovalPrompt = useStore((s) => s.answerApprovalPrompt);
  const prompt: ApprovalPrompt | null = held?.prompt ?? null;

  useEffect(() => {
    if (prompt === null) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      // The composer keeps Escape while the user is typing, like the
      // extension dialog's text-field rule.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        answerApprovalPrompt(tabId, "Deny");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, tabId, answerApprovalPrompt]);

  if (prompt === null) return null;
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t("dialog.approval.title")}
      data-approval-card
      className="animate-rise pointer-events-auto mx-auto mb-2 w-full max-w-[var(--transcript-max)] rounded-xl border border-line ambient glass-surface shadow-float"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <Label>{t("dialog.approval.title")}</Label>
        <span className="min-w-0 truncate font-mono text-xs text-ink" title={prompt.toolName}>
          {prompt.toolName}
        </span>
        {prompt.origin === "mcp" && <Chip tone="iris">{t("dialog.approval.origin")}</Chip>}
      </div>
      <div className="px-4 pt-2">
        {prompt.reason !== null && (
          <p className="text-[11px] leading-snug text-ink-mid">
            <span className="text-ink-faint">{t("dialog.approval.reason")}: </span>
            <span data-selectable>{prompt.reason}</span>
          </p>
        )}
        {prompt.details.length > 0 && (
          <pre
            data-selectable
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line-soft bg-sunken px-2.5 py-2 font-mono text-[12px] leading-[1.55] text-ink"
          >
            {prompt.details.join("\n")}
          </pre>
        )}
        {prompt.providerSafety.length > 0 && (
          <div className="mt-2">
            <Label>{t("dialog.approval.safety")}</Label>
            <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-ink-mid">
              {prompt.providerSafety.map((line, i) => (
                <li key={i} data-selectable>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-4 pb-3 pt-3">
        <Button variant="ghost" onClick={() => answerApprovalPrompt(tabId, "Deny")}>
          {t("dialog.approval.deny")}
        </Button>
        <Button variant="solid" tone="signal" onClick={() => answerApprovalPrompt(tabId, "Approve")}>
          {t("dialog.approval.allow")}
        </Button>
      </div>
    </div>
  );
}
