import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planExtensionPath } from "./plan-extension";
import { advisorOverlayPath } from "./advisor-overlay";
import {
  collectDiagnosticsBundle,
  previewDiagnosticsBundle,
  scrubSettings,
  type DiagnosticsFacts,
  type DiagnosticsOptions,
  type DiagnosticsPreview,
} from "./diagnostics";
import type { RegistrySettings } from "./registry";
import type { OwnedSessionRecord, ProjectRecord } from "./types";

const inflateRawP = promisify(inflateRaw);

const NOW = new Date(Date.UTC(2026, 8, 8, 12, 0, 0));

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diag-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function settingsWith(secrets: Partial<RegistrySettings>): RegistrySettings {
  return {
    remoteToken: "",
    remotePasswordHash: "",
    remotePasswordSalt: "",
    themeId: "dark",
    ...secrets,
  } as unknown as RegistrySettings;
}

function project(override: Partial<ProjectRecord> & { path: string }): ProjectRecord {
  return {
    name: path.basename(override.path),
    addedAt: NOW.toISOString(),
    lastModel: null,
    lastThinkingLevel: null,
    lastAdvisor: null,
    lastAdvisorModel: null,
    defaultModel: null,
    defaultAdvisorModel: null,
    ...override,
  };
}

function session(
  override: Partial<OwnedSessionRecord> & { tabId: string; projectCwd: string },
): OwnedSessionRecord {
  return {
    sessionId: "0198e9f0-0000-7000-8000-000000000000",
    lineageDir: `omp-ui--p--${override.tabId}`,
    worktree: null,
    planImplementationSource: null,
    launchedAt: NOW.toISOString(),
    mode: "rpc-ui",
    agentMode: "build",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    ...override,
  };
}

function facts(override: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  return {
    appVersion: "0.10.2",
    ompVersion: "17.1.8",
    ompPath: "/usr/bin/omp",
    electronVersion: "37.0.0",
    nodeVersion: process.version,
    chromeVersion: "130.0",
    packaged: false,
    packageFormat: "unknown",
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    totalMemBytes: 1,
    freeMemBytes: 1,
    cpuModels: ["test"],
    sessionsRoot: path.join(tmpRoot, "sessions"),
    archiveRoot: path.join(tmpRoot, "archive"),
    agentDir: path.join(tmpRoot, "agent"),
    registryFile: path.join(tmpRoot, "registry.json"),
    logDir: path.join(tmpRoot, "logs"),
    windowStateFile: path.join(tmpRoot, "window-state.json"),
    ...override,
  };
}

function options(override: Partial<DiagnosticsOptions> = {}): DiagnosticsOptions {
  return {
    facts: facts(),
    settings: settingsWith({}),
    projects: [],
    sessions: [],
    liveTabIds: [],
    includeTranscripts: false,
    destinationPath: path.join(tmpRoot, "bundle.zip"),
    gitRunner: async () => "",
    now: () => NOW,
    ...override,
  };
}

