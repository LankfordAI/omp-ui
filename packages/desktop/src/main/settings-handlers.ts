import { randomUUID } from "node:crypto";
import {
  CH,
  importVsCodeThemeFiles,
  normalizeKeybindingOverrides,
  parseFleetProjectRoots,
  sniffBackdropMime,
  type AgentMode,
  type GlassChrome,
  type KeybindingOverrides,
  type PlanFormat,
  type PlacementPreference,
  type FleetRung,
  type Registry,
  type RequestHandlers,
  type RegistrySettings,
  type SessionMode,
  type RepositoryThemeInstallRequest,
  type StoredThemeDraft,
  type ThemeBackdropBytes,
  type ThemeMode,
  type VsCodeImportResult,
  type VsCodeThemeFileInput,
  type TranscriptWidth,
  type UpdateTrain,
  type VaultNoteVoice,
  type RoutineSpendDefaultsInput,
} from "@omp-ui/core";
import {
  commitStoredTheme,
  removeStoredTheme,
  saveStoredTheme,
  setOfficialThemes,
  setStoredThemeMotion,
  type StoredThemeDeps,
} from "./stored-themes";
import type { ThemeRepositoryService } from "./theme-repositories";
import { ROUTINES_DISABLED_ERROR } from "./routine-scheduler";

type SettingsHandlerChannels =
  | typeof CH.setDefaultMode
  | typeof CH.setDefaultAgentMode
  | typeof CH.listCompactionMethods
  | typeof CH.setDefaultCompactionMethod
  | typeof CH.setPlanFormat
  | typeof CH.setHibernateIdleMinutes
  | typeof CH.setStreamStallAbortSeconds
  | typeof CH.setAdvisorAutoReply
  | typeof CH.setStallAutoContinue
  | typeof CH.setDesktopNotifications
  | typeof CH.setHtmlArtifactScripts
  | typeof CH.setArtifactLibraryEnabled
  | typeof CH.setDeviceAgentAccess
  | typeof CH.setTelemetryModelsEnabled
  | typeof CH.setTelemetryThemesEnabled
  | typeof CH.setDefaultAdvisor
  | typeof CH.setDefaultAutoThinking
  | typeof CH.setSubagentModelInheritByDefault
  | typeof CH.setSkipDeleteConfirmation
  | typeof CH.setSkipTerminateConfirmation
  | typeof CH.setGettingStartedSeen
  | typeof CH.setExperimentsEnabled
  | typeof CH.setAutoresearchEnabled
  | typeof CH.setRoutinesEnabled
  | typeof CH.setRoutineSpendDefaults
  | typeof CH.setCouncilEnabled
  | typeof CH.setSnoozedSectionEnabled
  | typeof CH.setAutoSettleMergedPullRequests
  | typeof CH.setRemoteVsCodeEnabled
  | typeof CH.setVoiceInputEnabled
  | typeof CH.setSttModel
  | typeof CH.setThemeId
  | typeof CH.setThemeMode
  | typeof CH.setLightThemeId
  | typeof CH.setDarkThemeId
  | typeof CH.importVsCodeTheme
  | typeof CH.saveStoredTheme
  | typeof CH.removeStoredTheme
  | typeof CH.readThemeBackdrop
  | typeof CH.addThemeRepository
  | typeof CH.removeThemeRepository
  | typeof CH.browseThemeRepository
  | typeof CH.installRepositoryTheme
  | typeof CH.previewRepositoryThemeBackdrop
  | typeof CH.setStoredThemeMotion
  | typeof CH.setOfficialThemes
  | typeof CH.setBackdropMotion
  | typeof CH.setThemeAgentAccess
  | typeof CH.setIssueAgentAccess
  | typeof CH.setFontFamilyId
  | typeof CH.setTranscriptWidth
  | typeof CH.setGlassChrome
  | typeof CH.setKeybindings
  | typeof CH.setAppUpdateCheckOnLaunch
  | typeof CH.setAppUpdateTrain
  | typeof CH.setOmpUpdateCheckOnLaunch
  | typeof CH.setOmpAutoUpgrade
  | typeof CH.setVaultNoteVoice
  | typeof CH.setFleetPlacement
  | typeof CH.setFleetAgentDispatch
  | typeof CH.setFleetExecEnabled
  | typeof CH.setFleetExecCeiling
  | typeof CH.setFleetProjectRoots;

