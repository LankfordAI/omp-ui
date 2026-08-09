import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the three surfaces it touches.
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
const { CH } = await import("@omp-ui/core");

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const FILE_NAME = `2026-07-29T16-18-42-427Z_${SESSION_ID}.jsonl`;
const MESSAGE_LINE = `{"type":"message","id":"abc123","parentId":null,"timestamp":"2026-07-29T16:19:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`;
const TITLE_LINE = `{"type":"title","v":1,"title":"Old session","source":"user","updatedAt":"2026-07-29T16:19:30.000Z"}`;

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
 * Real registry file + real lineage dirs, exactly as ADR-0003 lays them out.
 * `file`: "active" writes the transcript, "archived" only a .gz, "missing"
 * leaves the lineage empty.
 */
function setup(file: "active" | "archived" | "missing" = "active"): { sessionsRoot: string; archiveRoot: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-fork-be-"));
  const agentDir = path.join(base, "agent");
  // Default profile, so PI_CODING_AGENT_DIR wins over the XDG branch (paths.ts:38).
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const sessionsRoot = path.join(agentDir, "sessions");
  const archiveRoot = path.join(agentDir, "archive", "sessions");
  const activeDir = path.join(sessionsRoot, LINEAGE);
  fs.mkdirSync(activeDir, { recursive: true });
  const header = JSON.stringify({
    type: "session",
    id: SESSION_ID,
    cwd: "/proj",
    timestamp: "2026-07-29T16:18:42.427Z",
  });
  if (file === "active") fs.writeFileSync(path.join(activeDir, FILE_NAME), `${TITLE_LINE}\n${header}\n${MESSAGE_LINE}\n`);
  if (file === "archived") {
    const archivedDir = path.join(archiveRoot, LINEAGE);
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, `${FILE_NAME}.gz`), "gz");
  }

  seedRegistry(path.join(base, "registry.json"), {
    settings: { defaultMode: "pty" },
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
        tabId: "tab-1",
        sessionId: file === "missing" ? null : SESSION_ID,
        lineageDir: LINEAGE,
        projectCwd: "/proj",
        launchedAt: "2026-07-29T16:18:42.427Z",
        mode: "rpc-ui",
        advisor: true,
        advisorModel: "openrouter/a/b:high",
        cachedTitle: "Old session",
        cachedModified: "2026-07-29T16:18:42.427Z",
      }),
    ],
  });

  handlers.clear();
  sent.length = 0;
  new MainBackend(win as never, path.join(base, "registry.json")).registerIpc();
  return { sessionsRoot, archiveRoot };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);
const readRegistry = (): { sessions: Record<string, unknown>[] } =>
  JSON.parse(fs.readFileSync(path.join(base, "registry.json"), "utf8"));

describe("sessionFork", () => {
  it("copies the transcript into a new lineage, registers it, and leaves the source untouched", async () => {
    const { sessionsRoot } = setup();
    const sourceFile = path.join(sessionsRoot, LINEAGE, FILE_NAME);
    const before = fs.readFileSync(sourceFile, "utf8");

    const res = (await invoke(CH.forkSession, "tab-1")) as { tabId: string };

    // New lineage dir holding exactly one fork file, re-headed but complete.
    const forkLineage = fs.readdirSync(sessionsRoot).find((d) => d !== LINEAGE)!;
    const forkFiles = fs.readdirSync(path.join(sessionsRoot, forkLineage)).filter((f) => f.endsWith(".jsonl"));
    expect(forkFiles).toHaveLength(1);
    const lines = fs.readFileSync(path.join(sessionsRoot, forkLineage, forkFiles[0]!), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const forkRecord = readRegistry().sessions.find((s) => s.tabId === res.tabId)!;
    // The title line rides along untouched, so the fork shows the source's name.
    expect(lines[0]).toEqual(JSON.parse(TITLE_LINE));
    expect(lines[1]).toMatchObject({
      type: "session",
      id: forkRecord.sessionId,
      parentSession: sourceFile,
      cwd: "/proj",
    });
    expect(lines[2]).toEqual(JSON.parse(MESSAGE_LINE));

    // The record inherits how the source launches; cachedTitle converges to
    // the forked file's title line on the broadcast's hydration pass.
    expect(forkRecord).toMatchObject({
      lineageDir: forkLineage,
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cachedTitle: "Old session",
    });
    // Source: same file bytes, same registry row.
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(before);
    expect(readRegistry().sessions).toHaveLength(2);
    // The renderer opens the fork on resolve, so state must already be out.
    expect(sent.some((m) => m.channel === CH.onStateChanged)).toBe(true);
  });

  it("rejects for an unknown tab", async () => {
    setup();
    await expect(invoke(CH.forkSession, "nope")).rejects.toThrow(/unknown session tab/);
    expect(readRegistry().sessions).toHaveLength(1);
  });

  it("rejects an archived source rather than forking a stale gz", async () => {
    setup("archived");
    await expect(invoke(CH.forkSession, "tab-1")).rejects.toThrow(/unarchive/);
    expect(readRegistry().sessions).toHaveLength(1);
  });

  it("rejects a session with no transcript yet", async () => {
    setup("missing");
    await expect(invoke(CH.forkSession, "tab-1")).rejects.toThrow(/no transcript/);
    expect(readRegistry().sessions).toHaveLength(1);
  });
});
