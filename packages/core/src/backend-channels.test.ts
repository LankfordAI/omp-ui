import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BACKEND_CHANNELS,
  CH,
  dispatchNotify,
  dispatchRequest,
  makeBackendClient,
  type BackendChannelSpec,
  type BackendTransport,
  type ChannelTable,
  type NotifyChannel,
  type OmpBackend,
  type RequestChannel,
} from "./backend-channels";
import type { MergeBackStatus, SpawnRequest } from "./types";

type SpecChannel<Kind extends BackendChannelSpec[keyof BackendChannelSpec]["kind"]> = {
  [Method in keyof BackendChannelSpec]: BackendChannelSpec[Method]["kind"] extends Kind
    ? BackendChannelSpec[Method]["channel"]
    : never;
}[keyof BackendChannelSpec];

type InboundMethod = {
  [Method in keyof BackendChannelSpec]: BackendChannelSpec[Method]["kind"] extends
    | "request"
    | "notify"
    ? Method
    : never;
}[keyof BackendChannelSpec];

type MethodArgs<Method extends InboundMethod> = BackendChannelSpec[Method] extends RequestChannel<
  infer Args,
  unknown
>
  ? Args
  : BackendChannelSpec[Method] extends NotifyChannel<infer Args>
    ? Args
    : never;

type RuntimeListener = (...args: never[]) => void;

const spawnRequest: SpawnRequest = {
  origin: "new",
  mode: "rpc-ui",
  projectCwd: "/project",
  advisor: false,
  cols: 120,
  rows: 40,
  worktree: null,
};

const VALID_ARGS = {
  addProject: ["/project"],
  browseDirectories: ["/project"],
  cancelProviderOAuth: [],
  checkAppUpdate: [],
  checkOmpUpdate: [],
  checkoutBranch: ["/project", "feature", { create: true }],
  clearDismissedAppUpdate: [],
  clearDismissedOmpUpdate: [],
  clearProviderKey: ["OPENROUTER_API_KEY"],
  clearRemotePassword: [],
  convertToWorktree: ["tab-1", "feature", null],
  deleteSession: ["tab-1", true],
  deleteSessionPreview: ["tab-1"],
  dismissAppUpdate: ["1.2.3", true],
  dismissOmpUpdate: ["1.2.3", false],
  downloadAppUpdate: [],
  downloadOmpUpdate: [],
  forkSession: ["tab-1"],
  generateTitle: ["/project", "prompt"],
  getAdvisorDefaults: ["/project"],
  getAppUpdateState: [],
  getBranchDiff: ["/project", "main"],
  getMcpServers: [null],
  getMergeBackStatus: ["/project", "feature", null],
  getOmpUpdateState: [],
  getProjectOpenAvailability: [],
  getProviderOAuthState: [],
  getRemoteState: [],
  getState: [],
  hibernatePlanSource: ["source", "implementation"],
  listBranches: ["/project", { fetchUpstream: true }],
  listCompactionMethods: [],
  listProjectFiles: ["/project"],
  memoryOverview: ["/project"],
  mergeWorktreeBranch: ["/project", "feature", "main"],
  moveProject: ["/project", null],
  moveSession: ["tab-1", null],
  openAppUpdateReleaseNotes: [],
  openPath: ["/tmp/transcript.html"],
  openProject: ["/project", "files"],
  ptyPasteImage: ["tab-1", { type: "image", data: "base64", mimeType: "image/png" }],
  ptyResize: ["tab-1", 120, 40],
  ptyWrite: ["tab-1", "input"],
  pullBranch: ["/project"],
  readOmpSettings: [null],
  readPlanFile: ["tab-1", "/tmp/plan.html"],
  readProviderKeys: [null],
  readProviderOAuth: [],
  regenerateRemoteToken: [],
  releaseWorktree: ["tab-1"],
  removeProject: ["/project"],
  reportStallCap: ["tab-1", true],
  resolveFileMentions: ["/project", "@file"],
  restartForAppUpdate: [false],
  restartSession: ["tab-1"],
  rpcSend: ["tab-1", { type: "prompt", custom: undefined }],
  setAdvisorAutoReply: [true],
  setAppUpdateCheckOnLaunch: [true],
  setAppUpdateInstallOnQuit: [false],
  setDefaultAdvisor: [true],
  setDefaultAgentMode: ["build"],
  setDefaultCompactionMethod: [null],
  setDefaultMode: ["rpc-ui"],
  setDesktopNotifications: [true],
  setFontFamilyId: ["mono"],
  setHibernateIdleMinutes: [30],
  setMcpServerEnabled: [{ projectCwd: null, name: "github", enabled: true }],
  setOmpUpdateCheckOnLaunch: [true],
  setPlanFormat: ["html"],
  setProjectDefaultAdvisorModel: ["/project", null],
  setProjectDefaultModel: ["/project", null],
  setProviderKey: ["OPENROUTER_API_KEY", "key"],
  setRemoteBind: ["localhost"],
  setRemoteEnabled: [true],
  setRemotePassword: ["password"],
  setRemotePort: [8080],
  setSessionAdvisor: ["tab-1", true, null],
  setSessionModel: ["tab-1", null, null],
  setSkipDeleteConfirmation: [true],
  setStallAutoContinue: [true],
  setStreamStallAbortSeconds: [45],
  setThemeId: ["dark"],
  setLocaleId: ["ko"],
  setWindowChrome: ["#000", "#fff"],
  shellKill: ["tab-1"],
  shellResize: ["tab-1", 120, 40],
  shellSpawn: ["tab-1", "/project", 120, 40, "shell"],
  shellWrite: ["tab-1", "input"],
  showAppUpdateDownload: [],
  showPathInFolder: ["/tmp/file"],
  signOutProviderOAuth: ["openai-codex"],
  spawnSession: [spawnRequest],
  startProviderOAuth: ["openai-codex"],
  suggestBranchName: ["/project", "plan"],
  switchMode: ["tab-1", "pty"],
  submitProviderOAuthInput: ["https://chatgpt.com/…"],
  tabViewed: ["client-1", null],
  terminateSession: ["tab-1"],
  toggleFavorite: ["model"],
  writeOmpSetting: ["theme", { custom: true }],
} satisfies { [Method in InboundMethod]: MethodArgs<Method> };

