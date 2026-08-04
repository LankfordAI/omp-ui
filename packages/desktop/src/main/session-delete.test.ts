import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real MainBackend imports electron; stub the three surfaces it touches.
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
}));

const { MainBackend } = await import("./backend");
const { CH } = await import("./channels");

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const FILE_NAME = `2026-07-29T16-18-42-427Z_${SESSION_ID}.jsonl`;

const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base: string;

/** Real registry file + real lineage dirs in both roots, exactly as ADR-0003 lays them out. */
function setup(): {
  backend: InstanceType<typeof MainBackend>;
  sessionsRoot: string;
  archiveRoot: string;
} {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-del-"));
  const agentDir = path.join(base, "agent");
  // Default profile, so PI_CODING_AGENT_DIR wins over the XDG branch (paths.ts:38).
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const sessionsRoot = path.join(agentDir, "sessions");
  const archiveRoot = path.join(agentDir, "archive", "sessions");
  const activeDir = path.join(sessionsRoot, LINEAGE);
  const artifacts = path.join(activeDir, path.basename(FILE_NAME, ".jsonl"));
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(path.join(archiveRoot, LINEAGE), { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, FILE_NAME),
    `${JSON.stringify({
      type: "session",
      id: SESSION_ID,
      cwd: "/proj",
      timestamp: "2026-07-29T16:18:42.427Z",
    })}\n`,
  );
  fs.writeFileSync(path.join(artifacts, "__advisor.jsonl"), "advisor\n");
  fs.writeFileSync(path.join(archiveRoot, LINEAGE, "old.jsonl.gz"), "gz");

  const registryFile = path.join(base, "registry.json");
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      schemaVersion: 1,
      settings: { defaultMode: "pty" },
      projects: [
        { path: "/proj", name: "proj", addedAt: "2026-07-29T00:00:00.000Z" },
      ],
      sessions: [
        {
          tabId: "tab-1",
          sessionId: SESSION_ID,
          lineageDir: LINEAGE,
          projectCwd: "/proj",
          launchedAt: "2026-07-29T16:18:42.427Z",
          mode: "pty",
          advisor: false,
          cachedTitle: "Old session",
          cachedModified: "2026-07-29T16:18:42.427Z",
        },
      ],
    }),
  );

  handlers.clear();
  sent.length = 0;
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  return { backend, sessionsRoot, archiveRoot };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);
const readRegistry = (): { sessions: unknown[] } =>
  JSON.parse(fs.readFileSync(path.join(base, "registry.json"), "utf8"));

/**
 * The two in-flight collections the delete path consults. They are private to
 * MainBackend and there is no public way to fake a running session, so these
 * tests reach in deliberately — the cast names the real shape of fields this
 * file owns, rather than asserting a shape onto external data.
 */
interface FakeLive {
  kind: string;
  pty: { kill: (signal?: string) => void };
  exited: Promise<void>;
  markExited: () => void;
  suppressExit?: boolean;
}
interface BackendInternals {
  live: Map<string, FakeLive>;
  spawning: Map<string, Promise<void>>;
}
const internals = (backend: InstanceType<typeof MainBackend>): BackendInternals =>
  backend as unknown as BackendInternals;

/**
 * Stands in for a running process the way spawnPty registers one: `exited`
 * settles only when the fake honours a signal, so a delete really does have to
 * reap it. `diesOn` picks which signal the fake obeys ("never" = neither).
 */
