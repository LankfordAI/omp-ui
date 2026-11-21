import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@omp-ui/core";
import { MainBackend } from "./backend";
import { seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the surfaces it touches
// (backend-remote-instances.test.ts's pattern).
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
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
      ["mergeWorktreeBranch", () => requests[CH.mergeWorktreeBranch](unregistered, "main", "main")],
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
});
