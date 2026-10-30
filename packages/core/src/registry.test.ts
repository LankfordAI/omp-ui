import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { Registry, SETTINGS, planHandoffDescendants } from "./registry";
import type { RegistrySettings } from "./registry";
import type { OwnedSessionRecord } from "./types";

const tmpDirs: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-reg-"));
  tmpDirs.push(dir);
  return path.join(dir, "registry.json");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sessionRecord(patch: Partial<OwnedSessionRecord> = {}): OwnedSessionRecord {
  return {
    tabId: "tab-1",
    sessionId: null,
    lineageDir: "omp-ui--proj--11111111-2222-3333-4444-555555555555",
    projectCwd: "/abs/proj",
    worktree: null,
    planImplementationSource: null, experiment: null,
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "pty",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    autoTitled: false,
    snoozed: false,
    snoozedUntilMs: null,
    pinnedAtMs: null,
    heldPrompt: null,
    scheduledPrompt: null,
    pullRequests: [],
    autoSettleOnMerge: null,
    private: false,
    chat: false,
    askSource: null,
    fleet: null,
    cachedTitle: null,
    cachedModified: null,
    agentMode: "build",
    ...patch,
  };
}

function rejectAtomicReplaces(file: string): () => void {
  const saved = `${file}.saved`;
  fs.renameSync(file, saved);
  fs.mkdirSync(file);
  return () => {
    fs.rmSync(file, { recursive: true });
    fs.renameSync(saved, file);
  };
}

describe("SETTINGS", () => {
  it("describes every persisted setting with its exact value type", () => {
    type ExpectedDescriptors = {
      [K in keyof RegistrySettings]: {
        fallback: () => RegistrySettings[K];
        parse: (value: unknown) => RegistrySettings[K];
      };
    };

    expectTypeOf(SETTINGS).toEqualTypeOf<ExpectedDescriptors>();
    expect(Object.keys(SETTINGS)).toEqual([
      "defaultMode",
      "defaultAgentMode",
      "defaultCompactionMethod",
      "planFormat",
      "hibernateIdleMinutes",
      "streamStallAbortSeconds",
      "advisorAutoReply",
      "stallAutoContinue",
      "desktopNotifications",
      "htmlArtifactScripts",
      "defaultAdvisor",
      "defaultAutoThinking",
      "modelFavorites",
      "subagentModelInheritByDefault",
      "agentRoster",
      "skipDeleteConfirmation",
      "skipTerminateConfirmation",
      "experimentsEnabled",
      "snoozedSectionEnabled",
      "autoSettleMergedPullRequests",
      "voiceInputEnabled",
      "sttModel",
      "audioInputDevice",
      "audioOutputDevice",
      "memoryDefaultsSeeded",
      "autoThinkingDefaultSeeded",
      "hibernateManualDefaultSeeded",
      "reviewRoster",
      "reviewRosterImported",
      "gettingStartedSeen",
      "dismissedAppUpdateVersion",
      "dismissedOmpUpdateVersion",
      "themeId",
      "themeMode",
      "lightThemeId",
      "darkThemeId",
      "importedThemes",
      "fontFamilyId",
      "transcriptWidth",
      "glassChrome",
      "localeId",
      "keybindings",
      "appUpdateCheckOnLaunch",
      "appUpdateTrain",
      "vaultRegistry",
      "vaultNoteVoice",
      "ompUpdateCheckOnLaunch",
      "ompAutoUpgrade",
      "chatLastModel",
      "chatLastThinkingLevel",
      "remoteEnabled",
      "remoteBind",
      "remotePort",
      "remoteToken",
      "remotePasswordHash",
      "remotePasswordSalt",
      "instanceId",
      "fleetPlacement",
      "fleetAgentDispatch",
      "fleetExecEnabled",
      "fleetExecCeiling",
      "fleetGrants",
      "fleetProjectRoots",
      "webhooksEnabled",
      "mcpEndpointEnabled",
      "remoteVsCodeEnabled",
    ]);
  });
  it("creates fresh mutable fallbacks", () => {
    expect(SETTINGS.modelFavorites.fallback()).not.toBe(SETTINGS.modelFavorites.fallback());
    expect(SETTINGS.agentRoster.fallback()).not.toBe(SETTINGS.agentRoster.fallback());
    expect(SETTINGS.agentRoster.fallback()).toEqual([
      "reviewer",
      "scout",
      "security-reviewer",
      "sonic",
      "task",
    ]);
  });
});

describe("Registry.load", () => {
  it("starts empty when the file is missing", () => {
    const reg = Registry.load(tmpFile());
    expect(reg.projects).toEqual([]);
    expect(reg.sessions).toEqual([]);
    expect(reg.getSetting("defaultMode")).toBe("rpc-ui");
    expect(reg.getSetting("defaultAgentMode")).toBe("plan");
    expect(reg.getSetting("skipDeleteConfirmation")).toBe(false);
    expect(reg.getSetting("skipTerminateConfirmation")).toBe(false);
    // Issue #623: a fresh registry has never seen the Getting started checklist.
    expect(reg.getSetting("gettingStartedSeen")).toBe(false);
    expect(reg.getSetting("experimentsEnabled")).toBe(false);
    expect(reg.getSetting("snoozedSectionEnabled")).toBe(false);
    // Issue #647: the mic button is off, and the dictation model auto-resolves.
    expect(reg.getSetting("voiceInputEnabled")).toBe(false);
    expect(reg.getSetting("sttModel")).toBeNull();
    // Issue #857: both audio roles default to the OS default.
    expect(reg.getSetting("audioInputDevice")).toBeNull();
    expect(reg.getSetting("audioOutputDevice")).toBeNull();
    // Issue #109: HTML is the default plan review rendition.
    expect(reg.getSetting("planFormat")).toBe("html");
    // Issue #923: sessions settle manually by default; hibernation is opt-in.
    expect(reg.getSetting("hibernateIdleMinutes")).toBe(0);
    // Issue #111: auto-reply defaults on.
    expect(reg.getSetting("advisorAutoReply")).toBe(true);
    // Issue #251: stall auto-continue defaults on.
    expect(reg.getSetting("stallAutoContinue")).toBe(true);
    // Issue #271: desktop notifications default on.
    expect(reg.getSetting("desktopNotifications")).toBe(true);
    // Issue #174: the advisor does not default on.
    expect(reg.getSetting("defaultAdvisor")).toBe(false);
  });

  it("parses a non-boolean snoozedSectionEnabled setting as false (issue #935)", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, projects: [], sessions: [], settings: { snoozedSectionEnabled: "yes" } }),
    );
    const reg = Registry.load(file);
    expect(reg.getSetting("snoozedSectionEnabled")).toBe(false);
  });

  it("recovers from a corrupt JSON file by quarantining it", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{not json");
    const reg = Registry.load(file);
    expect(reg.projects).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings.some((f) => f.startsWith("registry.json.corrupt-"))).toBe(true);
  });

  it("treats an unknown schemaVersion as corrupt", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, projects: [], sessions: [] }));
    const reg = Registry.load(file);
    expect(reg.projects).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("drops malformed elements but keeps the valid rest", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: 42 }, { path: "/abs/proj", name: "proj", addedAt: "t" }],
        sessions: [sessionRecord(), { tabId: null }],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/proj"]);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["tab-1"]);
    expect(fs.existsSync(file)).toBe(true); // no quarantine for element-level issues
  });

  it("normalizes a legacy session without plan handoff metadata to null", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, projects: [], sessions: [sessionRecord()] }),
    );

    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]?.planImplementationSource).toBeNull();
  });

  it("drops a malformed plan handoff record without quarantining unrelated sessions", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [],
        sessions: [
          sessionRecord(),
          {
            ...sessionRecord({ tabId: "bad-handoff" }),
            planImplementationSource: {
              sourceTabId: "planning-tab",
              planTitle: "",
              planFilePath: "local://plans/accepted.md",
            },
          },
        ],
      }),
    );

    const reg = Registry.load(file);
    expect(reg.sessions.map((session) => session.tabId)).toEqual(["tab-1"]);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["registry.json"]);
  });

  it("defaults the remote-access settings when no remote* key is present", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: { defaultMode: "pty" },
        projects: [],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.getSetting("remoteEnabled")).toBe(false);
    expect(reg.getSetting("remoteBind")).toBe("localhost");
    expect(reg.getSetting("remotePort")).toBe(4677);
    expect(reg.getSetting("remoteToken")).toBe("");
    expect(reg.getSetting("remotePasswordHash")).toBe("");
    expect(reg.getSetting("remotePasswordSalt")).toBe("");
    expect(fs.existsSync(file)).toBe(true); // absent remote* keys are legal, not corrupt
  });

  it("migrates a registry without defaultAgentMode to Plan", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: { defaultMode: "rpc-ui" },
        projects: [],
        sessions: [],
      }),
    );

    expect(Registry.load(file).getSetting("defaultAgentMode")).toBe("plan");
  });

  it("falls back independently across malformed setting families", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          defaultMode: "terminal",
          defaultAgentMode: "PLAN",
          planFormat: "markdown",
          hibernateIdleMinutes: 30.5,
          advisorAutoReply: "true",
          stallAutoContinue: "no",
          desktopNotifications: "yes",
          defaultAdvisor: "yes",
          modelFavorites: [42, "kept", null, "also-kept"],
          skipDeleteConfirmation: 1,
          dismissedAppUpdateVersion: false,
          dismissedOmpUpdateVersion: {},
          themeId: "",
          appUpdateCheckOnLaunch: "yes",
          appUpdateTrain: "canary",
          vaultRegistry: "nope",
          vaultNoteVoice: 0,
          ompUpdateCheckOnLaunch: 0,
          ompAutoUpgrade: "nope",
          remoteEnabled: "no",
          remoteBind: "public",
          remotePort: 1023,
          remoteToken: 123,
          remotePasswordHash: 123,
          remotePasswordSalt: 456,
          instanceId: 7,
          fleetPlacement: ["prefer"],
          fleetAgentDispatch: "yes",
        },
        projects: [],
        sessions: [],
      }),
    );

    const reg = Registry.load(file);
    expect(reg.getSetting("defaultMode")).toBe("rpc-ui");
    expect(reg.getSetting("defaultAgentMode")).toBe("plan");
    expect(reg.getSetting("planFormat")).toBe("html");
    expect(reg.getSetting("hibernateIdleMinutes")).toBe(0);
    expect(reg.getSetting("advisorAutoReply")).toBe(true);
    expect(reg.getSetting("stallAutoContinue")).toBe(true);
    expect(reg.getSetting("desktopNotifications")).toBe(true);
    expect(reg.getSetting("defaultAdvisor")).toBe(false);
    expect(reg.getFavorites()).toEqual(["kept", "also-kept"]);
    expect(reg.getSetting("skipDeleteConfirmation")).toBe(false);
    expect(reg.getSetting("dismissedAppUpdateVersion")).toBeNull();
    expect(reg.getSetting("dismissedOmpUpdateVersion")).toBeNull();
    expect(reg.getSetting("themeId")).toBe("graphite");
    expect(reg.getSetting("appUpdateCheckOnLaunch")).toBe(true);
    expect(reg.getSetting("appUpdateTrain")).toBe("stable");
    expect(reg.getSetting("vaultRegistry")).toEqual({ vaults: [], defaultWriteVault: null });
    expect(reg.getSetting("vaultNoteVoice")).toBe("user");
    expect(reg.getSetting("ompUpdateCheckOnLaunch")).toBe(true);
    expect(reg.getSetting("ompAutoUpgrade")).toBe(true);
    expect(reg.getSetting("remoteEnabled")).toBe(false);
    expect(reg.getSetting("remoteBind")).toBe("localhost");
    expect(reg.getSetting("remotePort")).toBe(4677);
    expect(reg.getSetting("remoteToken")).toBe("");
    expect(reg.getSetting("remotePasswordHash")).toBe("");
    expect(reg.getSetting("remotePasswordSalt")).toBe("");
    expect(reg.getSetting("instanceId")).toBe("");
    expect(reg.getSetting("fleetPlacement")).toEqual({});
    expect(reg.getSetting("fleetAgentDispatch")).toBe(false);
  });

  it("keeps only 1-64 character fleet placement keys with a known preference (issue #899)", () => {
    const file = tmpFile();
    const longKey = "k".repeat(64);
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          fleetPlacement: {
            local: "prefer",
            [longKey]: "manual",
            ["k".repeat(65)]: "prefer",
            "": "less",
            remote: "always",
            other: 3,
          },
        },
      }),
    );
    expect(Registry.load(file).getSetting("fleetPlacement")).toEqual({ local: "prefer", [longKey]: "manual" });
  });

  it("round-trips the fleet settings and defaults them when absent (issue #899)", () => {
    const fresh = Registry.load(tmpFile());
    expect(fresh.getSetting("fleetPlacement")).toEqual({});
    expect(fresh.getSetting("fleetAgentDispatch")).toBe(false);
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("fleetPlacement", { local: "less", "remote-1": "manual" });
    reg.setSetting("fleetAgentDispatch", true);
    const reloaded = Registry.load(file);
    expect(reloaded.getSetting("fleetPlacement")).toEqual({ local: "less", "remote-1": "manual" });
    expect(reloaded.getSetting("fleetAgentDispatch")).toBe(true);
  });

  it("falls back to the locked-down ladder on malformed values and round-trips good ones (issue #901)", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: { fleetExecEnabled: "yes", fleetExecCeiling: "root", fleetGrants: [], fleetProjectRoots: "/srv" },
      }),
    );
    const broken = Registry.load(file);
    expect(broken.getSetting("fleetExecEnabled")).toBe(false);
    expect(broken.getSetting("fleetExecCeiling")).toBe("dispatch");
    expect(broken.getSetting("fleetGrants")).toEqual({});
    expect(broken.getSetting("fleetProjectRoots")).toEqual([]);

    broken.setSetting("fleetExecEnabled", true);
    broken.setSetting("fleetExecCeiling", "full");
    broken.setSetting("fleetGrants", { "inst-a": { rung: "full", label: "studio", updatedAt: "t" } });
    broken.setSetting("fleetProjectRoots", ["/srv/repos"]);
    const reloaded = Registry.load(file);
    expect(reloaded.getSetting("fleetExecEnabled")).toBe(true);
    expect(reloaded.getSetting("fleetExecCeiling")).toBe("full");
    expect(reloaded.getSetting("fleetGrants")).toEqual({ "inst-a": { rung: "full", label: "studio", updatedAt: "t" } });
    expect(reloaded.getSetting("fleetProjectRoots")).toEqual(["/srv/repos"]);
  });

  it("accepts only bounded integer remote ports", () => {
    for (const [value, expected] of [
      [1024, 1024],
      [65535, 65535],
      [1023, 4677],
      [65536, 4677],
      [1234.5, 4677],
      ["4677", 4677],
    ] as const) {
      const file = tmpFile();
      fs.writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, settings: { remotePort: value } }),
      );
      expect(Registry.load(file).getSetting("remotePort")).toBe(expected);
    }
  });
});

