import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, createBreadcrumbRing, type DesktopClientFacts } from "@omp-ui/core";
import type * as Core from "@omp-ui/core";
import type { ClientEffects } from "./host-application";
import { seedRegistry, testHost, type BoundConnection } from "./test/fixtures";

vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return { ...core, resolveOmpBinary: () => null };
});

const inflateRawP = promisify(inflateRaw);

let base: string;
let registryFile: string;
let ipc: BoundConnection;

async function zipNames(zipPath: string): Promise<string[]> {
  const buf = fs.readFileSync(zipPath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const names: string[] = [];
  let at = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(at + 28, true);
    names.push(buf.toString("utf8", at + 46, at + 46 + nameLength));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return names;
}

async function unzipEntry(zipPath: string, wanted: string): Promise<string> {
  const buf = fs.readFileSync(zipPath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  let at = view.getUint32(eocd + 16, true);
  for (let index = 0; index < view.getUint16(eocd + 10, true); index += 1) {
    const nameLength = view.getUint16(at + 28, true);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    const local = view.getUint32(at + 42, true);
    const dataStart =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (name === wanted) {
      const bytes = buf.subarray(dataStart, dataStart + view.getUint32(at + 20, true));
      return new TextDecoder().decode(await inflateRawP(Buffer.from(bytes)));
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  throw new Error(`no such entry: ${wanted}`);
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> => ipc.invoke(ch, ...args);

/** Every client effect stubbed; only `chooseDiagnosticsPath` is exercised here. */
function fakeEffects(): ClientEffects {
  return {
    openPath: vi.fn(async () => {}),
    showPathInFolder: vi.fn(),
    openProject: vi.fn(async () => {}),
    getProjectOpenAvailability: vi.fn(() => ({ vsCode: false, terminal: false })),
    setWindowChrome: vi.fn(),
    chooseDiagnosticsPath: vi.fn(async () => null),
    appUpdate: {
      state: {
        status: "disabled",
        currentVersion: null,
        latestVersion: null,
        releaseUrl: null,
        releaseName: null,
        format: "unknown",
        progress: null,
        downloadedPath: null,
        installOnQuit: false,
        error: null,
      },
      checkNow: vi.fn(),
      download: vi.fn(async () => {}),
      openReleaseNotes: vi.fn(async () => {}),
      showDownload: vi.fn(async () => {}),
      restart: vi.fn(() => "unavailable" as const),
      setInstallOnQuit: vi.fn(),
      dismiss: vi.fn(),
    },
  };
}

function makeHost(patch: {
  clientEffects?: ClientEffects;
  clientFacts?: () => DesktopClientFacts | null;
} = {}): void {
  ipc = testHost(registryFile, {
    paths: { logDir: path.join(base, "logs") },
    breadcrumbs: createBreadcrumbRing(path.join(base, "logs")),
    ...patch,
  });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-diag-backend-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, { settings: { remoteToken: "tok-abc" } });
  fs.mkdirSync(path.join(base, "logs"), { recursive: true });
  fs.writeFileSync(path.join(base, "logs", "main.log"), "boot line\n");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("diagnostics channels", () => {
  it("preview answers with sections without writing anything", async () => {
    makeHost();
    const preview = (await invoke(CH.previewDiagnosticsBundle)) as {
      sections: Array<{ id: string; included: boolean; files: unknown[] }>;
      totalBytes: number;
      warnings: string[];
    };
    expect(preview.sections.find((s) => s.id === "manifest")).toBeDefined();
    expect(preview.sections.find((s) => s.id === "settings")!.included).toBe(true);
    // Nothing was written: only the seeded logs dir exists under base.
    expect(fs.readdirSync(base).filter((n) => n.includes(".zip"))).toEqual([]);
  });

  it("export writes the requested zip with the expected entries", async () => {
    makeHost();
    const dest = path.join(base, "out", "bundle.zip");
    const result = (await invoke(CH.exportDiagnosticsBundle, {
      includeTranscripts: false,
      destinationPath: dest,
    })) as { path: string; totalBytes: number };
    expect(result.path).toBe(dest);
    const names = await zipNames(dest);
    expect(names).toContain("manifest.json");
    expect(names).toContain("settings.json");
    expect(names).toContain("logs/main.log");
    expect(names.some((n) => n.startsWith("transcripts/"))).toBe(false);
    // The bundle never carries the token; settings.json reports presence instead.
    const settingsText = await unzipEntry(dest, "settings.json");
    expect(settingsText).not.toContain("tok-abc");
    expect(JSON.parse(settingsText).hasRemoteToken).toBe(true);
    // The manifest reports the host's own facts; no desktop client is attached.
    const manifest = JSON.parse(await unzipEntry(dest, "manifest.json")) as {
      host: { verifier: { state: string } };
      desktopClient: unknown;
    };
    expect(manifest.host).toMatchObject({
      dataRoot: base,
      hostVersion: "0.0.0",
      hostProtocol: 2,
      credentialBackend: "test",
    });
    expect(manifest.host.verifier.state).toBe("degraded");
    expect(manifest.desktopClient).toBeNull();
  });

  it("export reports the attached desktop client and carries its window state", async () => {
    const windowStateFile = path.join(base, "window-state.json");
    fs.writeFileSync(windowStateFile, '{"bounds":{}}');
    makeHost({
      clientFacts: () => ({
        clientVersion: "9.9.9",
        electronVersion: "37.0.0",
        chromeVersion: "130.0",
        windowStateFile,
        packaged: false,
        packageFormat: "deb",
      }),
    });
    const dest = path.join(base, "client.zip");
    await invoke(CH.exportDiagnosticsBundle, { includeTranscripts: false, destinationPath: dest });
    const manifest = JSON.parse(await unzipEntry(dest, "manifest.json")) as {
      desktopClient: { electronVersion: string };
    };
    expect(manifest.desktopClient.electronVersion).toBe("37.0.0");
    expect(await zipNames(dest)).toContain("window-state.json");
  });

  it("export with null destination lands beside the registry", async () => {
    makeHost();
    const result = (await invoke(CH.exportDiagnosticsBundle, {
      includeTranscripts: false,
      destinationPath: null,
    })) as { path: string };
    expect(path.dirname(result.path)).toBe(path.join(base, "diagnostics"));
  });

  it("rejects a concurrent second export", async () => {
    makeHost();
    const dest = path.join(base, "b.zip");
    const first = invoke(CH.exportDiagnosticsBundle, {
      includeTranscripts: false,
      destinationPath: dest,
    });
    await expect(
      invoke(CH.exportDiagnosticsBundle, { includeTranscripts: false, destinationPath: dest }),
    ).rejects.toThrow("diagnostic export already in progress");
    await first;
  });

  it("choosePath returns the client's file path or null on cancel", async () => {
    const effects = fakeEffects();
    const choose = vi.mocked(effects.chooseDiagnosticsPath);
    makeHost({ clientEffects: effects });
    choose.mockResolvedValue("/tmp/picked.zip");
    expect(await invoke(CH.chooseDiagnosticsPath, "omp-ui-diagnostics.zip")).toBe("/tmp/picked.zip");
    expect(choose).toHaveBeenCalledWith("omp-ui-diagnostics.zip");
    choose.mockResolvedValue(null);
    expect(await invoke(CH.chooseDiagnosticsPath, "")).toBeNull();
  });

  it("choosePath is refused on a host with no desktop client attached", async () => {
    makeHost();
    await expect(invoke(CH.chooseDiagnosticsPath, "x")).rejects.toThrow(
      "not available on this host",
    );
  });

  it("records breadcrumbs that reach the bundle's logs", async () => {
    makeHost();
    await invoke(CH.setRemoteEnabled, true);
    const dest = path.join(base, "crumb.zip");
    await invoke(CH.exportDiagnosticsBundle, {
      includeTranscripts: false,
      destinationPath: dest,
    });
    const lines = await unzipEntry(dest, "logs/breadcrumbs.log");
    expect(lines).toContain('"kind":"remote-enable"');
    const ring = JSON.parse(await unzipEntry(dest, "breadcrumbs.json")) as Array<{
      kind: string;
    }>;
    expect(ring.some((e) => e.kind === "remote-enable")).toBe(true);
  });
});
