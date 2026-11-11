import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitGuardOverlayPath, outRepliesOverlayPath, subagentModelOverlayPath } from "@omp-ui/core";
import * as Core from "@omp-ui/core";
import {
  RPC_BRIDGE_IDS,
  writeCouncilForSpawn,
  readGoalContinuationModesCached,
  resetGoalContinuationModesCache,
  writeRpcExtensions,
  writeRpcOverlays,
  writeSessionOverlays,
  type RpcBridgeWriters,
} from "./spawn-config";
import { ownedSessionRecord } from "./test/fixtures";

vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return { ...core, readOmpGoalContinuationModes: vi.fn(), readInstalledOmpVersion: vi.fn() };
});

const readOmpGoalContinuationModesMock = vi.mocked(Core.readOmpGoalContinuationModes);
const readInstalledOmpVersionMock = vi.mocked(Core.readInstalledOmpVersion);

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spawn-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function bridgeWriters(write: (id: (typeof RPC_BRIDGE_IDS)[number]) => string): RpcBridgeWriters {
  return {
    plan: () => write("plan"),
    advisorStats: () => write("advisorStats"),
    mcpStatus: () => write("mcpStatus"),
    capabilities: () => write("capabilities"),
    vibe: () => write("vibe"),
    browserPane: () => write("browserPane"),
    autoresearch: () => write("autoresearch"),
    limits: () => write("limits"),
    asyncJobs: () => write("asyncJobs"),
    sessionSpend: () => write("sessionSpend"),
    tree: () => write("tree"),
    knowledgeVault: () => write("knowledgeVault"),
    askContext: () => write("askContext"),
    carryoverContext: () => write("carryoverContext"),
    privateGuard: () => write("privateGuard"),
    sideCommands: () => write("sideCommands"),
    fleetWake: () => write("fleetWake"),
  };
}