describe("Registry persistence", () => {
  it("round-trips projects, sessions, and settings", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.addSession(sessionRecord());
    reg.setSetting("defaultMode", "rpc-ui");
    reg.setSetting("defaultAgentMode", "build");
    reg.setSetting("skipDeleteConfirmation", true);
    reg.setSetting("skipTerminateConfirmation", true);
    reg.setSetting("gettingStartedSeen", true);

    const reloaded = Registry.load(file);
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0]).toMatchObject({ path: "/abs/proj", name: "proj" });
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]).toMatchObject({ tabId: "tab-1", sessionId: null });
    expect(reloaded.getSetting("defaultMode")).toBe("rpc-ui");
    expect(reloaded.getSetting("defaultAgentMode")).toBe("build");
    expect(reloaded.getSetting("skipDeleteConfirmation")).toBe(true);
    expect(reloaded.getSetting("skipTerminateConfirmation")).toBe(true);
    expect(reloaded.getSetting("gettingStartedSeen")).toBe(true);
  });

  it("round-trips persisted plan handoff metadata", () => {
    const file = tmpFile();
    const source = {
      sourceTabId: "planning-tab",
      planTitle: "Implement the accepted plan",
      planFilePath: "local://plans/accepted.md",
    };
    const reg = Registry.load(file);
    reg.addSession(sessionRecord({ planImplementationSource: source }));

    const reloaded = Registry.load(file);
    expect(reloaded.sessions[0]?.planImplementationSource).toEqual(source);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion).toBe(1);
  });

  it("round-trips persisted experiment provenance, including a null launch branch", () => {
    const file = tmpFile();
    const experiment = {
      goal: "cut p95 latency",
      metric: "p95_ms",
      unit: "ms",
      direction: "lower" as const,
      launchedBranch: null,
      launchedAt: "2026-09-17T10:00:00.000Z",
    };
    const reg = Registry.load(file);
    reg.addSession(sessionRecord({ experiment }));

    const reloaded = Registry.load(file);
    expect(reloaded.sessions[0]?.experiment).toEqual(experiment);
  });

  it("drops a session whose experiment is incomplete without touching its siblings", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [],
        sessions: [
          sessionRecord(),
          {
            ...sessionRecord({ tabId: "no-metric" }),
            experiment: {
              goal: "g",
              unit: "",
              direction: "lower",
              launchedBranch: "autoresearch/g/abcd",
              launchedAt: "t",
            },
          },
          {
            ...sessionRecord({ tabId: "no-branch-key" }),
            experiment: { goal: "g", metric: "m", unit: "", direction: "higher", launchedAt: "t" },
          },
        ],
      }),
    );

    const reg = Registry.load(file);
    expect(reg.sessions.map((session) => session.tabId)).toEqual(["tab-1"]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("defaults dismissedAppUpdateVersion to null when the field is absent", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { skipDeleteConfirmation: true } }),
    );
    expect(Registry.load(file).getSetting("dismissedAppUpdateVersion")).toBeNull();
  });

  it("round-trips the dismissed app-update version across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    expect(reg.getSetting("dismissedAppUpdateVersion")).toBeNull();
    reg.setSetting("dismissedAppUpdateVersion", "1.2.0");
    expect(reg.getSetting("dismissedAppUpdateVersion")).toBe("1.2.0");
    expect(Registry.load(file).getSetting("dismissedAppUpdateVersion")).toBe("1.2.0");
    reg.setSetting("dismissedAppUpdateVersion", null);
    expect(Registry.load(file).getSetting("dismissedAppUpdateVersion")).toBeNull();
  });

  it("defaults dismissedOmpUpdateVersion to null when the field is absent", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { skipDeleteConfirmation: true } }),
    );
    expect(Registry.load(file).getSetting("dismissedOmpUpdateVersion")).toBeNull();
  });

  it("round-trips the dismissed omp-update version across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    expect(reg.getSetting("dismissedOmpUpdateVersion")).toBeNull();
    reg.setSetting("dismissedOmpUpdateVersion", "1.2.0");
    expect(reg.getSetting("dismissedOmpUpdateVersion")).toBe("1.2.0");
    expect(Registry.load(file).getSetting("dismissedOmpUpdateVersion")).toBe("1.2.0");
    reg.setSetting("dismissedOmpUpdateVersion", null);
    expect(Registry.load(file).getSetting("dismissedOmpUpdateVersion")).toBeNull();
  });

  it("round-trips each audio role's label and null across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    expect(reg.getSetting("audioInputDevice")).toBeNull();
    expect(reg.getSetting("audioOutputDevice")).toBeNull();
    reg.setSetting("audioInputDevice", "AT2020 USB");
    reg.setSetting("audioOutputDevice", "Schiit Unison Universal Dac");
    expect(Registry.load(file).getSetting("audioInputDevice")).toBe("AT2020 USB");
    expect(Registry.load(file).getSetting("audioOutputDevice")).toBe("Schiit Unison Universal Dac");
    reg.setSetting("audioInputDevice", null);
    reg.setSetting("audioOutputDevice", null);
    expect(Registry.load(file).getSetting("audioInputDevice")).toBeNull();
    expect(Registry.load(file).getSetting("audioOutputDevice")).toBeNull();

    // An empty string is not a device label; the OS default wins.
    const junk = tmpFile();
    fs.writeFileSync(junk, JSON.stringify({ schemaVersion: 1, settings: { audioInputDevice: "" } }));
    expect(Registry.load(junk).getSetting("audioInputDevice")).toBeNull();
  });

  it("migrates the legacy audioDevice label into both roles (issue #857)", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, settings: { audioDevice: "AT2020 USB" } }));
    const reg = Registry.load(file);
    expect(reg.getSetting("audioInputDevice")).toBe("AT2020 USB");
    expect(reg.getSetting("audioOutputDevice")).toBe("AT2020 USB");

    // Once either role key is present on disk, the legacy key is ignored.
    const migrated = tmpFile();
    fs.writeFileSync(
      migrated,
      JSON.stringify({
        schemaVersion: 1,
        settings: { audioDevice: "AT2020 USB", audioInputDevice: null, audioOutputDevice: "USB DAC" },
      }),
    );
    const reg2 = Registry.load(migrated);
    expect(reg2.getSetting("audioInputDevice")).toBeNull();
    expect(reg2.getSetting("audioOutputDevice")).toBe("USB DAC");

    // A legacy empty string is not a label; nothing seeds.
    const junk = tmpFile();
    fs.writeFileSync(junk, JSON.stringify({ schemaVersion: 1, settings: { audioDevice: "" } }));
    expect(Registry.load(junk).getSetting("audioInputDevice")).toBeNull();
    expect(Registry.load(junk).getSetting("audioOutputDevice")).toBeNull();
  });

  it("round-trips the plan format and falls back to html for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("planFormat", "md");
    expect(Registry.load(file).getSetting("planFormat")).toBe("md");
    reg.setSetting("planFormat", "html");
    expect(Registry.load(file).getSetting("planFormat")).toBe("html");

    const junk = tmpFile();
    fs.writeFileSync(junk, JSON.stringify({ schemaVersion: 1, settings: { planFormat: "pdf" } }));
    expect(Registry.load(junk).getSetting("planFormat")).toBe("html");
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("planFormat")).toBe("html");
  });

  it("round-trips the hibernate idle window and falls back to 0 for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("hibernateIdleMinutes", 0);
    expect(Registry.load(file).getSetting("hibernateIdleMinutes")).toBe(0);
    reg.setSetting("hibernateIdleMinutes", 1440);
    expect(Registry.load(file).getSetting("hibernateIdleMinutes")).toBe(1440);
    reg.setSetting("hibernateIdleMinutes", 30);
    expect(Registry.load(file).getSetting("hibernateIdleMinutes")).toBe(30);

    for (const junk of [-1, 30.5, 1441, "30", null, true]) {
      const f = tmpFile();
      fs.writeFileSync(
        f,
        JSON.stringify({ schemaVersion: 1, settings: { hibernateIdleMinutes: junk } }),
      );
      expect(Registry.load(f).getSetting("hibernateIdleMinutes")).toBe(0);
    }
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("hibernateIdleMinutes")).toBe(0);
  });

  it("forces the legacy idle hibernate window to off once (issue #923)", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { hibernateIdleMinutes: 30 } }),
    );
    expect(Registry.load(file).getSetting("hibernateIdleMinutes")).toBe(0);
    // The marker persisted with the flip.
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
      settings: Record<string, unknown>;
    };
    expect(onDisk.settings.hibernateManualDefaultSeeded).toBe(true);
    expect(onDisk.settings.hibernateIdleMinutes).toBe(0);
    // A second load writes nothing; a window re-enabled afterwards persists.
    const bytes = fs.readFileSync(file, "utf8");
    Registry.load(file);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    const reg = Registry.load(file);
    reg.setSetting("hibernateIdleMinutes", 45);
    expect(Registry.load(file).getSetting("hibernateIdleMinutes")).toBe(45);
  });

  it("round-trips the stall watchdog window and falls back to 180 for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("streamStallAbortSeconds", 0);
    expect(Registry.load(file).getSetting("streamStallAbortSeconds")).toBe(0);
    reg.setSetting("streamStallAbortSeconds", 600);
    expect(Registry.load(file).getSetting("streamStallAbortSeconds")).toBe(600);

    for (const junk of [-1, 180.5, 3601, "180", null, true]) {
      const f = tmpFile();
      fs.writeFileSync(
        f,
        JSON.stringify({ schemaVersion: 1, settings: { streamStallAbortSeconds: junk } }),
      );
      expect(Registry.load(f).getSetting("streamStallAbortSeconds")).toBe(180);
    }
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("streamStallAbortSeconds")).toBe(180);
  });

  it("round-trips advisor auto-reply and defaults to on for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("advisorAutoReply", false);
    expect(Registry.load(file).getSetting("advisorAutoReply")).toBe(false);
    reg.setSetting("advisorAutoReply", true);
    expect(Registry.load(file).getSetting("advisorAutoReply")).toBe(true);

    const junk = tmpFile();
    fs.writeFileSync(junk, JSON.stringify({ schemaVersion: 1, settings: { advisorAutoReply: "no" } }));
    expect(Registry.load(junk).getSetting("advisorAutoReply")).toBe(true);
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("advisorAutoReply")).toBe(true);
  });

  it("round-trips stall auto-continue and defaults to on for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("stallAutoContinue", false);
    expect(Registry.load(file).getSetting("stallAutoContinue")).toBe(false);
    reg.setSetting("stallAutoContinue", true);
    expect(Registry.load(file).getSetting("stallAutoContinue")).toBe(true);

    for (const junk of ["no", 1, null, {}]) {
      const f = tmpFile();
      fs.writeFileSync(
        f,
        JSON.stringify({ schemaVersion: 1, settings: { stallAutoContinue: junk } }),
      );
      expect(Registry.load(f).getSetting("stallAutoContinue")).toBe(true);
    }
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("stallAutoContinue")).toBe(true);
  });

  it("round-trips desktop notifications and defaults to on for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("desktopNotifications", false);
    expect(Registry.load(file).getSetting("desktopNotifications")).toBe(false);
    reg.setSetting("desktopNotifications", true);
    expect(Registry.load(file).getSetting("desktopNotifications")).toBe(true);

    for (const junk of ["yes", 0, null, {}]) {
      const f = tmpFile();
      fs.writeFileSync(
        f,
        JSON.stringify({ schemaVersion: 1, settings: { desktopNotifications: junk } }),
      );
      expect(Registry.load(f).getSetting("desktopNotifications")).toBe(true);
    }
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("desktopNotifications")).toBe(true);
  });

  it("round-trips default advisor and falls back to off for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("defaultAdvisor", true);
    expect(Registry.load(file).getSetting("defaultAdvisor")).toBe(true);
    reg.setSetting("defaultAdvisor", false);
    expect(Registry.load(file).getSetting("defaultAdvisor")).toBe(false);

    const junk = tmpFile();
    fs.writeFileSync(junk, JSON.stringify({ schemaVersion: 1, settings: { defaultAdvisor: "no" } }));
    expect(Registry.load(junk).getSetting("defaultAdvisor")).toBe(false);
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("defaultAdvisor")).toBe(false);
  });

  it("round-trips default auto thinking and falls back to on for anything unknown", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("defaultAutoThinking", true);
    expect(Registry.load(file).getSetting("defaultAutoThinking")).toBe(true);
    reg.setSetting("defaultAutoThinking", false);
    expect(Registry.load(file).getSetting("defaultAutoThinking")).toBe(false);

    const junk = tmpFile();
    fs.writeFileSync(
      junk,
      JSON.stringify({ schemaVersion: 1, settings: { defaultAutoThinking: "no" } }),
    );
    expect(Registry.load(junk).getSetting("defaultAutoThinking")).toBe(true);
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("defaultAutoThinking")).toBe(true);
  });

  it("flips a legacy persisted off default to on once", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { defaultAutoThinking: false } }),
    );
    expect(Registry.load(file).getSetting("defaultAutoThinking")).toBe(true);
    // The marker persisted: an explicit off chosen afterwards survives reload.
    const reg = Registry.load(file);
    reg.setSetting("defaultAutoThinking", false);
    expect(Registry.load(file).getSetting("defaultAutoThinking")).toBe(false);
  });

  it("defaults a fresh registry to auto thinking on", () => {
    expect(Registry.load(tmpFile()).getSetting("defaultAutoThinking")).toBe(true);
  });

  it("defaults theme and launch update checks when the settings fields are absent", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { skipDeleteConfirmation: true } }),
    );
    const reg = Registry.load(file);
    expect(reg.getSetting("themeId")).toBe("graphite");
    expect(reg.getSetting("localeId")).toBe("en");
    expect(reg.getSetting("appUpdateCheckOnLaunch")).toBe(true);
    expect(reg.getSetting("appUpdateTrain")).toBe("stable");
    expect(reg.getSetting("ompUpdateCheckOnLaunch")).toBe(true);
    expect(reg.getSetting("ompAutoUpgrade")).toBe(true);
    expect(reg.getSetting("vaultNoteVoice")).toBe("user");
    expect(reg.getSetting("gettingStartedSeen")).toBe(false);
  });

  it("round-trips a non-default theme and launch update checks across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("themeId", "theme-from-a-newer-build");
    reg.setSetting("localeId", "ko");
    reg.setSetting("appUpdateCheckOnLaunch", false);
    reg.setSetting("appUpdateTrain", "nightly");
    reg.setSetting("vaultNoteVoice", "assistant");
    reg.setSetting("ompUpdateCheckOnLaunch", false);
    reg.setSetting("ompAutoUpgrade", false);
    reg.setSetting("gettingStartedSeen", true);

    const reloaded = Registry.load(file);
    expect(reloaded.getSetting("themeId")).toBe("theme-from-a-newer-build");
    expect(reloaded.getSetting("localeId")).toBe("ko");
    expect(reloaded.getSetting("appUpdateCheckOnLaunch")).toBe(false);
    expect(reloaded.getSetting("appUpdateTrain")).toBe("nightly");
    expect(reloaded.getSetting("vaultNoteVoice")).toBe("assistant");
    expect(reloaded.getSetting("ompUpdateCheckOnLaunch")).toBe(false);
    expect(reloaded.getSetting("ompAutoUpgrade")).toBe(false);
    expect(reloaded.getSetting("gettingStartedSeen")).toBe(true);
  });

  it("round-trips the vault registry across a reload", () => {
    const file = tmpFile();
    const vaultRegistry = {
      vaults: [
        { name: "Vault", path: "/abs/Vault", homeFolder: "omp-ui/", allowWritesOutsideHome: false },
        { name: "Notes", path: "/abs/Notes", homeFolder: "agents/notes/", allowWritesOutsideHome: true },
      ],
      defaultWriteVault: "Notes",
    };
    Registry.load(file).setSetting("vaultRegistry", vaultRegistry);
    expect(Registry.load(file).getSetting("vaultRegistry")).toEqual(vaultRegistry);
  });

  it("does not write when a public setting setter receives the current value", () => {
    const sameValueSetters: Array<[string, (registry: Registry) => void]> = [
      ["defaultMode", (registry) => registry.setSetting("defaultMode", "rpc-ui")],
      ["defaultAgentMode", (registry) => registry.setSetting("defaultAgentMode", "plan")],
      ["planFormat", (registry) => registry.setSetting("planFormat", "html")],
      ["hibernateIdleMinutes", (registry) => registry.setSetting("hibernateIdleMinutes", 0)],
      ["streamStallAbortSeconds", (registry) => registry.setSetting("streamStallAbortSeconds", 180)],
      ["advisorAutoReply", (registry) => registry.setSetting("advisorAutoReply", true)],
      ["stallAutoContinue", (registry) => registry.setSetting("stallAutoContinue", true)],
      ["desktopNotifications", (registry) => registry.setSetting("desktopNotifications", true)],
      ["defaultAdvisor", (registry) => registry.setSetting("defaultAdvisor", false)],
      ["skipDeleteConfirmation", (registry) => registry.setSetting("skipDeleteConfirmation", false)],
      ["skipTerminateConfirmation", (registry) => registry.setSetting("skipTerminateConfirmation", false)],
      ["gettingStartedSeen", (registry) => registry.setSetting("gettingStartedSeen", false)],
      ["experimentsEnabled", (registry) => registry.setSetting("experimentsEnabled", false)],
      ["snoozedSectionEnabled", (registry) => registry.setSetting("snoozedSectionEnabled", false)],
      ["voiceInputEnabled", (registry) => registry.setSetting("voiceInputEnabled", false)],
      ["sttModel", (registry) => registry.setSetting("sttModel", null)],
      ["audioInputDevice", (registry) => registry.setSetting("audioInputDevice", null)],
      ["audioOutputDevice", (registry) => registry.setSetting("audioOutputDevice", null)],
      ["themeId", (registry) => registry.setSetting("themeId", "graphite")],
      ["fontFamilyId", (registry) => registry.setSetting("fontFamilyId", "default")],
      ["transcriptWidth", (registry) => registry.setSetting("transcriptWidth", "wide")],
      ["glassChrome", (registry) => registry.setSetting("glassChrome", "subtle")],
      ["localeId", (registry) => registry.setSetting("localeId", "en")],
      ["appUpdateCheckOnLaunch", (registry) => registry.setSetting("appUpdateCheckOnLaunch", true)],
      ["appUpdateTrain", (registry) => registry.setSetting("appUpdateTrain", "stable")],
      ["vaultNoteVoice", (registry) => registry.setSetting("vaultNoteVoice", "user")],
      ["ompUpdateCheckOnLaunch", (registry) => registry.setSetting("ompUpdateCheckOnLaunch", true)],
      ["ompAutoUpgrade", (registry) => registry.setSetting("ompAutoUpgrade", true)],
      ["remoteEnabled", (registry) => registry.setSetting("remoteEnabled", false)],
      ["remoteBind", (registry) => registry.setSetting("remoteBind", "localhost")],
      ["remotePort", (registry) => registry.setSetting("remotePort", 4677)],
      ["remoteToken", (registry) => registry.setSetting("remoteToken", "")],
      ["remotePasswordHash", (registry) => registry.setSetting("remotePasswordHash", "")],
      ["remotePasswordSalt", (registry) => registry.setSetting("remotePasswordSalt", "")],
      ["instanceId", (registry) => registry.setSetting("instanceId", "")],
      ["dismissedAppUpdateVersion", (registry) => registry.setSetting("dismissedAppUpdateVersion", null)],
      ["dismissedOmpUpdateVersion", (registry) => registry.setSetting("dismissedOmpUpdateVersion", null)],
      ["fleetAgentDispatch", (registry) => registry.setSetting("fleetAgentDispatch", false)],
    ];

    for (const [name, setSameValue] of sameValueSetters) {
      const file = tmpFile();
      const reg = Registry.load(file);
      const marker = `unchanged-${name}`;
      fs.writeFileSync(file, marker);
      setSameValue(reg);
      expect(fs.readFileSync(file, "utf8"), name).toBe(marker);
    }
  });

  it("writes settings patches as one transaction", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSettings({ remotePasswordHash: "deadbeef", remotePasswordSalt: "0011" });
    expect(reg.getSetting("remotePasswordHash")).toBe("deadbeef");
    expect(reg.getSetting("remotePasswordSalt")).toBe("0011");
    const reloaded = Registry.load(file);
    expect(reloaded.getSetting("remotePasswordHash")).toBe("deadbeef");
    expect(reloaded.getSetting("remotePasswordSalt")).toBe("0011");
  });

  it("keeps a credential pair unchanged when its write fails, then permits retry", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.addSession(sessionRecord());
    reg.setSettings({ remotePasswordHash: "old-hash", remotePasswordSalt: "old-salt" });
    const projectsBefore = reg.projects;
    const sessionsBefore = reg.sessions;
    const restore = rejectAtomicReplaces(file);

    expect(() =>
      reg.setSettings({ remotePasswordHash: "new-hash", remotePasswordSalt: "new-salt" }),
    ).toThrow();
    expect(reg.projects).toEqual(projectsBefore);
    expect(reg.sessions).toEqual(sessionsBefore);
    expect(reg.getSetting("remotePasswordHash")).toBe("old-hash");
    expect(reg.getSetting("remotePasswordSalt")).toBe("old-salt");

    restore();
    reg.setSettings({ remotePasswordHash: "new-hash", remotePasswordSalt: "new-salt" });
    const reloaded = Registry.load(file);
    expect(reloaded.getSetting("remotePasswordHash")).toBe("new-hash");
    expect(reloaded.getSetting("remotePasswordSalt")).toBe("new-salt");
  });

  it("does not write an unchanged settings patch", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSettings({ remotePasswordHash: "same-hash", remotePasswordSalt: "same-salt" });
    const restore = rejectAtomicReplaces(file);
    expect(() =>
      reg.setSettings({ remotePasswordHash: "same-hash", remotePasswordSalt: "same-salt" }),
    ).not.toThrow();
    restore();
  });

  it("uses Object.is when comparing setting values", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("remotePort", Number.NaN);
    fs.writeFileSync(file, "unchanged-NaN");
    reg.setSetting("remotePort", Number.NaN);
    expect(fs.readFileSync(file, "utf8")).toBe("unchanged-NaN");
  });

  it("leaves no tmp file behind after save", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings).toEqual(["registry.json"]);
  });
});