function recordingTransport() {
  const requests: Array<{ channel: string; args: unknown[] }> = [];
  const notifications: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, RuntimeListener>();
  const transport: BackendTransport = {
    request<Args extends unknown[], Result>(channel: string, args: Args): Promise<Result> {
      requests.push({ channel, args });
      return Promise.resolve({ channel, args }) as never;
    },
    notify<Args extends unknown[]>(channel: string, args: Args): void {
      notifications.push({ channel, args });
    },
    on<Args extends unknown[]>(channel: string, cb: (...args: Args) => void): void {
      listeners.set(channel, cb as unknown as RuntimeListener);
    },
  };
  return { transport, requests, notifications, listeners };
}

function recordingTable() {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const request: Record<string, (...args: unknown[]) => unknown> = {};
  const notify: Record<string, (...args: unknown[]) => void> = {};
  for (const descriptor of Object.values(BACKEND_CHANNELS)) {
    if (descriptor.kind === "request") {
      request[descriptor.channel] = (...args) => {
        calls.push({ channel: descriptor.channel, args });
        return undefined;
      };
    } else if (descriptor.kind === "notify") {
      notify[descriptor.channel] = (...args) => {
        calls.push({ channel: descriptor.channel, args });
      };
    }
  }
  return { table: { request, notify } as unknown as ChannelTable, calls };
}

describe("BACKEND_CHANNELS", () => {
  it("derives unique channel names and runtime codecs for every inbound channel", () => {
    const entries = Object.entries(BACKEND_CHANNELS);
    const inbound = entries.filter(([, descriptor]) => descriptor.kind !== "event");
    const events = entries.filter(([, descriptor]) => descriptor.kind === "event");
    expect(Object.keys(CH)).toEqual(entries.map(([method]) => method));
    expect(new Set(Object.values(CH)).size).toBe(entries.length);
    expect(inbound).toHaveLength(100);
    expect(events).toHaveLength(12);
    for (const [, descriptor] of inbound) expect(descriptor).toHaveProperty("args");
    for (const [, descriptor] of events) expect(descriptor).not.toHaveProperty("args");
  });

  it("derives the complete public client and handler table", () => {
    type Method = keyof BackendChannelSpec;
    type HandledChannel = keyof ChannelTable["request"] | keyof ChannelTable["notify"];
    expectTypeOf<keyof OmpBackend>().toEqualTypeOf<Method>();
    expectTypeOf<keyof typeof CH>().toEqualTypeOf<Method>();
    expectTypeOf<keyof ChannelTable["request"]>().toEqualTypeOf<SpecChannel<"request">>();
    expectTypeOf<keyof ChannelTable["notify"]>().toEqualTypeOf<SpecChannel<"notify">>();
    expectTypeOf<Extract<HandledChannel, SpecChannel<"event">>>().toEqualTypeOf<never>();
    expectTypeOf<ChannelTable["request"]["branch:mergeStatus"]>().toEqualTypeOf<
      (
        projectCwd: string,
        branch: string,
        base: string | null,
      ) => MergeBackStatus | Promise<MergeBackStatus>
    >();
  });
});

