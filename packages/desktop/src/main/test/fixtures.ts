import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentMode,
  OwnedSessionRecord,
  FleetGrantRecord,
  FleetRung,
  PlacementPreference,
  PlanFormat,
  GlassChrome,
  ProjectRecord,
  RemoteBind,
  SessionMode,
  TranscriptWidth,
} from "@omp-ui/core";

interface RegistrySettings {
  defaultMode: SessionMode;
  defaultAgentMode: AgentMode;
  defaultCompactionMethod: string | null;
  planFormat: PlanFormat;
  streamStallAbortSeconds: number;
  advisorAutoReply: boolean;
  stallAutoContinue: boolean;
  defaultAdvisor: boolean;
  defaultAutoThinking: boolean;
  modelFavorites: string[];
  skipDeleteConfirmation: boolean;
  experimentsEnabled: boolean;
  voiceInputEnabled: boolean;
  liveWorkParking: boolean;
  liveProgressReportMinutes: number | null;
  sttModel: string | null;
  memoryDefaultsSeeded: boolean;
  autoThinkingDefaultSeeded: boolean;
  hibernateManualDefaultSeeded: boolean;
  reviewRoster: unknown;
  reviewRosterImported: boolean;
  gettingStartedSeen: boolean;
  dismissedAppUpdateVersion: string | null;
  dismissedOmpUpdateVersion: string | null;
  themeId: string;
  fontFamilyId: string;
  transcriptWidth: TranscriptWidth;
  glassChrome: GlassChrome;
  localeId: string;
  appUpdateCheckOnLaunch: boolean;
  appUpdateTrain: "stable" | "nightly";
  vaultRegistry: {
    vaults: Array<{ name: string; path: string; homeFolder: string; allowWritesOutsideHome: boolean }>;
    defaultWriteVault: string | null;
  };
  vaultNoteVoice: "user" | "assistant";
  ompUpdateCheckOnLaunch: boolean;
  ompAutoUpgrade: boolean;
  chatLastModel: string | null;
  chatLastThinkingLevel: string | null;
  remoteEnabled: boolean;
  remoteBind: RemoteBind;
  remotePort: number;
  remoteToken: string;
  remotePasswordHash: string;
  remotePasswordSalt: string;
  instanceId: string;
  fleetPlacement: Record<string, PlacementPreference>;
  fleetAgentDispatch: boolean;
  fleetExecEnabled: boolean;
  fleetExecCeiling: FleetRung;
  fleetGrants: Record<string, FleetGrantRecord>;
  fleetProjectRoots: string[];
}

interface RegistrySeed {
  schemaVersion: 1;
  settings: RegistrySettings;
  projects: ProjectRecord[];
  sessions: OwnedSessionRecord[];
}

interface RegistrySeedPatch {
  settings?: Partial<RegistrySettings>;
  projects?: ProjectRecord[];
  sessions?: OwnedSessionRecord[];
}

export function ownedSessionRecord(
  patch: Partial<OwnedSessionRecord> = {},
): OwnedSessionRecord {
  return {
    tabId: "tab-1",
    sessionId: null,
    lineageDir: "omp-ui--proj--11111111-2222-3333-4444-555555555555",
    projectCwd: "/proj",
    worktree: null,
    planImplementationSource: null, experiment: null, fleet: null,
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "rpc-ui",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    autoTitled: false,
    private: false,
    chat: false,
    askSource: null,
    cachedTitle: null,
    cachedModified: null,
    agentMode: "build",
    ...patch,
  };
}

export function seedRegistry(file: string, patch: RegistrySeedPatch = {}): void {
  const settings: RegistrySettings = {
    defaultMode: "rpc-ui",
    defaultAgentMode: "plan",
    planFormat: "html",
    defaultCompactionMethod: null,
    streamStallAbortSeconds: 180,
    advisorAutoReply: true,
    stallAutoContinue: true,
    defaultAdvisor: false,
    defaultAutoThinking: false,
    // Default true so seeds exercise post-migration registries; tests
    // wanting the legacy shape set it false via the patch.
    autoThinkingDefaultSeeded: true,
    // Default true so seeds exercise post-migration registries (issue #923).
    hibernateManualDefaultSeeded: true,
    modelFavorites: [],
    skipDeleteConfirmation: false,
    experimentsEnabled: false,
    voiceInputEnabled: false,
    liveWorkParking: true,
    liveProgressReportMinutes: null,
    sttModel: null,
    memoryDefaultsSeeded: false,
    reviewRoster: null,
    reviewRosterImported: true,
    // Default false: the boot seed (issue #623) flips it for registries that
    // already carry projects or sessions, exactly like an upgrade does.
    gettingStartedSeen: false,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    themeId: "graphite",
    fontFamilyId: "default",
    transcriptWidth: "wide",
    glassChrome: "subtle",
    localeId: "en",
    appUpdateCheckOnLaunch: true,
    appUpdateTrain: "stable",
    vaultRegistry: { vaults: [], defaultWriteVault: null },
    vaultNoteVoice: "user",
    ompUpdateCheckOnLaunch: true,
    ompAutoUpgrade: true,
    chatLastModel: null,
    chatLastThinkingLevel: null,
    remoteEnabled: false,
    remoteBind: "localhost",
    remotePort: 4677,
    remoteToken: "",
    remotePasswordHash: "",
    remotePasswordSalt: "",
    instanceId: "",
    fleetPlacement: {},
    fleetAgentDispatch: false,
    fleetExecEnabled: false,
    fleetExecCeiling: "dispatch",
    fleetGrants: {},
    fleetProjectRoots: [],
    ...patch.settings,
  };
  settings.modelFavorites = [...settings.modelFavorites];

  const data: RegistrySeed = {
    schemaVersion: 1,
    settings,
    projects: (patch.projects ?? []).map((project) => ({ ...project })),
    sessions: (patch.sessions ?? []).map((session) => ({ ...session })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
