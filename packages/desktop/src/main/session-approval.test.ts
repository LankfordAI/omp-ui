import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// The same reversible-stub harness as session-advisor.test.ts: the approval
// change relaunches through the identical rail, and the fake RpcClient's kill
// reports the exit so the relaunch actually completes.
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
const TAB = "tab-1";
const rpcOptions: { configOverlays?: string[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {},
  },
};

let base: string;

function setup(): { sessionsRoot: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-appr-"));
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
  fs.mkdirSync(path.join(sessionsRoot, LINEAGE), { recursive: true });

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    settings: { defaultMode: "rpc-ui" },
    projects: [
      {
        path: "/proj",
        name: "proj",
        addedAt: "2026-07-29T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
        browserClock: false,
        reviewRoster: null,
      },
    ],
    sessions: [
      ownedSessionRecord({
        tabId: TAB,
        sessionId: null,
        lineageDir: LINEAGE,
        projectCwd: "/proj",
        launchedAt: "2026-07-29T16:18:42.427Z",
        mode: "rpc-ui",
      }),
    ],
  });

  handlers.clear();
  new MainBackend(win as never, registryFile).registerIpc();
  return { sessionsRoot };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);
const readRegistry = (): {
  sessions: { approvalMode: string | null }[];
} => JSON.parse(fs.readFileSync(path.join(base, "registry.json"), "utf8"));

const resume = async (): Promise<void> => {
  await invoke(CH.spawnSession, { origin: "resume", resumeTabId: TAB, cols: 80, rows: 24 });
};

const relaunches = (): number => RpcClientMock.mock.calls.length - 1;
const approvalOverlay = (options: { configOverlays?: string[] } | undefined): string | undefined =>
  options?.configOverlays?.find((f) => path.basename(f) === "omp-ui-approval.yml");

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

describe("session:setApprovalMode (issue #681)", () => {
  it("relaunches a live session with the overlay carrying the new tier", async () => {
    setup();
    await resume();

    await expect(invoke(CH.setSessionApprovalMode, TAB, "always-ask")).resolves.toBeUndefined();

    expect(readRegistry().sessions[0]).toMatchObject({ approvalMode: "always-ask" });
    expect(relaunches()).toBe(1);
    const overlay = approvalOverlay(rpcOptions.at(-1));
    expect(overlay).toBeDefined();
    expect(fs.readFileSync(overlay!, "utf8")).toBe("tools:\n  approvalMode: always-ask\n");
  });

  it("removes the artifact on unpin so a stale overlay never rides the spawn", async () => {
    const { sessionsRoot } = setup();
    await resume();
    await invoke(CH.setSessionApprovalMode, TAB, "write");
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE, "omp-ui-approval.yml"))).toBe(true);

    await invoke(CH.setSessionApprovalMode, TAB, null);

    expect(approvalOverlay(rpcOptions.at(-1))).toBeUndefined();
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE, "omp-ui-approval.yml"))).toBe(false);
    expect(readRegistry().sessions[0]).toMatchObject({ approvalMode: null });
  });

  it("does not relaunch when the mode is unchanged", async () => {
    setup();
    await resume();

    await invoke(CH.setSessionApprovalMode, TAB, null);

    expect(relaunches()).toBe(0);
  });

  it("records without relaunching a dormant session, and its next spawn applies the pin", async () => {
    setup();

    await invoke(CH.setSessionApprovalMode, TAB, "yolo");

    expect(RpcClientMock.mock.calls.length).toBe(0); // never live: nothing to restart
    expect(readRegistry().sessions[0]).toMatchObject({ approvalMode: "yolo" });

    await resume();

    const overlay = approvalOverlay(rpcOptions.at(-1));
    expect(fs.readFileSync(overlay!, "utf8")).toBe("tools:\n  approvalMode: yolo\n");
  });
});