describe("writeRpcExtensions", () => {
  it("reports every bridge independently, including plan and advisor stats", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writers = bridgeWriters((id) => {
      if (id === "plan" || id === "advisorStats") throw new Error(`${id} failed`);
      return `/${id}.ts`;
    });

    expect(
      writeRpcExtensions(tmp(), { autoresearchEnabled: true }, writers),
    ).toEqual({
      paths: [
        "/mcpStatus.ts",
        "/capabilities.ts",
        "/vibe.ts",
        "/browserPane.ts",
        "/autoresearch.ts",
        "/limits.ts",
        "/asyncJobs.ts",
        "/sessionSpend.ts",
        "/tree.ts",
        "/knowledgeVault.ts",
        "/askContext.ts",
        "/carryoverContext.ts",
        "/privateGuard.ts",
        "/sideCommands.ts",
        "/fleetWake.ts",
      ],
      loaded: {
        plan: false,
        advisorStats: false,
        mcpStatus: true,
        capabilities: true,
        vibe: true,
        browserPane: true,
        autoresearch: true,
        limits: true,
        asyncJobs: true,
        sessionSpend: true,
        tree: true,
        knowledgeVault: true,
        askContext: true,
        carryoverContext: true,
        privateGuard: true,
        sideCommands: true,
        fleetWake: true,
      },
    });
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("records a disabled autoresearch bridge without invoking it", () => {
    const autoresearch = vi.fn(() => "/autoresearch.ts");
    const writers = bridgeWriters((id) =>
      id === "autoresearch" ? autoresearch() : `/${id}.ts`,
    );
    const result = writeRpcExtensions(
      tmp(),
      { autoresearchEnabled: false },
      writers,
    );
    expect(result.loaded.autoresearch).toBe(false);
    expect(autoresearch).not.toHaveBeenCalled();
  });

});

describe("writeCouncilForSpawn", () => {
  const member = (name: string, model: string | null, enabled = true): Core.CouncilMember => ({
    name,
    model,
    instructions: `instructions for ${name}`,
    enabled,
  });
  const global: Core.CouncilDocument = {
    instructions: "shared instructions",
    members: [member("global", "provider/global")],
  };

  it("uses the project launch set for exact grants, the manifest, and the completed package", () => {
    const dir = tmp();
    const project: Core.CouncilDocument = {
      instructions: "project instructions",
      members: [
        member("disabled", "provider/disabled", false),
        member("missing", null),
        member("first", "provider/first"),
        member("second", "provider/second"),
        member("third", "provider/third"),
        member("extra", "provider/extra"),
      ],
      trial: member("trial", "provider/trial"),
    };
    const result = writeCouncilForSpawn(dir, true, global, project);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready Council");
    expect(result.snapshot.members.map((entry) => entry.model)).toEqual([
      "provider/first", "provider/second", "provider/third",
    ]);
    expect(result.snapshot.instructions).toBe("project instructions");
    expect(result.snapshot.trial?.model).toBe("provider/trial");
    expect(result.snapshot.configWarnings).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(Core.councilRosterSnapshotPath(dir), "utf8"))).toEqual(result.snapshot);
    expect(result.overlayPath).toBe(Core.councilOverlayPath(dir));
    expect(fs.readFileSync(result.overlayPath!, "utf8")).toBe(
      'async:\n  enabled: true\ntask:\n  batch: true\n  perCallModel: "on"\n' +
      'modelRoles:\n  "omp-ui-council-1": "provider/first"\n' +
      '  "omp-ui-council-2": "provider/second"\n' +
      '  "omp-ui-council-3": "provider/third"\n' +
      '  "omp-ui-council-trial": "provider/trial"\n',
    );
    expect(result.extensionPath).toBe(Core.councilExtensionDir(dir));
    const pkg = JSON.parse(fs.readFileSync(path.join(result.extensionPath, "package.json"), "utf8"));
    for (const entry of pkg.omp.extensions as string[]) {
      expect(fs.statSync(path.join(result.extensionPath, entry)).isFile()).toBe(true);
    }
    expect(fs.statSync(path.join(result.extensionPath, "agents", `${Core.COUNCIL_AGENT}.md`)).isFile()).toBe(true);
  });

  it("falls back to the global roster, then to an empty ready Council without grants", () => {
    const dir = tmp();
    const inherited = writeCouncilForSpawn(dir, true, global, null);
    expect(inherited.status).toBe("ready");
    if (inherited.status !== "ready") throw new Error("expected ready Council");
    expect(inherited.snapshot.members.map((entry) => entry.model)).toEqual(["provider/global"]);
    const empty = writeCouncilForSpawn(dir, true, null, null);
    expect(empty).toMatchObject({ status: "ready", overlayPath: null, snapshot: { members: [], trial: null, configWarnings: [] } });
    expect(fs.existsSync(Core.councilOverlayPath(dir))).toBe(false);
    expect(JSON.parse(fs.readFileSync(Core.councilRosterSnapshotPath(dir), "utf8"))).toEqual(
      empty.status === "ready" ? empty.snapshot : null,
    );
  });

  it("lets an empty project override global and never grants a trial-only launch", () => {
    const dir = tmp();
    writeCouncilForSpawn(dir, true, global, null);
    const result = writeCouncilForSpawn(dir, true, global, {
      instructions: null,
      members: [],
      trial: member("trial", "provider/trial"),
    });
    expect(result).toMatchObject({ status: "ready", overlayPath: null, snapshot: { members: [], trial: null } });
    if (result.status !== "ready") throw new Error("expected ready Council");
    expect(result.snapshot.configWarnings).toHaveLength(1);
    expect(fs.existsSync(Core.councilOverlayPath(dir))).toBe(false);
  });

  it("does not resolve a disabled Council and removes its stale artifacts and legacy review files", () => {
    const dir = tmp();
    writeCouncilForSpawn(dir, true, global, null);
    const legacy = ["omp-ui-code-review.ts", "omp-ui-review.yml", "omp-ui-review-roster.json"];
    for (const file of legacy) fs.writeFileSync(path.join(dir, file), "stale");
    const unreadable: Core.CouncilDocument = {
      get instructions(): string | null { throw new Error("disabled roster was read"); },
      get members(): readonly Core.CouncilMember[] { throw new Error("disabled roster was read"); },
    };
    expect(writeCouncilForSpawn(dir, false, unreadable, unreadable)).toEqual({
      status: "disabled", extensionPath: null, overlayPath: null,
    });
    for (const file of [Core.councilOverlayPath(dir), Core.councilRosterSnapshotPath(dir), Core.councilExtensionDir(dir), ...legacy.map((file) => path.join(dir, file))]) {
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it.each(["overlay", "snapshot", "extension"] as const)("reports a real %s write failure without passing grants or an incomplete package", (stage) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = tmp();
      const blocked = stage === "overlay" ? Core.councilOverlayPath(dir)
        : stage === "snapshot" ? Core.councilRosterSnapshotPath(dir)
        : Core.councilExtensionPath(dir);
      fs.mkdirSync(blocked, { recursive: true });
      const result = writeCouncilForSpawn(dir, true, global, null);
      expect(result.status).toBe("unavailable");
      if (result.status !== "unavailable") throw new Error("expected unavailable Council");
      expect(result.failure.stage).toBe(stage);
      expect(result.failure.message).toContain(blocked);
      expect(result.overlayPath).toBeNull();
      expect(result.extensionPath).toBe(stage === "extension" ? null : Core.councilExtensionDir(dir));
      if (stage !== "overlay") expect(fs.existsSync(Core.councilOverlayPath(dir))).toBe(false);
      if (stage !== "snapshot") expect(fs.existsSync(Core.councilRosterSnapshotPath(dir))).toBe(false);
      expect(warning.mock.calls[0]?.[1]).toMatchObject({ ...result.failure, cause: expect.any(Error) });
      // A Council preparation failure is not fatal to ordinary session configuration.
      expect(writeSessionOverlays(ownedSessionRecord(), dir)).toContain(path.join(dir, "omp-ui-model.yml"));
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves the original resolution cause and removes stale grants before writing diagnostics", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = tmp();
      writeCouncilForSpawn(dir, true, global, null);
      const cause = new Error("roster could not be read");
      const unreadable: Core.CouncilDocument = {
        get instructions(): string | null { throw cause; },
        members: [],
      };
      const result = writeCouncilForSpawn(dir, true, unreadable, null);
      expect(result).toEqual({
        status: "unavailable", extensionPath: Core.councilExtensionDir(dir), overlayPath: null,
        failure: { stage: "resolve", message: cause.message },
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith("[council] initialization failed:", {
        stage: "resolve", message: cause.message, cause,
      });
      expect(fs.existsSync(Core.councilOverlayPath(dir))).toBe(false);
      expect(fs.existsSync(Core.councilRosterSnapshotPath(dir))).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });

  it("logs a secondary diagnostic failure separately without replacing the original failure", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = tmp();
      fs.mkdirSync(Core.councilOverlayPath(dir));
      fs.mkdirSync(Core.councilExtensionPath(dir), { recursive: true });
      const result = writeCouncilForSpawn(dir, true, global, null);
      expect(result).toMatchObject({ status: "unavailable", extensionPath: null, overlayPath: null, failure: { stage: "overlay" } });
      if (result.status !== "unavailable") throw new Error("expected unavailable Council");
      const original = warning.mock.calls[0]?.[1] as { cause: Error };
      const diagnostic = warning.mock.calls[1]?.[1] as { failure: Core.CouncilInitializationFailure; cause: Error };
      expect(warning.mock.calls.map(([message]) => message)).toEqual([
        "[council] initialization failed:", "[council] diagnostic extension failed:",
      ]);
      expect(result.failure.message).toBe(original.cause.message);
      expect(diagnostic.failure).toBe(result.failure);
      expect(diagnostic.cause).not.toBe(original.cause);
      expect(diagnostic.cause.message).toContain(Core.councilExtensionPath(dir));
      expect(fs.existsSync(Core.councilRosterSnapshotPath(dir))).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });
});

describe("writeSessionOverlays vault pin", () => {
  it("appends one vault-disabled pin after the approval overlay on every rewrite", () => {
    const dir = tmp();
    const file = path.join(dir, "omp-ui-vault.yml");
    fs.writeFileSync(file, "vault:\n  enabled: true\n");
    const record = ownedSessionRecord({ approvalMode: "always-ask" });
    for (let launch = 0; launch < 2; launch += 1) {
      const overlays = writeSessionOverlays(record, dir);
      expect(overlays.filter((overlay) => overlay === file)).toEqual([file]);
      expect(overlays.at(-2)).toBe(path.join(dir, "omp-ui-approval.yml"));
      expect(overlays.at(-1)).toBe(file);
      expect(fs.readFileSync(file, "utf8")).toBe("vault:\n  enabled: false\n");
    }
  });

  it("warns and preserves the other overlays if the vault pin cannot be written", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "omp-ui-vault.yml"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const overlays = writeSessionOverlays(ownedSessionRecord({ approvalMode: "write" }), dir);
      expect(overlays).toContain(path.join(dir, "omp-ui-approval.yml"));
      expect(overlays).not.toContain(path.join(dir, "omp-ui-vault.yml"));
      expect(warning).toHaveBeenCalledExactlyOnceWith("[vault] could not write the overlay:", expect.any(Error));
    } finally {
      warning.mockRestore();
    }
  });
});