describe("Registry mutations", () => {
  it("dedupes projects by path and returns the existing record", () => {
    const reg = Registry.load(tmpFile());
    const first = reg.addProject("/abs/proj");
    const second = reg.addProject("/abs/proj");
    expect(reg.projects).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("removeProject cascades to its session records only", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addSession(sessionRecord({ tabId: "t-a", projectCwd: "/abs/a" }));
    reg.addSession(sessionRecord({ tabId: "t-b", projectCwd: "/abs/b" }));
    reg.removeProject("/abs/a");
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/b"]);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["t-b"]);
  });

  it("setSessionAdvisor records the flag and the pinned model together", () => {
    const reg = Registry.load(tmpFile());
    reg.addSession(sessionRecord());
    reg.setSessionAdvisor("tab-1", true, "openrouter/anthropic/claude-opus-5:high");
    expect(reg.sessions[0]).toMatchObject({
      advisor: true,
      advisorModel: "openrouter/anthropic/claude-opus-5:high",
    });
    // Turning it off must not silently drop the model the user picked — the
    // next "on" should come back with the same advisor.
    reg.setSessionAdvisor("tab-1", false, "openrouter/anthropic/claude-opus-5:high");
    expect(reg.sessions[0]).toMatchObject({
      advisor: false,
      advisorModel: "openrouter/anthropic/claude-opus-5:high",
    });
  });

  it("setSessionAdvisor survives a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord());
    reg.setSessionAdvisor("tab-1", true, "a/b");
    expect(Registry.load(file).sessions[0]).toMatchObject({ advisor: true, advisorModel: "a/b" });
  });

  it("setSessionApprovalMode persists across reload without touching projects", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/proj");
    reg.addSession(sessionRecord());
    reg.setSessionApprovalMode("tab-1", "always-ask");
    expect(Registry.load(file).sessions[0]).toMatchObject({ approvalMode: "always-ask" });
    // No project last-used mirror: a pin is a session decision, not memory.
    expect(Registry.load(file).projects[0]).not.toMatchObject({ lastApprovalMode: "always-ask" });
    reg.setSessionApprovalMode("tab-1", null);
    expect(Registry.load(file).sessions[0]).toMatchObject({ approvalMode: null });
  });

  it("a pinned always-ask-cached tier survives Registry.load", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord());
    reg.setSessionApprovalMode("tab-1", "always-ask-cached");
    expect(Registry.load(file).sessions[0]).toMatchObject({ approvalMode: "always-ask-cached" });
  });

  it("setSessionServiceTier records and persists the tier across reload and clears it", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord());
    reg.setSessionServiceTier("tab-1", "ultrafast");
    expect(reg.sessions[0]).toMatchObject({ serviceTier: "ultrafast" });
    expect(Registry.load(file).sessions[0]).toMatchObject({ serviceTier: "ultrafast" });
    reg.setSessionServiceTier("tab-1", null);
    expect(reg.sessions[0]).toMatchObject({ serviceTier: null });
    expect(Registry.load(file).sessions[0]).toMatchObject({ serviceTier: null });
  });

  it("remembers the complete model and advisor tuples per project", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.addSession(sessionRecord());

    reg.setSessionModel("tab-1", "openrouter/anthropic/claude-opus-5", "high");
    reg.setSessionAdvisor("tab-1", false, "openrouter/openai/gpt-5.6:medium");

    expect(reg.sessions[0]).toMatchObject({
      model: "openrouter/anthropic/claude-opus-5",
      thinkingLevel: "high",
      advisor: false,
      advisorModel: "openrouter/openai/gpt-5.6:medium",
    });
    expect(Registry.load(file).projects[0]).toMatchObject({
      lastModel: "openrouter/anthropic/claude-opus-5",
      lastThinkingLevel: "high",
      lastAdvisor: false,
      lastAdvisorModel: "openrouter/openai/gpt-5.6:medium",
    });
  });

  it("keeps projects written before lastModel existed, defaulting them to null", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: "/proj", name: "proj", addedAt: "t" }],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.projects[0]).toMatchObject({
      path: "/proj",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
      repositoryKey: null,
      icon: null,
    });
  });

  it("keeps a verbatim repositoryKey and normalizes malformed ones to null", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: "/proj-a", name: "a", addedAt: "t", repositoryKey: "github.com/o/r" },
          { path: "/proj-b", name: "b", addedAt: "t" },
          { path: "/proj-c", name: "c", addedAt: "t", repositoryKey: 42 },
        ],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.projects).toHaveLength(3);
    expect(reg.projects[0]!.repositoryKey).toBe("github.com/o/r");
    expect(reg.projects[1]!.repositoryKey).toBeNull();
    expect(reg.projects[2]!.repositoryKey).toBeNull();
    reg.setSetting("themeId", "normalized-repository-keys");
    const reloaded = Registry.load(file);
    expect(reloaded.projects[0]!.repositoryKey).toBe("github.com/o/r");
    expect(reloaded.projects[1]!.repositoryKey).toBeNull();
    expect(reloaded.projects[2]!.repositoryKey).toBeNull();
  });

  it("sets and clears repositoryKey, persisting across save and reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    expect(reg.addProject("/abs/proj").repositoryKey).toBeNull();
    expect(reg.setProjectRepositoryKey("/abs/proj", "github.com/o/r")).toBeUndefined();
    expect(reg.projects[0]!.repositoryKey).toBe("github.com/o/r");
    expect(Registry.load(file).projects[0]!.repositoryKey).toBe("github.com/o/r");
    // Equal value: no save — the file stays byte-identical.
    const before = fs.readFileSync(file, "utf8");
    reg.setProjectRepositoryKey("/abs/proj", "github.com/o/r");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    reg.setProjectRepositoryKey("/abs/proj", null);
    expect(reg.projects[0]!.repositoryKey).toBeNull();
    expect(Registry.load(file).projects[0]!.repositoryKey).toBeNull();
    // Unknown project: no throw, no write.
    const settled = fs.readFileSync(file, "utf8");
    reg.setProjectRepositoryKey("/nope", "github.com/o/r");
    expect(fs.readFileSync(file, "utf8")).toBe(settled);
    expect(reg.projects).toHaveLength(1);
  });

  it("initializes knowledgeHome to null on addProject and keeps it across reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    expect(reg.addProject("/abs/proj").knowledgeHome).toBeNull();
    expect(Registry.load(file).projects[0]!.knowledgeHome).toBeNull();
  });

  it("keeps valid knowledge homes and vault pins across save and reload", () => {
    const file = tmpFile();
    const homes = [
      { home: "docs" }, { home: "docs", vault: "Notes" },
      { home: "vault" }, { home: "vault", vault: "Notes" },
      { home: "both" }, { home: "both", vault: "Notes" },
    ];
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      projects: homes.map((knowledgeHome, i) => ({ path: `/proj-${i}`, name: `proj-${i}`, addedAt: "t", knowledgeHome })),
      sessions: [],
    }));
    const reg = Registry.load(file);
    expect(reg.projects.map((project) => project.knowledgeHome)).toEqual(homes);
    reg.setSetting("themeId", "knowledge-home-round-trip");
    expect(Registry.load(file).projects.map((project) => project.knowledgeHome)).toEqual(homes);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion).toBe(1);
  });

  it("normalizes malformed knowledge homes without dropping their projects", () => {
    const file = tmpFile();
    const malformed = [
      null, false, "vault", [], {}, { home: "unknown" },
      { home: "vault", extra: true }, { home: "vault", vault: null },
      { home: "vault", vault: "" }, { home: "vault", vault: 42 },
    ];
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      projects: malformed.map((knowledgeHome, i) => ({ path: `/proj-${i}`, name: `proj-${i}`, addedAt: "t", knowledgeHome })),
      sessions: [],
    }));
    const reg = Registry.load(file);
    expect(reg.projects).toHaveLength(10);
    expect(reg.projects.every((project) => project.knowledgeHome === null)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    reg.setSetting("themeId", "normalized-knowledge-homes");
    const reloaded = Registry.load(file);
    expect(reloaded.projects).toHaveLength(10);
    expect(reloaded.projects.every((project) => project.knowledgeHome === null)).toBe(true);
  });

  it("retains a project's vault pin when that vault is removed from the registry", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: "/proj", name: "proj", addedAt: "t", knowledgeHome: { home: "vault", vault: "Notes" } }],
      sessions: [],
      settings: {
        vaultRegistry: {
          vaults: [
            { name: "Notes", path: "/abs/Notes", homeFolder: "omp-ui/", allowWritesOutsideHome: false },
            { name: "Other", path: "/abs/Other", homeFolder: "omp-ui/", allowWritesOutsideHome: false },
          ],
          defaultWriteVault: "Notes",
        },
      },
    }));
    const reg = Registry.load(file);
    reg.setSetting("vaultRegistry", {
      vaults: [{ name: "Other", path: "/abs/Other", homeFolder: "omp-ui/", allowWritesOutsideHome: false }],
      defaultWriteVault: "Other",
    });
    const reloaded = Registry.load(file);
    expect(reloaded.projects[0]!.knowledgeHome).toEqual({ home: "vault", vault: "Notes" });
    expect(reloaded.getSetting("vaultRegistry").defaultWriteVault).toBe("Other");
    reloaded.setSetting("vaultRegistry", { vaults: [], defaultWriteVault: null });
    expect(Registry.load(file).projects[0]!.knowledgeHome).toEqual({ home: "vault", vault: "Notes" });
  });

  it("initializes both model pins to null on addProject", () => {
    const reg = Registry.load(tmpFile());
    const record = reg.addProject("/abs/proj");
    expect(record.defaultModel).toBeNull();
    expect(record.defaultAdvisorModel).toBeNull();
  });

  it("setProjectDefaultModel pins, clears, and skips no-op writes", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.setProjectDefaultModel("/abs/proj", "p/m");
    expect(reg.projects[0]).toMatchObject({ defaultModel: "p/m" });
    // A pin must survive a reload.
    expect(Registry.load(file).projects[0]).toMatchObject({ defaultModel: "p/m" });
    // Setting the same value again saves nothing.
    const before = fs.readFileSync(file, "utf8");
    reg.setProjectDefaultModel("/abs/proj", "p/m");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    // Clearing stores null, not the absence of a field.
    reg.setProjectDefaultModel("/abs/proj", null);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    expect(raw.projects[0]).toMatchObject({ defaultModel: null });
  });

  it("setProjectDefaultAdvisorModel pins, clears, and skips no-op writes", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.setProjectDefaultAdvisorModel("/abs/proj", "p/m:high");
    expect(reg.projects[0]).toMatchObject({ defaultAdvisorModel: "p/m:high" });
    expect(Registry.load(file).projects[0]).toMatchObject({ defaultAdvisorModel: "p/m:high" });
    const before = fs.readFileSync(file, "utf8");
    reg.setProjectDefaultAdvisorModel("/abs/proj", "p/m:high");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    reg.setProjectDefaultAdvisorModel("/abs/proj", null);
    expect(Registry.load(file).projects[0]).toMatchObject({ defaultAdvisorModel: null });
  });

  it("pin mutators are no-ops for an unknown project and write nothing", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    const before = fs.readFileSync(file, "utf8");
    reg.setProjectDefaultModel("/abs/zzz", "p/m");
    reg.setProjectDefaultAdvisorModel("/abs/zzz", "p/m");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(reg.projects[0]).toMatchObject({ defaultModel: null, defaultAdvisorModel: null });
  });

  it("drops a project record whose pin field is the wrong type", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: "/proj", name: "proj", addedAt: "t", lastModel: null, lastAdvisorModel: null, defaultModel: 42 },
          { path: "/ok", name: "ok", addedAt: "t", lastModel: null, lastAdvisorModel: null, defaultAdvisorModel: null },
        ],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.projects.map((p) => p.path)).toEqual(["/ok"]);
  });

  it("setProjectBrowserClock turns the clock on and off, survives a reload, and skips no-op or unknown writes", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    expect(reg.projects[0]!.browserClock).toBe(false);
    reg.setProjectBrowserClock("/abs/proj", true);
    expect(Registry.load(file).projects[0]!.browserClock).toBe(true);
    const before = fs.readFileSync(file, "utf8");
    reg.setProjectBrowserClock("/abs/proj", true);
    reg.setProjectBrowserClock("/abs/zzz", false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    reg.setProjectBrowserClock("/abs/proj", false);
    expect(Registry.load(file).projects[0]!.browserClock).toBe(false);
  });

  it("setProjectKnowledgeHome sets a home, survives a reload, and returns true", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    expect(reg.setProjectKnowledgeHome("/abs/proj", { home: "vault", vault: "Notes" })).toBe(true);
    expect(reg.projects[0]!.knowledgeHome).toEqual({ home: "vault", vault: "Notes" });
    expect(Registry.load(file).projects[0]!.knowledgeHome).toEqual({ home: "vault", vault: "Notes" });
    expect(reg.setProjectKnowledgeHome("/abs/proj", { home: "both" })).toBe(true);
    const stored = Registry.load(file).projects[0]!.knowledgeHome;
    expect(stored).toEqual({ home: "both" });
    expect(Object.keys(stored!)).toEqual(["home"]);
  });

  it("setProjectKnowledgeHome returns false and leaves the file untouched for an equal value, even in another key order on disk", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: "/proj", name: "proj", addedAt: "t", knowledgeHome: { vault: "Notes", home: "vault" } }],
      sessions: [],
    }));
    const reg = Registry.load(file);
    const before = fs.readFileSync(file, "utf8");
    expect(reg.setProjectKnowledgeHome("/proj", { home: "vault", vault: "Notes" })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(reg.setProjectKnowledgeHome("/proj", { home: "docs" })).toBe(true);
    const docs = fs.readFileSync(file, "utf8");
    expect(reg.setProjectKnowledgeHome("/proj", { home: "docs" })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(docs);
  });

  it("setProjectKnowledgeHome returns false for an unknown project without a save", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    const before = fs.readFileSync(file, "utf8");
    expect(reg.setProjectKnowledgeHome("/abs/zzz", { home: "docs" })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("setProjectKnowledgeHome clears the home with null", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.setProjectKnowledgeHome("/abs/proj", { home: "docs" });
    expect(reg.setProjectKnowledgeHome("/abs/proj", null)).toBe(true);
    expect(reg.projects[0]!.knowledgeHome).toBeNull();
    expect(Registry.load(file).projects[0]!.knowledgeHome).toBeNull();
    expect(reg.setProjectKnowledgeHome("/abs/proj", null)).toBe(false);
  });

  it("drops a project record whose browserClock is not a boolean", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: "/proj", name: "proj", addedAt: "t", browserClock: "yes" },
          { path: "/ok", name: "ok", addedAt: "t", browserClock: true },
        ],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.projects.map((p) => [p.path, p.browserClock])).toEqual([["/ok", true]]);
  });

  it("keeps legacy sessions and defaults missing preferences to null", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.model;
    delete legacy.thinkingLevel;
    delete legacy.advisorModel;
    delete legacy.advisor;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({
      model: null,
      thinkingLevel: null,
      advisor: false,
      advisorModel: null,
      subagentModels: null,
    });
  });

  it("loads a legacy record without approvalMode as inherit and drops a bad tier", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord({ tabId: "legacy" }) };
    delete legacy.approvalMode;
    const bad: Record<string, unknown> = {
      ...sessionRecord({ tabId: "bad" }),
      approvalMode: "yolo-forever",
    };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy, bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["legacy"]);
    expect(reg.sessions[0]!.approvalMode).toBeNull();
  });

  it("loads a legacy record without serviceTier as null and drops a bad tier", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord({ tabId: "legacy" }) };
    delete legacy.serviceTier;
    const bad: Record<string, unknown> = {
      ...sessionRecord({ tabId: "bad" }),
      serviceTier: "turbo",
    };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy, bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["legacy"]);
    expect(reg.sessions[0]).toMatchObject({ serviceTier: null });
  });

  it("normalizes proposed plans on load without ever dropping the session", () => {
    const file = tmpFile();
    // A legacy record post-dates the field: absent must load as [].
    const legacy: Record<string, unknown> = { ...sessionRecord({ tabId: "legacy" }) };
    delete legacy.proposedPlans;
    const mixed: Record<string, unknown> = {
      ...sessionRecord({ tabId: "mixed" }),
      proposedPlans: [
        { key: "local://auth-plan.html", title: "add auth", status: "pending" },
        { key: "local://ok-plan.md", title: "x", status: "sunset" },
        { key: "/etc/passwd", title: "x", status: "executed" },
        { key: "local://auth-plan.html", title: "dup", status: "executed" },
        "not-an-object",
        { key: "local://good-plan.md", title: "good", status: "executed" },
      ],
    };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy, mixed] }));
    const reg = Registry.load(file);
    // A malformed history row drops only itself; both sessions survive.
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["legacy", "mixed"]);
    expect(reg.sessions[0]!.proposedPlans).toEqual([]);
    expect(reg.sessions[1]!.proposedPlans).toEqual([
      { key: "local://auth-plan.html", title: "add auth", status: "pending" },
      { key: "local://good-plan.md", title: "good", status: "executed" },
    ]);
  });

  it("round-trips proposed plans through addSession/updateSession", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord());
    reg.updateSession("tab-1", {
      proposedPlans: [{ key: "local://auth-plan.md", title: "add auth", status: "pending" }],
    });
    const reloaded = Registry.load(file);
    expect(reloaded.sessions[0]!.proposedPlans).toEqual([
      { key: "local://auth-plan.md", title: "add auth", status: "pending" },
    ]);
  });

  it("updateSession applies partial patches", () => {
    const reg = Registry.load(tmpFile());
    reg.addSession(sessionRecord());
    const updated = reg.updateSession("tab-1", {
      sessionId: "019faeab-cc7b-7000-8bfc-67242a2869d8",
      cachedTitle: "A title",
    });
    expect(updated).toMatchObject({
      tabId: "tab-1",
      sessionId: "019faeab-cc7b-7000-8bfc-67242a2869d8",
      cachedTitle: "A title",
      cachedModified: null,
      mode: "pty",
    });
    expect(reg.updateSession("nope", { cachedTitle: "x" })).toBeUndefined();
  });

  it("removeSession drops only the named record", () => {
    const reg = Registry.load(tmpFile());
    reg.addSession(sessionRecord({ tabId: "t-1" }));
    reg.addSession(sessionRecord({ tabId: "t-2" }));
    reg.removeSession("t-1");
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["t-2"]);
  });

  it("leaves session, project, and settings memory unchanged after a failed write and retries", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.addSession(sessionRecord());
    reg.setSetting("themeId", "paper");
    const projectsBefore = reg.projects;
    const sessionsBefore = reg.sessions;
    const restore = rejectAtomicReplaces(file);

    expect(() => reg.setSessionModel("tab-1", "provider/model", "high")).toThrow();
    expect(reg.projects).toEqual(projectsBefore);
    expect(reg.sessions).toEqual(sessionsBefore);
    expect(reg.getSetting("themeId")).toBe("paper");

    restore();
    reg.setSessionModel("tab-1", "provider/model", "high");
    expect(reg.sessions[0]).toMatchObject({ model: "provider/model", thinkingLevel: "high" });
    expect(reg.projects[0]).toMatchObject({
      lastModel: "provider/model",
      lastThinkingLevel: "high",
    });
    expect(Registry.load(file).sessions[0]).toMatchObject({
      model: "provider/model",
      thinkingLevel: "high",
    });
  });
});

