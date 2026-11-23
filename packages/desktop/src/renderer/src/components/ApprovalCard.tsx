import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalDetailLine, ApprovalPrompt } from "@omp-ui/core/approval";
import { classifyApprovalDetails } from "@omp-ui/core/approval";
import { routineToolKeyFromApprovalName } from "@omp-ui/core/routine";
import { useAndroidBack } from "../lib/android-back";
import { findRecord, useStore } from "../store";
import { Button, Chip, Label, Switch } from "./ui";

/**
 * Paint one classified detail block. When no compound-bash segment rows are
 * present the whole block stays a single text node joined by `\n` —
 * byte-identical to the old verbatim `details.join("\n")`, so a prompt
 * without the markers renders exactly as before. Otherwise every line gets
 * its own row and segment rows split into colored pieces like the omp TUI:
 * signal on `✓` with a dim command, copper on `?` with an emphasized command
 * and reason (issue #1208).
 */
function renderDetailLines(lines: readonly ApprovalDetailLine[]): ReactNode {
  if (!lines.some((entry) => entry.kind !== "plain")) {
    return lines.map((entry) => entry.line).join("\n");
  }
  return lines.map((entry, index) => {
    if (entry.kind === "plain") {
      return <div key={index}>{entry.line}</div>;
    }
    const allowed = entry.kind === "allowed-segment";
    return (
      <div key={index} data-approval-segment={allowed ? "allowed" : "prompted"}>
        <span className={allowed ? "text-signal" : "text-copper"}>{entry.marker}</span>
        {entry.gap}
        <span className={allowed ? "text-ink-dim" : "font-semibold text-ink"}>{entry.command}</span>
        <span className={allowed ? undefined : "text-copper"}>{entry.suffix}</span>
      </div>
    );
  });
}

/**
 * The approval card (issue #681, ADR-0038): the dedicated answer surface for
 * omp's tool-approval select — an `Allow tool: <name>` frame whose options are
 * Approve/Deny, or on omp ≥ 18.11.3 Approve / Approve <subject> for this
 * session / Deny (issue #883), routed here by the frame reducer instead of the
 * generic dialog queue. Under Ask and remember (`always-ask-cached`, issue
 * #950) the frame also offers grant choices — remember a folder and/or a file,
 * for this session or, with the "in every session" switch on, for every
 * session — shown verbatim above Allow once (omp's `Approve Once`). The agent
 * is *blocked* on the reply: omp maps the answered label exactly and a
 * non-matching reply is a denial — a dropped dialog must read as refusal,
 * never a silent approval. Escape and Deny both answer "deny", which lands the
 * clean "denied by user" transcript path. A restricted-folder prompt (issue
 * #951) shows the folder and the "asks in every mode" note in place of the
 * generic reason.
 *
 * Non-modal by design, mounted in the floating dialog stack above the
 * composer: the transcript keeps streaming around it while the single tool
 * call waits.
 */