describe("writeSessionOverlays — git guard pin (#832)", () => {
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  });
  function isolatedAgentDir(): { dir: string; agent: string } {
    const dir = tmp();
    const agent = path.join(dir, "agent");
    fs.mkdirSync(agent, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agent;
    return { dir, agent };
  }
  const worktree = {
    path: "/wt/branch",
    branch: "omp-ui/proj-11111111",
    base: "main",
  };

  it("pins the guard on for an unconfigured worktree session", () => {
    const { dir } = isolatedAgentDir();
    const file = gitGuardOverlayPath(dir);
    const overlays = writeSessionOverlays(ownedSessionRecord({ worktree }), dir);
    expect(overlays).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe("bash:\n  gitGuard: true\n");
  });

  it("omits the pin for a project-checkout session", () => {
    const { dir } = isolatedAgentDir();
    const file = gitGuardOverlayPath(dir);
    fs.writeFileSync(file, "bash:\n  gitGuard: true\n");
    const overlays = writeSessionOverlays(ownedSessionRecord({ worktree: null }), dir);
    expect(overlays).not.toContain(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("omits the pin and drops the stale artifact when the global layer names the key", () => {
    const { dir, agent } = isolatedAgentDir();
    fs.writeFileSync(path.join(agent, "config.yml"), "bash:\n  gitGuard: false\n", "utf8");
    const file = gitGuardOverlayPath(dir);
    fs.writeFileSync(file, "bash:\n  gitGuard: true\n");
    const overlays = writeSessionOverlays(ownedSessionRecord({ worktree }), dir);
    expect(overlays).not.toContain(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("writeSessionOverlays private pin (issue #852)", () => {
  it("appends the quiet pin last on every rewrite of a private record", () => {
    const dir = tmp();
    const file = path.join(dir, "omp-ui-private.yml");
    const record = ownedSessionRecord({ private: true });
    for (let launch = 0; launch < 2; launch += 1) {
      const overlays = writeSessionOverlays(record, dir);
      expect(overlays.filter((overlay) => overlay === file)).toEqual([file]);
      expect(overlays.at(-1)).toBe(file);
      expect(fs.readFileSync(file, "utf8")).toBe(
        "autolearn:\n  enabled: false\nmnemopi:\n  autoRetain: false\nhindsight:\n  autoRetain: false\n",
      );
    }
  });

  it("omits the pin for an ordinary record and drops a stale artifact", () => {
    const dir = tmp();
    const file = path.join(dir, "omp-ui-private.yml");
    fs.writeFileSync(file, "mnemopi:\n  autoRetain: false\n");
    const overlays = writeSessionOverlays(ownedSessionRecord(), dir);
    expect(overlays).not.toContain(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("warns and preserves the other overlays if the pin cannot be written", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "omp-ui-private.yml"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const overlays = writeSessionOverlays(ownedSessionRecord({ private: true }), dir);
      expect(overlays).toContain(path.join(dir, "omp-ui-vault.yml"));
      expect(overlays).not.toContain(path.join(dir, "omp-ui-private.yml"));
      expect(warning).toHaveBeenCalledExactlyOnceWith("[private] could not write the overlay:", expect.any(Error));
    } finally {
      warning.mockRestore();
    }
  });
});
describe("writeSessionOverlays worktree pin", () => {
  it("appends the worktree pin exactly once on every launch", () => {
    const dir = tmp();
    const file = path.join(dir, "omp-ui-worktree.yml");
    const record = ownedSessionRecord({ approvalMode: "always-ask" });
    for (let launch = 0; launch < 2; launch += 1) {
      const overlays = writeSessionOverlays(record, dir);
      expect(overlays.filter((overlay) => overlay === file)).toEqual([file]);
    }
    // Pin VALUES are verified where they are serialized — YAML-parsed in
    // worktree-overlay.test.ts — and against the real runtime in
    // ovnfs-isolation-live.test.ts. Byte-layout checks here would pin
    // serialization (and mis-fire on Windows, where yamlQuote escapes the
    // lineage path's backslashes) instead of the rail contract above.
  });

  it("warns and preserves the other overlays if the worktree pin cannot be written", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "omp-ui-worktree.yml"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const overlays = writeSessionOverlays(ownedSessionRecord({ approvalMode: "write" }), dir);
      expect(overlays).toContain(path.join(dir, "omp-ui-approval.yml"));
      expect(overlays).not.toContain(path.join(dir, "omp-ui-worktree.yml"));
      expect(warning).toHaveBeenCalledExactlyOnceWith("[worktree] could not write the overlay:", expect.any(Error));
    } finally {
      warning.mockRestore();
    }
  });
});


describe("writeSessionOverlays — subagent overlay (ADR-0031)", () => {
  it("umbrella on + no session choice: every roster name inherits the session model", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(ownedSessionRecord(), dir, undefined, {
      inheritByDefault: true,
      roster: ["scout", "task"],
    });
    const file = subagentModelOverlayPath(dir);
    expect(overlays).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe(
      'task:\n  agentModelOverrides:\n    "scout": "*"\n    "task": "*"\n',
    );
  });

  it("an explicit session map replaces the umbrella outright", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(
      ownedSessionRecord({ subagentModels: { task: "openai/gpt-5" } }),
      dir,
      undefined,
      { inheritByDefault: true, roster: ["scout", "task"] },
    );
    const file = subagentModelOverlayPath(dir);
    expect(overlays).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe(
      'task:\n  agentModelOverrides:\n    "task": "openai/gpt-5"\n',
    );
  });

  it("umbrella off + no session choice: no overlay, and a stale file is removed", () => {
    const dir = tmp();
    writeSessionOverlays(ownedSessionRecord({ subagentModels: { scout: "*" } }), dir, undefined, {
      inheritByDefault: false,
      roster: [],
    });
    const overlays = writeSessionOverlays(ownedSessionRecord(), dir, undefined, {
      inheritByDefault: false,
      roster: ["scout"],
    });
    expect(overlays).not.toContain(subagentModelOverlayPath(dir));
    expect(fs.existsSync(subagentModelOverlayPath(dir))).toBe(false);
  });

  it("omitted subagent config keeps a record's explicit choice", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(
      ownedSessionRecord({ subagentModels: { scout: "openai/gpt-5" } }),
      dir,
    );
    expect(overlays).toContain(subagentModelOverlayPath(dir));
  });
});

describe("writeSessionOverlays — auto thinking selector", () => {
  it("pins the model without a :auto suffix and adds the settings key", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(
      ownedSessionRecord({ model: "p/m", thinkingLevel: "auto" }),
      dir,
    );
    const file = overlays.find((f) => path.basename(f) === "omp-ui-model.yml");
    expect(file).toBeDefined();
    const text = fs.readFileSync(file!, "utf8");
    expect(text).toBe('modelRoles:\n  default: "p/m"\ndefaultThinkingLevel: "auto"\n');
    expect(text).not.toContain("p/m:auto");
  });

  it("writes the settings-only overlay when auto is picked without a model", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(
      ownedSessionRecord({ model: null, thinkingLevel: "auto" }),
      dir,
    );
    const file = overlays.find((f) => path.basename(f) === "omp-ui-model.yml");
    expect(file).toBeDefined();
    expect(fs.readFileSync(file!, "utf8")).toBe('defaultThinkingLevel: "auto"\n');
  });

  it("a concrete level still composes the :level suffix as before", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(
      ownedSessionRecord({ model: "p/m", thinkingLevel: "xhigh" }),
      dir,
    );
    const file = overlays.find((f) => path.basename(f) === "omp-ui-model.yml");
    expect(fs.readFileSync(file!, "utf8")).toBe('modelRoles:\n  default: "p/m:xhigh"\n');
  });

  it("an auto gate pin strips the suffix and sets the settings key", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(ownedSessionRecord({ model: null, thinkingLevel: null }), dir, {
      model: { model: "p/m", level: "auto" },
      advisorModel: null,
    });
    const file = overlays.find((f) => path.basename(f) === "omp-ui-model.yml");
    expect(fs.readFileSync(file!, "utf8")).toBe('modelRoles:\n  default: "p/m"\ndefaultThinkingLevel: "auto"\n');
  });
});