interface SettingsHandlerDependencies {
  registry: Registry;
  broadcast: () => Promise<void>;
  supportedCompactionMethods: () => Promise<string[]>;
  onAppUpdateTrainChanged: () => Promise<void>;
  /** Exec switch or ceiling moved: revoke detached execs that lost Full control (issue #905). */
  onFleetLadderChanged: () => void;
  /** Sharing preference changed: synchronously cancel revoked delivery before broadcasting. */
  onTelemetryChanged: () => void;
  /** Revoke synchronously; roster reconciliation must not delay authoritative state. */
  onArtifactLibraryChanged?: (enabled: boolean) => void;
  /** Routines gate moved (ADR-0100): park or resume timers and the clock; never reaps. */
  onRoutinesEnabledChanged?: (enabled: boolean) => void;
  /** Default routine spend caps moved: republish `routines:state`. */
  onRoutineSpendDefaultsChanged?: () => void;
  /** Council graduation (amends #1055): seed the global roster from favorites. */
  seedCouncilRoster: () => Promise<void>;
  /** The one stored-theme save path (issue #1168); the host tool reuses the same object. */
  themes: StoredThemeDeps;
  /** Theme repositories (#1178): the list, cached listings, and the install route. */
  themeRepositories: ThemeRepositoryService;
}

