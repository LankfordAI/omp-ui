import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionFile from "./session-file";
import {
  resolveOwnedStatsAttribution,
  resolveStatsAttributions,
  statsProjectIdentity,
  type StatsReadContext,
} from "./stats-attribution";
import type { OwnedSessionRecord, ProjectRecord } from "./types";

const LINEAGE = "omp-ui--old-name--11111111-2222-3333-4444-555555555555";
const UNKNOWN = { identity: { key: "unattributed", kind: "unattributed" }, title: null };
const temporaryRoots: string[] = [];

function projectRecord(projectPath: string, name = "Project"): ProjectRecord {
  return {
    path: projectPath,
    name,
    addedAt: "2026-01-01T00:00:00.000Z",
    lastModel: null,
    lastThinkingLevel: null,
    lastAdvisor: null,
    lastAdvisorModel: null,
    defaultModel: null,
    defaultAdvisorModel: null,
    browserClock: false,
    councilRoster: null,
    knowledgeHome: null,
    repositoryKey: null,
    icon: null,
  };
}

function sessionRecord(patch: Partial<OwnedSessionRecord> = {}): OwnedSessionRecord {
  return {
    tabId: "tab-1",
    sessionId: "original-id",
    lineageDir: LINEAGE,
    projectCwd: "/abs/project",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "pty",
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    private: false,
    chat: false,
    askSource: null,
    fleet: null,
    autoTitled: false,
    snoozed: false,
    snoozedUntilMs: null,
    pinnedAtMs: null,
    settledAtMs: null,
    heldPrompt: null,
    scheduledPrompt: null,
    pullRequests: [],
    autoSettleOnMerge: null,
    cachedTitle: null,
    cachedModified: null,
    ...patch,
  };
}

