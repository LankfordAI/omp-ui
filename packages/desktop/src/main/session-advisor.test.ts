import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { MainBackend } = await import("./backend");
const { CH } = await import("./channels");

const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
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
function setup(opts: { materialized: boolean }): {
  backend: InstanceType<typeof MainBackend>;
  sessionsRoot: string;
} {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-adv-"));
  const agentDir = path.join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

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
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      schemaVersion: 1,
      settings: { defaultMode: "rpc-ui" },
      projects: [{ path: "/proj", name: "proj", addedAt: "2026-07-29T00:00:00.000Z" }],
      sessions: [
        {
          tabId: "tab-1",
          sessionId,
          lineageDir: LINEAGE,
          projectCwd: "/proj",
          launchedAt: "2026-07-29T16:18:42.427Z",
          mode: "rpc-ui",
          model: "openrouter/openai/gpt-5.6",
          thinkingLevel: "high",
          advisor: true,
          advisorModel: null,
          cachedTitle: null,
          cachedModified: null,
        },
      ],
    }),
  );

  handlers.clear();
  sent.length = 0;
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  return { backend, sessionsRoot };
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

/**
 * `live` and the launch seam are private. These tests reach in deliberately:
 * there is no public way to stand up a running session, and a relaunch is
 * exactly what this feature does.
 *
 * The stub replaces `spawnRpc` — the last step, which actually forks omp — and
 * NOT `spawn`, so the real resume path (`prepareResume`, session-file
 * resolution, the advisor overlay write) still executes. Stubbing `spawn`
 * instead would skip the very code these tests exist to cover.
 */
interface BackendInternals {
  live: Map<string, unknown>;
  ompPath: string | null;
  spawnRpc(record: { tabId: string }): { tabId: string };
  configOverlays(
    record: {
      model?: string | null;
      thinkingLevel?: string | null;
      advisor: boolean;
      advisorModel: string | null;
    },
    lineageDir: string,
  ): string[];
}
const internals = (backend: InstanceType<typeof MainBackend>): BackendInternals =>
  backend as unknown as BackendInternals;

/** Replaces the process fork so no omp is launched; records the record spawned. */
function captureSpawn(backend: InstanceType<typeof MainBackend>): { tabId: string }[] {
  const calls: { tabId: string }[] = [];
  // A resolved binary is required before spawn even looks at the session.
  internals(backend).ompPath = "/usr/bin/true";
  internals(backend).spawnRpc = (record) => {
    calls.push(record);
    return { tabId: record.tabId };
  };
  return calls;
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("session:setAdvisor", () => {
  it("relaunches a session whose transcript has not been written yet", async () => {
    // The bug: omp materializes the .jsonl lazily, so a session toggled before
    // its first prompt has `sessionId: null` and an empty lineage dir.
    // Resolving it as a resume reported "session files are gone".
    const { backend } = setup({ materialized: false });
    const calls = captureSpawn(backend);
    internals(backend).live.set("tab-1", { kind: "rpc-ui" });

    await expect(invoke(CH.sessionSetAdvisor, "tab-1", false, null)).resolves.toBeUndefined();

    expect(readRegistry().sessions[0]).toMatchObject({
      model: "openrouter/openai/gpt-5.6",
      thinkingLevel: "high",
      advisor: false,
      advisorModel: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tabId: "tab-1", advisor: false });
  });

  it("still refuses when a materialized session's files really are gone", async () => {
    const { backend, sessionsRoot } = setup({ materialized: true });
    const calls = captureSpawn(backend);
    internals(backend).live.set("tab-1", { kind: "rpc-ui" });
    fs.rmSync(path.join(sessionsRoot, LINEAGE), { recursive: true, force: true });

    await expect(invoke(CH.sessionSetAdvisor, "tab-1", false, null)).rejects.toThrow(
      /session files are gone/,
    );
    expect(calls).toEqual([]);
  });

  it("reapplies the session's main model and thinking level after an advisor toggle", async () => {
    const { backend, sessionsRoot } = setup({ materialized: false });
    captureSpawn(backend);
    internals(backend).live.set("tab-1", { kind: "rpc-ui" });

    await invoke(CH.sessionSetAdvisor, "tab-1", false, null);

    const record = readRegistry().sessions[0]!;
    const overlays = internals(backend).configOverlays(record, path.join(sessionsRoot, LINEAGE));
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
    const { backend, sessionsRoot } = setup({ materialized: true });
    captureSpawn(backend);
    internals(backend).live.set("tab-1", { kind: "rpc-ui" });
    fs.rmSync(path.join(sessionsRoot, LINEAGE), { recursive: true, force: true });

    await expect(invoke(CH.sessionSetAdvisor, "tab-1", false, null)).rejects.toThrow();
    const exit = sent.filter((m) => m.channel === CH.ptyExit).at(-1);
    expect(exit?.args[0]).toBe("tab-1");
  });

  it("relaunches a materialized session the same way", async () => {
    const { backend } = setup({ materialized: true });
    const calls = captureSpawn(backend);
    internals(backend).live.set("tab-1", { kind: "rpc-ui" });

    await invoke(CH.sessionSetAdvisor, "tab-1", true, "openrouter/x-ai/grok-4-fast");

    expect(readRegistry().sessions[0]).toMatchObject({
      advisor: true,
      advisorModel: "openrouter/x-ai/grok-4-fast",
    });
    expect(calls).toHaveLength(1);
  });

  it("records the choice without relaunching a dormant session", async () => {
    const { backend } = setup({ materialized: true });
    const calls = captureSpawn(backend);
    // No `live` entry: nothing to restart, the next launch reads the record.
    await invoke(CH.sessionSetAdvisor, "tab-1", false, null);

    expect(readRegistry().sessions[0]).toMatchObject({ advisor: false });
    expect(calls).toEqual([]);
  });

  it("is a no-op when nothing actually changed", async () => {
    const { backend } = setup({ materialized: true });
    const calls = captureSpawn(backend);
    internals(backend).live.set("tab-1", { kind: "rpc-ui" });
    // Already advisor: true / model: null — restarting would cost a relaunch
    // for no change at all.
    await invoke(CH.sessionSetAdvisor, "tab-1", true, null);
    expect(calls).toEqual([]);
  });

  it("is a no-op for an unknown tab", async () => {
    const { backend } = setup({ materialized: true });
    const calls = captureSpawn(backend);
    await expect(invoke(CH.sessionSetAdvisor, "nope", false, null)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