export function ApprovalCard({ tabId }: { tabId: string }) {
  const held = useStore((s) => s.rpc[tabId]?.approvalPrompt ?? null);
  const answerApprovalPrompt = useStore((s) => s.answerApprovalPrompt);
  // A Routine run's card answers once only (ADR-0100, #1252): granting a
  // session-wide approval would widen its compiled tool policy for the rest
  // of an unattended run, so the session option never renders there. In
  // place of it, Always allow (#1276) answers once and appends the tool to
  // the routine's toolPolicy.allow so future fires never prompt again —
  // only the definition changes, never this run's fire-time overlay.
  const routine = useStore((s) => findRecord(s.state, tabId)?.routine ?? null);
  const grantRoutineTool = useStore((s) => s.grantRoutineTool);
  const reportError = useStore((s) => s.reportError);
  const prompt: ApprovalPrompt | null = held?.prompt ?? null;
  // The switch belongs to one held frame: a new approval starts un-remembered
  // without an effect, because the held frame object is stable per hold.
  const [alwaysFrame, setAlwaysFrame] = useState<unknown>(null);
  const root = useRef<HTMLDivElement>(null);
  useAndroidBack({ open: prompt !== null, refs: root, kind: "blocker", onBack: "block" });

  // When a compound approval's detail list overflows, bring the first `?` row
  // into view (issue #1208): everything above it is already allowed.
  useEffect(() => {
    if (prompt === null) return;
    const row = root.current?.querySelector<HTMLElement>('[data-approval-segment="prompted"]');
    if (row !== undefined && row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [prompt]);

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
        answerApprovalPrompt(tabId, "deny");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, tabId, answerApprovalPrompt]);

  if (prompt === null) return null;
  const always = alwaysFrame === held!.frame;
  const hasGrants = prompt.grants.length > 0;
  // Frame text deliberately not i18n'd: it names omp's grant subject and
  // must match what the harness composed.
  const sessionLabel = routine === null ? prompt.sessionLabel : null;
  const grantKey = routine !== null ? routineToolKeyFromApprovalName(prompt.toolName) : "";
  const restrictedFolder = prompt.restrictedFolder;
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="false"
      aria-label="Allow tool"
      data-approval-card
      className="animate-rise pointer-events-auto mx-auto mb-2 w-full max-w-[var(--transcript-max)] rounded-md border border-line ambient glass-surface shadow-float"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <Label>Allow tool</Label>
        <span className="min-w-0 truncate font-mono text-xs text-ink" title={prompt.toolName}>
          {prompt.toolName}
        </span>
        {prompt.origin === "mcp" && <Chip tone="iris">MCP server tool</Chip>}
        {restrictedFolder !== null && <Chip tone="copper">Restricted folder</Chip>}
      </div>
      <div className="px-4 pt-2">
        {restrictedFolder !== null ? (
          <div data-approval-restricted>
            <p className="text-xs leading-snug text-ink-mid">
              <span className="text-ink-faint">Restricted folder: </span>
              <span data-selectable className="break-all font-mono">
                {restrictedFolder}
              </span>
            </p>
            <p className="mt-0.5 text-xs leading-snug text-ink-faint">
              Restricted folders (tools.restrictedFolders) ask in every approval mode, yolo included. No session or remembered approval covers them.
            </p>
          </div>
        ) : (
          prompt.reason !== null && (
            <p className="text-xs leading-snug text-ink-mid">
              <span className="text-ink-faint">Reason: </span>
              <span data-selectable>{prompt.reason}</span>
            </p>
          )
        )}
        {prompt.details.length > 0 && (
          <pre
            data-selectable
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line-soft bg-sunken px-2.5 py-2 font-mono text-xs leading-[1.55] text-ink"
          >
            {renderDetailLines(classifyApprovalDetails(prompt.details))}
          </pre>
        )}
        {prompt.providerSafety.length > 0 && (
          <div className="mt-2">
            <Label>Provider safety checks</Label>
            <ul className="mt-1 space-y-0.5 text-xs leading-snug text-ink-mid">
              {prompt.providerSafety.map((line, i) => (
                <li key={i} data-selectable>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {hasGrants && (
        <div data-approval-grants className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <Label>Remember</Label>
          {prompt.grants.map((grant) => {
            const label = always ? grant.alwaysLabel : grant.label;
            return (
              <Button
                key={grant.scope}
                variant="outline"
                title={label}
                className="min-w-0 max-w-full"
                onClick={() => answerApprovalPrompt(tabId, { grant: grant.scope, always })}
              >
                <span className="truncate">{label}</span>
              </Button>
            );
          })}
          <span className="ml-auto flex items-center gap-1.5 text-xs text-ink-mid">
            <Switch
              on={always}
              onChange={(next) => setAlwaysFrame(next ? held!.frame : null)}
              label="in every session"
            />
            in every session
          </span>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 px-4 pb-3 pt-3">
        <Button variant="ghost" onClick={() => answerApprovalPrompt(tabId, "deny")}>
          Deny
        </Button>
        {routine !== null && grantKey !== "" && (
          <Button
            variant="outline"
            title={`${prompt.toolName} · ${routine.name}`}
            onClick={() => {
              answerApprovalPrompt(tabId, "once");
              void grantRoutineTool(routine.id, grantKey).catch(reportError);
            }}
          >
            Always allow
          </Button>
        )}
        {sessionLabel !== null && (
          <Button variant="ghost" onClick={() => answerApprovalPrompt(tabId, "session")}>
            {sessionLabel}
          </Button>
        )}
        <Button variant="solid" tone="signal" onClick={() => answerApprovalPrompt(tabId, "once")}>
          {hasGrants ? "Allow once" : "Allow"}
        </Button>
      </div>
    </div>
  );
}