describe("readGoalContinuationModesCached", () => {
  it("probes once per identical config and re-probes when a layer changes", async () => {
    const home = tmp();
    const project = tmp();
    const agentDir = path.join(home, ".omp", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const prevAgent = process.env.PI_CODING_AGENT_DIR;
    const prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    try {
      resetGoalContinuationModesCache();
      readOmpGoalContinuationModesMock.mockResolvedValue(["interactive"]);
      await expect(readGoalContinuationModesCached("/bin/omp", project)).resolves.toEqual(["interactive"]);
      await readGoalContinuationModesCached("/bin/omp", project);
      expect(readOmpGoalContinuationModesMock).toHaveBeenCalledTimes(1);

      // A user edit to either merged layer busts the key.
      fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
      fs.writeFileSync(path.join(project, ".omp", "config.yml"), "goal:\n  continuationModes: [rpc]\n");
      await readGoalContinuationModesCached("/bin/omp", project);
      expect(readOmpGoalContinuationModesMock).toHaveBeenCalledTimes(2);

      fs.writeFileSync(path.join(agentDir, "config.yml"), "goal:\n  continuationModes: [rpc, pty]\n");
      await readGoalContinuationModesCached("/bin/omp", project);
      expect(readOmpGoalContinuationModesMock).toHaveBeenCalledTimes(3);

      // Unrelated metadata: same fingerprint, still cached.
      await readGoalContinuationModesCached("/bin/omp", project);
      expect(readOmpGoalContinuationModesMock).toHaveBeenCalledTimes(3);

      // A different binary is a different answer source.
      await readGoalContinuationModesCached("/other/omp", project);
      expect(readOmpGoalContinuationModesMock).toHaveBeenCalledTimes(4);
    } finally {
      process.env.PI_CODING_AGENT_DIR = prevAgent;
      process.env.HOME = prevHome;
      resetGoalContinuationModesCache();
    }
  });

  it("does not cache failures", async () => {
    resetGoalContinuationModesCache();
    readOmpGoalContinuationModesMock.mockReset();
    readOmpGoalContinuationModesMock.mockRejectedValueOnce(new Error("omp gone"));
    await expect(readGoalContinuationModesCached("/bin/omp", null)).rejects.toThrow("omp gone");
    readOmpGoalContinuationModesMock.mockResolvedValue(["interactive"]);
    await expect(readGoalContinuationModesCached("/bin/omp", null)).resolves.toEqual(["interactive"]);
    expect(readOmpGoalContinuationModesMock).toHaveBeenCalledTimes(2);
    resetGoalContinuationModesCache();
  });
});

describe("writeRpcOverlays — out:// pin (issue #969)", () => {
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    resetGoalContinuationModesCache();
  });
  async function spawnOverlays(version: string | null, globalConfig?: string): Promise<{ dir: string; overlays: string[] }> {
    const dir = tmp();
    const agent = path.join(dir, "agent");
    fs.mkdirSync(agent, { recursive: true });
    if (globalConfig !== undefined) fs.writeFileSync(path.join(agent, "config.yml"), globalConfig, "utf8");
    process.env.PI_CODING_AGENT_DIR = agent;
    resetGoalContinuationModesCache();
    readOmpGoalContinuationModesMock.mockResolvedValue(["interactive"]);
    readInstalledOmpVersionMock.mockResolvedValue(version);
    fs.writeFileSync(outRepliesOverlayPath(dir), "out:\n  enabled: true\n");
    const overlays = await writeRpcOverlays(ownedSessionRecord({ projectCwd: dir }), dir, "/bin/omp");
    return { dir, overlays };
  }

  it("pins out.enabled on omp 18.14.0 when no config layer names it", async () => {
    const { dir, overlays } = await spawnOverlays("18.14.0");
    expect(overlays).toContain(outRepliesOverlayPath(dir));
    expect(fs.readFileSync(outRepliesOverlayPath(dir), "utf8")).toBe("out:\n  enabled: true\n");
  });

  it("drops the pin below 18.14.0 and on an unknown version", async () => {
    for (const version of ["18.13.3", null]) {
      const { dir, overlays } = await spawnOverlays(version);
      expect(overlays).not.toContain(outRepliesOverlayPath(dir));
      expect(fs.existsSync(outRepliesOverlayPath(dir))).toBe(false);
    }
  });

  it("leaves an explicitly configured user value to omp", async () => {
    const { dir, overlays } = await spawnOverlays("18.14.0", "out:\n  enabled: false\n");
    expect(overlays).not.toContain(outRepliesOverlayPath(dir));
    expect(fs.existsSync(outRepliesOverlayPath(dir))).toBe(false);
  });
});