describe("Session insertion order", () => {
  it("addSession splices ahead of its project's first record in an interleaved array", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addSession(sessionRecord({ tabId: "t-a1", projectCwd: "/abs/a" }));
    reg.addSession(sessionRecord({ tabId: "t-b1", projectCwd: "/abs/b" }));
    reg.addSession(sessionRecord({ tabId: "t-a2", projectCwd: "/abs/a" }));
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["t-a2", "t-a1", "t-b1"]);
  });
});

describe("Registry worktree field", () => {
  it("round-trips a worktree record through save and load", () => {
    const file = tmpFile();
    const worktree = {
      path: "/state/omp-ui/worktrees/proj--abc12345/omp-ui-deadbeef",
      branch: "omp-ui/deadbeef",
      base: "abcdef0123456789abcdef0123456789abcdef01",
    };
    Registry.load(file).addSession(sessionRecord({ worktree }));
    const reloaded = Registry.load(file);
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]).toEqual({
      ...sessionRecord({ worktree }),
      model: null,
      thinkingLevel: null,
      advisorModel: null,
      planImplementationSource: null, experiment: null,
      agentMode: "build",
    });
  });

  it("normalizes a record without a worktree to null on load", () => {
    const file = tmpFile();
    Registry.load(file).addSession(sessionRecord());
    const reloaded = Registry.load(file);
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]).toMatchObject({ tabId: "tab-1", worktree: null });
  });

  it("normalizes a legacy worktree without a base to base null on load", () => {
    const file = tmpFile();
    const legacy = {
      ...sessionRecord(),
      worktree: {
        path: "/state/omp-ui/worktrees/proj--abc12345/omp-ui-deadbeef",
        branch: "omp-ui/deadbeef",
      },
    };
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }),
    );
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]!.worktree).toEqual({
      path: "/state/omp-ui/worktrees/proj--abc12345/omp-ui-deadbeef",
      branch: "omp-ui/deadbeef",
      base: null,
    });
  });

  it("drops a session whose worktree base is neither a string nor null", () => {
    const file = tmpFile();
    const good = sessionRecord({ tabId: "good" });
    const bad = {
      ...sessionRecord({ tabId: "bad" }),
      worktree: { path: "/wt/checkout", branch: "omp-ui/deadbeef", base: 42 },
    };
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, projects: [], sessions: [good, bad] }),
    );
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "good" });
  });

  it("drops a session with a malformed worktree, keeping the rest of the registry", () => {
    const file = tmpFile();
    const good = sessionRecord({ tabId: "good" });
    const bad = { ...sessionRecord({ tabId: "bad" }), worktree: { path: "x" } };
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, projects: [], sessions: [good, bad] }),
    );
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "good" });
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("Registry agentMode field", () => {
  it("round-trips agentMode through save and load", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord());
    reg.updateSession("tab-1", { agentMode: "plan" });
    reg.addSession(sessionRecord({ tabId: "tab-2" }));
    reg.updateSession("tab-2", { agentMode: "build" });
    const reloaded = Registry.load(file);
    expect(reloaded.sessions).toHaveLength(2);
    // New sessions take the top of their project, so tab-2 persisted first.
    expect(reloaded.sessions[0]).toMatchObject({ tabId: "tab-2", agentMode: "build" });
    expect(reloaded.sessions[1]).toMatchObject({ tabId: "tab-1", agentMode: "plan" });
  });

  it("normalizes a legacy session without an agentMode to build on load", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.agentMode;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "tab-1", agentMode: "build" });
  });

  it("drops a session whose agentMode is not plan or build, keeping the rest of the registry", () => {
    const file = tmpFile();
    const good = sessionRecord({ tabId: "good" });
    const bad = { ...sessionRecord({ tabId: "bad" }), agentMode: "PLAN" };
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, projects: [], sessions: [good, bad] }),
    );
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "good" });
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("Registry snapshots", () => {
  it("returns deep-frozen snapshots detached from internal state", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject("/abs/proj");
    const first = reg.projects;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    // ESM strict mode: writing a frozen object throws; either way nothing leaks back.
    expect(() => {
      (first[0] as { name: string }).name = "mutated";
    }).toThrow(TypeError);
    expect(reg.projects[0]!.name).toBe("proj");
  });
});

