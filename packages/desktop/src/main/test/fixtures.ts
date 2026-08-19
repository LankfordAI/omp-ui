import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentMode,
  OwnedSessionRecord,
  PlanFormat,
  ProjectRecord,
  RemoteBind,
  SessionMode,
} from "@omp-ui/core";

interface RegistrySettings {
  defaultMode: SessionMode;
  defaultAgentMode: AgentMode;
  planFormat: PlanFormat;
  advisorAutoReply: boolean;
  defaultAdvisor: boolean;
  modelFavorites: string[];
  skipDeleteConfirmation: boolean;
  dismissedAppUpdateVersion: string | null;
  dismissedOmpUpdateVersion: string | null;
  themeId: string;
  appUpdateCheckOnLaunch: boolean;
  ompUpdateCheckOnLaunch: boolean;
  remoteEnabled: boolean;
  remoteBind: RemoteBind;
  remotePort: number;
  remoteToken: string;
  remotePasswordHash: string;
  remotePasswordSalt: string;
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
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "rpc-ui",
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    ...patch,
  };
}

export function seedRegistry(file: string, patch: RegistrySeedPatch = {}): void {
  const settings: RegistrySettings = {
    defaultMode: "rpc-ui",
    defaultAgentMode: "plan",
    planFormat: "html",
    advisorAutoReply: true,
    defaultAdvisor: false,
    modelFavorites: [],
    skipDeleteConfirmation: false,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    themeId: "graphite",
    appUpdateCheckOnLaunch: true,
    ompUpdateCheckOnLaunch: true,
    remoteEnabled: false,
    remoteBind: "localhost",
    remotePort: 4677,
    remoteToken: "",
    remotePasswordHash: "",
    remotePasswordSalt: "",
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
