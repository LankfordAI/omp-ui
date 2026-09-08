import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedRegistry } from "./test/fixtures";

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
const showSaveDialog = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
}));
vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omp-ui/core")>();
  return { ...core, resolveOmpBinary: () => null };
});

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { createBreadcrumbRing } = await import("./breadcrumbs");

const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

const inflateRawP = promisify(inflateRaw);

let base: string;
let registryFile: string;

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

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

function makeBackend(): void {
  new MainBackend(win as never, registryFile, {
    logDir: path.join(base, "logs"),
    breadcrumbs: createBreadcrumbRing(path.join(base, "logs")),
  }).registerIpc();
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
  handlers.clear();
  showSaveDialog.mockReset();
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("diagnostics channels", () => {
  it("preview answers with sections without writing anything", async () => {
    makeBackend();
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
    makeBackend();
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
  });

  it("export with null destination lands beside the registry", async () => {
    makeBackend();
    const result = (await invoke(CH.exportDiagnosticsBundle, {
      includeTranscripts: false,
      destinationPath: null,
    })) as { path: string };
    expect(path.dirname(result.path)).toBe(path.join(base, "diagnostics"));
  });

  it("rejects a concurrent second export", async () => {
    makeBackend();
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

  it("choosePath returns the dialog's file path or null on cancel", async () => {
    makeBackend();
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/tmp/picked.zip" });
    expect(await invoke(CH.chooseDiagnosticsPath, "omp-ui-diagnostics.zip")).toBe("/tmp/picked.zip");
    const dialogOpts = showSaveDialog.mock.calls[0]![1] as { defaultPath: string };
    expect(dialogOpts.defaultPath).toBe("omp-ui-diagnostics.zip");
    showSaveDialog.mockResolvedValue({ canceled: true });
    expect(await invoke(CH.chooseDiagnosticsPath, "")).toBeNull();
  });

  it("records breadcrumbs that reach the bundle's logs", async () => {
    makeBackend();
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