describe("Model favorites", () => {
  it("getFavorites returns empty array on new registry", () => {
    const reg = Registry.load(tmpFile());
    expect(reg.getFavorites()).toEqual([]);
  });

  it("toggleFavorite adds a key on first call", () => {
    const reg = Registry.load(tmpFile());
    reg.toggleFavorite("anthropic/claude-opus-5");
    expect(reg.getFavorites()).toEqual(["anthropic/claude-opus-5"]);
  });

  it("toggleFavorite round-trips through Registry.load", () => {
    const file = tmpFile();
    const reg1 = Registry.load(file);
    reg1.toggleFavorite("anthropic/claude-opus-5");
    reg1.toggleFavorite("openai/gpt-4o");
    // Reload from disk
    const reg2 = Registry.load(file);
    expect(reg2.getFavorites()).toEqual(["anthropic/claude-opus-5", "openai/gpt-4o"]);
  });

  it("toggleFavorite toggles off on second call", () => {
    const file = tmpFile();
    const reg1 = Registry.load(file);
    reg1.toggleFavorite("anthropic/claude-opus-5");
    reg1.toggleFavorite("anthropic/claude-opus-5");
    const reg2 = Registry.load(file);
    expect(reg2.getFavorites()).toEqual([]);
  });

  it("parseRegistryData defaults modelFavorites to empty when missing", () => {
    // Upgrade path for existing registry files without modelFavorites
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: { defaultMode: "pty" },
        projects: [],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.getFavorites()).toEqual([]);
  });

  it("parseRegistryData preserves existing modelFavorites", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          defaultMode: "pty",
          modelFavorites: ["anthropic/claude-opus-5", "openai/gpt-4o"],
        },
        projects: [],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.getFavorites()).toEqual(["anthropic/claude-opus-5", "openai/gpt-4o"]);
  });

  it("parseRegistryData drops non-string entries from modelFavorites", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          defaultMode: "pty",
          modelFavorites: ["anthropic/claude-opus-5", 42, null, "openai/gpt-4o"],
        },
        projects: [],
        sessions: [],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.getFavorites()).toEqual(["anthropic/claude-opus-5", "openai/gpt-4o"]);
  });
});