describe("makeBackendClient", () => {
  it("routes every method through its declared transport channel", async () => {
    const recorded = recordingTransport();
    const client = makeBackendClient(recorded.transport);
    for (const [method, descriptor] of Object.entries(BACKEND_CHANNELS)) {
      const invoke = Reflect.get(client, method) as (...args: never[]) => unknown;
      if (descriptor.kind === "event") {
        const listener = (): void => undefined;
        invoke(listener as never);
        expect(recorded.listeners.get(descriptor.channel)).toBe(listener);
      } else {
        const args = Reflect.get(VALID_ARGS, method) as never[];
        await invoke(...args);
        const records = descriptor.kind === "request" ? recorded.requests : recorded.notifications;
        expect(records.at(-1)).toEqual({ channel: descriptor.channel, args });
      }
    }
  });
});

describe("transport dispatch", () => {
  it("decodes every valid inbound tuple and preserves values and order", async () => {
    const { table, calls } = recordingTable();
    for (const [method, args] of Object.entries(VALID_ARGS)) {
      const descriptor = BACKEND_CHANNELS[method as InboundMethod];
      if (descriptor.kind === "request") await dispatchRequest(table, descriptor.channel, args);
      else dispatchNotify(table, descriptor.channel, args);
    }
    expect(calls).toHaveLength(100);
    expect(calls.map(({ channel }) => channel)).toEqual(
      Object.keys(VALID_ARGS).map((method) => BACKEND_CHANNELS[method as InboundMethod].channel),
    );
    for (const call of calls) {
      const method = Object.keys(VALID_ARGS).find(
        (candidate) => BACKEND_CHANNELS[candidate as InboundMethod].channel === call.channel,
      ) as InboundMethod;
      expect(call.args).toEqual(VALID_ARGS[method]);
    }
  });

  it.each([
    [CH.openProject, ["/project"], "argument 1"],
    [CH.addProject, [{ secret: "do-not-echo" }], "argument 0"],
    [CH.openProject, ["/project", "secret-target"], "argument 1"],
    [CH.ptyPasteImage, ["tab-1", { type: "secret-type", data: "x", mimeType: "x" }], "argument 1.type"],
    [CH.setRemotePort, [Number.POSITIVE_INFINITY], "argument 0"],
    [CH.getState, ["secret-extra"], "expected at most 0"],
  ] as const)("rejects malformed request arguments before the handler", async (channel, args, path) => {
    const { table, calls } = recordingTable();
    await expect(dispatchRequest(table, channel, [...args])).rejects.toThrow(path);
    expect(calls).toHaveLength(0);
    try {
      await dispatchRequest(table, channel, [...args]);
    } catch (error) {
      expect(String(error)).toContain(channel);
      expect(String(error)).not.toContain("do-not-echo");
      expect(String(error)).not.toContain("secret-target");
      expect(String(error)).not.toContain("secret-type");
      expect(String(error)).not.toContain("secret-extra");
    }
  });

  it("drops malformed notifications without invoking handlers or throwing", () => {
    const { table, calls } = recordingTable();
    expect(() => dispatchNotify(table, CH.ptyWrite, ["tab-1"])).not.toThrow();
    expect(() => dispatchNotify(table, CH.ptyResize, ["tab-1", "wide", 40])).not.toThrow();
    expect(() => dispatchNotify(table, CH.rpcSend, ["tab-1", []])).not.toThrow();
    expect(() => dispatchNotify(table, CH.shellKill, ["tab-1", "extra"])).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("preserves omitted optional positions and normalizes present null", async () => {
    const lengths: number[] = [];
    const values: unknown[] = [];
    const table = {
      request: {
        [CH.getBranchDiff]: function (_project: string, base?: string | null) {
          lengths.push(arguments.length);
          values.push(base);
        },
      },
      notify: {},
    } as unknown as ChannelTable;
    await dispatchRequest(table, CH.getBranchDiff, ["/project"]);
    await dispatchRequest(table, CH.getBranchDiff, ["/project", null]);
    expect(lengths).toEqual([1, 2]);
    expect(values).toEqual([undefined, undefined]);
  });

  it("rejects undeclared and inherited request channels and ignores notify equivalents", async () => {
    const table = {
      request: { rogue: () => "fail-open" },
      notify: { rogue: () => undefined },
    } as unknown as ChannelTable;
    for (const channel of ["rogue", "constructor", "toString"]) {
      await expect(dispatchRequest(table, channel, [])).rejects.toThrow(`unknown channel ${channel}`);
      expect(() => dispatchNotify(table, channel, [])).not.toThrow();
    }
  });

  it("preserves request handler failures and swallows notification handler failures", async () => {
    const table = {
      request: {
        [CH.getState]: () => {
          throw new Error("request-handler-failure");
        },
      },
      notify: {
        [CH.shellKill]: () => {
          throw new Error("notify-handler-failure");
        },
      },
    } as unknown as ChannelTable;
    await expect(dispatchRequest(table, CH.getState, [])).rejects.toThrow("request-handler-failure");
    expect(() => dispatchNotify(table, CH.shellKill, ["tab-1"])).not.toThrow();
  });
});
