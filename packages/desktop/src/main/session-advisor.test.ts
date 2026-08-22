import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the surfaces it touches. The
// safeStorage stub is reversible rather than absent so the provider-key store is
// genuinely constructible — it holds no keys here, so nothing is written.
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
}));

vi.mock("@omp-ui/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omp-ui/core")>()),
  RpcClient: vi.fn(),
}));

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { RpcClient } = await import("@omp-ui/core");
const RpcClientMock = vi.mocked(RpcClient);
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const sent: { channel: string; args: unknown[] }[] = [];
const TAB = "tab-1";
const rpcOptions: { configOverlays?: string[]; initialCommands?: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base: string;

/**
 * A session exactly as `newSession` leaves it: registered, live, and **not yet
 * materialized** — `sessionId: null` and an empty lineage dir. omp writes the
 * transcript lazily, on the first turn, so this is the state of every session
 * between "new session" and the first prompt.
 */
function setup(opts: { materialized: boolean; defaultAgentMode?: "plan" | "build" }): { sessionsRoot: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-adv-"));
  const agentDir = path.join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  process.env.OPENROUTER_API_KEY = "test-key";
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  const ompBin = path.join(base, "omp");
  fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.OMP_UI_OMP_PATH = ompBin;

  const sessionsRoot = path.join(agentDir, "sessions");
  const activeDir = path.join(sessionsRoot, LINEAGE);
  fs.mkdirSync(activeDir, { recursive: true });

  let sessionId: string | null = null;
  if (opts.materialized) {
    sessionId = "019faeab-cc7b-7000-8bfc-67242a2869d8";
    fs.writeFileSync(
      path.join(activeDir, `2026-07-29T16-18-42-427Z_${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId, cwd: "/proj" })}\n`,
    );
  }

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    settings: { defaultMode: "rpc-ui", defaultAgentMode: opts.defaultAgentMode ?? "build" },
    projects: [
      {
        path: "/proj",
        name: "proj",
        addedAt: "2026-07-29T00:00:00.000Z",
        lastModel: null,
        lastAdvisorModel: null,
      },
    ],
    sessions: [
      ownedSessionRecord({
        tabId: TAB,
        sessionId,
        lineageDir: LINEAGE,
        projectCwd: "/proj",
        launchedAt: "2026-07-29T16:18:42.427Z",
        mode: "rpc-ui",
        model: "openrouter/openai/gpt-5.6",
        thinkingLevel: "high",
        advisor: true,
        advisorModel: null,
      }),
    ],
  });

  handlers.clear();
  sent.length = 0;
  new MainBackend(win as never, registryFile).registerIpc();
  return { sessionsRoot };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);
const readRegistry = (): {
  sessions: {
    model: string | null;
    thinkingLevel: string | null;
    advisor: boolean;
    advisorModel: string | null;
  }[];
} => JSON.parse(fs.readFileSync(path.join(base, "registry.json"), "utf8"));

const resume = async (): Promise<void> => {
  await invoke(CH.spawnSession, {
    projectCwd: "/proj",
    mode: "rpc-ui",
    advisor: true,
    cols: 80,
    rows: 24,
    resumeTabId: TAB,
  });
};

const fresh = async (startInPlanMode?: boolean): Promise<void> => {
  const req: Record<string, unknown> = {
    projectCwd: "/proj",
    mode: "rpc-ui",
    advisor: true,
    cols: 80,
    rows: 24,
  };
  if (startInPlanMode !== undefined) req.startInPlanMode = startInPlanMode;
  await invoke(CH.spawnSession, req);
};

const relaunches = (): number => RpcClientMock.mock.calls.length - 1;

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  delete process.env.OMP_UI_OMP_PATH;
  rpcOptions.length = 0;
  RpcClientMock.mockReset();
  RpcClientMock.mockImplementation(function (
    this: unknown,
    opts: { onExit: (code: number | null) => void; configOverlays?: string[] },
  ) {
    rpcOptions.push(opts);
    return { kill: vi.fn(() => opts.onExit(0)), send: vi.fn() };
  } as unknown as typeof RpcClient);
});