describe("legacy registries with absent optional fields (issue #294)", () => {
  it("normalizes every absent preference field to null, agentMode to build", () => {
    const file = tmpFile();
    const legacyProject: Record<string, unknown> = {
      path: "/abs/proj",
      name: "proj",
      addedAt: "t",
    };
    const legacySession: Record<string, unknown> = { ...sessionRecord() };
    for (const k of [
      "model",
      "thinkingLevel",
      "compactionMethod",
      "advisor",
      "agentMode",
      "worktree",
      "planImplementationSource",
      "experiment",
    ]) {
      delete legacySession[k];
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, projects: [legacyProject], sessions: [legacySession] }),
    );
    const reg = Registry.load(file);
    expect(reg.projects[0]).toMatchObject({
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      knowledgeHome: null,
      repositoryKey: null,
      icon: null,
    });
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({
      model: null,
      thinkingLevel: null,
      advisor: false,
      compactionMethod: null,
      approvalMode: null,
      agentMode: "build",
      worktree: null,
      planImplementationSource: null, experiment: null,
    });
  });
});

describe("autoTitled marker (issue #804)", () => {
  it("normalizes a legacy session without autoTitled to false on load", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.autoTitled;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "tab-1", autoTitled: false });
  });

  it("drops a session whose present autoTitled is not a boolean", () => {
    // Same guard shape as advisor: absent loads as false, a present
    // non-boolean is a malformed record (issue #804).
    const file = tmpFile();
    const bad = { ...sessionRecord(), autoTitled: "yes" };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(0);
  });

  it("persists the marker set and cleared through updateSession across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord());
    reg.updateSession("tab-1", { autoTitled: true });
    expect(Registry.load(file).sessions[0]).toMatchObject({ tabId: "tab-1", autoTitled: true });
    reg.updateSession("tab-1", { autoTitled: false });
    expect(Registry.load(file).sessions[0]).toMatchObject({ tabId: "tab-1", autoTitled: false });
  });
});