/** Reads a written bundle back into name → bytes, parsing the real structures. */
async function readZip(zipPath: string): Promise<Map<string, Uint8Array>> {
  const buf = fs.readFileSync(zipPath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const out = new Map<string, Uint8Array>();
  let at = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(at + 28, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLen + view.getUint16(localOffset + 28, true);
    const stored = buf.subarray(dataStart, dataStart + compressedSize);
    out.set(
      name,
      uncompressedSize === 0
        ? new Uint8Array(0)
        : new Uint8Array(await inflateRawP(Buffer.from(stored))),
    );
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

function jsonOf(bytes: Uint8Array | undefined): unknown {
  expect(bytes).toBeDefined();
  return JSON.parse(new TextDecoder().decode(bytes));
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

interface LineageRow {
  lineageDir: string;
  live: boolean;
  files: Array<{ name: string; sizeBytes: number }>;
}

function lineageRows(bytes: Uint8Array | undefined): LineageRow[] {
  return jsonOf(bytes) as LineageRow[];
}

function sectionOf(preview: DiagnosticsPreview, id: string) {
  const found = preview.sections.find((s) => s.id === id);
  expect(found, `section ${id}`).toBeDefined();
  return found!;
}

describe("scrubSettings", () => {
  it("drops the three secret fields and reports presence only", () => {
    const scrubbed = scrubSettings(
      settingsWith({
        remoteToken: "tok-123",
        remotePasswordHash: "",
        remotePasswordSalt: "",
      }),
    );
    expect(scrubbed.remoteToken).toBeUndefined();
    expect(scrubbed.remotePasswordHash).toBeUndefined();
    expect(scrubbed.remotePasswordSalt).toBeUndefined();
    expect(scrubbed.hasRemoteToken).toBe(true);
    expect(scrubbed.hasRemotePassword).toBe(false);
    expect(scrubbed.themeId).toBe("dark");
  });
});

describe("previewDiagnosticsBundle", () => {
  it("reports per-section file counts and sizes from stat only", async () => {
    fs.mkdirSync(path.join(tmpRoot, "logs"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "logs", "main.log"), "x".repeat(4096));
    const preview = await previewDiagnosticsBundle(options());
    const logs = sectionOf(preview, "logs");
    expect(logs.included).toBe(true);
    expect(logs.files.map((f) => f.name)).toEqual(["main.log"]);
    expect(logs.totalBytes).toBe(4096);
    expect(sectionOf(preview, "transcripts").included).toBe(false);
    expect(sectionOf(preview, "window-state").included).toBe(false);
    for (const id of ["versions", "platform", "settings", "registry", "lineages", "breadcrumbs"]) {
      expect(sectionOf(preview, id).included, id).toBe(true);
    }
    expect(preview.totalBytes).toBeGreaterThan(4096);
  });

  it("degrades a missing log dir, missing lineage dir, and a non-repo to warnings", async () => {
    // The sessions root EXISTS so the missing lineage dir is a real anomaly,
    // not just an absent root.
    fs.mkdirSync(path.join(tmpRoot, "sessions"), { recursive: true });
    const preview = await previewDiagnosticsBundle(
      options({
        sessions: [session({ tabId: "t1", projectCwd: "/gone", lineageDir: "omp-ui--gone--a" })],
        projects: [project({ path: path.join(tmpRoot, "not-a-repo") })],
        gitRunner: async () => {
          throw new Error("not a git repository");
        },
      }),
    );
    expect(preview.warnings.some((w) => w.includes("not a git repository"))).toBe(true);
    expect(preview.warnings.some((w) => w.includes("log dir missing"))).toBe(true);
    expect(preview.warnings.some((w) => w.includes("lineage dir missing"))).toBe(true);
    // The failed repo still yields an answer row, not a dropped section.
    expect(sectionOf(preview, "git").included).toBe(true);
  });
});

describe("collectDiagnosticsBundle", () => {
  it("lists lineage files from both roots, active first, names and sizes only", async () => {
    const active = path.join(tmpRoot, "sessions", "omp-ui--p--live");
    const archivedDir = path.join(tmpRoot, "archive", "omp-ui--p--dead");
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(active, "s1.jsonl"), "{}\n");
    fs.mkdirSync(path.join(active, "local"), { recursive: true });
    fs.writeFileSync(path.join(archivedDir, "s2.jsonl.gz"), "gz");
    const sessions = [
      session({ tabId: "live", projectCwd: "/p", lineageDir: "omp-ui--p--live" }),
      session({ tabId: "dead", projectCwd: "/p", lineageDir: "omp-ui--p--dead" }),
    ];
    const result = await collectDiagnosticsBundle(options({ sessions, liveTabIds: ["live"] }));
    const rows = lineageRows((await readZip(result.path)).get("lineages.json"));
    expect(rows.map((r) => r.lineageDir)).toEqual(["omp-ui--p--live", "omp-ui--p--dead"]);
    expect(rows[0]!.live).toBe(true);
    // Subdirectories never appear; only regular files with their sizes.
    expect(rows[0]!.files).toEqual([{ name: "s1.jsonl", sizeBytes: 3 }]);
    expect(rows[1]!.files).toEqual([{ name: "s2.jsonl.gz", sizeBytes: 2 }]);
  });

  it("never carries secret material and settings.json has the two booleans", async () => {
    const result = await collectDiagnosticsBundle(
      options({
        settings: settingsWith({
          remoteToken: "supertoken",
          remotePasswordHash: "hashhex",
          remotePasswordSalt: "salthex",
        }),
      }),
    );
    const entries = await readZip(result.path);
    const settings = jsonOf(entries.get("settings.json")) as Record<string, unknown>;
    expect(settings.remoteToken).toBeUndefined();
    expect(settings.remotePasswordHash).toBeUndefined();
    expect(settings.remotePasswordSalt).toBeUndefined();
    expect(settings.hasRemoteToken).toBe(true);
    expect(settings.hasRemotePassword).toBe(true);
    for (const [name, bytes] of entries) {
      const text = textOf(bytes);
      expect(text, name).not.toContain("supertoken");
      expect(text, name).not.toContain("hashhex");
      expect(text, name).not.toContain("salthex");
    }
  });

  it("copies logs, the breadcrumb ring, window state, and manifest", async () => {
    fs.mkdirSync(path.join(tmpRoot, "logs"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "logs", "main.log"), "hello log\n");
    fs.writeFileSync(path.join(tmpRoot, "logs", "breadcrumbs.log.old"), "old\n");
    fs.writeFileSync(path.join(tmpRoot, "window-state.json"), '{"bounds":{}}');
    const result = await collectDiagnosticsBundle(
      options({ breadcrumbs: [{ at: NOW.toISOString(), seq: 1, kind: "launch", detail: "v" }] }),
    );
    const entries = await readZip(result.path);
    expect(textOf(entries.get("logs/main.log")!)).toBe("hello log\n");
    expect(entries.has("logs/breadcrumbs.log.old")).toBe(true);
    expect(entries.has("logs/breadcrumbs.log")).toBe(false);
    expect(entries.has("window-state.json")).toBe(true);
    expect(jsonOf(entries.get("breadcrumbs.json"))).toHaveLength(1);
    const manifest = jsonOf(entries.get("manifest.json")) as Record<string, unknown>;
    expect(manifest.includeTranscripts).toBe(false);
    expect(manifest.appVersion).toBe("0.10.2");
    expect((manifest.redaction as unknown[]).length).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(fs.statSync(result.path).size);
  });

  it("excludes transcripts by default and caps them with a warning when opted in", async () => {
    const dir = path.join(tmpRoot, "sessions", "omp-ui--p--t1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.jsonl"), "x".repeat(100));
    fs.writeFileSync(path.join(dir, "b.jsonl"), "y".repeat(100));
    fs.writeFileSync(path.join(dir, "c.bak"), "z");
    const sessions = [session({ tabId: "t1", projectCwd: "/p", lineageDir: "omp-ui--p--t1" })];

    const off = await collectDiagnosticsBundle(options({ sessions }));
    expect(
      [...(await readZip(off.path)).keys()].filter((n) => n.startsWith("transcripts/")),
    ).toEqual([]);

    const on = await collectDiagnosticsBundle(
      options({ sessions, includeTranscripts: true, transcriptCapBytes: 50 }),
    );
    const names = [...(await readZip(on.path)).keys()].filter((n) => n.startsWith("transcripts/"));
    expect(names).toEqual(["transcripts/omp-ui--p--t1/a.jsonl"]);
    expect(on.warnings.some((w) => w.includes("cap"))).toBe(true);
  });

  it("collects generated files only for live sessions", async () => {
    const live = path.join(tmpRoot, "sessions", "omp-ui--p--live");
    const dead = path.join(tmpRoot, "sessions", "omp-ui--p--dead");
    fs.mkdirSync(live, { recursive: true });
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(planExtensionPath(live), "plan ext");
    fs.writeFileSync(advisorOverlayPath(live), "overlay");
    fs.writeFileSync(planExtensionPath(dead), "not collected");
    const result = await collectDiagnosticsBundle(
      options({
        sessions: [
          session({ tabId: "live", projectCwd: "/p", lineageDir: "omp-ui--p--live" }),
          session({ tabId: "dead", projectCwd: "/p", lineageDir: "omp-ui--p--dead" }),
        ],
        liveTabIds: ["live"],
      }),
    );
    const names = [...(await readZip(result.path)).keys()]
      .filter((n) => n.startsWith("extensions/"))
      .sort();
    expect(names).toEqual([
      `extensions/live/${path.basename(advisorOverlayPath(live))}`,
      `extensions/live/${path.basename(planExtensionPath(live))}`,
    ]);
  });

  it("queries each effective tree once and truncates a long status", async () => {
    const calls: string[] = [];
    const many = Array.from({ length: 2001 }, (_, i) => `?? f${i}`).join("\n");
    const result = await collectDiagnosticsBundle(
      options({
        projects: [project({ path: "/repoA" }), project({ path: "/repoB" })],
        sessions: [
          session({ tabId: "t1", projectCwd: "/repoA" }),
          session({
            tabId: "t2",
            projectCwd: "/repoB",
            worktree: { path: "/wt/b", branch: "b", base: null },
          }),
        ],
        gitRunner: async (cwd) => {
          calls.push(cwd);
          return cwd === path.resolve("/wt/b") ? many : "";
        },
      }),
    );
    // repoA's session runs at projectCwd (deduped with the project), repoB's in its worktree.
    expect(calls).toEqual([path.resolve("/repoA"), path.resolve("/repoB"), path.resolve("/wt/b")]);
    const gitEntries = [...(await readZip(result.path)).entries()].filter(([n]) =>
      n.startsWith("git/"),
    );
    expect(gitEntries.map(([n]) => n)).toEqual([
      "git/0-repoa.txt",
      "git/1-repob.txt",
      "git/2-b.txt",
    ]);
    const text = textOf(gitEntries[2]![1]);
    expect(text.endsWith("[truncated]\n")).toBe(true);
    // 2000 kept lines + the marker, no tail of the 2001st.
    expect(text.split("\n")).toHaveLength(2002);
    expect(text).not.toContain("f2000");
  });

  it("records a git failure as an [error] line plus a warning", async () => {
    const result = await collectDiagnosticsBundle(
      options({
        projects: [project({ path: "/broken" })],
        gitRunner: async () => {
          throw new Error("git exploded");
        },
      }),
    );
    expect(result.warnings.some((w) => w.includes("git exploded"))).toBe(true);
    const entries = await readZip(result.path);
    const file = [...entries.entries()].find(([n]) => n.startsWith("git/"))!;
    expect(textOf(file[1])).toBe("[error] git exploded\n");
  });

  it("rejects an invalid destinationPath before touching the disk", async () => {
    await expect(
      collectDiagnosticsBundle(options({ destinationPath: "relative/bundle.zip" })),
    ).rejects.toThrow("invalid destination path");
    await expect(
      collectDiagnosticsBundle(options({ destinationPath: "has\0nul" })),
    ).rejects.toThrow("invalid destination path");
    expect(fs.existsSync(path.join(tmpRoot, "relative"))).toBe(false);
  });

  it("defaults beside the registry under diagnostics/", async () => {
    const result = await collectDiagnosticsBundle(options({ destinationPath: null }));
    expect(path.dirname(result.path)).toBe(path.join(tmpRoot, "diagnostics"));
    expect(path.basename(result.path)).toMatch(/^omp-ui-diagnostics-\d{8}-\d{6}\.zip$/);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it("removes the tmp file when the final commit fails", async () => {
    // A directory at the destination makes rename() fail after the tmp write.
    fs.mkdirSync(path.join(tmpRoot, "bundle.zip"), { recursive: true });
    await expect(collectDiagnosticsBundle(options())).rejects.toThrow(/failed to write/);
    expect(fs.readdirSync(tmpRoot).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("leaves no tmp file on success", async () => {
    const result = await collectDiagnosticsBundle(options());
    expect(fs.readdirSync(tmpRoot).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect((await readZip(result.path)).has("manifest.json")).toBe(true);
  });

  it("still writes a bundle when every source is missing", async () => {
    const result = await collectDiagnosticsBundle(
      options({
        facts: facts({
          sessionsRoot: path.join(tmpRoot, "nope"),
          archiveRoot: path.join(tmpRoot, "nope2"),
          logDir: path.join(tmpRoot, "nope3"),
        }),
        projects: [],
        sessions: [],
      }),
    );
    const entries = await readZip(result.path);
    expect(entries.has("manifest.json")).toBe(true);
    expect(entries.has("settings.json")).toBe(true);
    expect(entries.has("logs/main.log")).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