export function registerSettingsHandlers(
  deps: SettingsHandlerDependencies,
): Pick<RequestHandlers, SettingsHandlerChannels> {
  const commit = async <K extends keyof RegistrySettings>(
    key: K,
    value: RegistrySettings[K],
  ): Promise<void> => {
    deps.registry.setSetting(key, value);
    await deps.broadcast();
  };

  return {
    [CH.setDefaultMode]: (value: SessionMode) => commit("defaultMode", value),
    [CH.listCompactionMethods]: () => deps.supportedCompactionMethods(),
    [CH.setDefaultAgentMode]: (value: AgentMode) => commit("defaultAgentMode", value),
    [CH.setDefaultCompactionMethod]: async (method: string | null) => {
      if (method !== null) {
        const supported = await deps.supportedCompactionMethods();
        if (!supported.includes(method)) throw new Error(`Unsupported compaction method: ${method}`);
      }
      await commit("defaultCompactionMethod", method);
    },
    [CH.setPlanFormat]: (value: PlanFormat) => commit("planFormat", value),
    [CH.setHibernateIdleMinutes]: (value: number) => commit("hibernateIdleMinutes", value),
    [CH.setStreamStallAbortSeconds]: (value: number) => commit("streamStallAbortSeconds", value),
    [CH.setAdvisorAutoReply]: (value: boolean) => commit("advisorAutoReply", value),
    [CH.setStallAutoContinue]: (value: boolean) => commit("stallAutoContinue", value),
    [CH.setDesktopNotifications]: (value: boolean) => commit("desktopNotifications", value),
    [CH.setHtmlArtifactScripts]: (value: boolean) => commit("htmlArtifactScripts", value),
    [CH.setArtifactLibraryEnabled]: async (value: boolean) => {
      deps.registry.setSetting("artifactLibraryEnabled", value);
      try { deps.onArtifactLibraryChanged?.(value); }
      finally { await deps.broadcast(); }
    },
    [CH.setDeviceAgentAccess]: (value: boolean) => commit("deviceAgentAccess", value),
    [CH.setTelemetryModelsEnabled]: async (value: boolean) => {
      deps.registry.setSetting("telemetryModelsEnabled", value);
      deps.onTelemetryChanged();
      await deps.broadcast();
    },
    [CH.setTelemetryThemesEnabled]: async (on: boolean) => {
      const consentId = on ? deps.registry.getSetting("telemetryThemesConsentId") ?? randomUUID() : null;
      deps.registry.setSetting("telemetryThemesConsentId", consentId);
      deps.onTelemetryChanged();
      await deps.broadcast();
    },
    [CH.setDefaultAdvisor]: (value: boolean) => commit("defaultAdvisor", value),
    [CH.setDefaultAutoThinking]: (value: boolean) => commit("defaultAutoThinking", value),
    [CH.setSubagentModelInheritByDefault]: (value: boolean) =>
      commit("subagentModelInheritByDefault", value),
    [CH.setSkipDeleteConfirmation]: (value: boolean) => commit("skipDeleteConfirmation", value),
    [CH.setSkipTerminateConfirmation]: (value: boolean) => commit("skipTerminateConfirmation", value),
    [CH.setGettingStartedSeen]: (value: boolean) => commit("gettingStartedSeen", value),
    [CH.setExperimentsEnabled]: (value: boolean) => commit("experimentsEnabled", value),
    [CH.setAutoresearchEnabled]: (value: boolean) => commit("autoresearchEnabled", value),
    [CH.setRoutinesEnabled]: async (value: boolean) => {
      deps.registry.setSetting("routinesEnabled", value);
      try { deps.onRoutinesEnabledChanged?.(value); }
      finally { await deps.broadcast(); }
    },
    // Edited only while the gate is on (ADR-0100 §9); the codec bounds both caps.
    [CH.setRoutineSpendDefaults]: async (value: RoutineSpendDefaultsInput) => {
      if (!deps.registry.getSetting("routinesEnabled")) throw new Error(ROUTINES_DISABLED_ERROR);
      deps.registry.setSetting("routineWarnCostUsd", value.warnUsd);
      deps.registry.setSetting("routineMaxCostUsd", value.maxUsd);
      deps.onRoutineSpendDefaultsChanged?.();
      await deps.broadcast();
    },
    // Seed before committing so the editor rendered after the flip shows the
    // roster (#1055 ordering preserved).
    [CH.setCouncilEnabled]: async (value: boolean) => {
      if (value) await deps.seedCouncilRoster();
      await commit("councilEnabled", value);
    },
    [CH.setSnoozedSectionEnabled]: (value: boolean) => commit("snoozedSectionEnabled", value),
    [CH.setAutoSettleMergedPullRequests]: (value: boolean) => commit("autoSettleMergedPullRequests", value),
    [CH.setRemoteVsCodeEnabled]: (value: boolean) => commit("remoteVsCodeEnabled", value),
    [CH.setVoiceInputEnabled]: (value: boolean) => commit("voiceInputEnabled", value),
    [CH.setSttModel]: (value: string | null) => commit("sttModel", value),
    [CH.setThemeId]: (value: string) => commit("themeId", value),
    [CH.setThemeMode]: (value: ThemeMode) => commit("themeMode", value),
    [CH.setLightThemeId]: (value: string) => commit("lightThemeId", value),
    [CH.setDarkThemeId]: (value: string) => commit("darkThemeId", value),
    // The host re-runs the same mapping and gate the page previewed, then
    // stores through the shared save path: a remote client cannot store a
    // theme that fails contrast (issues #999, #1168). A same-id re-import
    // replaces in place.
    [CH.importVsCodeTheme]: async (files: VsCodeThemeFileInput[]): Promise<VsCodeImportResult> => {
      const result = importVsCodeThemeFiles(files);
      if (!result.ok) return result;
      // commitStoredTheme never gates (the import already ran the contrast
      // gate); its only refusal is the shared cap.
      const saved = await commitStoredTheme(deps.themes, result.source);
      if (!saved.ok && saved.reason === "invalid") return { ok: false, reason: "parse", message: saved.message };
      return result;
    },
    [CH.saveStoredTheme]: (draft: StoredThemeDraft) => saveStoredTheme(deps.themes, draft),
    [CH.removeStoredTheme]: (id: string) => removeStoredTheme(deps.themes, id),
    [CH.readThemeBackdrop]: async (assetHash: string): Promise<ThemeBackdropBytes | null> => {
      const bytes = await deps.themes.backdrops.read(assetHash);
      if (bytes === null) return null;
      return { mime: sniffBackdropMime(bytes) ?? "image/png", data: Buffer.from(bytes).toString("base64") };
    },
    [CH.addThemeRepository]: (input: string) => deps.themeRepositories.add(input),
    [CH.removeThemeRepository]: (repository: string) => deps.themeRepositories.remove(repository),
    [CH.browseThemeRepository]: (repository: string, refresh: boolean) =>
      deps.themeRepositories.browse(repository, refresh),
    [CH.installRepositoryTheme]: (request: RepositoryThemeInstallRequest) => deps.themeRepositories.install(request),
    [CH.previewRepositoryThemeBackdrop]: (request: RepositoryThemeInstallRequest) =>
      deps.themeRepositories.previewBackdrop(request),
    [CH.setStoredThemeMotion]: (id: string, on: boolean) => setStoredThemeMotion(deps.themes, id, on),
    [CH.setOfficialThemes]: (value: boolean) => setOfficialThemes(deps.themes, value),
    [CH.setBackdropMotion]: (value: boolean) => commit("backdropMotion", value),
    [CH.setThemeAgentAccess]: (value: boolean) => commit("themeAgentAccess", value),
    [CH.setIssueAgentAccess]: (value: boolean) => commit("issueAgentAccess", value),
    [CH.setFontFamilyId]: (value: string) => commit("fontFamilyId", value),
    [CH.setTranscriptWidth]: (value: TranscriptWidth) => commit("transcriptWidth", value),
    [CH.setGlassChrome]: (value: GlassChrome) => commit("glassChrome", value),
    // The codec already refused conflicts and reserved chords; defaults drop
    // so the registry stores only what the user changed.
    [CH.setKeybindings]: (value: KeybindingOverrides) =>
      commit("keybindings", normalizeKeybindingOverrides(value)),
    [CH.setAppUpdateCheckOnLaunch]: (value: boolean) => commit("appUpdateCheckOnLaunch", value),
    [CH.setAppUpdateTrain]: async (value: UpdateTrain) => {
      deps.registry.setSetting("appUpdateTrain", value);
      await deps.onAppUpdateTrainChanged();
      await deps.broadcast();
    },
    [CH.setOmpUpdateCheckOnLaunch]: (value: boolean) => commit("ompUpdateCheckOnLaunch", value),
    [CH.setOmpAutoUpgrade]: (value: boolean) => commit("ompAutoUpgrade", value),
    [CH.setVaultNoteVoice]: (value: VaultNoteVoice) => commit("vaultNoteVoice", value),
    // Always a new object (setSetting is an Object.is no-op); "normal" is the absent default.
    [CH.setFleetPlacement]: (machineKey: string, pref: PlacementPreference) => {
      const { [machineKey]: _previous, ...rest } = deps.registry.getSetting("fleetPlacement");
      return commit("fleetPlacement", pref === "normal" ? rest : { ...rest, [machineKey]: pref });
    },
    [CH.setFleetAgentDispatch]: (value: boolean) => commit("fleetAgentDispatch", value),
    // The ladder is re-read per request, so flipping exec off lands instantly;
    // running detached execs are re-checked before the broadcast, so a slow or
    // failing state build cannot leave a revoked one running (issue #905).
    [CH.setFleetExecEnabled]: async (value: boolean) => {
      deps.registry.setSetting("fleetExecEnabled", value);
      deps.onFleetLadderChanged();
      await deps.broadcast();
    },
    [CH.setFleetExecCeiling]: async (value: FleetRung) => {
      deps.registry.setSetting("fleetExecCeiling", value);
      deps.onFleetLadderChanged();
      await deps.broadcast();
    },
    // The parser is the sanitizer: non-absolute or control-char rows drop.
    [CH.setFleetProjectRoots]: (roots: string[]) => commit("fleetProjectRoots", parseFleetProjectRoots(roots)),
  };
}
