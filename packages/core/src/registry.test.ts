import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "./registry";
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
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "pty",
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    ...patch,
  };
}

describe("Registry.load", () => {
  it("starts empty when the file is missing", () => {
    const reg = Registry.load(tmpFile());
    expect(reg.projects).toEqual([]);
    expect(reg.sessions).toEqual([]);
    expect(reg.defaultMode).toBe("rpc-ui");
    expect(reg.skipDeleteConfirmation).toBe(false);
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
});

describe("Registry persistence", () => {
  it("round-trips projects, sessions, and settings", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.addProject("/abs/proj");
    reg.addSession(sessionRecord());
    reg.setDefaultMode("rpc-ui");
    reg.setSkipDeleteConfirmation(true);

    const reloaded = Registry.load(file);
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0]).toMatchObject({ path: "/abs/proj", name: "proj" });
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]).toMatchObject({ tabId: "tab-1", sessionId: null });
    expect(reloaded.defaultMode).toBe("rpc-ui");
    expect(reloaded.skipDeleteConfirmation).toBe(true);
  });

  it("defaults dismissedAppUpdateVersion to null when the field is absent", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { skipDeleteConfirmation: true } }),
    );
    expect(Registry.load(file).dismissedAppUpdateVersion).toBeNull();
  });

  it("round-trips the dismissed app-update version across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    expect(reg.dismissedAppUpdateVersion).toBeNull();
    reg.setDismissedAppUpdateVersion("1.2.0");
    expect(reg.dismissedAppUpdateVersion).toBe("1.2.0");
    expect(Registry.load(file).dismissedAppUpdateVersion).toBe("1.2.0");
    reg.setDismissedAppUpdateVersion(null);
    expect(Registry.load(file).dismissedAppUpdateVersion).toBeNull();
  });

  it("defaults dismissedOmpUpdateVersion to null when the field is absent", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { skipDeleteConfirmation: true } }),
    );
    expect(Registry.load(file).dismissedOmpUpdateVersion).toBeNull();
  });

  it("round-trips the dismissed omp-update version across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    expect(reg.dismissedOmpUpdateVersion).toBeNull();
    reg.setDismissedOmpUpdateVersion("1.2.0");
    expect(reg.dismissedOmpUpdateVersion).toBe("1.2.0");
    expect(Registry.load(file).dismissedOmpUpdateVersion).toBe("1.2.0");
    reg.setDismissedOmpUpdateVersion(null);
    expect(Registry.load(file).dismissedOmpUpdateVersion).toBeNull();
  });

  it("defaults theme and launch update checks when the settings fields are absent", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { skipDeleteConfirmation: true } }),
    );
    const reg = Registry.load(file);
    expect(reg.themeId).toBe("graphite");
    expect(reg.appUpdateCheckOnLaunch).toBe(true);
    expect(reg.ompUpdateCheckOnLaunch).toBe(true);
  });

  it("round-trips a non-default theme and launch update checks across a reload", () => {
    const file = tmpFile();
    const reg = Registry.load(file);
    reg.setThemeId("monokai");
    reg.setAppUpdateCheckOnLaunch(false);
    reg.setOmpUpdateCheckOnLaunch(false);

    const reloaded = Registry.load(file);
    expect(reloaded.themeId).toBe("monokai");
    expect(reloaded.appUpdateCheckOnLaunch).toBe(false);
    expect(reloaded.ompUpdateCheckOnLaunch).toBe(false);
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
    });
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
