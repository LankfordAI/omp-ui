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
    expect(reg.defaultMode).toBe("pty");
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
        projects: [{ path: 42 }, { path: "/abs/proj", name: "proj", advisor: false, addedAt: "t" }],
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

    const reloaded = Registry.load(file);
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0]).toMatchObject({ path: "/abs/proj", name: "proj", advisor: false });
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]).toMatchObject({ tabId: "tab-1", sessionId: null });
    expect(reloaded.defaultMode).toBe("rpc-ui");
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

  it("setProjectAdvisor flips the flag", () => {
    const reg = Registry.load(tmpFile());
    reg.addProject("/abs/proj");
    reg.setProjectAdvisor("/abs/proj", true);
    expect(reg.projects[0]!.advisor).toBe(true);
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
