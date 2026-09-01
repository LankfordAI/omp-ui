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
    planImplementationSource: null,
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "pty",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
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
      "defaultAdvisor",
      "modelFavorites",
      "skipDeleteConfirmation",
      "sessionOrderFrozen",
      "dismissedAppUpdateVersion",
      "dismissedOmpUpdateVersion",
      "themeId",
      "fontFamilyId",
      "localeId",
      "appUpdateCheckOnLaunch",
      "ompUpdateCheckOnLaunch",
      "remoteEnabled",
      "remoteBind",
      "remotePort",
      "remoteToken",
      "remotePasswordHash",
      "remotePasswordSalt",
    ]);
  });

  it("creates fresh mutable fallbacks", () => {
    expect(SETTINGS.modelFavorites.fallback()).not.toBe(SETTINGS.modelFavorites.fallback());
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
    // Issue #109: HTML is the default plan review rendition.
    expect(reg.getSetting("planFormat")).toBe("html");
    // Issue #246: idle rpc-ui sessions hibernate after a 30 min quiet window.
    expect(reg.getSetting("hibernateIdleMinutes")).toBe(30);
    // Issue #111: auto-reply defaults on.
    expect(reg.getSetting("advisorAutoReply")).toBe(true);
    // Issue #251: stall auto-continue defaults on.
    expect(reg.getSetting("stallAutoContinue")).toBe(true);
    // Issue #271: desktop notifications default on.
    expect(reg.getSetting("desktopNotifications")).toBe(true);
    // Issue #174: the advisor does not default on.
    expect(reg.getSetting("defaultAdvisor")).toBe(false);
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
          ompUpdateCheckOnLaunch: 0,
          remoteEnabled: "no",
          remoteBind: "public",
          remotePort: 1023,
          remoteToken: 123,
          remotePasswordHash: 123,
          remotePasswordSalt: 456,
        },
        projects: [],
        sessions: [],
      }),
    );

    const reg = Registry.load(file);
    expect(reg.getSetting("defaultMode")).toBe("rpc-ui");
    expect(reg.getSetting("defaultAgentMode")).toBe("plan");
    expect(reg.getSetting("planFormat")).toBe("html");
    expect(reg.getSetting("hibernateIdleMinutes")).toBe(30);
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
    expect(reg.getSetting("ompUpdateCheckOnLaunch")).toBe(true);
    expect(reg.getSetting("remoteEnabled")).toBe(false);
    expect(reg.getSetting("remoteBind")).toBe("localhost");
    expect(reg.getSetting("remotePort")).toBe(4677);
    expect(reg.getSetting("remoteToken")).toBe("");
    expect(reg.getSetting("remotePasswordHash")).toBe("");
    expect(reg.getSetting("remotePasswordSalt")).toBe("");
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

    const reloaded = Registry.load(file);
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0]).toMatchObject({ path: "/abs/proj", name: "proj" });
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]).toMatchObject({ tabId: "tab-1", sessionId: null });
    expect(reloaded.getSetting("defaultMode")).toBe("rpc-ui");
    expect(reloaded.getSetting("defaultAgentMode")).toBe("build");
    expect(reloaded.getSetting("skipDeleteConfirmation")).toBe(true);
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

  it("round-trips the hibernate idle window and falls back to 30 for anything unknown", () => {
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
      expect(Registry.load(f).getSetting("hibernateIdleMinutes")).toBe(30);
    }
    const absent = tmpFile();
    fs.writeFileSync(absent, JSON.stringify({ schemaVersion: 1, settings: {} }));
    expect(Registry.load(absent).getSetting("hibernateIdleMinutes")).toBe(30);
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
    expect(reg.getSetting("ompUpdateCheckOnLaunch")).toBe(true);
  });

  it("round-trips a non-default theme and launch update checks across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setSetting("themeId", "theme-from-a-newer-build");
    reg.setSetting("localeId", "ko");
    reg.setSetting("appUpdateCheckOnLaunch", false);
    reg.setSetting("ompUpdateCheckOnLaunch", false);

    const reloaded = Registry.load(file);
    expect(reloaded.getSetting("themeId")).toBe("theme-from-a-newer-build");
    expect(reloaded.getSetting("localeId")).toBe("ko");
    expect(reloaded.getSetting("appUpdateCheckOnLaunch")).toBe(false);
    expect(reloaded.getSetting("ompUpdateCheckOnLaunch")).toBe(false);
  });

  it("does not write when a public setting setter receives the current value", () => {
    const sameValueSetters: Array<[string, (registry: Registry) => void]> = [
      ["defaultMode", (registry) => registry.setSetting("defaultMode", "rpc-ui")],
      ["defaultAgentMode", (registry) => registry.setSetting("defaultAgentMode", "plan")],
      ["planFormat", (registry) => registry.setSetting("planFormat", "html")],
      ["hibernateIdleMinutes", (registry) => registry.setSetting("hibernateIdleMinutes", 30)],
      ["streamStallAbortSeconds", (registry) => registry.setSetting("streamStallAbortSeconds", 180)],
      ["advisorAutoReply", (registry) => registry.setSetting("advisorAutoReply", true)],
      ["stallAutoContinue", (registry) => registry.setSetting("stallAutoContinue", true)],
      ["desktopNotifications", (registry) => registry.setSetting("desktopNotifications", true)],
      ["defaultAdvisor", (registry) => registry.setSetting("defaultAdvisor", false)],
      ["skipDeleteConfirmation", (registry) => registry.setSetting("skipDeleteConfirmation", false)],
      ["themeId", (registry) => registry.setSetting("themeId", "graphite")],
      ["fontFamilyId", (registry) => registry.setSetting("fontFamilyId", "default")],
      ["localeId", (registry) => registry.setSetting("localeId", "en")],
      ["appUpdateCheckOnLaunch", (registry) => registry.setSetting("appUpdateCheckOnLaunch", true)],
      ["ompUpdateCheckOnLaunch", (registry) => registry.setSetting("ompUpdateCheckOnLaunch", true)],
      ["remoteEnabled", (registry) => registry.setSetting("remoteEnabled", false)],
      ["remoteBind", (registry) => registry.setSetting("remoteBind", "localhost")],
      ["remotePort", (registry) => registry.setSetting("remotePort", 4677)],
      ["remoteToken", (registry) => registry.setSetting("remoteToken", "")],
      ["remotePasswordHash", (registry) => registry.setSetting("remotePasswordHash", "")],
      ["remotePasswordSalt", (registry) => registry.setSetting("remotePasswordSalt", "")],
      ["dismissedAppUpdateVersion", (registry) => registry.setSetting("dismissedAppUpdateVersion", null)],
      ["dismissedOmpUpdateVersion", (registry) => registry.setSetting("dismissedOmpUpdateVersion", null)],
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

  it("moveProject inserts before a sibling in either direction", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addProject("/abs/c");
    // A later project before an earlier one — the `to` index is looked up
    // after the splice, so it lands ahead of the previously-removed slot.
    reg.moveProject("/abs/c", "/abs/a");
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/c", "/abs/a", "/abs/b"]);
    // And an earlier project before a later one.
    reg.moveProject("/abs/a", "/abs/c");
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/a", "/abs/c", "/abs/b"]);
  });

  it("moveProject appends when beforePath is null or no longer registered", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addProject("/abs/c");
    reg.moveProject("/abs/a", null);
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/b", "/abs/c", "/abs/a"]);
    reg.moveProject("/abs/b", "/abs/gone");
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/c", "/abs/a", "/abs/b"]);
  });

  it("moveProject writes nothing when the project already sits before its target", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addProject("/abs/c");
    const restore = rejectAtomicReplaces(file);
    expect(() => reg.moveProject("/abs/a", "/abs/b")).not.toThrow();
    expect(reg.projects.map((project) => project.path)).toEqual(["/abs/a", "/abs/b", "/abs/c"]);
    restore();
  });

  it("moveProject leaves the order alone when the target is the project itself", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    for (const p of ["/abs/a", "/abs/b", "/abs/c", "/abs/d"]) reg.addProject(p);
    // The sidebar computes `beforePath` from the row below the drop point, so
    // dropping a project just above itself asks to move it before itself. That
    // is the "leave it put" gesture, and it must not reorder anything. Four
    // projects, not three: with three, appending happens to land the moved
    // project back where it started, which hides the bug entirely.
    reg.moveProject("/abs/c", "/abs/c");
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/a", "/abs/b", "/abs/c", "/abs/d"]);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.projects.map((p: { path: string }) => p.path)).toEqual([
      "/abs/a",
      "/abs/b",
      "/abs/c",
      "/abs/d",
    ]);
  });

  it("moveProject with an unknown source is a no-op and writes nothing", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addProject("/abs/c");
    reg.moveProject("/abs/zzz", "/abs/b");
    expect(reg.projects.map((p) => p.path)).toEqual(["/abs/a", "/abs/b", "/abs/c"]);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.projects.map((p: { path: string }) => p.path)).toEqual(["/abs/a", "/abs/b", "/abs/c"]);
  });

  it("moveProject persists the new order across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addProject("/abs/c");
    reg.moveProject("/abs/c", "/abs/a");
    expect(Registry.load(file).projects.map((p) => p.path)).toEqual(["/abs/c", "/abs/a", "/abs/b"]);
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
    });
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

  it("keeps legacy sessions and defaults missing preferences to null", () => {
    const file = tmpFile();
    const legacy: Record<string, unknown> = { ...sessionRecord() };
    delete legacy.model;
    delete legacy.thinkingLevel;
    delete legacy.advisorModel;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [], sessions: [legacy] }));
    const reg = Registry.load(file);
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({ model: null, thinkingLevel: null, advisorModel: null });
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

