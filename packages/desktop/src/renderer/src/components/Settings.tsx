import { AppUpdateRestartAction } from "./AppUpdateCard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AppUpdateState,
  MemoryOverview,
  OmpSettingEntry,
  OmpSettingLayer,
  OmpSettingsSnapshot,
  OmpSettingValue,
  OmpUpdateState,
  ProviderKeysSnapshot,
  ProviderKeyStatus,
  RemoteState,
} from "@omp-ui/core/types";
import {
  MEMORY_SETTING_GROUP,
  OMP_MODEL_ROLE_IDS,
  OMP_MODEL_ROLES_KEY,
  OMP_SETTING_GROUPS,
} from "@omp-ui/core/omp-settings-keys";
import QRCode from "qrcode";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import {
  SCALE_STEPS,
  setTranscriptScale,
  useTranscriptScale,
} from "../lib/text-scale";
import { resolveTheme, THEMES } from "../lib/themes";
import { useStore, type CompactionMethodsLoad, type SettingsPage } from "../store";
import {
  Button,
  ChoiceCapsule,
  Chip,
  CopyButton,
  Dot,
  Empty,
  Label,
  Modal,
  Panel,
  Switch,
} from "./ui";

/**
 * The settings modal (issue #36): eight pages behind one store-driven nav
 * (`settingsPage`), so callers can deep-link a page. The omp and Memory pages
 * are schema-driven GUIs over a curated allowlist of omp's own settings,
 * written through `omp config set` and re-read after every write — the
 * snapshot is the single source of truth for values AND layer badges (a first
 * write legitimately flips a badge from `default` to `global`), so nothing is
 * patched optimistically.
 *
 * The snapshot is loaded once here rather than per page: omp, Memory, and
 * About consume it, and it costs four omp invocations.
 */

type Load =
  | { status: "loading" }
  | { status: "loaded"; snapshot: OmpSettingsSnapshot }
  | { status: "error"; message: string };

type OverviewLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; overview: MemoryOverview }
  | { status: "error"; message: string };

/** ipcRenderer.invoke wraps main-process errors — unwrap for display (#16 precedent). */
function displayMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

/** readOmpSettings never rejects with this — only a null ompPath produces it. */
const OMP_MISSING = "omp binary not found";

const PAGES: ReadonlyArray<{ id: SettingsPage; label: string }> = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "updates", label: "Updates" },
  { id: "remote", label: "Remote access" },
  { id: "providers", label: "Providers" },
  { id: "memory", label: "Memory" },
  { id: "omp", label: "omp" },
  { id: "about", label: "About" },
];

const FIELD =
  "h-7 min-w-0 rounded-md border border-line bg-raised px-2 text-xs text-ink " +
  "transition-colors duration-150 focus:border-line-strong focus:outline-none " +
  "disabled:pointer-events-none disabled:opacity-35";

/* -------------------------------------------------------------------- rows */

function Row({
  title,
  hint,
  badge,
  children,
  stacked,
}: {
  title: string;
  hint?: string;
  badge?: ReactNode;
  children: ReactNode;
  /** Full-width children below the title block, for controls too wide for the right column. */
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">{title}</span>
          {badge}
        </div>
        {hint !== undefined && hint !== "" && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>
        )}
        <div className="mt-1.5">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">{title}</span>
          {badge}
        </div>
        {hint !== undefined && hint !== "" && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            {hint}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/** `default` stays unbadged — it is the quiet common case. */
function layerBadge(layer: OmpSettingLayer): ReactNode {
  if (layer === "project") return <Chip tone="copper">project</Chip>;
  if (layer === "global") return <Chip>global</Chip>;
  return null;
}

/**
 * A text/number field committing on Enter or blur; Escape reverts to the
 * snapshot value. An unchanged draft commits nothing. Escape with no edit is
 * left to bubble so it still closes the modal; with one it reverts and stops.
 */
function CommitField({
  current,
  kind,
  label,
  placeholder,
  disabled,
  className,
  onCommit,
}: {
  current: string;
  kind: "text" | "number";
  label: string;
  placeholder?: string;
  disabled: boolean;
  className?: string;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== current) onCommit(draft);
  };

  return (
    <input
      type={kind}
      value={draft ?? current}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draft !== null) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cn(FIELD, className)}
    />
  );
}

/* ----------------------------------------------------------------- general */

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

