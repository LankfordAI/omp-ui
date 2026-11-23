import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { OMP_MODEL_ROLES_KEY, OMP_SETTING_GROUPS } from "@omp-ui/core/omp-settings-keys";
import { findRecord, sessionCwd, useStore } from "../../store";
import { Button, Empty, Label } from "../ui";
import { Row, SettingControl, layerBadge } from "./rows";
import { OMP_MISSING, type FooterContext, type Load } from "./types";
import {
  AGENT_PREWALK_AUTO_KEY,
  APPROVAL_SETTING_KEY,
  COMPOSER_PREDICTION_ALTERNATIVES_KEY,
  COMPOSER_PREDICTIONS_KEY,
  CONTEXT_FILES_EXTRA_KEY,
  LIVE_VOICE_SETTING_KEY,
  OMP_MAX_CONCURRENCY_KEY,
  OMP_SUBAGENT_MODELS_KEY,
  SESSION_MAX_COST_KEY,
  SESSION_WARN_COST_KEY,
  SPEECH_SPEED_SETTING_KEY,
  RESTRICTED_FOLDERS_KEY,
  TTS_LOCAL_SPEED_SETTING_KEY,
  STATUS_LINE_SEGMENT_OPTIONS_KEY,
  TOOL_APPROVAL_POLICIES_KEY,
  UNPAUSED_PROVIDERS_KEY,
} from "@omp-ui/core/omp-settings-keys";
import { ModelRolesSection } from "./ModelRolesSection";
import { SubagentModelsSection } from "./SubagentModelsSection";
import { SubagentConcurrencySection } from "./SubagentConcurrencySection";
import { SpendCapSection } from "./SpendCapSection";
import { ApprovalModeSection } from "./ApprovalModeSection";
import { RestrictedFoldersSection } from "./RestrictedFoldersSection";
import { ComputerControlSection } from "./ComputerControlSection";
import { ContextFilesSection } from "./ContextFilesSection";
import { LiveVoiceSection } from "./LiveVoiceSection";
import { StatusLineSection } from "./StatusLineSection";
import { ComposerPredictionSection } from "./ComposerPredictionSection";
import { UnpausedProvidersSection } from "./UnpausedProvidersSection";
import { AgentPrewalkAutoSection } from "./AgentPrewalkAutoSection";

// Localized hints that replace omp's own description for rows whose copy the
// UI must state regardless of the installed binary's wording (#1063).
const ROW_HINTS: Partial<Record<string, string>> = {
  textVerbosity: "How long omp's written answers run. omp 18.17 flipped the default to low, and it now applies to Codex too — shorter answers that finish sooner. medium restores the previous answer length. Changes apply to sessions started afterwards.",
  "task.workerThreads": "Caps the worker THREADS subagents run on (default 4), not how many subagents may run at once. Up to 8 concurrent subagents stay on the main thread; a worker joins at 9 and one more at each doubling (18, 36, 72). 0 keeps every subagent on the main thread — it does not mean unlimited. Changes apply to sessions started afterwards.",
  "edit.mode": "Selects the edit tool's dialect. magic takes described changes — Markdown bullets of what to change, per file — and a fast model writes and applies the patch; pick its model on the edit.magic.model row (empty = the smol role). none removes only the edit tool; bash stays available and is force-enabled even when bash.enabled is off. This is not a read-only or safety mode. With none, whole-file rewrites via write carry no structured diff, so change receipts and diff cards degrade; review depends on later repository diffs. Changes apply to sessions started afterwards.",
  // omp's own description cannot say this is transport, not live steering.
  "providers.openaiResponsesWebsockets":
    "Sends catalog-supported standard Responses traffic over WebSockets instead of HTTP/SSE, falling back to HTTP/SSE automatically when a connection fails. This is TRANSPORT only — it is not live steering, which stays on its own row. A model or request that sets it false is unaffected. Changes apply to sessions started afterwards.",
};