describe("Session sidebar order (#274)", () => {
  it("moveSession inserts before a sibling in either direction", () => {
    const reg = Registry.load(tmpFile());
    for (const tabId of ["s-1", "s-2", "s-3"]) reg.addSession(sessionRecord({ tabId }));
    // Top insertion (#274): the newest record leads.
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-3", "s-2", "s-1"]);
    // One step up: before its predecessor.
    reg.moveSession("s-1", "s-2");
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-3", "s-1", "s-2"]);
    // One step down from the top: before the successor's successor.
    reg.moveSession("s-3", "s-2");
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("moveSession appends when beforeTabId is null or no longer present", () => {
    const reg = Registry.load(tmpFile());
    for (const tabId of ["s-1", "s-2", "s-3"]) reg.addSession(sessionRecord({ tabId }));
    reg.moveSession("s-3", null);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-2", "s-1", "s-3"]);
    reg.moveSession("s-2", "s-gone");
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("moveSession leaves the order alone when the target is the session itself", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    for (const tabId of ["s-1", "s-2", "s-3", "s-4"]) reg.addSession(sessionRecord({ tabId }));
    // Four sessions, not three: with three, appending happens to land the
    // moved record back where it started, which hides the bug entirely.
    reg.moveSession("s-2", "s-2");
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-4", "s-3", "s-2", "s-1"]);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: { tabId: string }[] };
    expect(raw.sessions.map((s) => s.tabId)).toEqual(["s-4", "s-3", "s-2", "s-1"]);
  });

  it("moveSession with an unknown source is a no-op and writes nothing", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    for (const tabId of ["s-1", "s-2"]) reg.addSession(sessionRecord({ tabId }));
    fs.writeFileSync(file, "unchanged-marker");
    reg.moveSession("s-zzz", "s-1");
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["s-2", "s-1"]);
    expect(fs.readFileSync(file, "utf8")).toBe("unchanged-marker");
  });

  it("moveSession persists the new order across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    for (const tabId of ["s-1", "s-2", "s-3"]) reg.addSession(sessionRecord({ tabId }));
    reg.moveSession("s-1", "s-3");
    expect(Registry.load(file).sessions.map((s) => s.tabId)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("addSession splices ahead of its project's first record in an interleaved array", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject("/abs/a");
    reg.addProject("/abs/b");
    reg.addSession(sessionRecord({ tabId: "t-a1", projectCwd: "/abs/a" }));
    reg.addSession(sessionRecord({ tabId: "t-b1", projectCwd: "/abs/b" }));
    reg.addSession(sessionRecord({ tabId: "t-a2", projectCwd: "/abs/a" }));
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["t-a2", "t-a1", "t-b1"]);
  });

  it("seeds the frozen order from recency once and never re-sorts again", () => {
    const file = tmpFile();
    // Legacy format: insertion-ordered sessions, no freeze marker.
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: "/abs/p", name: "p", addedAt: "t" }],
        sessions: [
          sessionRecord({ tabId: "old", launchedAt: "2026-01-01T00:00:00.000Z" }),
          sessionRecord({ tabId: "new", launchedAt: "2026-02-01T00:00:00.000Z" }),
        ],
      }),
    );

    const reg = Registry.load(file);
    // The upgrade is invisible: today's recency sort becomes the frozen order.
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["new", "old"]);
    expect(reg.getSetting("sessionOrderFrozen")).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      settings: { sessionOrderFrozen?: boolean };
      sessions: { tabId: string }[];
    };
    expect(raw.settings.sessionOrderFrozen).toBe(true);
    expect(raw.sessions.map((s) => s.tabId)).toEqual(["new", "old"]);

    // A user drag after the upgrade survives every later load.
    reg.moveSession("old", "new");
    expect(Registry.load(file).sessions.map((s) => s.tabId)).toEqual(["old", "new"]);
  });

  it("seeding keeps records naming an unregistered project after the known buckets", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: "/abs/proj", name: "p", addedAt: "t" }],
        sessions: [
          sessionRecord({ tabId: "orphan", projectCwd: "/abs/elsewhere" }),
          sessionRecord({ tabId: "owned-old", launchedAt: "2026-01-01T00:00:00.000Z" }),
          sessionRecord({ tabId: "owned-new", launchedAt: "2026-02-01T00:00:00.000Z" }),
        ],
      }),
    );
    const reg = Registry.load(file);
    expect(reg.sessions.map((s) => s.tabId)).toEqual(["owned-new", "owned-old", "orphan"]);
  });

  it("loading a missing or corrupt file never seeds a write", () => {
    const missing = tmpFile();
    const reg = Registry.load(missing);
    expect(fs.existsSync(missing)).toBe(false);
    expect(reg.getSetting("sessionOrderFrozen")).toBe(false);

    const corrupt = tmpFile();
    fs.writeFileSync(corrupt, "{not json");
    Registry.load(corrupt);
    expect(fs.existsSync(corrupt)).toBe(false);
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
      planImplementationSource: null,
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
      "agentMode",
      "worktree",
      "planImplementationSource",
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
    });
    expect(reg.sessions).toHaveLength(1);
    expect(reg.sessions[0]).toMatchObject({
      model: null,
      thinkingLevel: null,
      compactionMethod: null,
      agentMode: "build",
      worktree: null,
      planImplementationSource: null,
    });
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
