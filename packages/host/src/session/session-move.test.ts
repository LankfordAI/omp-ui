import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CH } from "@omp-ui/core";
import { ownedSessionRecord, seedRegistry, testHost, type BoundConnection } from "../test/fixtures";

let ipc: BoundConnection;

let base: string;

function setup(): { registryFile: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-session-move-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
      { path: "/p/a", name: "A", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
      { path: "/p/b", name: "B", addedAt: "2026-08-02T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
    ],
    // Insertion order deliberately disagrees with recency within /p/a: the
    // persisted array order must win over either (issue #274).
    sessions: [
      ownedSessionRecord({ tabId: "a-old", projectCwd: "/p/a", launchedAt: "2026-08-01T00:00:00.000Z" }),
      ownedSessionRecord({ tabId: "a-new", projectCwd: "/p/a", launchedAt: "2026-08-05T00:00:00.000Z" }),
      ownedSessionRecord({ tabId: "b-1", projectCwd: "/p/b", launchedAt: "2026-08-03T00:00:00.000Z" }),
    ],
    settings: { sessionOrderFrozen: true },
  });

  ipc = testHost(registryFile);
  return { registryFile };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> => ipc.invoke(ch, ...args);

/** The per-project session id arrays of the last stateChanged broadcast. */
function lastBroadcastSessions(): Record<string, string[]> {
  const last = [...ipc.sent].reverse().find((m) => m.channel === CH.onStateChanged);
  if (last === undefined) throw new Error("no stateChanged broadcast captured");
  const state = last.args[0] as { projects: { project: { path: string }; sessions: { tabId: string }[] }[] };
  return Object.fromEntries(
    state.projects.map((g) => [g.project.path, g.sessions.map((s) => s.tabId)]),
  );
}

function diskSessions(registryFile: string): Record<string, string[]> {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    sessions: { tabId: string; projectCwd: string }[];
  };
  const out: Record<string, string[]> = {};
  for (const s of raw.sessions) (out[s.projectCwd] ??= []).push(s.tabId);
  return out;
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("session reorder (issue #274)", () => {
  it("moves a session before another and broadcasts the new order", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "a-old", "a-new");
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
  });

  it("appends within its project when beforeTabId is null", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "a-new", null);
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
  });

  it("appends within its project when beforeTabId names another project's session", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "a-old", "b-1");
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-new", "a-old"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-new", "a-old"], "/p/b": ["b-1"] });
  });

  it("is a broadcast-only no-op for an unknown source", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "zzz", "a-new");
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
  });
});