function GeneralPage() {
  const state = useStore((s) => s.state);
  const setDefaultMode = useStore((s) => s.setDefaultMode);
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

/* -------------------------------------------------------------- appearance */

/** The planes and accents each swatch strip paints, in strip order. */
const SWATCH_TOKENS = [
  "--color-void",
  "--color-surface",
  "--color-raised",
  "--color-signal",
  "--color-copper",
  "--color-rose",
  "--color-iris",
] as const;

function AppearancePage() {
  const themeId = useStore((s) => s.state?.themeId);
  const setThemeId = useStore((s) => s.setThemeId);
  const activeId = resolveTheme(themeId).id;

  return (
    <div className="px-4 py-3">
      <div className="grid grid-cols-2 gap-2">
        {THEMES.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={active}
              onClick={() => void setThemeId(t.id)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors duration-150",
                active
                  ? "border-line-strong bg-hover"
                  : "border-line bg-raised hover:border-line-strong",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-ink">{t.label}</span>
                <Chip>{t.dark ? "dark" : "light"}</Chip>
              </span>
              {/* Inline styles are the one sanctioned exception here: these
                  swatches paint a theme that is NOT the active one, so the
                  live CSS tokens cannot express them. */}
              <span className="mt-2 flex h-4 overflow-hidden rounded border border-line">
                {SWATCH_TOKENS.map((token) => (
                  <span
                    key={token}
                    className="flex-1"
                    style={{ background: t.tokens[token] }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-ink-faint">
        Every theme keeps mint reserved for agent liveness (ADR-0004).
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- updates */

function appStatusLine(u: AppUpdateState): string {
  switch (u.status) {
    case "available":
      return `${u.latestVersion ?? "a newer release"} available`;
    case "downloading":
      return `downloading ${u.latestVersion ?? ""}…`;
    case "downloaded":
      return `${u.latestVersion ?? "update"} downloaded${u.installOnQuit ? " — installs on quit" : ""}`;
    case "installing":
      return `applying ${u.latestVersion ?? "update"}…`;
    case "up-to-date":
      return "up to date";
    case "checking":
      return "checking…";
    case "disabled":
      return "omp-ui checks disabled in this build — omp binary updates are independent";
    case "error":
      return u.error ?? "update check failed";
    default:
      return "no check has run yet";
  }
}

function ompStatusLine(u: OmpUpdateState): string {
  switch (u.status) {
    case "missing":
      return "not installed";
    case "available":
      return `${u.latestVersion ?? "a newer release"} available`;
    case "downloading":
      return `installing ${u.latestVersion ?? ""}…`;
    case "installed":
      return `${u.latestVersion ?? "update"} installed — new sessions use it`;
    case "up-to-date":
      return "up to date";
    case "checking":
      return "checking…";
    case "error":
      return u.error ?? "update check failed";
    default:
      return "no check has run yet";
  }
}

function UpdatesPage() {
  const state = useStore((s) => s.state);
  const appUpdate = useStore((s) => s.appUpdate);
  const ompUpdate = useStore((s) => s.ompUpdate);
  const setAppUpdateCheckOnLaunch = useStore(
    (s) => s.setAppUpdateCheckOnLaunch,
  );
  const setOmpUpdateCheckOnLaunch = useStore(
    (s) => s.setOmpUpdateCheckOnLaunch,
  );
  const clearDismissedAppUpdate = useStore((s) => s.clearDismissedAppUpdate);
  const clearDismissedOmpUpdate = useStore((s) => s.clearDismissedOmpUpdate);
  const checkAppUpdate = useStore((s) => s.checkAppUpdate);
  const checkOmpUpdate = useStore((s) => s.checkOmpUpdate);
  const downloadOmpUpdate = useStore((s) => s.downloadOmpUpdate);
  const downloadAppUpdate = useStore((s) => s.downloadAppUpdate);

  const setAppUpdateInstallOnQuit = useStore(
    (s) => s.setAppUpdateInstallOnQuit,
  );
  const showAppUpdateDownload = useStore((s) => s.showAppUpdateDownload);
  const openAppUpdateReleaseNotes = useStore(
    (s) => s.openAppUpdateReleaseNotes,
  );

  // Clear THEN check, so the card reappears immediately if an offer stands.
  const reofferApp = (): void => {
    void clearDismissedAppUpdate().then(() => checkAppUpdate());
  };
  const reofferOmp = (): void => {
    void clearDismissedOmpUpdate().then(() => checkOmpUpdate());
  };

  return (
    <div className="space-y-3 px-4 py-3">
      <Panel className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">omp-ui</p>
            <p className="mt-0.5 font-mono text-[11px] text-ink-mid tabular-nums">
              {appUpdate.currentVersion ?? "unversioned build"}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {appStatusLine(appUpdate)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* The update card's primary action mirrored (issue #89): a check
                that answers "available" here must not require closing
                Settings to reach the corner card — and the downloaded
                follow-through finishes the install without leaving either. */}
            {appUpdate.status === "available" &&
              (appUpdate.format === "unknown" ? (
                <Button
                  size="xs"
                  variant="solid"
                  onClick={() => void openAppUpdateReleaseNotes()}
                >
                  View release
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="solid"
                  onClick={() => void downloadAppUpdate()}
                >
                  {appUpdate.format === "appimage" ||
                  appUpdate.format === "nsis" ||
                  appUpdate.format === "maczip"
                    ? "Update"
                    : "Download"}
                </Button>
              ))}
            {appUpdate.status === "downloaded" &&
              (appUpdate.format === "appimage" ||
              appUpdate.format === "nsis" ||
              appUpdate.format === "maczip" ? (
                <>
                  <AppUpdateRestartAction size="xs" />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void setAppUpdateInstallOnQuit(!appUpdate.installOnQuit)
                    }
                  >
                    {appUpdate.installOnQuit
                      ? "Undo install on quit"
                      : "Install when I quit"}
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  variant="solid"
                  onClick={() => void showAppUpdateDownload()}
                >
                  Show in folder
                </Button>
              ))}
            <Button
              size="xs"
              disabled={appUpdate.status === "installing"}
              onClick={() => void checkAppUpdate()}
            >
              Check now
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-mid">Check on launch</span>
          <Switch
            on={state?.appUpdateCheckOnLaunch ?? true}
            onChange={(next) => void setAppUpdateCheckOnLaunch(next)}
            label="check for omp-ui updates on launch"
          />
        </div>
        {typeof state?.dismissedAppUpdateVersion === "string" && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-mid">
              Dismissed: {state.dismissedAppUpdateVersion}
            </span>
            <Button size="xs" variant="ghost" onClick={reofferApp}>
              Re-offer
            </Button>
          </div>
        )}
      </Panel>

      <Panel className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">omp binary</p>
            <p className="mt-0.5 font-mono text-[11px] text-ink-mid tabular-nums">
              {ompUpdate.installedVersion ?? "not installed"}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {ompStatusLine(ompUpdate)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* The same install OmpUpdateCard.tsx offers — reachable here
                because a user whose omp is missing has no card to click once
                they dismiss it. The available-update action joins it for the
                same reason (issue #89). */}
            {ompUpdate.status === "available" && (
              <Button
                size="xs"
                variant="solid"
                onClick={() => void downloadOmpUpdate()}
              >
                Update now
              </Button>
            )}
            {ompUpdate.status === "missing" && (
              <Button
                size="xs"
                variant="solid"
                onClick={() => void downloadOmpUpdate()}
              >
                Install
              </Button>
            )}
            <Button size="xs" onClick={() => void checkOmpUpdate()}>
              Check now
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-mid">Check on launch</span>
          <Switch
            on={state?.ompUpdateCheckOnLaunch ?? true}
            onChange={(next) => void setOmpUpdateCheckOnLaunch(next)}
            label="check for omp updates on launch"
          />
        </div>
        {typeof state?.dismissedOmpUpdateVersion === "string" && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-mid">
              Dismissed: {state.dismissedOmpUpdateVersion}
            </span>
            <Button size="xs" variant="ghost" onClick={reofferOmp}>
              Re-offer
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ remote */

function remoteStatusLine(r: RemoteState): string {
  switch (r.status) {
    case "starting":
      return "starting…";
    case "listening":
      return `listening on ${r.port}`;
    case "error":
      return r.error ?? "the server could not start";
    default:
      return "stopped";
  }
}

function remoteStatusTone(
  status: RemoteState["status"],
): "signal" | "copper" | "rose" | "neutral" {
  if (status === "listening") return "signal";
  if (status === "starting") return "copper";
  if (status === "error") return "rose";
  return "neutral";
}

/**
 * The QR of the pairing URL. Rendered as an SVG string rather than a canvas: qrcode's `browser`
 * field remaps its entry and stubs `fs`, so `toString(..., { type: "svg" })` is the one route that
 * needs no polyfill in either the renderer or the web bundle.
 */
function PairingQr({ url, hasPassword }: { url: string; hasPassword: boolean }) {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let live = true;
    setSvg("");
    void QRCode.toString(url, {
      type: "svg",
      margin: 1,
      // Deliberately NOT theme tokens: a scannable QR needs true black on true white, and a
      // camera does not care about the app's palette.
      color: { dark: "#000000", light: "#ffffff" },
    }).then(
      (out) => {
        if (live) setSvg(out);
      },
      () => {
        // A QR that will not render must not take the page down — the URL above still copies.
      },
    );
    return () => {
      live = false;
    };
  }, [url]);

  if (svg === "") return null;
  return (
    <Panel className="flex items-center gap-3 px-4 py-3">
      <div
        className="size-32 shrink-0 rounded-md bg-white p-1.5"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="min-w-0">
        <Label>Scan to pair</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {hasPassword
            ? "Opens omp-ui in the phone&apos;s browser; it will ask for your password."
            : "Opens omp-ui in the phone&apos;s browser with the token already attached."}
        </p>
      </div>
    </Panel>
  );
}

/**
 * The remote sign-in password row. Mirrors ProviderRow: self-managed editing/draft state, the
 * input never pre-filled (only a hash exists server-side, nothing to reveal), Enter saves,
 * Escape cancels without closing the modal.
 */
function PasswordRow() {
  const hasPassword = useStore((s) => s.remote.hasPassword);
  const setRemotePassword = useStore((s) => s.setRemotePassword);
  const clearRemotePassword = useStore((s) => s.clearRemotePassword);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const save = (): void => {
    const value = draft.trim();
    if (value === "") return;
    setDraft("");
    setEditing(false);
    void setRemotePassword(value); // policy rejections surface via alertRemoteError
  };

  const cancel = (): void => {
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-ink">Password</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            Primary sign-in for remote devices. Stored as a salted hash — it cannot
            be revealed, only changed or cleared.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!editing && !hasPassword && (
            <Button size="xs" onClick={() => setEditing(true)}>
              Set password
            </Button>
          )}
          {!editing && hasPassword && (
            <>
              <span className="text-[11px] text-ink-mid">password set</span>
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                Change
              </Button>
              <Button size="xs" onClick={() => void clearRemotePassword()}>
                Clear
              </Button>
            </>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={input}
            type="password"
            value={draft}
            aria-label="remote access password"
            placeholder="at least 8 characters"
            spellCheck={false}
            autoComplete="new-password"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                // Stopped so Escape cancels the row, not the whole modal.
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
            className={cn(FIELD, "flex-1")}
          />
          <Button size="xs" disabled={draft.trim() === ""} onClick={save}>
            Save
          </Button>
          <Button size="xs" variant="ghost" onClick={cancel}>
            cancel
          </Button>
        </div>
      )}
    </div>
  );
}

const REMOTE_BIND_OPTIONS = [
  { value: "localhost", label: "localhost" },
  { value: "lan", label: "local network" },
] as const;

function RemotePage() {
  const remote = useStore((s) => s.remote);
  const setRemoteEnabled = useStore((s) => s.setRemoteEnabled);
  const setRemoteBind = useStore((s) => s.setRemoteBind);
  const setRemotePort = useStore((s) => s.setRemotePort);
  const regenerateRemoteToken = useStore((s) => s.regenerateRemoteToken);
  const [revealed, setRevealed] = useState(false);

  const primaryUrl = remote.urls[0] ?? null;

  return (
    <div className="space-y-3 px-4 py-3">
      <Panel className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot
            tone={remoteStatusTone(remote.status)}
            pulse={remote.status === "starting"}
          />
          <p className="text-xs font-medium text-ink">
            {remoteStatusLine(remote)}
          </p>
        </div>
        {remote.webBundleMissing && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-copper">
            the browser bundle is missing — run{" "}
            <span className="font-mono">npm run build:web</span>
          </p>
        )}
      </Panel>

      <div className="divide-y divide-line-soft">
        <Row
          title="Enable remote access"
          hint="Off by default. A connected client can do everything you can, including editing files and running commands."
        >
          <Switch
            on={remote.enabled}
            onChange={(next) => void setRemoteEnabled(next)}
            label="enable remote access"
          />
        </Row>
        <div>
          <Row
            title="Bind address"
            hint="Which interface the server listens on."
          >
            <ChoiceCapsule
              label="bind address"
              value={remote.bind}
              options={REMOTE_BIND_OPTIONS}
              onChange={(value) => void setRemoteBind(value)}
              optionClassName="px-2 text-[11px]"
            />
          </Row>
          {remote.bind === "lan" && (
            <p className="pb-2.5 text-[11px] leading-relaxed text-rose">
              Anyone on this network with your password or a token link can drive your agent.
              Plain HTTP, so the connection is not encrypted.
            </p>
          )}
        </div>
        <Row title="Port" hint="A whole number between 1024 and 65535.">
          <CommitField
            current={String(remote.port)}
            kind="number"
            label="remote access port"
            disabled={false}
            className="w-24"
            onCommit={(raw) => void setRemotePort(Number(raw))}
          />
        </Row>
        <PasswordRow />
        <Row
          title="Access token (fallback)"
          hint="Still works while a password is set. Regenerating disconnects every client using it."
        >
          <div className="flex items-center gap-1.5">
            <span
              data-selectable
              className="max-w-48 truncate font-mono text-[11px] text-ink-mid"
              title={revealed ? remote.token : undefined}
            >
              {revealed ? remote.token : "••••••••••••"}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? "hide" : "reveal"}
            </Button>
            <CopyButton text={remote.token} />
            <Button size="xs" onClick={() => void regenerateRemoteToken()}>
              Regenerate
            </Button>
          </div>
        </Row>
        <Row
          title="Connection URL"
          hint={
            remote.hasPassword
              ? "Open this on the other device, then sign in with your password."
              : "Open this on the other device — the token rides along."
          }
        >
          <div className="flex items-center gap-1.5">
            <span
              data-selectable
              className="max-w-64 truncate font-mono text-[11px] text-ink-mid"
              title={primaryUrl ?? undefined}
            >
              {primaryUrl ?? "—"}
            </span>
            {primaryUrl !== null && <CopyButton text={primaryUrl} />}
          </div>
        </Row>
        {remote.hasPassword && (
          <Row
            title="Token link (fallback)"
            hint="Full-access URL with the embedded token, for devices where typing a password is impractical."
          >
            <div className="flex items-center gap-1.5">
              <span
                data-selectable
                className="max-w-64 truncate font-mono text-[11px] text-ink-mid"
                title={remote.tokenUrls[0] ?? undefined}
              >
                {remote.tokenUrls[0] ?? "—"}
              </span>
              {remote.tokenUrls[0] !== undefined && (
                <CopyButton text={remote.tokenUrls[0]} />
              )}
            </div>
          </Row>
        )}
      </div>

      {remote.urls.length > 1 && (
        <div className="space-y-0.5">
          <Label>Also reachable at</Label>
          {remote.urls.slice(1).map((url) => (
            <p
              key={url}
              data-selectable
              className="truncate font-mono text-[11px] text-ink-faint"
            >
              {url}
            </p>
          ))}
        </div>
      )}

      {remote.status === "listening" && primaryUrl !== null && (
        <PairingQr url={primaryUrl} hasPassword={remote.hasPassword} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- providers */

type ProviderLoad =
  | { status: "loading" }
  | { status: "loaded"; snapshot: ProviderKeysSnapshot }
  | { status: "error"; message: string };

/** How the row labels each source, and how loudly. */
function sourceChip(row: ProviderKeyStatus): ReactNode {
  if (row.source === "stored") return <Chip tone="signal">saved here</Chip>;
  if (row.source === "environment") return <Chip>environment</Chip>;
  if (row.source === "login-shell")
    return <Chip tone="iris">shell profile</Chip>;
  // Report-only: omp loads project .env files itself, so nothing was injected.
  if (row.source === "dotenv") return <Chip tone="copper">project .env</Chip>;
  return null;
}

/**
 * One provider row: masked status plus an input that appears on demand. The
 * input is never pre-filled — the renderer has no key material to fill it with,
 * only a masked tail — so typing always means "replace this credential".
 */
function ProviderRow({
  row,
  busy,
  onSave,
  onClear,
}: {
  row: ProviderKeyStatus;
  busy: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const save = (): void => {
    const value = draft.trim();
    if (value === "") return;
    setDraft("");
    setEditing(false);
    onSave(value);
  };

  const cancel = (): void => {
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink">{row.label}</span>
            {sourceChip(row)}
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
            {row.activeEnv}
            {row.masked !== null && (
              <span className="ml-2 text-ink-dim">{row.masked}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!editing && (
            <Button size="xs" disabled={busy} onClick={() => setEditing(true)}>
              {row.source === "stored" ? "Replace" : "Add key"}
            </Button>
          )}
          {!editing && row.source === "stored" && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={onClear}>
              remove
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={input}
            // `password` so the value is not readable over a shoulder or in a
            // screen share, and so no password manager offers to autofill it.
            type="password"
            value={draft}
            aria-label={`${row.label} key`}
            placeholder={row.hint ?? row.env}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                // Stopped so Escape closes the editor, not the whole modal.
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
            className={cn(FIELD, "flex-1")}
          />
          <Button
            size="xs"
            disabled={busy || draft.trim() === ""}
            onClick={save}
          >
            Save
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={cancel}>
            cancel
          </Button>
        </div>
      )}

      {row.shadowsEnvironment && !editing && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          Overrides the <span className="font-mono">{row.activeEnv}</span> your
          environment already provides.
        </p>
      )}
    </div>
  );
}

function ProvidersPage({ projectCwd }: { projectCwd: string | null }) {
  const readProviderKeys = useStore((s) => s.readProviderKeys);
  const setProviderKey = useStore((s) => s.setProviderKey);
  const clearProviderKey = useStore((s) => s.clearProviderKey);

  const [load, setLoad] = useState<ProviderLoad>({ status: "loading" });
  /** env name of the row with a write in flight; its controls stay disabled. */
  const [pendingEnv, setPendingEnv] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    readProviderKeys(projectCwd).then(
      (snapshot) => {
        if (g === gen.current) setLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => {
        if (g === gen.current)
          setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [readProviderKeys, projectCwd]);

  /** Every write answers with the refreshed snapshot, so no re-read is needed. */
  const run = (envName: string, op: Promise<ProviderKeysSnapshot>): void => {
    setPendingEnv(envName);
    op.then(
      (snapshot) => {
        setWriteError(null);
        setLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => setWriteError(displayMessage(err)),
    ).finally(() => setPendingEnv(null));
  };

  if (load.status === "loading") {
    return <Empty title="Reading providers…" />;
  }
  if (load.status === "error") {
    return <Empty title="Could not read provider keys" hint={load.message} />;
  }

  const { providers, encryptionAvailable, backend } = load.snapshot;
  const configured = providers.filter((p) => p.source !== "none");
  const groups: ReadonlyArray<{
    id: ProviderKeyStatus["group"];
    label: string;
  }> = [
    { id: "models", label: "Model providers" },
    { id: "search", label: "Web search" },
  ];

  return (
    <div className="space-y-3 px-4 py-3">
      <Panel className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot tone={configured.length > 0 ? "signal" : "copper"} />
          <p className="text-xs font-medium text-ink">
            {configured.length === 0
              ? "No provider credentials — omp can only offer models that need no key"
              : `${configured.length} of ${providers.length} providers have a credential`}
          </p>
        </div>
        {encryptionAvailable ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            Keys you add are encrypted by your OS credential store (
            <span className="font-mono">{backend}</span>).
          </p>
        ) : (
          <p className="mt-1.5 text-[11px] leading-relaxed text-copper">
            No OS credential store is available here, so keys cannot be saved
            securely and adding one is refused. Export the variable from your
            shell profile instead.
          </p>
        )}
      </Panel>

      {writeError !== null && (
        <p className="text-[11px] leading-relaxed text-rose">{writeError}</p>
      )}

      {groups.map(({ id, label }) => {
        const rows = providers.filter((p) => p.group === id);
        if (rows.length === 0) return null;
        return (
          <div key={id} className="space-y-0.5">
            <Label>{label}</Label>
            <div className="divide-y divide-line-soft">
              {rows.map((row) => (
                <ProviderRow
                  key={row.id}
                  row={row}
                  busy={pendingEnv !== null}
                  onSave={(value) =>
                    run(row.env, setProviderKey(row.env, value))
                  }
                  onClear={() => run(row.env, clearProviderKey(row.activeEnv))}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettingControl({
  entry,
  pendingKey,
  commit,
}: {
  entry: OmpSettingEntry;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const pending = pendingKey === entry.key;

  const commitScalar = (raw: string): void => {
    if (entry.type === "number") {
      const value = Number(raw);
      // Empty or non-finite reverts: this surface does not expose config reset.
      if (raw.trim() === "" || !Number.isFinite(value)) return;
      commit(entry.key, value);
    } else {
      if (raw === "") return;
      commit(entry.key, raw);
    }
  };

  if (entry.type === "boolean") {
    return (
      <Switch
        on={entry.value === true}
        onChange={(next) => commit(entry.key, next)}
        label={entry.key}
        disabled={pending}
      />
    );
  }
  // A failed enum-member read (options null) is non-fatal upstream; the value
  // remains editable as free text for omp to validate on write.
  if (entry.type === "enum" && entry.options !== null) {
    const value = typeof entry.value === "string" ? entry.value : "";
    return (
      <select
        aria-label={entry.key}
        value={value}
        disabled={pending}
        onChange={(event) => commit(entry.key, event.target.value)}
        className={FIELD}
      >
        {value === "" && (
          <option value="" disabled>
            unset
          </option>
        )}
        {entry.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (
    entry.type === "number" ||
    entry.type === "string" ||
    entry.type === "enum"
  ) {
    return (
      <CommitField
        current={entry.value === undefined ? "" : String(entry.value)}
        kind={entry.type === "number" ? "number" : "text"}
        label={entry.key}
        disabled={pending}
        className={entry.type === "number" ? "w-24" : "w-44"}
        onCommit={commitScalar}
      />
    );
  }
  // Future array/record entries stay visible without guessing an editor.
  return (
    <span
      className="max-w-56 truncate font-mono text-[11px] text-ink-mid"
      title={entry.key}
    >
      {entry.value === undefined ? "—" : JSON.stringify(entry.value)}
    </span>
  );
}

/* --------------------------------------------------------------------- omp */

function OmpPage({
  load,
  projectCwd,
  pendingKey,
  writeError,
  commit,
  retry,
}: {
  load: Load;
  projectCwd: string | null;
  pendingKey: string | null;
  writeError: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
}) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openMcpManager = useStore((s) => s.openMcpManager);
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);

  if (load.status === "loading") {
    return (
      <Empty
        title="Reading omp configuration…"
        hint="Values, layers, and enum members come from omp's own config CLI."
      />
    );
  }

  // readOmpSettings itself never rejects — snapshot.error carries omp's own
  // failure — but the IPC hop still can, so both land in the same treatment.
  const failure =
    load.status === "error"
      ? load.message
      : load.snapshot.error !== null
        ? load.snapshot.error
        : null;
  // The `status` check rides along so the destructure below narrows: an error
  // load carries no snapshot, and a loaded one can still report `error`.
  if (failure !== null || load.status !== "loaded") {
    const missing = failure === OMP_MISSING;
    return (
      <Empty
        title="Could not read omp's configuration"
        hint={
          missing
            ? "omp is not installed, so there is nothing to configure yet."
            : (failure ?? undefined)
        }
        action={
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={retry}>
              retry
            </Button>
            {missing && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => openSettings("updates")}
              >
                install omp from the Updates page
              </Button>
            )}
          </div>
        }
      />
    );
  }

  const { snapshot } = load;
  const byKey = new Map<string, OmpSettingEntry>(
    snapshot.entries.map((e) => [e.key, e]),
  );
  const rolesEntry = byKey.get(OMP_MODEL_ROLES_KEY);
  const rolesRecord: Record<string, unknown> =
    rolesEntry !== undefined &&
    typeof rolesEntry.value === "object" &&
    rolesEntry.value !== null &&
    !Array.isArray(rolesEntry.value)
      ? rolesEntry.value
      : {};

  const commitRole = (role: string, raw: string): void => {
    const next = raw.trim();
    // `omp config set modelRoles` is REPLACE-not-merge: a partial post would
    // delete every sibling role, so the WHOLE merged record goes out, with the
    // role's key omitted when cleared (blank = unset).
    const merged: Record<string, unknown> = { ...rolesRecord };
    if (next === "") delete merged[role];
    else merged[role] = next;
    commit(OMP_MODEL_ROLES_KEY, merged);
  };


  const tab =
    activeTabId === null
      ? undefined
      : tabs.find((t) => t.tabId === activeTabId);
  const mcpReady = tab !== undefined && tab.projectCwd !== "";

  return (
    <div className="pb-1.5">
      {projectCwd === null && (
        <p className="px-4 pt-3 text-[11px] text-ink-faint">
          No session focused — showing omp&apos;s global configuration.
        </p>
      )}
      {writeError !== null && (
        <p className="mx-4 mt-3 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {writeError}
        </p>
      )}

      {rolesEntry !== undefined && (
        <section className="px-4 pt-3">
          <div className="flex items-center gap-2">
            <Label>Model roles</Label>
            {layerBadge(rolesEntry.layer)}
          </div>
          {rolesEntry.description !== "" && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
              {rolesEntry.description}
            </p>
          )}
          <div className="mt-1.5 divide-y divide-line-soft">
            {OMP_MODEL_ROLE_IDS.map((role) => (
              <div key={role} className="flex items-center gap-3 py-1.5">
                <span className="w-20 shrink-0 font-mono text-[11px] text-ink-mid">
                  {role}
                </span>
                <CommitField
                  current={
                    typeof rolesRecord[role] === "string"
                      ? (rolesRecord[role] as string)
                      : ""
                  }
                  kind="text"
                  label={`model role ${role}`}
                  placeholder="model[:level] — blank = unset"
                  disabled={pendingKey === OMP_MODEL_ROLES_KEY}
                  className="flex-1"
                  onCommit={(raw) => commitRole(role, raw)}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {OMP_SETTING_GROUPS.map((group) => {
        const entries = group.keys
          .map((key) => byKey.get(key))
          .filter((e): e is OmpSettingEntry => e !== undefined);
        // A future omp may drop a whole group; an empty section is noise.
        if (entries.length === 0) return null;
        return (
          <section key={group.title} className="px-4 pt-3">
            <Label>{group.title}</Label>
            {group.description !== undefined && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                {group.description}
              </p>
            )}
            <div className="mt-1 divide-y divide-line-soft">
              {entries.map((entry) => (
                <Row
                  key={entry.key}
                  title={entry.key}
                  hint={entry.description}
                  badge={layerBadge(entry.layer)}
                >
                  <SettingControl
                    entry={entry}
                    pendingKey={pendingKey}
                    commit={commit}
                  />
                </Row>
              ))}
            </div>
          </section>
        );
      })}

      <div className="mt-1 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-[11px] text-ink-faint">
          MCP servers resolve per project from native and translated tool configs (issue #36);
          the global list applies to every project.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            disabled={!mcpReady}
            title={mcpReady ? undefined : "focus a session tab first — the manager pins to it"}
            onClick={() => {
              if (tab === undefined) return;
              // One modal at a time: stacked Escape listeners would close both.
              closeSettings();
              openMcpManager(tab.projectCwd, tab.tabId);
            }}
          >
            MCP servers…
          </Button>
          <Button size="xs" onClick={() => { closeSettings(); openMcpManager(null); }}>
            Global MCP servers…
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ memory */

function MemoryBankPath({
  label,
  path,
  exists,
}: {
  label: string;
  path: string;
  exists: boolean;
}) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <span className="truncate font-mono text-[10px] text-ink-mid" title={path}>
        {path}
      </span>
      <Chip tone={exists ? undefined : "copper"}>
        {exists ? "exists" : "not created"}
      </Chip>
    </div>
  );
}

function MemoryOverviewPanel({
  load,
  projectCwd,
  retry,
}: {
  load: OverviewLoad;
  projectCwd: string | null;
  retry: () => void;
}) {
  if (projectCwd === null) {
    return (
      <Panel className="px-3 py-2.5">
        <Label>Resolved memory</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          Focus a session tab to inspect its resolved backend and bank locations.
        </p>
      </Panel>
    );
  }
  if (load.status === "idle" || load.status === "loading") {
    return (
      <Panel className="px-3 py-2.5">
        <Label>Resolved memory</Label>
        <p className="mt-1 text-[11px] text-ink-faint">Discovering banks…</p>
      </Panel>
    );
  }
  if (load.status === "error") {
    return (
      <Panel className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-rose">{load.message}</p>
          <Button size="xs" onClick={retry}>retry</Button>
        </div>
      </Panel>
    );
  }

  const { overview } = load;
  return (
    <Panel className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Label className="mr-auto">Resolved memory</Label>
        <Chip mono>{overview.backend}</Chip>
        <Chip mono>{overview.scoping}</Chip>
      </div>
      {overview.error !== null && (
        <div className="flex items-center justify-between gap-3 rounded border border-rose-dim/50 bg-rose-wash px-2 py-1.5">
          <p className="text-[11px] leading-relaxed text-rose">{overview.error}</p>
          <Button size="xs" onClick={retry}>retry</Button>
        </div>
      )}
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wide text-ink-faint">base</span>
        <span className="truncate font-mono text-[10px] text-ink-mid" title={overview.baseDir}>
          {overview.baseDir}
        </span>
      </div>
      <MemoryBankPath
        label="global"
        path={overview.global.dbPath}
        exists={overview.global.exists}
      />
      {overview.project !== null ? (
        <MemoryBankPath
          label="project"
          path={overview.project.dbPath}
          exists={overview.project.exists}
        />
      ) : (
        <p className="text-[10px] leading-relaxed text-ink-faint">
          {overview.scoping === "global"
            ? "This project uses the global bank."
            : "No project bank has been discovered yet."}
        </p>
      )}
    </Panel>
  );
}

function MemoryPage({
  load,
  projectCwd,
  pendingKey,
  writeError,
  commit,
  retry,
  overviewRevision,
}: {
  load: Load;
  projectCwd: string | null;
  pendingKey: string | null;
  writeError: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
  overviewRevision: number;
}) {
  const openSettings = useStore((state) => state.openSettings);
  const [overviewLoad, setOverviewLoad] = useState<OverviewLoad>({ status: "idle" });
  const [overviewRetry, setOverviewRetry] = useState(0);
  const overviewGeneration = useRef(0);

  useEffect(() => {
    const generation = ++overviewGeneration.current;
    if (projectCwd === null) {
      setOverviewLoad({ status: "idle" });
      return;
    }

    let stale = false;
    setOverviewLoad({ status: "loading" });
    backend.memoryOverview(projectCwd).then(
      (overview) => {
        if (!stale && generation === overviewGeneration.current) {
          setOverviewLoad({ status: "loaded", overview });
        }
      },
      (error: unknown) => {
        if (!stale && generation === overviewGeneration.current) {
          setOverviewLoad({ status: "error", message: displayMessage(error) });
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [projectCwd, overviewRevision, overviewRetry]);

  const overviewPanel = (
    <MemoryOverviewPanel
      load={overviewLoad}
      projectCwd={projectCwd}
      retry={() => setOverviewRetry((revision) => revision + 1)}
    />
  );

  if (load.status === "loading") {
    return (
      <div className="space-y-3 px-4 py-3">
        {overviewPanel}
        <Empty title="Reading memory configuration…" />
      </div>
    );
  }
  const failure =
    load.status === "error"
      ? load.message
      : load.snapshot.error !== null
        ? load.snapshot.error
        : null;
  if (failure !== null || load.status !== "loaded") {
    const missing = failure === OMP_MISSING;
    return (
      <div className="space-y-3 px-4 py-3">
        {overviewPanel}
        <Empty
          title="Could not read memory configuration"
          hint={missing ? "omp is not installed, so there is nothing to configure yet." : (failure ?? undefined)}
          action={
            <div className="flex items-center gap-2">
              <Button size="xs" onClick={retry}>retry</Button>
              {missing && (
                <Button size="xs" variant="ghost" onClick={() => openSettings("updates")}>
                  install omp from the Updates page
                </Button>
              )}
            </div>
          }
        />
      </div>
    );
  }

  const byKey = new Map(load.snapshot.entries.map((entry) => [entry.key, entry]));
  const entries = MEMORY_SETTING_GROUP.keys
    .map((key) => byKey.get(key))
    .filter((entry): entry is OmpSettingEntry => entry !== undefined);

  return (
    <div className="space-y-3 px-4 py-3">
      <div>
        <p className="text-xs font-medium text-ink">Durable recall configuration</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          Configure what future sessions retain and recall, and inspect the resolved memory banks for the focused project.
        </p>
      </div>
      {overviewPanel}
      {writeError !== null && (
        <p className="rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {writeError}
        </p>
      )}
      {entries.length > 0 && (
        <section>
          <div className="flex items-center gap-2">
            <Label>{MEMORY_SETTING_GROUP.title}</Label>
          </div>
          {MEMORY_SETTING_GROUP.description !== undefined && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
              {MEMORY_SETTING_GROUP.description}
            </p>
          )}
          <div className="mt-1 divide-y divide-line-soft">
            {entries.map((entry) => (
              <Row
                key={entry.key}
                title={entry.key}
                hint={entry.description}
                badge={layerBadge(entry.layer)}
              >
                <SettingControl entry={entry} pendingKey={pendingKey} commit={commit} />
              </Row>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- about */

function AboutPage({ load }: { load: Load }) {
  const appUpdate = useStore((s) => s.appUpdate);
  const ompUpdate = useStore((s) => s.ompUpdate);
  // These facts are otherwise only visible inside update cards that are
  // usually hidden — that is this page's whole reason to exist.
  const rows: Array<[string, string]> = [
    ["omp-ui version", appUpdate.currentVersion ?? "—"],
    ["omp version", ompUpdate.installedVersion ?? "—"],
    ["omp path", ompUpdate.installPath ?? "—"],
    [
      "omp config dir",
      load.status === "loaded" ? (load.snapshot.agentDir ?? "—") : "—",
    ],
  ];

  return (
    <div className="px-4 py-3">
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="col-span-2 grid grid-cols-subgrid items-baseline"
          >
            <dt className="text-[11px] text-ink-faint">{label}</dt>
            <dd
              className="min-w-0 truncate font-mono text-[11px] text-ink-mid"
              title={value}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

export function Settings() {
  const page = useStore((s) => s.settingsPage) ?? "general";
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const readOmpSettings = useStore((s) => s.readOmpSettings);
  const writeOmpSetting = useStore((s) => s.writeOmpSetting);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const anyLive = useStore(
    (s) =>
      s.state?.projects.some((g) =>
        g.sessions.some((x) => x.live === "live"),
      ) ?? false,
  );

  const projectCwd =
    tabs.find((t) => t.tabId === activeTabId)?.projectCwd ?? null;

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  /** Key of the setting with a write in flight; its control stays disabled. */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    readOmpSettings(projectCwd).then(
      (snapshot) => {
        if (g === gen.current) setLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => {
        if (g === gen.current)
          setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [readOmpSettings, projectCwd, reloadKey]);

  const commit = (key: string, value: OmpSettingValue): void => {
    setPendingKey(key);
    writeOmpSetting(key, value)
      .then(
        () => {
          setWriteError(null);
          // The re-read is the single source of truth for values and layer
          // badges — nothing is patched optimistically.
          setReloadKey((k) => k + 1);
        },
        (err: unknown) => setWriteError(displayMessage(err)),
      )
      .finally(() => setPendingKey(null));
  };

  const agentDir = load.status === "loaded" ? load.snapshot.agentDir : null;

  let footer: ReactNode = null;
  if (page === "general") {
    footer = (
      <p>
        Default session and agent modes apply to new sessions; everything else
        applies immediately.
      </p>
    );
  } else if (page === "updates") {
    // Auto-download is deliberately absent: both download paths end in an
    // installer launch or an app restart.
    footer = <p>Downloads always need a click.</p>;
  } else if (page === "remote") {
    // Load-bearing honesty: installability and offline are secure-context-only, so a plain
    // http://<lan-ip> origin cannot have them no matter what the manifest says.
    footer = (
      <p>
        Over localhost the app is a full browser app. Over your local network it
        works as a responsive web app, but browsers reserve installability and
        offline support for secure origins — plain{" "}
        <span className="font-mono">http://&lt;lan-ip&gt;</span> is not one, so
        there is no install prompt until you front this with your own HTTPS (a
        TLS terminator, or Tailscale serve). Changing anything here restarts
        only the server; sessions keep running.
      </p>
    );
  } else if (page === "providers") {
    // Load-bearing: keys bind at process start, and a GUI launch inherits none
    // of the user's shell exports — the two facts that make this page exist.
    footer = (
      <p>
        omp reads credentials from the environment, so omp-ui supplies these to
        every session it launches — a key added here takes effect on the next
        session spawn.
        {anyLive && " Restart a session from its MCP panel to apply now."} Keys
        already exported by your shell profile are picked up automatically, and
        a project&apos;s <span className="font-mono">.env</span> is loaded by
        omp itself, so both are shown here but neither needs re-entering.
      </p>
    );
  } else if (page === "memory") {
    footer = (
      <p>
        Writes go to omp&apos;s global config (
        <span className="font-mono">{agentDir ?? "…"}/config.yml</span>); a
        project&apos;s <span className="font-mono">.omp/config.yml</span> can win
        and is shown as <span className="font-mono">project</span>. Memory
        configuration applies to sessions started after the change.
      </p>
    );
  } else if (page === "omp") {
    // Load-bearing per ADR-0005: where writes land, which layer wins, and when
    // they take effect. omp regenerates its YAML on write, so hand-written
    // comments in config.yml do not survive an edit from here.
    footer = (
      <p>
        Writes go to omp&apos;s global config (
        <span className="font-mono">{agentDir ?? "…"}/config.yml</span>); a
        project&apos;s <span className="font-mono">.omp/config.yml</span> still
        wins and is shown as <span className="font-mono">project</span>. omp
        binds model roles and the advisor at process start — changes take effect
        on the next session spawn.
        {anyLive && " Restart a session from its MCP panel to apply now."} omp
        regenerates its YAML on write, so comments in config.yml are dropped.
      </p>
    );
  }

  return (
    <Modal onClose={closeSettings} width="w-[46rem]">
      <section
        className="settings-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-header border-b border-line px-4 py-3.5">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            Application
          </p>
          <h2
            id="settings-title"
            className="font-display text-base font-semibold text-ink"
          >
            Settings
          </h2>
        </header>

        <div className="settings-layout flex">
          <nav className="settings-nav w-40 shrink-0 space-y-px border-r border-line p-1.5">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-current={page === p.id ? "page" : undefined}
                onClick={() => openSettings(p.id)}
                className={cn(
                  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors duration-150",
                  "hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none",
                  page === p.id ? "bg-hover text-ink" : "text-ink-mid",
                )}
              >
                {p.label}
              </button>
            ))}
          </nav>

          <div className="settings-body max-h-[30rem] min-w-0 flex-1 overflow-y-auto">
            {page === "general" && <GeneralPage />}
            {page === "appearance" && <AppearancePage />}
            {page === "updates" && <UpdatesPage />}
            {page === "remote" && <RemotePage />}
            {page === "providers" && <ProvidersPage projectCwd={projectCwd} />}
            {page === "memory" && (
              <MemoryPage
                load={load}
                projectCwd={projectCwd}
                pendingKey={pendingKey}
                writeError={writeError}
                commit={commit}
                retry={() => setReloadKey((revision) => revision + 1)}
                overviewRevision={reloadKey}
              />
            )}
            {page === "omp" && (
              <OmpPage
                load={load}
                projectCwd={projectCwd}
                pendingKey={pendingKey}
                writeError={writeError}
                commit={commit}
                retry={() => setReloadKey((k) => k + 1)}
              />
            )}
            {page === "about" && <AboutPage load={load} />}
          </div>
        </div>

        {footer !== null && (
          <footer className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-ink-faint">
            {footer}
          </footer>
        )}
      </section>
    </Modal>
  );
}
