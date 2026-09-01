import { useEffect } from "react";
import { cn } from "../../lib/cn";
import {
  SCALE_STEPS,
  setTranscriptScale,
  useTranscriptScale,
} from "../../lib/text-scale";
import { useStore, type CompactionMethodsLoad } from "../../store";
import { ChoiceCapsule, Switch } from "../ui";
import { UI_LOCALES, useT } from "../../lib/i18n";
import { FIELD, Row } from "./rows";

const DEFAULT_SESSION_MODE_OPTIONS = [
  { value: "rpc-ui", label: "native" },
  { value: "pty", label: "terminal" },
] as const;
const DEFAULT_AGENT_MODE_OPTIONS = [
  { value: "plan", label: "plan" },
  { value: "build", label: "build" },
] as const;
const PLAN_FORMAT_OPTIONS = [
  { value: "html", label: "html" },
  { value: "md", label: "markdown" },
] as const;
const STALL_ABORT_OPTIONS = [
  { value: 0, label: "off" },
  { value: 120, label: "2 min" },
  { value: 180, label: "3 min" },
  { value: 300, label: "5 min" },
  { value: 600, label: "10 min" },
] as const;
const HIBERNATE_IDLE_OPTIONS = [
  { value: 0, label: "off" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
] as const;

/**
 * Display metadata for compaction methods, keyed by the method id omp
 * publishes in `compaction.methodOrder`. Labels and descriptions are
 * verbatim from the `compaction.methodOrder` schema options embedded in
 * the omp 18.0.3 binary - re-verify this table when the omp binary is
 * upgraded. Unknown ids fall back to the raw id with no description;
 * never invent text for a method omp does not document.
 */
const COMPACTION_METHOD_META: Record<string, { label: string; description: string }> = {
  remote: {
    label: "OpenAI server compaction",
    description:
      "Use provider-native OpenAI-compatible server compaction when the active route supports it",
  },
  snapcompact: {
    label: "Snapcompact",
    description:
      "Archive history onto dense bitmap images the active vision model reads back; no LLM call",
  },
  handoff: {
    label: "Handoff",
    description: "Generate a handoff document and continue from it as the compaction summary",
  },
  soft: {
    label: "Soft compaction",
    description: "Summarize in place with a compaction model without using server compaction",
  },
  shake: {
    label: "Shake",
    description: "Drop recoverable heavy content in place without an LLM call",
  },
};

/** Verbatim from the installed omp's `compaction.methodOrder` setting description. */
const COMPACTION_DEFAULT_DESCRIPTION =
  "Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice";

/**
 * One visible row per compaction method, so every method's description is
 * readable without opening a dropdown. Follows the ChoiceCapsule a11y
 * pattern: a labelled group of aria-pressed buttons.
 */
function CompactionMethodPicker({
  value,
  load,
  onSelect,
}: {
  value: string | null;
  load: CompactionMethodsLoad;
  onSelect: (method: string | null) => void;
}) {
  type Option = {
    id: string | null;
    label: string;
    description?: string;
    disabled?: boolean;
  };
  const options: Option[] = [
    { id: null, label: "omp configured default", description: COMPACTION_DEFAULT_DESCRIPTION },
  ];
  if (load.status === "loaded") {
    // A persisted method the installed omp no longer publishes: show it,
    // pressed but inert, exactly as the previous select did.
    if (value !== null && !load.methods.includes(value)) {
      const meta = COMPACTION_METHOD_META[value];
      options.push({
        id: value,
        label: `${meta?.label ?? value} (unavailable)`,
        description: meta?.description,
        disabled: true,
      });
    }
    for (const method of load.methods) {
      const meta = COMPACTION_METHOD_META[method];
      options.push({
        id: method,
        label: meta?.label ?? method,
        description: meta?.description,
      });
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="group"
        aria-label="default compaction method"
        className="divide-y divide-line-soft rounded-md border border-line bg-raised"
      >
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <button
              key={option.id ?? "default"}
              type="button"
              aria-pressed={selected}
              disabled={option.disabled}
              onClick={() => {
                if (option.id !== value) onSelect(option.id);
              }}
              className={cn(
                "flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors duration-150",
                option.disabled
                  ? "cursor-not-allowed opacity-45"
                  : selected
                    ? "bg-hover text-ink"
                    : "text-ink-mid hover:bg-hover/50 focus-visible:bg-hover/50 focus-visible:outline-none",
              )}
            >
              <span className={cn("w-40 shrink-0 text-xs", selected && "font-medium")}>
                {option.label}
              </span>
              {option.description !== undefined && (
                <span className="min-w-0 flex-1 text-[11px] leading-snug text-ink-faint">
                  {option.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {load.status === "failed" && (
        <p className="text-[10px] text-ink-faint">
          Methods unavailable: {load.message}
        </p>
      )}
    </div>
  );
}

export function GeneralPage() {
  const state = useStore((s) => s.state);
  const setDefaultMode = useStore((s) => s.setDefaultMode);
  const t = useT();
  const setLocaleId = useStore((s) => s.setLocaleId);
  const setDefaultAgentMode = useStore((s) => s.setDefaultAgentMode);
  const setPlanFormat = useStore((s) => s.setPlanFormat);
  const compactionMethods = useStore((s) => s.compactionMethods);
  const ensureCompactionMethods = useStore((s) => s.ensureCompactionMethods);
  const setDefaultCompactionMethod = useStore((s) => s.setDefaultCompactionMethod);
  const setHibernateIdleMinutes = useStore((s) => s.setHibernateIdleMinutes);
  const setStreamStallAbortSeconds = useStore(
    (s) => s.setStreamStallAbortSeconds,
  );
  const setSkipDeleteConfirmation = useStore(
    (s) => s.setSkipDeleteConfirmation,
  );
  const setAdvisorAutoReply = useStore((s) => s.setAdvisorAutoReply);
  const setStallAutoContinue = useStore((s) => s.setStallAutoContinue);
  const setDesktopNotifications = useStore((s) => s.setDesktopNotifications);
  const setDefaultAdvisor = useStore((s) => s.setDefaultAdvisor);
  const scale = useTranscriptScale();
  const mode = state?.defaultMode ?? "pty";
  const agentMode = state?.defaultAgentMode ?? "plan";
  const planFormat = state?.planFormat ?? "html";
  const defaultCompactionMethod = state?.defaultCompactionMethod ?? null;
  useEffect(() => {
    void ensureCompactionMethods();
  }, [ensureCompactionMethods]);

  return (
    <div className="divide-y divide-line-soft px-4">
      <Row
        title={t("settings.general.language")}
        hint={t("settings.general.languageHint")}
      >
        <ChoiceCapsule
          label={t("settings.general.language")}
          value={state?.localeId ?? "en"}
          options={UI_LOCALES.map((l) => ({ value: l.id, label: l.label }))}
          onChange={(value) => void setLocaleId(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title="Default session mode"
        hint="How a new session opens — an embedded terminal, or the native transcript."
      >
        <ChoiceCapsule
          label="default session mode"
          value={mode}
          options={DEFAULT_SESSION_MODE_OPTIONS}
          onChange={(value) => void setDefaultMode(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title="Default agent mode"
        hint="How a new native session starts — read-only Plan, or write-enabled Build."
      >
        <ChoiceCapsule
          label="default agent mode"
          value={agentMode}
          options={DEFAULT_AGENT_MODE_OPTIONS}
          onChange={(value) => void setDefaultAgentMode(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title="Default compaction method"
        hint="Captured by new native sessions. omp configured default removes the override."
        stacked
      >
        <CompactionMethodPicker
          value={defaultCompactionMethod}
          load={compactionMethods}
          onSelect={(method) => void setDefaultCompactionMethod(method)}
        />
      </Row>
      <Row
        title="Plan format"
        hint="How the agent authors a plan for review — one self-contained HTML document rendered in the review modal, or markdown."
      >
        <ChoiceCapsule
          label="plan format"
          value={planFormat}
          options={PLAN_FORMAT_OPTIONS}
          onChange={(value) => void setPlanFormat(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title="Hibernate idle sessions"
        hint="Stop the agent process of a native session after it has been quiet this long. The tab you are looking at, each project's most recently active session, and terminal tabs are never hibernated. Its transcript stays on disk; resuming the session continues it."
      >
        <ChoiceCapsule
          label="hibernate idle sessions"
          value={state?.hibernateIdleMinutes ?? 30}
          options={HIBERNATE_IDLE_OPTIONS}
          onChange={(value) => void setHibernateIdleMinutes(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title="Stream-stall watchdog"
        hint="Abort a running turn after this much model-stream silence. The clock runs only while a model request is in flight: local tool execution suspends it for as long as the tool runs, and tool completion, compaction, retry backoff, and human answers each restart a full window. The session stays live — stall auto-continue or any prompt resumes it."
      >
        <ChoiceCapsule
          label="stall watchdog"
          value={state?.streamStallAbortSeconds ?? 180}
          options={STALL_ABORT_OPTIONS}
          onChange={(value) => void setStreamStallAbortSeconds(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title="Stall auto-continue"
        hint="When a turn is aborted because the model stream stalled, send a bounded continue prompt (max 2 in a row; any prompt re-arms) so the session resumes instead of sitting idle. The stall diagnostic still appears with this off. Terminal tabs have no prompt channel and are unaffected."
      >
        <Switch
          on={state?.stallAutoContinue ?? true}
          onChange={(next) => void setStallAutoContinue(next)}
          label="Stall auto-continue"
        />
      </Row>
      <Row
        title="Desktop notifications"
        hint="Post an OS notification when a background native session needs attention — its turn finished, a plan review is waiting for an answer, or stall auto-continue paused at its cap. The banner appears while the window is unfocused or a different tab is in view; clicking it focuses the window and resurfaces the session. Terminal sessions are not announced, and remote browser clients are unaffected."
      >
        <Switch
          on={state?.desktopNotifications ?? true}
          onChange={(next) => void setDesktopNotifications(next)}
          label="Desktop notifications"
        />
      </Row>
      <Row
        title="Advisor auto-reply"
        hint="An advisor comment that lands after the turn ends is answered automatically; off leaves it sitting in the transcript."
      >
        <Switch
          on={state?.advisorAutoReply ?? true}
          onChange={(next) => void setAdvisorAutoReply(next)}
          label="Advisor auto-reply"
        />
      </Row>
      <Row
        title="Default advisor"
        hint="Start new sessions with the advisor running. Projects with a remembered advisor keep their own last-used state."
      >
        <Switch
          on={state?.defaultAdvisor === true}
          onChange={(next) => void setDefaultAdvisor(next)}
          label="Default advisor"
        />
      </Row>
      <Row
        title="Skip the delete confirmation"
        hint="Deleting a session erases its whole lineage dir; skipping removes the warning."
      >
        <Switch
          on={state?.skipDeleteConfirmation === true}
          onChange={(next) => void setSkipDeleteConfirmation(next)}
          label="Skip the delete confirmation"
        />
      </Row>
      <Row
        title="Transcript text size"
        hint="Native transcripts only — the rest of the chrome is an app, not a document."
      >
        <select
          aria-label="transcript text size"
          value={String(scale)}
          onChange={(e) => setTranscriptScale(Number(e.target.value))}
          className={FIELD}
        >
          {SCALE_STEPS.map((step) => (
            <option key={step} value={String(step)}>
              {Math.round(step * 100)}%
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}

export function GeneralFooter() {
  return (
    <p>
      Default session and agent modes apply to new sessions; everything else
      applies immediately.
    </p>
  );
}
