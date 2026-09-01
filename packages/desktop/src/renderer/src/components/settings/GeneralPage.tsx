import { useEffect, useMemo } from "react";
import { cn } from "../../lib/cn";
import {
  SCALE_STEPS,
  setTranscriptScale,
  useTranscriptScale,
} from "../../lib/text-scale";
import { useStore, type CompactionMethodsLoad } from "../../store";
import { ChoiceCapsule, Switch } from "../ui";
import { currentLocaleId, UI_LOCALES, useT } from "../../lib/i18n";
import { FIELD, Row } from "./rows";

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
  const t = useT();
  type Option = {
    id: string | null;
    label: string;
    description?: string;
    disabled?: boolean;
  };
  const options: Option[] = [
    {
      id: null,
      label: t("settings.general.compactionOmpDefault"),
      description: COMPACTION_DEFAULT_DESCRIPTION,
    },
  ];
  if (load.status === "loaded") {
    // A persisted method the installed omp no longer publishes: show it,
    // pressed but inert, exactly as the previous select did.
    if (value !== null && !load.methods.includes(value)) {
      const meta = COMPACTION_METHOD_META[value];
      options.push({
        id: value,
        label: `${meta?.label ?? value}${t("settings.general.compactionOptionUnavailable")}`,
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
        aria-label={t("settings.general.compactionGroup")}
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
          {t("settings.general.compactionLoadFailed", { message: load.message })}
        </p>
      )}
    </div>
  );
}

export function GeneralPage() {
  const state = useStore((s) => s.state);
  const setDefaultMode = useStore((s) => s.setDefaultMode);
  const t = useT();
  const localeId = currentLocaleId();
  const sessionModeOptions = useMemo(
    () => [
      { value: "rpc-ui", label: t("settings.mode.native") },
      { value: "pty", label: t("settings.mode.terminal") },
    ] as const,
    [localeId, t],
  );
  const agentModeOptions = useMemo(
    () => [
      { value: "plan", label: t("settings.mode.plan") },
      { value: "build", label: t("settings.mode.build") },
    ] as const,
    [localeId, t],
  );
  const stallAbortOptions = useMemo(
    () => STALL_ABORT_OPTIONS.map((option) =>
      option.value === 0 ? { ...option, label: t("settings.option.off") } : option),
    [localeId, t],
  );
  const hibernateIdleOptions = useMemo(
    () => HIBERNATE_IDLE_OPTIONS.map((option) =>
      option.value === 0 ? { ...option, label: t("settings.option.off") } : option),
    [localeId, t],
  );
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
        title={t("settings.general.defaultSessionMode")}
        hint={t("settings.general.defaultSessionModeHint")}
      >
        <ChoiceCapsule
          label={t("settings.general.defaultSessionModeLabel")}
          value={mode}
          options={sessionModeOptions}
          onChange={(value) => void setDefaultMode(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title={t("settings.general.defaultAgentMode")}
        hint={t("settings.general.defaultAgentModeHint")}
      >
        <ChoiceCapsule
          label={t("settings.general.defaultAgentModeLabel")}
          value={agentMode}
          options={agentModeOptions}
          onChange={(value) => void setDefaultAgentMode(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title={t("settings.general.defaultCompactionMethod")}
        hint={t("settings.general.defaultCompactionMethodHint")}
        stacked
      >
        <CompactionMethodPicker
          value={defaultCompactionMethod}
          load={compactionMethods}
          onSelect={(method) => void setDefaultCompactionMethod(method)}
        />
      </Row>
      <Row
        title={t("settings.general.planFormat")}
        hint={t("settings.general.planFormatHint")}
      >
        <ChoiceCapsule
          label={t("settings.general.planFormatLabel")}
          value={planFormat}
          options={PLAN_FORMAT_OPTIONS}
          onChange={(value) => void setPlanFormat(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title={t("settings.general.hibernateIdle")}
        hint={t("settings.general.hibernateIdleHint")}
      >
        <ChoiceCapsule
          label={t("settings.general.hibernateIdleLabel")}
          value={state?.hibernateIdleMinutes ?? 30}
          options={hibernateIdleOptions}
          onChange={(value) => void setHibernateIdleMinutes(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title={t("settings.general.streamStallWatchdog")}
        hint={t("settings.general.streamStallWatchdogHint")}
      >
        <ChoiceCapsule
          label={t("settings.general.streamStallWatchdogLabel")}
          value={state?.streamStallAbortSeconds ?? 180}
          options={stallAbortOptions}
          onChange={(value) => void setStreamStallAbortSeconds(value)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <Row
        title={t("settings.general.stallAutoContinue")}
        hint={t("settings.general.stallAutoContinueHint")}
      >
        <Switch
          on={state?.stallAutoContinue ?? true}
          onChange={(next) => void setStallAutoContinue(next)}
          label={t("settings.general.stallAutoContinue")}
        />
      </Row>
      <Row
        title={t("settings.general.desktopNotifications")}
        hint={t("settings.general.desktopNotificationsHint")}
      >
        <Switch
          on={state?.desktopNotifications ?? true}
          onChange={(next) => void setDesktopNotifications(next)}
          label={t("settings.general.desktopNotifications")}
        />
      </Row>
      <Row
        title={t("settings.general.advisorAutoReply")}
        hint={t("settings.general.advisorAutoReplyHint")}
      >
        <Switch
          on={state?.advisorAutoReply ?? true}
          onChange={(next) => void setAdvisorAutoReply(next)}
          label={t("settings.general.advisorAutoReply")}
        />
      </Row>
      <Row
        title={t("settings.general.defaultAdvisor")}
        hint={t("settings.general.defaultAdvisorHint")}
      >
        <Switch
          on={state?.defaultAdvisor === true}
          onChange={(next) => void setDefaultAdvisor(next)}
          label={t("settings.general.defaultAdvisor")}
        />
      </Row>
      <Row
        title={t("settings.general.skipDeleteConfirmation")}
        hint={t("settings.general.skipDeleteConfirmationHint")}
      >
        <Switch
          on={state?.skipDeleteConfirmation === true}
          onChange={(next) => void setSkipDeleteConfirmation(next)}
          label={t("settings.general.skipDeleteConfirmation")}
        />
      </Row>
      <Row
        title={t("settings.general.transcriptTextSize")}
        hint={t("settings.general.transcriptTextSizeHint")}
      >
        <select
          aria-label={t("settings.general.transcriptTextSizeLabel")}
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
  const t = useT();
  return (
    <p>{t("settings.general.footnote")}</p>
  );
}
