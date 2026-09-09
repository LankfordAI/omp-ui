import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, type BackendState, type InstanceIdentity } from "@omp-ui/core";
import { MainBackend } from "./backend";

// The real MainBackend imports electron; stub the surfaces it touches (backend-broadcast.test.ts's pattern).
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
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

let base: string;
let registryFile: string;
const backends: MainBackend[] = [];

function boot(): MainBackend {
  handlers.clear();
  const be = new MainBackend(win as never, registryFile, { appVersion: "1.2.3" });
  be.registerIpc();
  backends.push(be);
  return be;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(fn(null, ...args));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backend-ri-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  registryFile = path.join(base, "registry.json");
});

afterEach(() => {
  for (const be of backends.splice(0)) be.killAll();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("remote instances wiring (issue #416)", () => {
  it("projects an empty remoteInstances list and answers instance:identity with a minted id", async () => {
    boot();
    const state = (await invoke(CH.getState)) as BackendState;
    expect(state.remoteInstances).toEqual([]);

    const identity = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    expect(identity.version).toBe("1.2.3");
    expect(identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the same instanceId across a reload", async () => {
    boot();
    const first = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    boot();
    const second = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    expect(second.instanceId).toBe(first.instanceId);
  });

  it("refuses the renderer proxy for an unknown instance", async () => {
    boot();
    await expect(invoke(CH.remoteInstanceRequest, "nope", CH.getState, [])).rejects.toThrow(
      "unknown instance nope",
    );
  });
});
