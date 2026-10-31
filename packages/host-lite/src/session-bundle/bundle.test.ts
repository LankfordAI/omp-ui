/**
 * The lite session bundle contract (issue #1010):
 * 1. scripts/bundle-session.mjs produces ONE loadable ESM bundle from the real
 *    desktop sources + shims; node-pty/ws/js-yaml stay external, electron is
 *    nowhere in the output.
 * 2. The bundle runs in plain Node: `createSessionBundle` builds the real
 *    SessionManager over fake deps (the same shape as desktop's
 *    session-manager.test.ts setup()), satisfies the seams.ts LiteSessions
 *    contract, `state()` projects the projects/modelFavorites-bearing
 *    BackendState, and the pane leaf that needs a window degrades through its
 *    shim instead of crashing.
 * 3. The drift gate: an `import "electron"` leaf added to the graph FAILS the
 *    build with the gate's named error — a future runtime-electron import
 *    reaching the session cluster can not ship silently inside lite.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileP = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const script = path.join(pkgRoot, "scripts/bundle-session.mjs");
const outDir = path.join(here, ".build");
const bundleFile = path.join(outDir, "session-bundle.mjs");
// Fixture builds use the CLI's outdir mode: entries keep their relative layout
// under .build (both entries live under src/session-bundle).
const paneLeafFile = path.join(outDir, "__fixtures__", "pane-leaf.js");
const driftFile = path.join(here, "__fixtures__/drift-leaf.ts");

/** Run the bundler CLI; resolves with combined output, rejects naming stderr. */
async function runScript(...args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [script, ...args], { cwd: pkgRoot });
    return `${stdout}${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`bundle-session failed: ${(e.stderr ?? "") + (e.stdout ?? "") || e.message}`, { cause: err });
  }
}

/** The bundle's export surface, per seams.ts LiteSessions plus the extras entry.ts adds. */
type BundleExports = {
  createSessionBundle(input: unknown): {
    /** seams.ts: flat partial RequestHandlers channel map. */
    handlers: Record<string, unknown>;
    /** additive seam field (src/seams.ts): flat partial notify map. */
    notify: Record<string, unknown>;
    sessions: {
      browserPaneEnsure(tabId: string): Promise<Record<string, unknown>>;
      /** Public desktop field (BrowserPaneHost); the shim-path proof drives it. */
      browserPanes: { ensure(tabId: string): Promise<Record<string, unknown>> };
      killAll(): void;
    };
    state(): Promise<
      Record<string, unknown> & { projects: Array<{ project: { name: string }; sessions: unknown[] }> }
    >;
    on(cb: (channel: string, args: unknown[]) => void): () => void;
    dispose(): Promise<void>;
  };
  CH: Record<string, string>;
  Registry: { load(file: string): { setSetting(key: string, value: unknown): void } & Record<string, never> };
  ProviderKeys: new (file: string, cipher: unknown, env: NodeJS.ProcessEnv) => unknown;
  SessionManager: unknown;
};

describe("session bundle", () => {
  let bundle!: BundleExports;

  beforeAll(async () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    // The CLI (the CI drift-gate command) builds the real graph into dist/ and
    // the pane-leaf fixture alongside; both runs must pass the gate.
    await runScript("--outfile", bundleFile);
    await runScript("--entry", path.join(here, "__fixtures__/pane-leaf.ts"), "--outfile", path.join(outDir, "x"));
    // Dynamic import: the artifact this loads is BUILT in beforeAll — no
    // static specifier can name a file that does not exist at compile time.
    bundle = (await import(bundleFile)) as BundleExports;
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("the built bundle is electron-free with node-pty kept external", async () => {
    await runScript("--outfile", bundleFile);
    const js = fs.readFileSync(bundleFile, "utf8");
    expect(js).not.toMatch(/from\s*["']electron["']/);
    expect(js).not.toMatch(/require\(\s*["']electron["']\s*\)/);
    // External node_modules leaves ride the app tree, not the bundle.
    expect(js).toMatch(/from\s*["']node-pty["']/);
    expect(js).toMatch(/from\s*["']ws["']/);
    // The workspace sources bundled IN (a plain-Node host can not load raw .ts).
    expect(js).not.toMatch(/from\s*["']@omp-ui\/core["']/);
  });

  it("state() projects the projects/modelFavorites-bearing BackendState core builds", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-bundle-"));
    try {
      const { deps, registry } = fakeDeps(bundle, base);
      registry.setSetting("modelFavorites", ["litellm/Model-X"]);
      registry.setSetting("defaultMode", "rpc-ui");
      const lite = bundle.createSessionBundle(deps);

      const state = await lite.state();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0]?.project.name).toBe("proj");
      // The owned session resolves to its transcript on disk: dormant (no
      // process), title hydrated from the session head, grouped under its project.
      const [summary] = state.projects[0]?.sessions as Array<Record<string, unknown>>;
      expect(summary.tabId).toBe("tab-1");
      expect(summary.live).toBe("dormant");
      expect(summary.title).toBe("Bundle proof");
      expect(state.chats).toEqual([]);
      expect(state.modelFavorites).toEqual(["litellm/Model-X"]);
      expect(state.defaultMode).toBe("rpc-ui");
      // Instance-only projections a join-only member never owns.
      expect(state.remoteInstances).toEqual([]);
      expect(state.fleetPending).toEqual([]);
      expect(state.fleetTerminals).toEqual([]);
      expect(state.spawnGate).toEqual({ model: null, advisorModel: null });
      // BackendState's omit-list: secrets/instance identity never ride state.
      expect(state).not.toHaveProperty("remoteToken");
      expect(state).not.toHaveProperty("remotePasswordHash");
      expect(state).not.toHaveProperty("instanceId");

      await lite.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("the session channel subset is present and the window-bound ones are absent", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-bundle-"));
    try {
      const { deps } = fakeDeps(bundle, base);
      const lite = bundle.createSessionBundle(deps);
      const CH = bundle.CH;

      // spawn / terminate(settle) / send(rpc+pty) / interrupt-shaped rails:
      // request channels on handlers, fire-and-forget rails on notify.
      for (const ch of [
        "getState",
        "spawnSession",
        "restartSession",
        "settleSession",
        "hibernatePlanSource",
        "switchMode",
        "forkSession",
        "deleteSession",
        "deleteSessionPreview",
        "sessionTranscriptPath",
        "answerPlanReview",
        "toggleFavorite",
      ]) {
        expect(lite.handlers[CH[ch] as string], ch).toBeTypeOf("function");
      }
      for (const ch of ["rpcSend", "ptyWrite", "ptyResize", "shellSpawn", "shellWrite", "shellKill"]) {
        const target = lite.notify[CH[ch] as string] ?? lite.handlers[CH[ch] as string];
        expect(target, ch).toBeTypeOf("function");
      }

      // Physically-impossible-without-a-window channels: absent, not denied.
      for (const ch of [
        "browserPaneEnsure",
        "browserPaneSubscribe",
        "browserPaneInput",
        "devicePaneEnsure",
        "devicePaneInput",
        "authPickBundleFile",
        "restartForAppUpdate",
        "checkAppUpdate",
        "openProject",
        "fleetTerminalWrite",
        "remoteInstanceNotify",
      ]) {
        expect(lite.handlers[CH[ch] as string]).toBeUndefined();
        expect(lite.notify[CH[ch] as string]).toBeUndefined();
      }
      await lite.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("on() carries broadcasts and dispose() unsubscribes; state rebuilds through the sink", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-bundle-"));
    try {
      const { deps } = fakeDeps(bundle, base);
      const lite = bundle.createSessionBundle(deps);
      const got: Array<{ channel: string; args: unknown[] }> = [];
      const off = lite.on((channel, args) => got.push({ channel, args }));

      // toggleFavorite is the bundle's own handler: it broadcasts. Start from
      // the empty seed so the toggle ADDS the favorite it then reports.
      await (lite.handlers[bundle.CH.toggleFavorite as string] as (key: string) => Promise<void>)(
        "litellm/Model-Y",
      );
      expect(got.length).toBeGreaterThanOrEqual(1);
      const [stateEvent] = got;
      expect(stateEvent?.channel).toBe(bundle.CH.onStateChanged);
      const state = stateEvent?.args[0] as { modelFavorites: string[] };
      expect(state.modelFavorites).toContain("litellm/Model-Y");

      off();
      const before = got.length;
      await (lite.handlers[bundle.CH.toggleFavorite as string] as (key: string) => Promise<void>)(
        "litellm/Model-Y",
      );
      expect(got.length).toBe(before);
      await lite.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("the pane leaf the bundle swapped degrades to unavailable — no Electron anywhere", async () => {
    // End-to-end through the SHIMMED desktop graph: BrowserPaneHost's default
    // factory dynamic-imports browser-pane-contents, which the gate redirected
    // to shims/browser-pane-contents.ts; its throwing factory lands on the
    // host's own create-failed error path.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-bundle-"));
    try {
      const { deps } = fakeDeps(bundle, base);
      const lite = bundle.createSessionBundle(deps);
      // Drive the pane host directly: same desktop code, bundle-loaded; the
      // swapped default factory (the shim) must degrade to create-failed.
      const ensured = await lite.sessions.browserPanes.ensure("tab-nope");
      expect(ensured).toEqual({ status: "unavailable", reason: "create-failed" });
      // And through a live-session-shaped rpc tab: without one, the real
      // desktop ladder answers not-live (no spawn runs in this suite).
      expect(await lite.sessions.browserPaneEnsure("tab-1")).toEqual({ status: "not-live" });
      await lite.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("a direct importer of the shimmed desktop file bundles onto the shim", async () => {
    // pane-leaf.ts imports browser-pane-contents BY PATH; the swap map must
    // redirect it (the build succeeds although that desktop file imports
    // electron) and the swapped exports behave as README documents.
    // Dynamic import (same reason as the bundle): pane-leaf.js is built output
    // of the beforeAll CLI run, absent at compile time.
    const leaf = (await import(paneLeafFile)) as unknown as {
      makeElectronPaneFactory(): (opts: never) => Promise<never>;
      clearBrowserPanePartition(): Promise<void>;
    };
    expect(typeof leaf.makeElectronPaneFactory).toBe("function");
    const factory = leaf.makeElectronPaneFactory();
    await expect(factory({} as never)).rejects.toThrow(/windowed host|headless/i);
    await expect(leaf.clearBrowserPanePartition()).resolves.toBeUndefined();
  });

  it(`DRIFT GATE: an import "electron" leaf in the graph fails the CLI build, naming itself`, async () => {
    expect(fs.existsSync(driftFile)).toBe(true);
    await expect(runScript("--entry", driftFile, "--outfile", path.join(outDir, "gate"))).rejects.toThrow(
      /electron-drift-gate/,
    );
  });
});

/** Fake deps copied from packages/desktop/src/main/session-manager.test.ts setup(): the same seams lite ships without a real omp or window. */
function fakeDeps(
  bundle: BundleExports,
  base: string,
): { deps: Record<string, unknown>; registry: { setSetting(key: string, value: unknown): void } } {
  const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
  const SESSION_ID = "01931d8a-6f7e-7000-8000-0000000000aa";
  const PROJECT = path.join(base, "proj");
  const sessionsRoot = path.join(base, "sessions");
  const archiveRoot = path.join(base, "archive", "sessions");
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(path.join(sessionsRoot, LINEAGE), { recursive: true });
  // One real transcript head so hydrate reads title/id (dormant → active → hydrated).
  fs.writeFileSync(
    path.join(sessionsRoot, LINEAGE, `2026-07-29T10-00-00-000Z_${SESSION_ID}.jsonl`),
    `${JSON.stringify({ type: "session", id: SESSION_ID, cwd: PROJECT, timestamp: "2026-07-29T10:00:00.000Z", title: "Bundle proof" })}\n`,
  );
  const registryFile = path.join(base, "registry.json");
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      schemaVersion: 1,
      settings: {},
      projects: [{ path: PROJECT, name: "proj", addedAt: "2026-07-29T00:00:00.000Z" }],
      sessions: [
        {
          tabId: "tab-1",
          sessionId: SESSION_ID,
          lineageDir: LINEAGE,
          projectCwd: PROJECT,
          launchedAt: "2026-07-29T10:00:00.000Z",
          mode: "rpc-ui",
          // Required-nullable in the registry guard: absence DROPS the record.
          cachedTitle: null,
          cachedModified: null,
        },
      ],
    }),
  );
  const registry = bundle.Registry.load(registryFile);
  const cipher = {
    available: true,
    backend: "test",
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (blob: Buffer) => blob.toString("utf8"),
  };
  return {
    registry,
    deps: {
      registry,
      registryFile,
      providerKeys: new bundle.ProviderKeys(path.join(base, "provider-keys.json"), cipher, {
        OPENROUTER_API_KEY: "test-key",
      }),
      getOmpPath: () => "/test/omp",
      collabCli: { exec: async () => ({ stdout: "", stderr: "stub", code: 1 }) },
      getSessionsRoot: () => sessionsRoot,
      getArchiveRoot: () => archiveRoot,
      getWorktreesRoot: () => path.join(base, "worktrees"),
      getChatsRoot: () => path.join(base, "chats"),
      // lite owns these two seams itself (entry.ts wraps the sinks); the fake
      // pair below would only apply if a caller tried to override them.
      send: () => {},
      broadcast: async () => {},
      breadcrumb: { record: () => {}, entries: () => [] },
      devicePane: {
        encodeJpeg: () => new Uint8Array(),
        agentDeviceBin: () => null,
        stateDir: () => path.join(base, "agent-device"),
      },
      // browserPane deliberately UNSET (optional seam): the pane host keeps
      // its default factory — the dynamic import the gate swapped for the
      // shim — so pane paths prove the swap end-to-end.
    },
  };
}