export function OmpPage({
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
  const state = useStore((s) => s.state);
  const openCapabilitiesViewer = useStore((s) => s.openCapabilitiesViewer);
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

  const tab =
    activeTabId === null
      ? undefined
      : tabs.find((tab) => tab.tabId === activeTabId);
  // The manager pins to the focused tab, so it resolves at that session's own
  // working tree — a worktree session's checkout (#325).
  const scopeCwd = tab === undefined ? undefined : sessionCwd(findRecord(state, tab.tabId));
  const mcpReady = scopeCwd !== undefined && scopeCwd !== "";

  return (
    <div className="pb-1.5">
      {projectCwd === null && (
        <p className="px-4 pt-3 text-xs text-ink-faint">
          No session focused — showing omp's global configuration.
        </p>
      )}
      {writeError !== null && (
        <p className="mx-4 mt-3 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {writeError}
        </p>
      )}

      <SpendCapSection
        warnEntry={byKey.get(SESSION_WARN_COST_KEY)}
        maxEntry={byKey.get(SESSION_MAX_COST_KEY)}
        projectCwd={projectCwd}
        pendingKey={pendingKey}
        commit={commit}
        retry={retry}
      />

      {rolesEntry !== undefined && (
        <ModelRolesSection entry={rolesEntry} pendingKey={pendingKey} commit={commit} />
      )}

      <SubagentModelsSection
        entry={byKey.get(OMP_SUBAGENT_MODELS_KEY)}
        projectCwd={projectCwd}
        pendingKey={pendingKey}
        commit={commit}
        retry={retry}
      />

      <SubagentConcurrencySection
        entry={byKey.get(OMP_MAX_CONCURRENCY_KEY)}
        projectCwd={projectCwd}
        pendingKey={pendingKey}
        commit={commit}
        retry={retry}
      />

      <ApprovalModeSection
        entry={byKey.get(APPROVAL_SETTING_KEY)}
        projectCwd={projectCwd}
        tabId={activeTabId}
        pendingKey={pendingKey}
        commit={commit}
        retry={retry}
      />

      <ComputerControlSection
        entry={byKey.get(TOOL_APPROVAL_POLICIES_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

      <RestrictedFoldersSection
        entry={byKey.get(RESTRICTED_FOLDERS_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

      <ContextFilesSection
        entry={byKey.get(CONTEXT_FILES_EXTRA_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

      <UnpausedProvidersSection
        entry={byKey.get(UNPAUSED_PROVIDERS_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

      <AgentPrewalkAutoSection
        entry={byKey.get(AGENT_PREWALK_AUTO_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

      <LiveVoiceSection
        entry={byKey.get(LIVE_VOICE_SETTING_KEY)}
        speechSpeedEntry={byKey.get(SPEECH_SPEED_SETTING_KEY)}
        localSpeedEntry={byKey.get(TTS_LOCAL_SPEED_SETTING_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

      <StatusLineSection
        entry={byKey.get(STATUS_LINE_SEGMENT_OPTIONS_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

      <ComposerPredictionSection
        masterEntry={byKey.get(COMPOSER_PREDICTIONS_KEY)}
        alternativesEntry={byKey.get(COMPOSER_PREDICTION_ALTERNATIVES_KEY)}
        pendingKey={pendingKey}
        commit={commit}
      />

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
              <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
                {group.description}
              </p>
            )}
            <div className="mt-1 divide-y divide-line-soft">
              {entries.map((entry) => (
                <Row
                  key={entry.key}
                  title={entry.key}
                  hint={
                    ROW_HINTS[entry.key] ?? entry.description
                  }
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
        <p className="text-xs text-ink-faint">
          MCP servers resolve per project from native and translated tool configs (issue #36); the global list applies to every project.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            disabled={!mcpReady}
            title={mcpReady ? undefined : "focus a session tab first — the viewer pins to it"}
            onClick={() => {
              if (tab === undefined || scopeCwd === undefined) return;
              // One modal at a time: stacked Escape listeners would close both.
              closeSettings();
              openCapabilitiesViewer(scopeCwd, tab.tabId, "mcp");
            }}
          >
            Session capabilities
          </Button>
          <Button size="xs" onClick={() => { closeSettings(); openCapabilitiesViewer(null, undefined, "mcp"); }}>
            Global MCP servers…
          </Button>
        </div>
      </div>
    </div>
  );
}

export function OmpFooter({ agentDir, anyLive }: FooterContext) {
  // Load-bearing per ADR-0005: where writes land, which layer wins, and when
  // they take effect. omp regenerates its YAML on write, so hand-written
  // comments in config.yml do not survive an edit from here.
  return (
    <p>
      Writes go to omp's global config (
      <span className="font-mono">{agentDir ?? "…"}/config.yml</span>
      {"); a project's "}
      <span className="font-mono">.omp/config.yml</span>
      {" still wins and is shown as "}
      <span className="font-mono">project</span>
      . omp binds model roles and the advisor at process start — changes take effect on the next session spawn.
      {anyLive && " Restart a session from its MCP panel to apply now."}
      {" omp regenerates its YAML on write, so comments in config.yml are dropped."}
    </p>
  );
}
