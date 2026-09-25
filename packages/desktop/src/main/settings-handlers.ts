import {
  CH,
  type AgentMode,
  type GlassChrome,
  type PlanFormat,
  type Registry,
  type RequestHandlers,
  type RegistrySettings,
  type SessionMode,
  type TranscriptWidth,
  type UpdateTrain,
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
  | typeof CH.setDefaultAdvisor
  | typeof CH.setSubagentModelInheritByDefault
  | typeof CH.setSkipDeleteConfirmation
  | typeof CH.setGettingStartedSeen
  | typeof CH.setExperimentsEnabled
  | typeof CH.setVoiceInputEnabled
  | typeof CH.setSttModel
  | typeof CH.setThemeId
  | typeof CH.setFontFamilyId
  | typeof CH.setTranscriptWidth
  | typeof CH.setGlassChrome
  | typeof CH.setLocaleId
  | typeof CH.setAppUpdateCheckOnLaunch
  | typeof CH.setAppUpdateTrain
  | typeof CH.setOmpUpdateCheckOnLaunch;

interface SettingsHandlerDependencies {
  registry: Registry;
  broadcast: () => Promise<void>;
  supportedCompactionMethods: () => Promise<string[]>;
  onAppUpdateTrainChanged: () => Promise<void>;
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
    [CH.setDefaultAdvisor]: (value: boolean) => commit("defaultAdvisor", value),
    [CH.setSubagentModelInheritByDefault]: (value: boolean) =>
      commit("subagentModelInheritByDefault", value),
    [CH.setSkipDeleteConfirmation]: (value: boolean) => commit("skipDeleteConfirmation", value),
    [CH.setGettingStartedSeen]: (value: boolean) => commit("gettingStartedSeen", value),
    [CH.setExperimentsEnabled]: (value: boolean) => commit("experimentsEnabled", value),
    [CH.setVoiceInputEnabled]: (value: boolean) => commit("voiceInputEnabled", value),
    [CH.setSttModel]: (value: string | null) => commit("sttModel", value),
    [CH.setThemeId]: (value: string) => commit("themeId", value),
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
  };
}
