import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@omp-ui/core";
import { MainBackend } from "./backend";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the surfaces it touches
// (backend-remote-instances.test.ts's pattern).
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

const win = {
  isDestroyed: () => false,
  webContents: { mainFrame: {}, isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

let base: string;
let registryFile: string;
const backends: MainBackend[] = [];

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backend-gate-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  registryFile = path.join(base, "registry.json");
});

afterEach(async () => {
  await Promise.all(backends.splice(0).map((be) => be.killAll()));
  fs.rmSync(base, { recursive: true, force: true });
});

function bootWithProject(projectPath: string): MainBackend {
  const project = {
    path: projectPath,
    name: "project",
    addedAt: "2026-08-01T00:00:00.000Z",
    lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null,
    defaultModel: null, defaultAdvisorModel: null, browserClock: false,
    councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null,
  };
  seedRegistry(registryFile, { projects: [project] });
  const be = new MainBackend(win as never, registryFile, { appVersion: "1.2.3" });
  backends.push(be);
  return be;
}

describe("project-scoped channels are gated on registered projects", () => {
  it("refuses an unregistered projectCwd with the registration error", async () => {
    const project = fs.mkdtempSync(path.join(base, "registered-"));
    const unregistered = fs.mkdtempSync(path.join(base, "unregistered-"));
    const be = bootWithProject(project);
    const requests = be.handlers().request;

    const gated: Array<[string, () => unknown]> = [
      ["getProjectSubagentModels", () => requests[CH.getProjectSubagentModels](unregistered)],
      ["setProjectSubagentModel", () => requests[CH.setProjectSubagentModel](unregistered, "explore", null)],
      ["getProjectMaxConcurrency", () => requests[CH.getProjectMaxConcurrency](unregistered)],
      ["setProjectMaxConcurrency", () => requests[CH.setProjectMaxConcurrency](unregistered, null)],
      ["getProjectSpendCaps", () => requests[CH.getProjectSpendCaps](unregistered)],
      ["setProjectSpendCap", () => requests[CH.setProjectSpendCap](unregistered, "warnCost", null)],
      ["getProjectApprovalMode", () => requests[CH.getProjectApprovalMode](unregistered)],
      ["setProjectApprovalMode", () => requests[CH.setProjectApprovalMode](unregistered, null)],
      ["setProjectDefaultModel", () => requests[CH.setProjectDefaultModel](unregistered, null)],
      ["setProjectDefaultAdvisorModel", () => requests[CH.setProjectDefaultAdvisorModel](unregistered, null)],
      ["setProjectBrowserClock", () => requests[CH.setProjectBrowserClock](unregistered, true)],
      ["setProjectKnowledgeHome", () => requests[CH.setProjectKnowledgeHome](unregistered, null)],
      ["getAdvisorDefaults", () => requests[CH.getAdvisorDefaults](unregistered)],
      ["getBranchDiff", () => requests[CH.getBranchDiff](unregistered, null)],
      ["listBranches", () => requests[CH.listBranches](unregistered)],
      ["checkoutBranch", () => requests[CH.checkoutBranch](unregistered, "main")],
      ["pullBranch", () => requests[CH.pullBranch](unregistered)],
      ["pushBranch", () => requests[CH.pushBranch](unregistered, "main")],
      ["pullRequestUrl", () => requests[CH.pullRequestUrl](unregistered, "main", "main")],
      ["createBranch", () => requests[CH.createBranch](unregistered, "feature/x", "main")],
      ["resolveMergeDestination", () => requests[CH.resolveMergeDestination](unregistered, null)],
      ["getMergeBackStatus", () => requests[CH.getMergeBackStatus](unregistered, "main", "main", null)],
      ["mergeWorktreeBranch", () => requests[CH.mergeWorktreeBranch](unregistered, "main", "main")],
      ["memoryOverview", () => requests[CH.memoryOverview](unregistered)],
      ["autoresearchOverview", () => requests[CH.autoresearchOverview](unregistered)],
      ["listProjectFiles", () => requests[CH.listProjectFiles](unregistered)],
      ["resolveFileMentions", () => requests[CH.resolveFileMentions](unregistered, "@foo")],
      ["openProject", () => requests[CH.openProject](unregistered, "files")],
      ["getMcpServers", () => requests[CH.getMcpServers](unregistered)],
    ];
    for (const [name, call] of gated) {
      await expect(Promise.resolve().then(call), name).rejects.toThrow(
        "that project is not registered here",
      );
    }
  });

  it("serves a registered projectCwd on a gated read channel", async () => {
    const project = fs.mkdtempSync(path.join(base, "registered-"));
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    const be = bootWithProject(project);
    const requests = be.handlers().request;
    await expect(Promise.resolve(requests[CH.getProjectSubagentModels](project))).resolves.toMatchObject({
      map: {},
    });
    await expect(requests[CH.listBranches](project)).resolves.toBeTruthy();
  });

  it("serves branch channels on an owned worktree checkout — the cwd the composer actually passes", async () => {
    // The renderer hands every branch channel `sessionCwd(record)` (view.ts),
    // i.e. the WORKTREE path for a worktree session, never the project root:
    // the gate must accept it or the whole branch chip dies in worktrees.
    const project = fs.mkdtempSync(path.join(base, "registered-"));
    const gitIn = (cwd: string, args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd,
        stdio: "ignore",
      });
    gitIn(project, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(project, "f.txt"), "a");
    gitIn(project, ["add", "f.txt"]);
    gitIn(project, ["commit", "-q", "-m", "seed"]);
    const worktreesRoot = path.join(base, "worktrees");
    const worktreePath = path.join(worktreesRoot, "proj", "feat-wt");
    fs.mkdirSync(worktreesRoot, { recursive: true });
    gitIn(project, ["worktree", "add", "-q", "-b", "feat/wt", worktreePath, "main"]);

    seedRegistry(registryFile, {
      projects: [{
        path: project, name: "project", addedAt: "2026-08-01T00:00:00.000Z",
        lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null,
        defaultModel: null, defaultAdvisorModel: null, browserClock: false,
        councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null,
      }],
      sessions: [ownedSessionRecord({
        projectCwd: project,
        worktree: { path: worktreePath, branch: "feat/wt", base: "main" },
      })],
    });
    const be = new MainBackend(win as never, registryFile, { appVersion: "1.2.3", worktreesRoot });
    backends.push(be);
    const requests = be.handlers().request;

    await expect(requests[CH.listBranches](worktreePath)).resolves.toMatchObject({
      current: "feat/wt",
    });
    await expect(requests[CH.pullRequestUrl](worktreePath, "main", "feat/wt")).resolves.toBeNull();
    // A real git mutation through the same gate: it must reach git, not the gate.
    await expect(requests[CH.createBranch](worktreePath, "cut-from-worktree", "HEAD")).resolves.toBeUndefined();

    // The tolerance is scoped to OWNED worktrees: a path under the root with
    // no session record stays refused.
    const stranger = path.join(worktreesRoot, "proj", "not-mine");
    fs.mkdirSync(stranger, { recursive: true });
    await expect(Promise.resolve().then(() => requests[CH.listBranches](stranger))).rejects.toThrow(
      "that project is not registered here",
    );
  });

  it("refuses browseDirectories and desktop-local shell open channels for remote clients", async () => {
    const project = fs.mkdtempSync(path.join(base, "registered-"));
    const be = bootWithProject(project);
    const remote = be.handlers("remote").request;
    await expect(Promise.resolve().then(() => remote[CH.browseDirectories]("/"))).rejects.toThrow(
      /only available in the desktop app/,
    );
    await expect(Promise.resolve().then(() => remote[CH.openPath]("/tmp/x"))).rejects.toThrow(
      /only available in the desktop app/,
    );
    await expect(Promise.resolve().then(() => remote[CH.showPathInFolder]("/tmp/x"))).rejects.toThrow(
      /only available in the desktop app/,
    );
    await expect(Promise.resolve().then(() => remote[CH.openProject](project, "files"))).rejects.toThrow(
      /only available in the desktop app/,
    );
  });

  it("rejects symlink escapes and outside paths in showPathInFolder while allowing exported HTML in a registered project", async () => {
    const project = fs.mkdtempSync(path.join(base, "registered-"));
    const outside = path.join(base, "secret.txt");
    fs.writeFileSync(outside, "secret");
    const artifactsRoot = path.join(base, "custom-artifacts");
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const escapeLink = path.join(artifactsRoot, "escape.txt");
    fs.symlinkSync(outside, escapeLink);
    const exportedHtml = path.join(project, "omp-session-abc.html");
    fs.writeFileSync(exportedHtml, "<html></html>");

    seedRegistry(registryFile, {
      projects: [{
        path: project, name: "project", addedAt: "2026-08-01T00:00:00.000Z",
        lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null,
        defaultModel: null, defaultAdvisorModel: null, browserClock: false,
        councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null,
      }],
    });
    const be = new MainBackend(win as never, registryFile, { appVersion: "1.2.3", artifactsRoot });
    backends.push(be);
    const requests = be.handlers().request;

    await expect(Promise.resolve().then(() => requests[CH.showPathInFolder](outside))).rejects.toThrow(
      /only files this app produced/,
    );
    await expect(Promise.resolve().then(() => requests[CH.showPathInFolder](escapeLink))).rejects.toThrow(
      /only files this app produced/,
    );
    await expect(Promise.resolve().then(() => requests[CH.showPathInFolder](exportedHtml))).resolves.toBeUndefined();
  });
});
