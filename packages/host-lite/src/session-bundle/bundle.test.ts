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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
      modelProviderReady(projectCwd: string): boolean;
      killAll(): void;
    };
    routines: {
      state(): Record<string, unknown>;
    };
    routinesControl: {
      state(): Record<string, unknown>;
      enable(caps?: { warnUsd?: number; maxUsd?: number }): Promise<Record<string, unknown>>;
      disable(): Promise<Record<string, unknown>>;
      setSpendDefaults(caps: { warnUsd?: number; maxUsd?: number }): Promise<Record<string, unknown>>;
    };
    state(): Promise<
      Record<string, unknown> & { projects: Array<{ project: { name: string }; sessions: unknown[] }> }
    >;
    on(cb: (channel: string, args: unknown[]) => void): () => void;
    dispose(): Promise<void>;
  };
  CH: Record<string, string>;
  Registry: {
    load(file: string): {
      setSetting(key: string, value: unknown): void;
      getSetting(key: string): unknown;
      sessions: Array<Record<string, unknown>>;
    } & Record<string, never>;
  };
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
        "claimFirstTitle",
        "answerPlanReview",
        "toggleFavorite",
      ]) {
        expect(lite.handlers[CH[ch] as string], ch).toBeTypeOf("function");
      }
      for (const ch of ["rpcSend", "ptyWrite", "ptyResize", "shellSpawn", "shellWrite", "shellKill"]) {
        const target = lite.notify[CH[ch] as string] ?? lite.handlers[CH[ch] as string];
        expect(target, ch).toBeTypeOf("function");
      }

      // The first-title claim (issue #1090) is the REAL manager's arbiter,
      // not a stub: a joined renderer of a host-lite-owned session races here
      // and gets the one-winner semantics — untitled tab grants once, then
      // denies; a tab this host never owned is refused outright.
      const claim = lite.handlers[CH.claimFirstTitle as string] as (tabId: string) => boolean;
      expect(claim("tab-1")).toBe(true);
      expect(claim("tab-1")).toBe(false);
      expect(claim("tab-gone")).toBe(false);

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

  it("enforces timed snooze deadlines via SnoozeClock, stamps reminderAtMs, and clears snooze on Pin (#1323)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-snooze-"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { deps } = fakeDeps(bundle, base);
      const lite = bundle.createSessionBundle(deps);
      const setSnoozed = lite.handlers[bundle.CH.setSessionSnoozed] as (
        tabId: string,
        snoozed: boolean,
        untilMs?: number | null,
      ) => void;
      const setPinned = lite.handlers[bundle.CH.setSessionPinned] as (tabId: string, pinned: boolean) => void;

      // Timed snooze wakes via SnoozeClock at deadline and stamps reminderAtMs.
      setSnoozed("tab-1", true, Date.now() + 5_000);
      let state = await lite.state();
      let [summary] = state.projects[0]?.sessions as Array<Record<string, unknown>>;
      expect(summary.snoozed).toBe(true);
      expect(summary.settledAtMs).toBeNull();
      expect(summary.reminderAtMs).toBeNull();

      await vi.advanceTimersByTimeAsync(5_001);
      state = await lite.state();
      [summary] = state.projects[0]?.sessions as Array<Record<string, unknown>>;
      expect(summary.snoozed).toBe(false);
      expect(summary.snoozedUntilMs).toBeNull();
      expect(typeof summary.reminderAtMs).toBe("number");

      // Pinning a snoozed row clears snooze so latest gesture wins.
      setSnoozed("tab-1", true, null);
      setPinned("tab-1", true);
      state = await lite.state();
      [summary] = state.projects[0]?.sessions as Array<Record<string, unknown>>;
      expect(summary.snoozed).toBe(false);
      expect(typeof summary.pinnedAtMs).toBe("number");

      await lite.dispose();
    } finally {
      vi.useRealTimers();
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

  it("registers the 8 routines:* channels, models:readChat, and plan:read, while keeping settings:setRoutines* absent (#1368)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-routines-ch-"));
    try {
      const { deps, registry } = fakeDeps(bundle, base);
      const lite = bundle.createSessionBundle(deps);
      const CH = bundle.CH;

      for (const ch of [
        "getRoutinesState",
        "createRoutine",
        "updateRoutine",
        "removeRoutine",
        "runRoutineNow",
        "testRoutineScript",
        "dryRunRoutine",
        "listRoutineToolCatalog",
        "readChatModels",
        "readPlanFile",
      ]) {
        expect(lite.handlers[CH[ch] as string], ch).toBeTypeOf("function");
      }

      // Host-local settings setters MUST stay absent from the public channel table.
      expect(lite.handlers[CH.setRoutinesEnabled as string]).toBeUndefined();
      expect(lite.handlers[CH.setRoutineSpendDefaults as string]).toBeUndefined();

      // artifactLibraryEnabled stays pinned false even if persisted true in registry.
      registry.setSetting("artifactLibraryEnabled", true);
      const st = await lite.state();
      expect(st.artifactLibraryEnabled).toBe(false);

      // Gate-off refuses routines:create with ROUTINES_DISABLED_ERROR.
      const createRoutine = lite.handlers[CH.createRoutine as string] as (input: unknown) => Promise<unknown>;
      await expect(
        createRoutine(sampleRoutineInput(path.join(base, "proj"))),
      ).rejects.toThrow("Routines is disabled in Settings → Routines");

      await lite.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("enforces headless boundaries: vaults disabled, artifact refresh refused, OAuth/models.yml providerReady, and atomic enable caps (#1368)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-routines-bounds-"));
    try {
      const projectCwd = path.join(base, "proj");
      const { deps, registry } = fakeDeps(bundle, base);
      // Populate vaultRegistry to prove Host Lite still withholds vault tools uniformly.
      registry.setSetting("vaultRegistry", {
        vaults: [{ name: "Vault", rootPath: path.join(base, "vault"), homeFolder: "omp-ui" }],
        defaultVault: "Vault",
      });
      // Empty providerKeys + OAuth / models.yml override proves headless providerReady works without API key env vars.
      const cipher = {
        available: true,
        backend: "test",
        encrypt: (plain: string) => Buffer.from(plain),
        decrypt: (blob: Buffer) => blob.toString("utf8"),
      };
      deps.providerKeys = new bundle.ProviderKeys(path.join(base, "empty-keys.json"), cipher, {});
      deps.hasOAuthProvider = () => true;
      deps.hasConfiguredModelsFileProvider = () => false;

      const lite = bundle.createSessionBundle(deps);
      expect(lite.sessions.modelProviderReady(projectCwd)).toBe(true);

      // Enable atomically with spend caps via routinesControl.
      const enabled = await lite.routinesControl.enable({ warnUsd: 1.25, maxUsd: 3.5 });
      expect(enabled.enabled).toBe(true);
      expect(enabled.defaultWarnCostUsd).toBe(1.25);
      expect(enabled.defaultMaxCostUsd).toBe(3.5);

      // Vault tools stay absent from catalog even with vaultRegistry populated.
      const listCatalog = lite.handlers[bundle.CH.listRoutineToolCatalog as string] as (
        cwd: string,
      ) => Promise<{ tools: Array<{ key: string }> }>;
      const cat = await listCatalog(projectCwd);
      expect(cat.tools.some((t) => t.key.startsWith("omp-ui_vault_"))).toBe(false);

      // Artifact-bound routine refuses runNow with "The artifact library is disabled" and records artifact-missing.
      const createRoutine = lite.handlers[bundle.CH.createRoutine as string] as (
        input: unknown,
      ) => Promise<{ id: string }>;
      const runNow = lite.handlers[bundle.CH.runRoutineNow as string] as (id: string) => Promise<unknown>;
      const getRoutinesState = lite.handlers[bundle.CH.getRoutinesState as string] as () => {
        runs: Array<{ outcome: string; reasonCode: string | null; tabId: string | null }>;
      };
      const created = await createRoutine(
        sampleRoutineInput(projectCwd, {
          name: "Artifact refresher",
          artifact: {
            artifactId: "0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b",
            datasetIds: ["rows"],
            autoApply: false,
          },
        }),
      );
      await expect(runNow(created.id)).rejects.toThrow("The artifact library is disabled");
      expect(getRoutinesState().runs[0]).toMatchObject({
        outcome: "failed",
        reasonCode: "artifact-missing",
        tabId: null,
      });

      await lite.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("fires routines end-to-end against a fake omp (runNow, pinned model, Plan-mode md + plan:read, overdue clock fire with atomic caps, and restart recovery) (#1368)", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-routines-e2e-"));
    try {
      const projectCwd = path.join(base, "proj");
      const fakeOmp = writeFakeOmpScript(base);
      const catalogSnapshot = {
        tools: [
          { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Read" },
          { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Bash" },
        ],
        staleServers: [],
        enumerationError: null,
        capturedAt: new Date().toISOString(),
      };
      const chatModelsSnapshot = {
        models: [
          {
            provider: "openrouter",
            id: "google/gemini-4-neon",
            name: "Gemini 4 Neon",
            thinking: { efforts: ["low", "medium", "high"] },
          },
        ],
        discovered: true,
        error: null,
      };

      const { deps, registry } = fakeDeps(bundle, base);
      deps.getOmpPath = () => fakeOmp;
      deps.routineCatalog = { list: async () => catalogSnapshot };
      deps.readChatModels = async () => chatModelsSnapshot;
      // Even if user registry says "html", Host Lite pins planFormatOverride: "md".
      registry.setSetting("planFormat", "html");

      const lite = bundle.createSessionBundle(deps);
      const CH = bundle.CH;
      const waiters: Array<() => void> = [];
      lite.on(() => {
        for (const fn of waiters.splice(0)) fn();
      });
      const waitForEvent = (predicate: () => boolean): Promise<void> => {
        if (predicate()) return Promise.resolve();
        const deferred = Promise.withResolvers<void>();
        const check = (): void => {
          if (predicate()) deferred.resolve();
          else waiters.push(check);
        };
        waiters.push(check);
        return deferred.promise;
      };
      await lite.routinesControl.enable({ warnUsd: 1.5, maxUsd: 4.5 });
      const readChatModels = lite.handlers[CH.readChatModels as string] as () => Promise<{ models: unknown[] }>;
      expect((await readChatModels()).models).toHaveLength(1);

      const createRoutine = lite.handlers[CH.createRoutine as string] as (
        input: unknown,
      ) => Promise<{ id: string }>;
      const runNow = lite.handlers[CH.runRoutineNow as string] as (
        id: string,
      ) => Promise<{ tabId: string; runId: string }>;
      const getRoutinesState = lite.handlers[CH.getRoutinesState as string] as () => {
        routines: Array<{ id: string }>;
        runs: Array<{ id: string; outcome: string; tabId: string | null }>;
      };
      const readPlanFile = lite.handlers[CH.readPlanFile as string] as (
        tabId: string,
        absPath: string,
      ) => Promise<string | null>;

      // 1. Run now with pinned model + Plan mode: verifies private session, overlays,
      //    pinned model choice via readModelCatalog, Markdown plan format, plan:read confinement,
      //    and RoutineRunRow running -> on-time lifecycle transition.
      const planRoutine = await createRoutine(
        sampleRoutineInput(projectCwd, {
          name: "Plan triage",
          mode: "plan",
          model: "openrouter/google/gemini-4-neon",
          thinkingLevel: "medium",
          destination: { projectCwd, workspace: "checkout" },
        }),
      );
      const fired = await runNow(planRoutine.id);
      expect(fired.tabId).toBeTruthy();

      // Wait for fake omp to emit agent_start -> agent_end and finalize run row to on-time
      // via real routines:state sink events (no wall-clock polling).
      await waitForEvent(() => {
        const row = getRoutinesState().runs.find((r) => r.id === fired.runId);
        return row?.outcome === "on-time";
      });

      const rec = registry.sessions.find((s) => s.tabId === fired.tabId) as
        | {
            tabId: string;
            lineageDir: string;
            private: boolean;
            model: string | null;
            thinkingLevel: string | null;
            routine: { id: string; warnCostUsd: number; maxCostUsd: number } | null;
          }
        | undefined;
      expect(rec).toBeDefined();
      expect(rec!.private).toBe(true);
      expect(rec!.model).toBe("openrouter/google/gemini-4-neon");
      expect(rec!.thinkingLevel).toBe("medium");
      expect(rec!.routine).toMatchObject({ id: planRoutine.id, warnCostUsd: 1.5, maxCostUsd: 4.5 });

      // Verify Plan-mode Markdown proposal is readable via lineage-confined plan:read,
      // while paths outside the lineage dir are refused (null).
      const lineagePath = path.join(base, "sessions", rec!.lineageDir);
      const planFile = path.join(lineagePath, "proposal.md");
      fs.writeFileSync(planFile, "# Plan\n\n- step 1\n", "utf8");
      expect(await readPlanFile(fired.tabId, planFile)).toBe("# Plan\n\n- step 1\n");
      expect(await readPlanFile(fired.tabId, path.join(base, "registry.json"))).toBeNull();
      // Confirm the fake omp received planFormat "md" (not "html") in its initial plan command.
      const recordedCmds = fs.readFileSync(path.join(base, "fake-omp-cmds.log"), "utf8");
      expect(recordedCmds).toContain("md");
      expect(recordedCmds).not.toContain("format html");

      // 2. Overdue clock fire on atomic enable: disable, seed an overdue routine in routines.json,
      //    re-enable with tightened caps, and verify the due fire runs with the NEW caps.
      await lite.routinesControl.disable();
      const routinesJsonPath = path.join(base, "routines.json");
      const rawStore = JSON.parse(fs.readFileSync(routinesJsonPath, "utf8")) as {
        schemaVersion: number;
        routines: Array<Record<string, unknown>>;
      };
      rawStore.routines[0]!.nextRunAtMs = Date.now() - 5_000;
      fs.writeFileSync(routinesJsonPath, JSON.stringify(rawStore, null, 2));
      await lite.dispose();

      // Reboot with gate OFF: verifies persisted recovery (disabled restart settles dormant unsettled
      // routine runs and interrupts any running history rows without firing the overdue routine).
      const runsPath = path.join(base, "routine-runs.json");
      const rawRuns = JSON.parse(fs.readFileSync(runsPath, "utf8")) as {
        schemaVersion: number;
        runs: Array<Record<string, unknown>>;
      };
      rawRuns.runs.unshift({
        id: "pre-crash-run",
        routineId: planRoutine.id,
        routineName: "Plan triage",
        firedAtMs: Date.now() - 10_000,
        scheduledForMs: null,
        trigger: "clock",
        outcome: "running",
        tabId: "dead-tab",
        reasonCode: null,
        missed: 0,
        pruned: false,
        staleCatalog: false,
      });
      fs.writeFileSync(runsPath, JSON.stringify(rawRuns, null, 2));

      const reg2 = bundle.Registry.load(path.join(base, "registry.json"));
      const lite2 = bundle.createSessionBundle({
        ...deps,
        registry: reg2,
      });
      const stateAfterDisabledBoot = (lite2.handlers[CH.getRoutinesState as string] as () => {
        enabled: boolean;
        runs: Array<{ id: string; outcome: string; reasonCode: string | null }>;
      })();
      expect(stateAfterDisabledBoot.enabled).toBe(false);
      expect(stateAfterDisabledBoot.runs.find((r) => r.id === "pre-crash-run")).toMatchObject({
        outcome: "failed",
        reasonCode: "interrupted",
      });
      // Dormant unsettled routine run from first boot was stamped settled at boot.
      const settledRec = reg2.sessions.find((s) => s.tabId === fired.tabId) as { settledAtMs?: number | null } | undefined;
      expect(typeof settledRec?.settledAtMs).toBe("number");
      // Atomic enable with tightened caps arms the overdue routine immediately with the NEW caps.
      const dueSpawned = Promise.withResolvers<void>();
      const hasDueSession = (): boolean =>
        reg2.sessions.some(
          (s) => (s as { routine?: { id?: string } | null }).routine?.id === planRoutine.id && s.tabId !== fired.tabId,
        );
      lite2.on(() => {
        if (hasDueSession()) dueSpawned.resolve();
      });
      await lite2.routinesControl.enable({ warnUsd: 0.75, maxUsd: 2.25 });
      if (!hasDueSession()) await dueSpawned.promise;
      const dueRec = reg2.sessions.find(
        (s) => (s as { routine?: { id?: string } | null }).routine?.id === planRoutine.id && s.tabId !== fired.tabId,
      ) as { routine: { warnCostUsd: number; maxCostUsd: number } } | undefined;
      expect(dueRec?.routine).toMatchObject({ warnCostUsd: 0.75, maxCostUsd: 2.25 });

      await lite2.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

/** Fake deps copied from packages/desktop/src/main/session-manager.test.ts setup(): the same seams lite ships without a real omp or window. */
function fakeDeps(
  bundle: BundleExports,
  base: string,
): {
  deps: Record<string, unknown>;
  registry: {
    setSetting(key: string, value: unknown): void;
    getSetting(key: string): unknown;
    sessions: Array<Record<string, unknown>>;
  };
} {
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

function sampleRoutineInput(projectCwd: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Morning check",
    instructions: "Report build health.",
    schedule: { kind: "cron", expr: "0 8 * * *" },
    timeZone: "UTC",
    destination: { projectCwd, workspace: "checkout" },
    mode: "build",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: null },
    toolPolicy: { allow: ["read"], deny: ["bash"], lastReviewedAt: "2026-11-25T00:00:00.000Z", reviewedCatalog: ["read", "bash"] },
    scripts: { pre: "", post: "" },
    timeoutMinutes: null,
    notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    artifact: null,
    enabled: true,
    ...overrides,
  };
}

function writeFakeOmpScript(baseDir: string): string {
  const scriptPath = path.join(baseDir, "fake-omp.mjs");
  const logPath = path.join(baseDir, "fake-omp-cmds.log");
  fs.writeFileSync(
    scriptPath,
    `#!${process.execPath}
import * as fs from "node:fs";
import * as readline from "node:readline";
const logPath = ${JSON.stringify(logPath)};
if (process.argv[2] === "config") {
  process.stdout.write("{}\\n");
  process.exit(0);
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "ready" });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  fs.appendFileSync(logPath, line + "\\n");
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "set_host_tools" || msg.type === "set_event_filter" || msg.type === "set_ask_dialog" || msg.type === "set_host_uri_schemes") {
    emit({ type: "response", id: msg.id, command: msg.type, success: true });
    return;
  }
  if (msg.type === "prompt") {
    emit({ type: "response", id: msg.id, command: "prompt", success: true });
    if (typeof msg.id === "string" && msg.id.startsWith("omp-ui-fleet-prompt-")) {
      emit({ type: "agent_start" });
      emit({ type: "agent_end", messages: [{ role: "assistant", content: "Done." }] });
    }
  }
});
`,
    { mode: 0o755 },
  );
  return scriptPath;
}
