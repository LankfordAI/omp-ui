import {
  CH,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  IMPORTED_THEMES_MAX,
  importVsCodeThemeFiles,
  parseFleetProjectRoots,
  type AgentMode,
  type GlassChrome,
  type PlanFormat,
  type PlacementPreference,
  type FleetRung,
  type Registry,
  type RequestHandlers,
  type RegistrySettings,
  type SessionMode,
  type ThemeMode,
  type VsCodeImportResult,
  type VsCodeThemeFileInput,
  type TranscriptWidth,
  type UpdateTrain,
  type VaultNoteVoice,
} from "@omp-ui/core";

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
  | typeof CH.setDefaultAdvisor
  | typeof CH.setDefaultAutoThinking
  | typeof CH.setSubagentModelInheritByDefault
  | typeof CH.setSkipDeleteConfirmation
  | typeof CH.setSkipTerminateConfirmation
  | typeof CH.setGettingStartedSeen
  | typeof CH.setExperimentsEnabled
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
  | typeof CH.removeImportedTheme
  | typeof CH.setFontFamilyId
  | typeof CH.setTranscriptWidth
  | typeof CH.setGlassChrome
  | typeof CH.setLocaleId
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
    [CH.setDefaultAdvisor]: (value: boolean) => commit("defaultAdvisor", value),
    [CH.setDefaultAutoThinking]: (value: boolean) => commit("defaultAutoThinking", value),
    [CH.setSubagentModelInheritByDefault]: (value: boolean) =>
      commit("subagentModelInheritByDefault", value),
    [CH.setSkipDeleteConfirmation]: (value: boolean) => commit("skipDeleteConfirmation", value),
    [CH.setSkipTerminateConfirmation]: (value: boolean) => commit("skipTerminateConfirmation", value),
    [CH.setGettingStartedSeen]: (value: boolean) => commit("gettingStartedSeen", value),
    [CH.setExperimentsEnabled]: (value: boolean) => commit("experimentsEnabled", value),
    [CH.setSnoozedSectionEnabled]: (value: boolean) => commit("snoozedSectionEnabled", value),
    [CH.setAutoSettleMergedPullRequests]: (value: boolean) => commit("autoSettleMergedPullRequests", value),
    [CH.setRemoteVsCodeEnabled]: (value: boolean) => commit("remoteVsCodeEnabled", value),
    [CH.setVoiceInputEnabled]: (value: boolean) => commit("voiceInputEnabled", value),
    [CH.setSttModel]: (value: string | null) => commit("sttModel", value),
    [CH.setThemeId]: (value: string) => commit("themeId", value),
    [CH.setThemeMode]: (value: ThemeMode) => commit("themeMode", value),
    [CH.setLightThemeId]: (value: string) => commit("lightThemeId", value),
    [CH.setDarkThemeId]: (value: string) => commit("darkThemeId", value),
    // The host re-runs the same mapping and gate the page previewed: a remote
    // client cannot store a theme that fails contrast (issue #999).
    [CH.importVsCodeTheme]: async (files: VsCodeThemeFileInput[]): Promise<VsCodeImportResult> => {
      const result = importVsCodeThemeFiles(files);
      if (!result.ok) return result;
      const rest = deps.registry.getSetting("importedThemes").filter((t) => t.id !== result.source.id);
      if (rest.length >= IMPORTED_THEMES_MAX) {
        return {
          ok: false,
          reason: "parse",
          message: `at most ${IMPORTED_THEMES_MAX} imported themes can be kept; remove one first`,
        };
      }
      await commit("importedThemes", [...rest, result.source]);
      return result;
    },
    // Picks naming the removed theme fall back to their defaults, so the
    // registry never points at a theme that no longer exists.
    [CH.removeImportedTheme]: async (id: string) => {
      const reg = deps.registry;
      reg.setSetting("importedThemes", reg.getSetting("importedThemes").filter((t) => t.id !== id));
      if (reg.getSetting("themeId") === id) reg.setSetting("themeId", DEFAULT_THEME_ID);
      if (reg.getSetting("darkThemeId") === id) reg.setSetting("darkThemeId", DEFAULT_THEME_ID);
      if (reg.getSetting("lightThemeId") === id) reg.setSetting("lightThemeId", DEFAULT_LIGHT_THEME_ID);
      await deps.broadcast();
    },
    [CH.setFontFamilyId]: (value: string) => commit("fontFamilyId", value),
    [CH.setTranscriptWidth]: (value: TranscriptWidth) => commit("transcriptWidth", value),
    [CH.setGlassChrome]: (value: GlassChrome) => commit("glassChrome", value),
    [CH.setLocaleId]: (value: string) => commit("localeId", value),
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