describe("private session flag (issue #852)", () => {
  it("normalizes a legacy session without private to false on load", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.private;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "tab-1", private: false });
  });

  it("drops a session whose present private is not a boolean", () => {
    // Same guard shape as advisor/autoTitled: absent loads as false, a
    // present non-boolean is a malformed record.
    const file = tmpFile();
    const bad = { ...sessionRecord(), private: "yes" };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(0);
  });

  it("persists private across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord({ private: true }));
    expect(Registry.load(file).sessions[0]).toMatchObject({ tabId: "tab-1", private: true });
  });
});

describe("snoozed sidebar flag (issue #935)", () => {
  it("normalizes a legacy session without snoozed to false on load", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.snoozed;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "tab-1", snoozed: false });
  });

  it("drops a session whose present snoozed is not a boolean", () => {
    // Same guard shape as autoTitled/private: absent loads as false, a
    // present non-boolean is a malformed record.
    const file = tmpFile();
    const bad = { ...sessionRecord(), snoozed: "yes" };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(0);
  });

  it("persists snoozed through updateSession across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addSession(sessionRecord());
    reg.updateSession("tab-1", { snoozed: true });
    expect(Registry.load(file).sessions[0]).toMatchObject({ tabId: "tab-1", snoozed: true });
    reg.updateSession("tab-1", { snoozed: false });
    expect(Registry.load(file).sessions[0]).toMatchObject({ tabId: "tab-1", snoozed: false });
  });

  it("normalizes an absent snoozedUntilMs to null and drops a non-number one (issue #979)", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord(), snoozed: true };
    delete legacy.snoozedUntilMs;
    const bad = { ...sessionRecord(), tabId: "tab-2", snoozed: true, snoozedUntilMs: "9am" };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy, bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ tabId: "tab-1", snoozed: true, snoozedUntilMs: null });
  });

  it("drops a deadline left on an unsnoozed record", () => {
    const file = tmpFile();
    const stray = { ...sessionRecord(), snoozed: false, snoozedUntilMs: 1_800_000_000_000 };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [stray] }));
    expect(Registry.load(file).sessions[0]).toMatchObject({ snoozed: false, snoozedUntilMs: null });
  });
});

describe("pinned sidebar stamp (issue #981)", () => {
  it("loads an absent pinnedAtMs as null, keeps a stamp, and drops a non-number one", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.pinnedAtMs;
    const pinned = { ...sessionRecord(), tabId: "tab-2", pinnedAtMs: 1_800_000_000_000 };
    const bad = { ...sessionRecord(), tabId: "tab-3", pinnedAtMs: true };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy, pinned, bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions.map((s) => [s.tabId, s.pinnedAtMs])).toEqual([
      ["tab-1", null],
      ["tab-2", 1_800_000_000_000],
    ]);
  });
});

describe("held prompt (issue #986)", () => {
  it("keeps the session when its held prompt is absent or malformed, and loads a complete one", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.heldPrompt;
    const held = {
      id: "h1",
      preview: "next step",
      imageCount: 0,
      documentCount: 0,
      createdAtMs: 1_800_000_000_000,
      sendAtMs: 1_800_000_060_000,
      sentAtMs: null,
      attempts: 0,
      error: null,
    };
    const holding = { ...sessionRecord(), tabId: "tab-2", heldPrompt: held };
    const bad = { ...sessionRecord(), tabId: "tab-3", heldPrompt: { id: "h2" } };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy, holding, bad] }));
    expect(Registry.load(file).sessions.map((s) => [s.tabId, s.heldPrompt])).toEqual([
      ["tab-1", null],
      ["tab-2", held],
      ["tab-3", null],
    ]);
  });
});