describe("session:setAdvisor", () => {
  it("relaunches a session whose transcript has not been written yet", async () => {
    // The bug: omp materializes the .jsonl lazily, so a session toggled before
    // its first prompt has `sessionId: null` and an empty lineage dir.
    // Resolving it as a resume reported "session files are gone".
    setup({ materialized: false });
    await resume();

    await expect(invoke(CH.setSessionAdvisor, "tab-1", false, null, false)).resolves.toBeUndefined();

    expect(readRegistry().sessions[0]).toMatchObject({
      model: "openrouter/openai/gpt-5.6",
      thinkingLevel: "high",
      advisor: false,
      advisorModel: null,
    });
    expect(relaunches()).toBe(1);
    expect(RpcClientMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ advisor: false }));
  });

  it("still refuses when a materialized session's files really are gone", async () => {
    const { sessionsRoot } = setup({ materialized: true });
    await resume();
    fs.rmSync(path.join(sessionsRoot, LINEAGE), { recursive: true, force: true });

    await expect(invoke(CH.setSessionAdvisor, "tab-1", false, null, false)).rejects.toThrow(
      /session files are gone/,
    );
    expect(relaunches()).toBe(0);
  });

  it("reapplies the session's main model and thinking level after an advisor toggle", async () => {
    setup({ materialized: false });
    await resume();

    await invoke(CH.setSessionAdvisor, TAB, false, null, false);

    const overlays = rpcOptions.at(-1)?.configOverlays ?? [];
    const modelOverlay = overlays.find((file) => path.basename(file) === "omp-ui-model.yml");
    expect(modelOverlay).toBeDefined();
    expect(fs.readFileSync(modelOverlay!, "utf8")).toBe(
      'modelRoles:\n  default: "openrouter/openai/gpt-5.6:high"\n',
    );
  });

  it("tells the renderer the agent died when the relaunch fails", async () => {
    // The old process was already killed with `suppressExit` set, which
    // deliberately swallows its exit. If the relaunch then fails, nothing else
    // will ever report it — the tab would sit there looking live over a dead
    // process, with no way back short of restarting the app.
    const { sessionsRoot } = setup({ materialized: true });
    await resume();
    fs.rmSync(path.join(sessionsRoot, LINEAGE), { recursive: true, force: true });

    await expect(invoke(CH.setSessionAdvisor, TAB, false, null, false)).rejects.toThrow();
    const exit = sent.filter((m) => m.channel === CH.onPtyExit).at(-1);
    expect(exit?.args[0]).toBe("tab-1");
  });

  it("relaunches a materialized session the same way", async () => {
    setup({ materialized: true });
    await resume();

    await invoke(CH.setSessionAdvisor, TAB, true, "openrouter/x-ai/grok-4-fast", false);

    expect(readRegistry().sessions[0]).toMatchObject({
      advisor: true,
      advisorModel: "openrouter/x-ai/grok-4-fast",
    });
    expect(relaunches()).toBe(1);
  });

  it("records the choice without relaunching a dormant session", async () => {
    setup({ materialized: true });
    // No live process: nothing to restart, the next launch reads the record.
    await invoke(CH.setSessionAdvisor, TAB, false, null, false);

    expect(readRegistry().sessions[0]).toMatchObject({ advisor: false });
    expect(RpcClientMock).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing actually changed", async () => {
    setup({ materialized: true });
    await resume();
    // Already advisor: true / model: null — restarting would cost a relaunch
    // for no change at all.
    await invoke(CH.setSessionAdvisor, TAB, true, null, false);
    expect(relaunches()).toBe(0);
  });

  it("preserves explicit Plan and Build posture across a live advisor relaunch", async () => {
    setup({ materialized: false, defaultAgentMode: "build" });
    await resume();
    await invoke(CH.setSessionAdvisor, TAB, false, null, true);
    expect(rpcOptions.at(-1)?.initialCommands).toEqual([
      expect.objectContaining({ message: "/omp-ui-plan on html" }),
    ]);

    setup({ materialized: false, defaultAgentMode: "plan" });
    await resume();
    await invoke(CH.setSessionAdvisor, TAB, false, null, false);
    expect(rpcOptions.at(-1)?.initialCommands).toEqual([
      expect.objectContaining({ message: "/omp-ui-plan off" }),
    ]);
  });

  it.each([
    ["explicit Plan with Build default", "build", true, "/omp-ui-plan on html"],
    ["explicit Build with Plan default", "plan", false, "/omp-ui-plan off"],
    ["omitted fresh posture with Plan default", "plan", undefined, "/omp-ui-plan on html"],
    ["omitted fresh posture with Build default", "build", undefined, "/omp-ui-plan off"],
  ] as const)("resolves %s", async (_label, defaultAgentMode, posture, expectedMessage) => {
    setup({ materialized: true, defaultAgentMode });
    await fresh(posture);
    expect(rpcOptions.at(-1)?.initialCommands).toEqual([
      expect.objectContaining({ message: expectedMessage }),
    ]);
  });

  it("starts an omitted resume in Build even when the app default is Plan", async () => {
    setup({ materialized: true, defaultAgentMode: "plan" });
    await resume();
    expect(rpcOptions.at(-1)?.initialCommands).toEqual([
      expect.objectContaining({ message: "/omp-ui-plan off" }),
    ]);
  });

  it("is a no-op for an unknown tab", async () => {
    setup({ materialized: true });
    await expect(invoke(CH.setSessionAdvisor, "nope", false, null, false)).resolves.toBeUndefined();
    expect(RpcClientMock).not.toHaveBeenCalled();
  });
});