function fakeLive(diesOn: "default" | "SIGKILL" | "never"): FakeLive & { signals: string[] } {
  const signals: string[] = [];
  let markExited = (): void => {};
  const exited = new Promise<void>((resolve) => {
    markExited = () => resolve();
  });
  return {
    kind: "pty",
    signals,
    exited,
    markExited,
    pty: {
      kill: (signal?: string) => {
        signals.push(signal ?? "default");
        const obeys =
          diesOn === "default" ? signal === undefined : diesOn === "SIGKILL" && signal === "SIGKILL";
        if (obeys) markExited();
      },
    },
  };
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("session:delete", () => {
  it("erases the record, the transcript, its artifacts, and the archived copy", async () => {
    const { sessionsRoot, archiveRoot } = setup();

    // The row is visible before the delete — the precondition the sidebar shows.
    const before = (await invoke(CH.stateGet)) as { projects: { sessions: { title: string }[] }[] };
    expect(before.projects[0]!.sessions.map((s) => s.title)).toEqual(["Old session"]);

    await invoke(CH.sessionDelete, "tab-1");

    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(false);
    expect(fs.existsSync(path.join(archiveRoot, LINEAGE))).toBe(false);
    expect(readRegistry().sessions).toEqual([]);
    // The sidebar learns about it by broadcast, not by polling.
    const broadcast = sent.filter((m) => m.channel === CH.stateChanged).at(-1);
    const state = broadcast!.args[0] as { projects: { sessions: unknown[] }[] };
    expect(state.projects[0]!.sessions).toEqual([]);
    // The shared roots survive: omp's own sessions live there too.
    expect(fs.existsSync(sessionsRoot)).toBe(true);
    expect(fs.existsSync(archiveRoot)).toBe(true);
  });

  it("stops a live session, then erases the record and its files", async () => {
    const { backend, sessionsRoot } = setup();
    const live = fakeLive("default");
    internals(backend).live.set("tab-1", live);

    await invoke(CH.sessionDelete, "tab-1");

    expect(live.signals).toEqual(["default"]);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(false);
    expect(readRegistry().sessions).toEqual([]);
    // The tab is going away — an exit notice would be noise about a session
    // the user just deleted.
    expect(sent.filter((m) => m.channel === CH.ptyExit)).toEqual([]);
  });

  it("escalates to SIGKILL when omp ignores the first signal", async () => {
    vi.useFakeTimers();
    try {
      const { backend, sessionsRoot } = setup();
      const live = fakeLive("SIGKILL");
      internals(backend).live.set("tab-1", live);

      const done = invoke(CH.sessionDelete, "tab-1") as Promise<void>;
      await vi.advanceTimersByTimeAsync(3_000);
      await done;

      expect(live.signals).toEqual(["default", "SIGKILL"]);
      expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(false);
      expect(readRegistry().sessions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Unlinking the lineage dir under a live writer would lose the delete (or
  // see omp recreate it), so an unkillable process keeps its files.
  it("keeps the session when even SIGKILL does not reap the process", async () => {
    vi.useFakeTimers();
    try {
      const { backend, sessionsRoot } = setup();
      const live = fakeLive("never");
      internals(backend).live.set("tab-1", live);

      const done = invoke(CH.sessionDelete, "tab-1") as Promise<void>;
      const settled = expect(done).rejects.toThrow(/did not exit/);
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;

      expect(fs.existsSync(path.join(sessionsRoot, LINEAGE, FILE_NAME))).toBe(true);
      expect(readRegistry().sessions).toHaveLength(1);
      // Still live, so its exit must reach the renderer again.
      expect(live.suppressExit).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The resume path awaits (unarchive/hydrate) before it registers the session
  // as live, so a delete arriving in that window has to wait for the spawn
  // rather than race the process that is about to own these files.
  it("waits for an in-flight resume spawn before deleting", async () => {
    const { backend, sessionsRoot } = setup();
    const live = fakeLive("default");
    let spawnDone = (): void => {};
    internals(backend).spawning.set(
      "tab-1",
      new Promise<void>((resolve) => {
        spawnDone = () => resolve();
      }),
    );

    const done = invoke(CH.sessionDelete, "tab-1") as Promise<void>;
    // Nothing may happen while the spawn is still in flight.
    await Promise.resolve();
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE, FILE_NAME))).toBe(true);

    internals(backend).live.set("tab-1", live);
    internals(backend).spawning.delete("tab-1");
    spawnDone();
    await done;

    expect(live.signals).toEqual(["default"]);
    expect(readRegistry().sessions).toEqual([]);
  });

  it("keeps the record when the files cannot be deleted, so the row stays retryable", async () => {
    setup();
    const rm = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("EBUSY"));
    await expect(invoke(CH.sessionDelete, "tab-1")).rejects.toThrow(/EBUSY/);
    expect(readRegistry().sessions).toHaveLength(1);
    rm.mockRestore();
  });

  it("is a no-op for an unknown tab", async () => {
    setup();
    await expect(invoke(CH.sessionDelete, "nope")).resolves.toBeUndefined();
    expect(readRegistry().sessions).toHaveLength(1);
  });
});