describe("chat records (issue #894)", () => {
  const chatDir = "/home/u/.omp-ui/chats/chat-0b9f7c1e-3d4a-4e5f-8a6b-7c8d9e0f1a2b";

  it("removeProject keeps a chat record even when its projectCwd matches", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject(chatDir);
    reg.addSession(sessionRecord({ tabId: "chat-1", projectCwd: chatDir, chat: true }));
    reg.addSession(sessionRecord({ tabId: "proj-1", projectCwd: chatDir }));
    reg.removeProject(chatDir);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["chat-1"]);
  });

  it("inserts a new chat ahead of existing chats without reordering project sessions", () => {
    const reg = Registry.load(tmpFile());
    reg.addSession(sessionRecord({ tabId: "p-1" }));
    reg.addSession(sessionRecord({ tabId: "c-1", projectCwd: `${chatDir}-1`, chat: true }));
    reg.addSession(sessionRecord({ tabId: "p-2" }));
    const before = reg.sessions.filter((s) => !s.chat).map((s) => s.tabId);
    reg.addSession(sessionRecord({ tabId: "c-2", projectCwd: `${chatDir}-2`, chat: true }));
    expect(reg.sessions.filter((s) => s.chat).map((s) => s.tabId)).toEqual(["c-2", "c-1"]);
    expect(reg.sessions.filter((s) => !s.chat).map((s) => s.tabId)).toEqual(before);
  });

  it("setSessionModel on a chat writes chatLast* and never a project's lastModel", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.addProject(chatDir);
    reg.addSession(sessionRecord({ tabId: "chat-1", projectCwd: chatDir, chat: true }));
    reg.setSessionModel("chat-1", "provider/chat-model", "low");

    const reloaded = Registry.load(file);
    expect(reloaded.getSetting("chatLastModel")).toBe("provider/chat-model");
    expect(reloaded.getSetting("chatLastThinkingLevel")).toBe("low");
    for (const project of reloaded.projects) expect(project.lastModel ?? null).toBeNull();
    expect(reloaded.sessions[0]).toMatchObject({ model: "provider/chat-model", thinkingLevel: "low" });
  });

  it("loads a legacy record without chat as false and drops only a non-boolean chat", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord({ tabId: "legacy" }) };
    delete legacy.chat;
    const bad = { ...sessionRecord({ tabId: "bad" }), chat: "yes" };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy, bad] }));
    const reg = Registry.load(file);
    expect(reg.sessions.map((s) => [s.tabId, s.chat])).toEqual([["legacy", false]]);
  });
});

describe("Ask chat source (issue #895)", () => {
  const askSource = { tabId: "source-tab", sessionId: "019faeab-cc7b-7000-8bfc-67242a2869d8" };

  it("loads a legacy record without askSource as null", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.askSource;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    expect(Registry.load(file).sessions).toEqual([{ ...sessionRecord(), askSource: null }]);
  });

  it("drops only a record whose askSource is malformed", () => {
    const file = tmpFile();
    const good = sessionRecord({ tabId: "ask", chat: true, askSource });
    const bad = { ...sessionRecord({ tabId: "bad" }), askSource: { tabId: "" } };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [good, bad] }));
    expect(Registry.load(file).sessions.map((s) => [s.tabId, s.askSource])).toEqual([["ask", askSource]]);
  });

  it("persists askSource across a reload", () => {
    const file = tmpFile();
    Registry.load(file).addSession(sessionRecord({ chat: true, askSource }));
    expect(Registry.load(file).sessions[0]!.askSource).toEqual(askSource);
  });
});

describe("fleet dispatch provenance (issue #899)", () => {
  const fleet = {
    dispatchId: "dispatch-1",
    batchId: "batch-1",
    dispatchedAt: "2026-10-20T10:00:00.000Z",
    requestedBy: { instanceId: "instance-a", label: "laptop", kind: "agent" as const, sourceTabId: "tab-src" },
  };

  it("loads a legacy record without fleet as null", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.fleet;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    expect(Registry.load(file).sessions).toEqual([{ ...sessionRecord(), fleet: null }]);
  });

  it("drops only a record whose fleet is malformed", () => {
    const file = tmpFile();
    const good = sessionRecord({ tabId: "dispatched", mode: "rpc-ui", fleet });
    const bad = { ...sessionRecord({ tabId: "bad" }), fleet: { ...fleet, requestedBy: { ...fleet.requestedBy, kind: "robot" } } };
    const extra = { ...sessionRecord({ tabId: "extra" }), fleet: { ...fleet, prompt: "never persisted" } };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [good, bad, extra] }));
    expect(Registry.load(file).sessions.map((s) => [s.tabId, s.fleet])).toEqual([["dispatched", fleet]]);
  });

  it("persists fleet across a reload", () => {
    const file = tmpFile();
    Registry.load(file).addSession(sessionRecord({ mode: "rpc-ui", fleet }));
    expect(Registry.load(file).sessions[0]!.fleet).toEqual(fleet);
  });
});

const handoffSource = (sourceTabId: string) => ({
  sourceTabId,
  planTitle: "Plan",
  planFilePath: "local://plans/plan.md",
});

describe("planHandoffDescendants (issue #309)", () => {
  it("returns nothing when no relation points at the root", () => {
    const sessions = [
      sessionRecord({ tabId: "a" }),
      sessionRecord({ tabId: "b", planImplementationSource: handoffSource("a") }),
    ];
    expect(planHandoffDescendants(sessions, "c")).toEqual([]);
    expect(planHandoffDescendants([], "a")).toEqual([]);
  });

  it("walks a chain from every level", () => {
    const sessions = [
      sessionRecord({ tabId: "plan" }),
      sessionRecord({ tabId: "child", planImplementationSource: handoffSource("plan") }),
      sessionRecord({ tabId: "grandchild", planImplementationSource: handoffSource("child") }),
    ];
    expect(planHandoffDescendants(sessions, "plan")).toEqual(["child", "grandchild"]);
    expect(planHandoffDescendants(sessions, "child")).toEqual(["grandchild"]);
    expect(planHandoffDescendants(sessions, "grandchild")).toEqual([]);
  });

  it("visits children depth-first, in registry order", () => {
    const sessions = [
      sessionRecord({ tabId: "root" }),
      sessionRecord({ tabId: "c1", planImplementationSource: handoffSource("root") }),
      sessionRecord({ tabId: "g1", planImplementationSource: handoffSource("c1") }),
      sessionRecord({ tabId: "c2", planImplementationSource: handoffSource("root") }),
      sessionRecord({ tabId: "g2", planImplementationSource: handoffSource("c2") }),
    ];
    expect(planHandoffDescendants(sessions, "root")).toEqual(["c1", "g1", "c2", "g2"]);
  });

  it("returns records pointing at a root that is itself not registered", () => {
    const sessions = [
      sessionRecord({ tabId: "child", planImplementationSource: handoffSource("gone") }),
    ];
    expect(planHandoffDescendants(sessions, "gone")).toEqual(["child"]);
  });

  it("neither follows nor includes a self-reference", () => {
    const sessions = [
      sessionRecord({ tabId: "root" }),
      sessionRecord({ tabId: "self", planImplementationSource: handoffSource("self") }),
    ];
    expect(planHandoffDescendants(sessions, "self")).toEqual([]);
    expect(planHandoffDescendants(sessions, "root")).toEqual([]);
  });

  it("terminates on a two-cycle and visits both members", () => {
    const sessions = [
      sessionRecord({ tabId: "r" }),
      // The r → a edge plus the a ↔ b cycle, where the cycle closes through a second record named "a".
      sessionRecord({ tabId: "a", planImplementationSource: handoffSource("b") }),
      sessionRecord({ tabId: "b", planImplementationSource: handoffSource("a") }),
      sessionRecord({ tabId: "a", planImplementationSource: handoffSource("r") }),
    ];
    expect(planHandoffDescendants(sessions, "r")).toEqual(["a", "b"]);
  });

  it("lists a duplicated child tabId once", () => {
    const sessions = [
      sessionRecord({ tabId: "root" }),
      sessionRecord({ tabId: "dup", planImplementationSource: handoffSource("root") }),
      sessionRecord({ tabId: "dup", planImplementationSource: handoffSource("root") }),
    ];
    expect(planHandoffDescendants(sessions, "root")).toEqual(["dup"]);
  });

  it("never returns unrelated sessions", () => {
    const sessions = [
      sessionRecord({ tabId: "root" }),
      sessionRecord({ tabId: "child", planImplementationSource: handoffSource("root") }),
      sessionRecord({ tabId: "other" }),
    ];
    expect(planHandoffDescendants(sessions, "root")).toEqual(["child"]);
  });
});

describe("stale sidebar keys (issue #919)", () => {
  it("loads a file carrying sidebarGroups and settings.sessionOrderFrozen intact, and the next write omits both", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        // Seeded already, so load itself writes nothing: addProject below is the next write.
        settings: { sessionOrderFrozen: true, autoThinkingDefaultSeeded: true, hibernateManualDefaultSeeded: true },
        projects: [
          { path: "/abs/a", name: "a", addedAt: "t" },
          { path: "/abs/b", name: "b", addedAt: "t" },
        ],
        sessions: [
          sessionRecord({ tabId: "s-1", projectCwd: "/abs/b" }),
          sessionRecord({ tabId: "s-2", projectCwd: "/abs/a" }),
        ],
        sidebarGroups: [{ id: "g1", name: "Team", collapsed: true, projectPaths: ["/abs/a"] }],
      }),
    );

    const reg = Registry.load(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/a", "/abs/b"]);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-1", "s-2"]);

    reg.addProject("/abs/c");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      settings: Record<string, unknown>;
      projects: { path: string }[];
      sessions: { tabId: string }[];
    };
    expect(raw).not.toHaveProperty("sidebarGroups");
    expect(raw.settings).not.toHaveProperty("sessionOrderFrozen");
    expect(raw.projects.map((p) => p.path)).toEqual(["/abs/a", "/abs/b", "/abs/c"]);
    expect(raw.sessions.map((s) => s.tabId)).toEqual(["s-1", "s-2"]);
  });
});