function fixture(): StatsReadContext & { base: string } {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stats-attribution-"));
  const base = process.platform === "win32" ? created.toLowerCase() : created;
  temporaryRoots.push(base);
  const sessionsRoot = path.join(base, "agent", "sessions");
  const archiveRoot = path.join(base, "agent", "archive", "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(archiveRoot, { recursive: true });
  return {
    base,
    source: { profile: null, databasePath: path.join(base, "stats.db"), sessionsRoot, archiveRoot },
    projects: [],
    sessions: [],
    ownedSessionsRoot: sessionsRoot,
    ownedArchiveRoot: archiveRoot,
  };
}

function writeFile(file: string, contents: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function header(cwd: string, title?: string): string {
  return `${JSON.stringify({ type: "session", version: 3, id: "header-id", cwd, title })}\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("registry-backed stats attribution", () => {
  it("inherits the exact lineage for forks and nested files even after files and worktree disappear", async () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"), "Renamed Project");
    const worktreePath = path.join(context.base, "gone-worktree");
    context.projects = [project, projectRecord(worktreePath, "Not the owner")];
    context.sessions = [sessionRecord({
      projectCwd: project.path,
      worktree: { path: worktreePath, branch: "gone", base: null },
      cachedTitle: "Retained title",
    })];
    fs.rmSync(context.source.sessionsRoot, { recursive: true });
    fs.rmSync(context.source.archiveRoot, { recursive: true });
    const keys = [
      path.join(context.ownedSessionsRoot, LINEAGE, "other-id.jsonl"),
      path.join(context.ownedSessionsRoot, LINEAGE, "other-id", "subagents", "worker.jsonl"),
      path.join(context.ownedArchiveRoot, LINEAGE, "fork-id.jsonl.gz"),
    ];
    const read = vi.spyOn(sessionFile, "readSessionHead");
    const attributions = await resolveStatsAttributions(keys, context);
    for (const key of keys) expect(attributions.get(key)).toEqual({ identity: statsProjectIdentity(project), title: "Retained title" });
    expect(read).not.toHaveBeenCalled();
  });

  it("distinguishes Chats and removed Projects without reassociating a removed child to its registered ancestor", async () => {
    const context = fixture();
    const ancestor = projectRecord(path.join(context.base, "project"));
    const removed = path.join(ancestor.path, "removed");
    context.projects = [ancestor];
    context.sessions = [
      sessionRecord({ projectCwd: removed }),
      sessionRecord({ tabId: "chat", lineageDir: "omp-ui--chat--chat-id", projectCwd: ancestor.path, chat: true }),
    ];
    const removedFile = path.join(context.ownedSessionsRoot, LINEAGE, "s.jsonl");
    const chatFile = path.join(context.ownedArchiveRoot, "omp-ui--chat--chat-id", "s.jsonl.gz");
    const actual = await resolveStatsAttributions([removedFile, chatFile], context);
    expect(actual.get(removedFile)).toEqual({ identity: { key: `unregistered:${removed}`, kind: "unregistered", cwd: removed }, title: null });
    expect(actual.get(chatFile)).toEqual({ identity: { key: "chat", kind: "chat" }, title: null });
  });

  it("requires a direct first-segment registry match under the host's known roots", async () => {
    const context = fixture();
    context.projects = [projectRecord("/abs/project")];
    context.sessions = [sessionRecord()];
    const keys = [
      path.join(context.ownedSessionsRoot, `${LINEAGE}-suffix`, "s.jsonl"),
      path.join(context.ownedSessionsRoot, "other", LINEAGE, "s.jsonl"),
      path.join(context.base, "foreign", LINEAGE, "s.jsonl"),
      path.join(context.ownedSessionsRoot, LINEAGE),
    ];
    const actual = await resolveStatsAttributions(keys, context);
    expect(actual.size).toBe(keys.length);
    for (const key of keys) {
      expect(resolveOwnedStatsAttribution(key, context)).toBeNull();
      expect(actual.get(key)).toEqual(UNKNOWN);
    }
  });

  it("does not apply a host registry lineage to the same name in another selected source", async () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"));
    const other = projectRecord(path.join(context.base, "other"), "Other");
    context.sessions = [sessionRecord({ projectCwd: project.path })];
    context.projects = [project, other];
    context.source = { ...context.source, sessionsRoot: path.join(context.base, "other-source"), archiveRoot: path.join(context.base, "other-archive") };
    const key = writeFile(path.join(context.source.sessionsRoot, LINEAGE, "s.jsonl"), header(other.path));
    expect(resolveOwnedStatsAttribution(key, context)).toBeNull();
    expect((await resolveStatsAttributions([key], context)).get(key)?.identity).toEqual(statsProjectIdentity(context.projects[1]!));
  });

  it("provides a filesystem-free synchronous fallback for keys first seen inside the aggregate snapshot", () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"));
    context.projects = [project];
    context.sessions = [sessionRecord({ projectCwd: project.path })];
    const realpath = vi.spyOn(fs.promises, "realpath");
    const open = vi.spyOn(fs.promises, "open");
    const read = vi.spyOn(sessionFile, "readSessionHead");
    expect(resolveOwnedStatsAttribution(`${LINEAGE}/new/subagents/new.jsonl`, context)).toEqual({ identity: statsProjectIdentity(project), title: null });
    expect(realpath).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("normalizes Windows drive paths, separators and case without changing original map keys", async () => {
    const context = fixture();
    const project = projectRecord("C:\\Work\\Project\\", "Windows Project");
    context.projects = [project];
    context.ownedSessionsRoot = "C:\\Data\\Sessions\\";
    context.ownedArchiveRoot = "C:\\Data\\Archive\\Sessions";
    context.source = { ...context.source, sessionsRoot: context.ownedSessionsRoot, archiveRoot: context.ownedArchiveRoot };
    context.sessions = [sessionRecord({ projectCwd: "c:/work/PROJECT/.", lineageDir: LINEAGE.toUpperCase() })];
    const key = `c:/DATA/sessions/${LINEAGE}/root/../fork.jsonl`;
    const actual = await resolveStatsAttributions([key], context);
    expect(actual.get(key)).toEqual({ identity: { key: "project:c:\\work\\project", kind: "project", path: "c:\\work\\project", name: "Windows Project" }, title: null });
    expect(resolveOwnedStatsAttribution(`${LINEAGE}\\nested\\worker.jsonl`, context)?.identity).toEqual(statsProjectIdentity(project));
    for (const invalid of ["C:relative.jsonl", "\\relative.jsonl", `/Data/Sessions/${LINEAGE}/fork.jsonl`, `..\\${LINEAGE}\\escape.jsonl`]) {
      expect(resolveOwnedStatsAttribution(invalid, context)).toBeNull();
    }
  });

  it("normalizes UNC registry identities and excludes sibling shares", () => {
    const context = fixture();
    context.ownedSessionsRoot = "\\\\Server\\Share\\Sessions";
    context.ownedArchiveRoot = "\\\\Server\\Share\\Archive";
    context.sessions = [sessionRecord({ projectCwd: "\\\\HOST\\Repos\\Project\\" })];
    context.projects = [projectRecord("//host/repos/project", "UNC")];
    expect(resolveOwnedStatsAttribution(`\\\\SERVER\\SHARE\\sessions\\${LINEAGE}\\s.jsonl`, context)?.identity).toEqual({
      key: "project:\\\\host\\repos\\project",
      kind: "project",
      path: "\\\\host\\repos\\project",
      name: "UNC",
    });
    expect(resolveOwnedStatsAttribution(`\\\\server\\share-other\\sessions\\${LINEAGE}\\s.jsonl`, context)).toBeNull();
  });
});

describe("bounded session-header attribution", () => {
  it("selects the most-specific registered cwd with boundary matching, never merges same-named Projects", async () => {
    const context = fixture();
    const parent = projectRecord(path.join(context.base, "repo"), "Same name");
    const child = projectRecord(path.join(parent.path, "nested"), "Same name");
    context.projects = [parent, child];
    const keys = [
      writeFile(path.join(context.source.sessionsRoot, "encoded", "parent.jsonl"), header(path.join(parent.path, "src"), "Parent")),
      writeFile(path.join(context.source.sessionsRoot, "encoded", "child.jsonl"), header(path.join(child.path, "src"), "Child")),
      writeFile(path.join(context.source.sessionsRoot, "encoded", "sibling.jsonl"), header(`${parent.path}-tools`)),
    ];
    const actual = await resolveStatsAttributions(keys, context);
    expect(actual.get(keys[0]!)?.identity).toEqual(statsProjectIdentity(parent));
    expect(actual.get(keys[1]!)?.identity).toEqual(statsProjectIdentity(child));
    expect(actual.get(keys[0]!)?.identity.key).not.toBe(actual.get(keys[1]!)?.identity.key);
    expect(actual.get(keys[2]!)).toEqual({ identity: { key: `unregistered:${parent.path}-tools`, kind: "unregistered", cwd: `${parent.path}-tools` }, title: null });
  });

  it("matches Windows header cwd boundaries and UNC paths on the reading host", async () => {
    const context = fixture();
    const project = projectRecord("C:\\Work\\Repo\\", "Drive Project");
    const nestedProject = projectRecord("c:/work/repo/nested", "Nested Project");
    const uncProject = projectRecord("\\\\SERVER\\Share\\Repo", "UNC Project");
    context.projects = [project, nestedProject, uncProject];
    const keys = [
      writeFile(path.join(context.source.sessionsRoot, "folder", "drive.jsonl"), header("c:/WORK/repo/src")),
      writeFile(path.join(context.source.sessionsRoot, "folder", "nested.jsonl"), header("C:\\WORK\\REPO\\Nested\\src")),
      writeFile(path.join(context.source.sessionsRoot, "folder", "unc.jsonl"), header("//server/share/repo/src")),
      writeFile(path.join(context.source.sessionsRoot, "folder", "sibling.jsonl"), header("C:\\work\\repo-tools")),
    ];
    const actual = await resolveStatsAttributions(keys, context);
    expect(actual.get(keys[0]!)?.identity).toEqual(statsProjectIdentity(project));
    expect(actual.get(keys[1]!)?.identity).toEqual(statsProjectIdentity(nestedProject));
    expect(actual.get(keys[2]!)?.identity).toEqual(statsProjectIdentity(uncProject));
    expect(actual.get(keys[3]!)?.identity).toEqual({ key: "unregistered:c:\\work\\repo-tools", kind: "unregistered", cwd: "c:\\work\\repo-tools" });
  });

  it("uses an exact recorded worktree path to recover its original Project, including a deleted worktree", async () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"), "Original");
    const worktreePath = path.join(context.base, "deleted-checkout");
    context.projects = [project];
    context.sessions = [sessionRecord({ projectCwd: project.path, worktree: { path: worktreePath, branch: "deleted", base: null } })];
    const exact = writeFile(path.join(context.source.sessionsRoot, "terminal", "exact.jsonl"), header(worktreePath));
    const nested = writeFile(path.join(context.source.sessionsRoot, "terminal", "nested.jsonl"), header(path.join(worktreePath, "src")));
    const actual = await resolveStatsAttributions([exact, nested], context);
    expect(actual.get(exact)?.identity).toEqual(statsProjectIdentity(project));
    expect(actual.get(nested)?.identity.kind).toBe("unregistered");
    context.projects = [];
    expect((await resolveStatsAttributions([exact], context)).get(exact)?.identity).toEqual({ key: `unregistered:${project.path}`, kind: "unregistered", cwd: project.path });
  });

  it("inherits a nested file's root companion and reads each root only once", async () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"));
    context.projects = [project];
    const root = writeFile(path.join(context.source.sessionsRoot, "folder", "root.jsonl"), header(project.path, "Root title"));
    const first = writeFile(path.join(context.source.sessionsRoot, "folder", "root", "subagent", "a.jsonl"), header("/unrelated/agent", "Agent title"));
    const second = path.join(context.source.sessionsRoot, "folder", "root", "subagent", "b.jsonl");
    const read = vi.spyOn(sessionFile, "readSessionHead");
    const relative = path.join("folder", "root.jsonl");
    const actual = await resolveStatsAttributions([root, first, second, relative, root], context);
    expect(actual.size).toBe(4);
    for (const key of [root, first, second, relative]) expect(actual.get(key)).toEqual({ identity: statsProjectIdentity(project), title: "Root title" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never decodes a folder into a cwd or guesses from a nested agent when its root header is absent", async () => {
    const context = fixture();
    context.projects = [projectRecord("/abs/project")];
    const folder = "--abs-project--";
    const missing = path.join(context.source.sessionsRoot, folder, "missing.jsonl");
    const nested = writeFile(path.join(context.source.sessionsRoot, folder, "missing", "agent.jsonl"), header("/abs/project"));
    const actual = await resolveStatsAttributions([missing, nested], context);
    expect(actual.get(missing)).toEqual(UNKNOWN);
    expect(actual.get(nested)).toEqual(UNKNOWN);
  });

  it("uses the existing title-slot convention and does not inspect beyond the 4 KiB prefix", async () => {
    const context = fixture();
    const cwd = path.join(context.base, "project");
    const slot = `${JSON.stringify({ type: "title", title: "Slot title" })}\n`;
    const known = writeFile(path.join(context.source.sessionsRoot, "folder", "known.jsonl"), slot + header(cwd));
    const late = writeFile(path.join(context.source.sessionsRoot, "folder", "late.jsonl"), `${" ".repeat(4096)}\n${header(cwd)}`);
    const relative = writeFile(path.join(context.source.sessionsRoot, "folder", "relative.jsonl"), header("relative/project", "Still has a title"));
    const actual = await resolveStatsAttributions([known, late, relative], context);
    expect(actual.get(known)).toEqual({ identity: { key: `unregistered:${cwd}`, kind: "unregistered", cwd }, title: "Slot title" });
    expect(actual.get(late)).toEqual(UNKNOWN);
    expect(actual.get(relative)).toEqual({ identity: { key: "unattributed", kind: "unattributed" }, title: "Still has a title" });
  });

  it("limits concurrent header reads to eight while retaining deterministic input-key order", async () => {
    const context = fixture();
    const keys = Array.from({ length: 25 }, (_, index) => writeFile(path.join(context.source.sessionsRoot, "folder", `${index}.jsonl`), header(path.join(context.base, "unregistered", `${index}`))));
    const original = sessionFile.readSessionHead;
    let active = 0;
    let maximum = 0;
    const gate = new EventEmitter();
    const started = once(gate, "started");
    let released = false;
    const read = vi.spyOn(sessionFile, "readSessionHead").mockImplementation(async (...args) => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 8) gate.emit("started");
      try {
        if (!released) await once(gate, "release");
        return await original(...args);
      } finally {
        active--;
      }
    });
    const pending = resolveStatsAttributions(keys, context);
    await started;
    expect(active).toBe(8);
    released = true;
    gate.emit("release");
    const actual = await pending;
    expect([...actual.keys()]).toEqual(keys);
    expect(read).toHaveBeenCalledTimes(25);
    expect(maximum).toBe(8);
    expect(active).toBe(0);
    keys.forEach((key, index) => expect(actual.get(key)?.identity.key).toBe(`unregistered:${path.join(context.base, "unregistered", `${index}`)}`));
  });

  it("streams only an archive prefix for missing active files and nested companions, without restoring or mutating sources", async () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"));
    context.projects = [project];
    const active = path.join(context.source.sessionsRoot, "folder", "archived.jsonl");
    const archive = path.join(context.source.archiveRoot, "folder", "archived.jsonl.gz");
    // A missing gzip trailer would fail whole-file decompression. Attribution
    // needs only the bounded, valid prefix, not the rest of a large transcript.
    const compressed = gzipSync(Buffer.concat([Buffer.from(header(project.path, "Archived title")), Buffer.alloc(8192, 120), randomBytes(256 * 1024)]));
    const bytes = compressed.subarray(0, compressed.length - 8);
    writeFile(archive, bytes);
    const before = fs.statSync(archive);
    const nested = path.join(context.source.sessionsRoot, "folder", "archived", "subagent", "worker.jsonl");
    const archivedNested = path.join(context.source.archiveRoot, "folder", "archived", "subagent", "worker.jsonl");
    const actual = await resolveStatsAttributions([active, nested, archive, archivedNested], context);
    for (const key of [active, nested, archive, archivedNested]) expect(actual.get(key)).toEqual({ identity: statsProjectIdentity(project), title: "Archived title" });
    expect(fs.existsSync(active)).toBe(false);
    expect(fs.readFileSync(archive)).toEqual(bytes);
    expect(fs.statSync(archive).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(path.dirname(archive))).toEqual(["archived.jsonl.gz"]);
  });

  it("does not scan unbounded gzip metadata before a header becomes available", async () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"));
    context.projects = [project];
    const active = path.join(context.source.sessionsRoot, "folder", "metadata.jsonl");
    const compressed = gzipSync(header(project.path));
    const gzipHeader = Buffer.from(compressed.subarray(0, 10));
    gzipHeader[3] = 8; // Optional gzip original filename, terminated by NUL.
    writeFile(path.join(context.source.archiveRoot, "folder", "metadata.jsonl.gz"),
      Buffer.concat([gzipHeader, Buffer.alloc(128 * 1024, 65), Buffer.from([0]), compressed.subarray(10)]));
    expect((await resolveStatsAttributions([active], context)).get(active)).toEqual(UNKNOWN);
  });

  it("does not replace an existing malformed active header with contradictory archive evidence", async () => {
    const context = fixture();
    const active = writeFile(path.join(context.source.sessionsRoot, "folder", "s.jsonl"), "not JSON\n");
    writeFile(path.join(context.source.archiveRoot, "folder", "s.jsonl.gz"), gzipSync(header("/archive/project")));
    const corrupt = writeFile(path.join(context.source.archiveRoot, "folder", "corrupt.jsonl.gz"), "invalid gzip");
    const actual = await resolveStatsAttributions([active, corrupt], context);
    expect(actual.get(active)).toEqual(UNKNOWN);
    expect(actual.get(corrupt)).toEqual(UNKNOWN);
  });

  it("confines relative keys to the selected root and never reads absolute keys outside known roots", async () => {
    const context = fixture();
    const project = projectRecord(path.join(context.base, "project"));
    context.projects = [project];
    writeFile(path.join(context.source.sessionsRoot, "folder", "s.jsonl"), header(project.path));
    const outside = writeFile(path.join(context.base, "outside.jsonl"), header(project.path));
    const keys = ["folder/s.jsonl", "../outside.jsonl", outside, "", "\0", context.source.sessionsRoot];
    const read = vi.spyOn(sessionFile, "readSessionHead");
    const actual = await resolveStatsAttributions(keys, context);
    expect(actual.size).toBe(keys.length);
    expect(actual.get(keys[0]!)?.identity).toEqual(statsProjectIdentity(project));
    for (const key of keys.slice(1)) expect(actual.get(key)).toEqual(UNKNOWN);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refuses header and directory symlink escapes but permits a link whose target stays inside the real root", async () => {
    const context = fixture();
    const outsideDir = path.join(context.base, "outside");
    const outside = writeFile(path.join(outsideDir, "s.jsonl"), header("/escaped/project"));
    const folder = path.join(context.source.sessionsRoot, "folder");
    fs.mkdirSync(folder, { recursive: true });
    const escapingFile = path.join(folder, "escape.jsonl");
    fs.symlinkSync(outside, escapingFile, "file");
    const escapingDir = path.join(context.source.sessionsRoot, "escape-dir");
    fs.symlinkSync(outsideDir, escapingDir, process.platform === "win32" ? "junction" : "dir");
    const insideCwd = path.join(context.base, "inside-project");
    const inside = writeFile(path.join(folder, "inside.jsonl"), header(insideCwd));
    const confined = path.join(folder, "link.jsonl");
    fs.symlinkSync(inside, confined, "file");
    const escapedNested = path.join(escapingDir, "s", "subagent", "worker.jsonl");
    const actual = await resolveStatsAttributions([escapingFile, path.join(escapingDir, "s.jsonl"), escapedNested, confined], context);
    for (const key of [escapingFile, path.join(escapingDir, "s.jsonl"), escapedNested]) expect(actual.get(key)).toEqual(UNKNOWN);
    expect(actual.get(confined)?.identity).toEqual({ key: `unregistered:${insideCwd}`, kind: "unregistered", cwd: insideCwd });
  });

  it("realpath-confines missing-active archive companions too", async () => {
    const context = fixture();
    const outside = writeFile(path.join(context.base, "outside.jsonl.gz"), gzipSync(header("/escaped/project")));
    const archive = path.join(context.source.archiveRoot, "folder", "s.jsonl.gz");
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.symlinkSync(outside, archive, "file");
    const active = path.join(context.source.sessionsRoot, "folder", "s.jsonl");
    expect((await resolveStatsAttributions([active], context)).get(active)).toEqual(UNKNOWN);
    expect(fs.existsSync(active)).toBe(false);
  });
});
