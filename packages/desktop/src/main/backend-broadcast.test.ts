import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainBackend } from "./backend";
import { CH } from "@omp-ui/core";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

const handlers = vi.hoisted(
  () => new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
);
const resolveSessionLocationMock = vi.hoisted(() => vi.fn());

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
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

vi.mock("@omp-ui/core", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    resolveSessionLocation: resolveSessionLocationMock,
  };
});

const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base = "";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

function broadcastStates(): {
  projects: { project: { path: string } }[];
  themeId: string;
}[] {
  return sent
    .filter((event) => event.channel === CH.onStateChanged)
    .map((event) => event.args[0] as {
      projects: { project: { path: string } }[];
      themeId: string;
    });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-broadcast-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
      {
        path: "/p/a",
        name: "A",
        addedAt: "2026-08-01T00:00:00.000Z",
        lastModel: null,
        lastAdvisorModel: null,
      },
      {
        path: "/p/b",
        name: "B",
        addedAt: "2026-08-02T00:00:00.000Z",
        lastModel: null,
        lastAdvisorModel: null,
      },
    ],
    sessions: [ownedSessionRecord({ projectCwd: "/p/a" })],
  });

  handlers.clear();
  sent.length = 0;
  resolveSessionLocationMock.mockReset().mockResolvedValue({ where: "missing" });
  new MainBackend(win as never, registryFile).registerIpc();
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("ordered backend broadcasts (issue #146)", () => {
  it("finishes an older state build and delivery before starting the next one", async () => {
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<{ where: "missing" }>();
    resolveSessionLocationMock.mockImplementationOnce(() => {
      firstReadStarted.resolve(undefined);
      return releaseFirstRead.promise;
    });

    const first = invoke(CH.toggleFavorite, "model-a");
    await firstReadStarted.promise;

    const second = invoke(CH.moveProject, "/p/a", null);
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(1);
    expect(broadcastStates()).toEqual([]);

    releaseFirstRead.resolve({ where: "missing" });
    await Promise.all([first, second]);

    const orders = broadcastStates().map((state) =>
      state.projects.map((group) => group.project.path),
    );
    expect(orders).toEqual([
      ["/p/a", "/p/b"],
      ["/p/b", "/p/a"],
    ]);
    expect(orders.at(-1)).toEqual(["/p/b", "/p/a"]);
  });

  it("keeps the chain usable after returning a failed build to its caller", async () => {
    resolveSessionLocationMock.mockRejectedValueOnce(new Error("state read failed"));

    const failed = invoke(CH.toggleFavorite, "model-a");
    await expect(failed).rejects.toThrow("state read failed");

    await expect(invoke(CH.setThemeId, "nord")).resolves.toBeUndefined();
    expect(broadcastStates()).toHaveLength(1);
    expect(broadcastStates()[0]?.themeId).toBe("nord");
  });
});
