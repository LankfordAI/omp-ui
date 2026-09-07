import { describe, expect, it } from "vitest";
import { resolveOmpBinary } from "./paths";
import {
  parseEnumOptions,
  readOmpCompactionMethods,
  readOmpSettings,
  readWebSearchProviders,
  writeOmpSetting,
  OMP_MODEL_ROLES_KEY,
  pristineEnvironment,
  type OmpConfigRunner,
} from "./omp-settings";

const OMP = "/x/omp";

/** A `config list --json` entry, with omp's own field names. */
function entry(
  value: unknown,
  type = "boolean",
  description = "Advisor on",
): unknown {
  return { value, type, description };
}

interface Reads {
  /** Values in the project cwd — the effective read. Omit for "same as global". */
  effective?: Record<string, unknown>;
  global: Record<string, unknown>;
  pristine: Record<string, unknown>;
  /** Human `config list` text supplying enum members. */
  human?: string;
  /** Keys naming a read that must reject instead of resolving. */
  reject?: Partial<
    Record<"effective" | "global" | "pristine" | "human", string>
  >;
}

/**
 * A runner that never spawns. The two `--json` reads carrying process.env
 * differ only by cwd, so the effective read is identified by its cwd; the
 * pristine read is the one whose HOME was replaced.
 */
function fakeRunner(
  reads: Reads,
  projectCwd: string | null,
): OmpConfigRunner & { calls: number } {
  const run = async (
    args: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => {
    run.calls += 1;
    const which =
      args.includes("--json") === false
        ? "human"
        : opts.env.HOME !== process.env.HOME
          ? "pristine"
          : projectCwd !== null && opts.cwd === projectCwd
            ? "effective"
            : "global";
    const failure = reads.reject?.[which];
    if (failure !== undefined) throw new Error(failure);
    if (which === "human") return reads.human ?? "";
    if (which === "pristine") return JSON.stringify(reads.pristine);
    if (which === "effective")
      return JSON.stringify(reads.effective ?? reads.global);
    return JSON.stringify(reads.global);
  };
  run.calls = 0;
  return run;
}

describe("readOmpCompactionMethods", () => {
  it("uses pristine capability and preserves the effective configured subset", async () => {
    const methods = await readOmpCompactionMethods(
      { ompPath: OMP, projectCwd: "/repo" },
      fakeRunner(
        {
          effective: {
            "compaction.methodOrder": entry(["soft", "remote", "soft", "removed"]),
          },
          global: {},
          pristine: {
            "compaction.methodOrder": entry(["remote", "snapcompact", "soft"]),
          },
        },
        "/repo",
      ),
    );
    expect(methods).toEqual({
      supported: ["remote", "snapcompact", "soft"],
      configuredOrder: ["soft", "remote"],
    });
  });

  it("rejects malformed or missing method arrays", async () => {
    await expect(
      readOmpCompactionMethods(
        { ompPath: OMP, projectCwd: null },
        fakeRunner({ global: {}, pristine: {} }, null),
      ),
    ).rejects.toThrow("compaction.methodOrder");
  });
});

describe("readOmpSettings", () => {
  it("marks a value the project layer overrides as project", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: "/repo" },
      fakeRunner(
        {
          effective: { "advisor.enabled": entry(false) },
          global: { "advisor.enabled": entry(true) },
          pristine: { "advisor.enabled": entry(true) },
        },
        "/repo",
      ),
    );
    expect(snapshot.error).toBeNull();
    const found = snapshot.entries.find((e) => e.key === "advisor.enabled");
    expect(found).toMatchObject({
      value: false,
      layer: "project",
      type: "boolean",
    });
  });

  it("marks a value only the global config changes as global", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: "/repo" },
      fakeRunner(
        {
          effective: { "advisor.enabled": entry(false) },
          global: { "advisor.enabled": entry(false) },
          pristine: { "advisor.enabled": entry(true) },
        },
        "/repo",
      ),
    );
    expect(
      snapshot.entries.find((e) => e.key === "advisor.enabled"),
    ).toMatchObject({
      value: false,
      layer: "global",
    });
  });

  it("marks a value no layer touches as default", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: { "advisor.enabled": entry(true) },
          pristine: { "advisor.enabled": entry(true) },
        },
        null,
      ),
    );
    expect(
      snapshot.entries.find((e) => e.key === "advisor.enabled"),
    ).toMatchObject({
      value: true,
      layer: "default",
    });
  });

  it("resolves with omp's message and no entries when a value read fails", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: { "advisor.enabled": entry(true) },
          pristine: { "advisor.enabled": entry(true) },
          reject: { global: "omp: config unreadable" },
        },
        null,
      ),
    );
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.error).toBe("omp: config unreadable");
  });

  it("keeps every option null but stays non-fatal when the enum read fails", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            "advisor.syncBacklog": entry("off", "enum", "Backlog sync"),
          },
          pristine: {
            "advisor.syncBacklog": entry("off", "enum", "Backlog sync"),
          },
          reject: { human: "boom" },
        },
        null,
      ),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.entries.every((e) => e.options === null)).toBe(true);
  });

  it("reports a missing binary as a snapshot rather than throwing", async () => {
    const snapshot = await readOmpSettings({ ompPath: null, projectCwd: null });
    expect(snapshot).toEqual({
      entries: [],
      agentDir: null,
      projectConfigPath: null,
      error: "omp binary not found",
    });
  });

  it("skips keys omp does not publish and credentials it redacts", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            "advisor.enabled": entry(true),
            autoResume: {
              value: "x",
              type: "string",
              description: "",
              redacted: true,
            },
          },
          pristine: { "advisor.enabled": entry(true) },
        },
        null,
      ),
    );
    expect(snapshot.entries.map((e) => e.key)).toEqual(["advisor.enabled"]);
  });
});

describe("OpenRouter variant", () => {
  it("preserves omp's enum order and layer when the setting is published", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            "providers.openrouterVariant": entry(
              "nitro",
              "enum",
              "OpenRouter route",
            ),
          },
          pristine: {
            "providers.openrouterVariant": entry(
              "auto",
              "enum",
              "OpenRouter route",
            ),
          },
          human: "providers.openrouterVariant = nitro (auto|nitro|floor)",
        },
        null,
      ),
    );

    expect(
      snapshot.entries.find((e) => e.key === "providers.openrouterVariant"),
    ).toMatchObject({
      value: "nitro",
      options: ["auto", "nitro", "floor"],
      layer: "global",
    });
  });
});

it("isolates both Windows home variables from the real profile", () => {
  expect(
    pristineEnvironment(
      "C:\\Temp\\pristine",
      {
        HOME: "C:\\Users\\real",
        USERPROFILE: "C:\\Users\\real",
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\real",
        PATH: "C:\\Windows",
      },
      "win32",
    ),
  ).toEqual({
    HOME: "C:\\Temp\\pristine",
    USERPROFILE: "C:\\Temp\\pristine",
    PATH: "C:\\Windows",
  });
});

it("preserves Unix HOME-only isolation", () => {
  expect(
    pristineEnvironment(
      "/tmp/pristine",
      { HOME: "/home/real", USERPROFILE: "kept" },
      "linux",
    ),
  ).toEqual({ HOME: "/tmp/pristine", USERPROFILE: "kept" });
});

it.runIf(process.platform === "win32")(
  "runs the pristine config read under a temporary Windows profile",
  async () => {
    let pristineEnv: NodeJS.ProcessEnv | null = null;
    const run: OmpConfigRunner = async (args, opts) => {
      if (
        args.includes("--json") &&
        opts.env.USERPROFILE !== process.env.USERPROFILE
      ) {
        pristineEnv = opts.env;
      }
      return args.includes("--json") ? JSON.stringify({}) : "";
    };
    await readOmpSettings({ ompPath: OMP, projectCwd: null }, run);
    expect(pristineEnv).not.toBeNull();
    expect(pristineEnv!.USERPROFILE).toBe(pristineEnv!.HOME);
    expect(pristineEnv).not.toHaveProperty("HOMEDRIVE");
    expect(pristineEnv).not.toHaveProperty("HOMEPATH");
  },
);

describe("parseEnumOptions", () => {
  it("reads enum members and ignores type placeholders", () => {
    const text = [
      "advisor.syncBacklog = off (off|1|3|5)",
      "advisor.enabled = true (boolean)",
      "advisor.immuneTurns = 3 (number)",
      "unrelated.key = x (a|b)",
      "not a setting line",
    ].join("\n");
    const options = parseEnumOptions(text, [
      "advisor.syncBacklog",
      "advisor.enabled",
      "advisor.immuneTurns",
    ]);
    expect(options["advisor.syncBacklog"]).toEqual(["off", "1", "3", "5"]);
    expect(options["advisor.enabled"]).toBeNull();
    expect(options["advisor.immuneTurns"]).toBeNull();
    // Keys outside the request never appear, even when omp prints them.
    expect(Object.keys(options)).not.toContain("unrelated.key");
  });
});

describe("writeOmpSetting", () => {
  it("refuses an unlisted key without invoking the runner", async () => {
    const run = fakeRunner({ global: {}, pristine: {} }, null);
    await expect(
      writeOmpSetting(
        { ompPath: OMP, key: "apiKeys.openai", value: "secret" },
        run,
      ),
    ).rejects.toThrow(
      /refusing to write unlisted omp setting: apiKeys\.openai/,
    );
    expect(run.calls).toBe(0);
  });

  it("admits the capability mirror keys — and still refuses strangers", async () => {
    // The scope catalogs (issue #383) widened the boundary with the skills
    // and tool-gate keys; everything else must still fail closed.
    for (const key of ["skills.ignoredSkills", "skills.enablePiProject", "bash.enabled", "security.enabled"]) {
      const run = fakeRunner({ global: {}, pristine: {} }, null);
      await writeOmpSetting({ ompPath: OMP, key, value: true }, run);
      expect(run.calls).toBeGreaterThan(0);
    }
    const run = fakeRunner({ global: {}, pristine: {} }, null);
    await expect(
      writeOmpSetting({ ompPath: OMP, key: "skills.someFutureKey", value: true }, run),
    ).rejects.toThrow(/refusing to write unlisted omp setting/);
    expect(run.calls).toBe(0);
  });

  it("refuses a missing binary without invoking the runner", async () => {
    const run = fakeRunner({ global: {}, pristine: {} }, null);
    await expect(
      writeOmpSetting(
        { ompPath: null, key: "advisor.enabled", value: true },
        run,
      ),
    ).rejects.toThrow("omp binary not found");
    expect(run.calls).toBe(0);
  });

  it("sends modelRoles to omp as a JSON string", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      {
        ompPath: OMP,
        key: OMP_MODEL_ROLES_KEY,
        value: { advisor: "x/adv", tiny: "y/tiny" },
      },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "modelRoles",
      '{"advisor":"x/adv","tiny":"y/tiny"}',
      "--json",
    ]);
  });

  it("serializes booleans as omp's own literals", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "advisor.enabled", value: false },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen[3]).toBe("false");
  });

  it("allowlists and serializes the OpenRouter variant", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "providers.openrouterVariant", value: "nitro" },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "providers.openrouterVariant",
      "nitro",
      "--json",
    ]);
  });

  it("puts a negative number after `--` so omp's CLI does not read it as a flag (issue #105)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "providers.streamIdleTimeoutSeconds", value: -1 },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "providers.streamIdleTimeoutSeconds",
      "--json",
      "--",
      "-1",
    ]);
  });

  it("propagates omp's stderr message unchanged", async () => {
    await expect(
      writeOmpSetting(
        { ompPath: OMP, key: "advisor.syncBacklog", value: "nope" },
        async () => {
          throw new Error("Invalid value: nope. Valid values: off, 1, 3, 5");
        },
      ),
    ).rejects.toThrow("Invalid value: nope. Valid values: off, 1, 3, 5");
  });
});

describe("readWebSearchProviders", () => {
  /** omp 18.1.10's rejection of the probe sentinel. */
  const ENUM_STDERR =
    'error: Expected --provider to be one of: auto, exa, brave, duckduckgo; got "omp-ui-provider-probe"';

  interface Probe {
    calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[];
  }

  /**
   * A probe runner: `fakeRunner` routes on `--json`, which would send this
   * probe's args down its "human" branch, so discovery records instead.
   */
  function probeRunner(
    respond: () => Promise<string>,
  ): OmpConfigRunner & Probe {
    const calls: Probe["calls"] = [];
    const run = async (
      args: readonly string[],
      opts: { cwd: string; env: NodeJS.ProcessEnv },
    ): Promise<string> => {
      calls.push({ args, env: opts.env });
      return respond();
    };
    return Object.assign(run, { calls });
  }

  it("reads the ids omp lists when it rejects the sentinel", async () => {
    const run = probeRunner(() => Promise.reject(new Error(ENUM_STDERR)));
    expect(await readWebSearchProviders({ ompPath: OMP }, run)).toEqual({
      providers: ["exa", "brave", "duckduckgo"],
      discovered: true,
      error: null,
    });
  });

  it("probes with omp's own flag and an replaced HOME, never a credential-carrying env", async () => {
    const run = probeRunner(() => Promise.reject(new Error(ENUM_STDERR)));
    await readWebSearchProviders({ ompPath: OMP }, run);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.args).toEqual(["search", "--provider=omp-ui-provider-probe"]);
    expect(run.calls[0]?.env.HOME).not.toBe(process.env.HOME);
  });

  it("degrades to a short reason when omp accepts the sentinel", async () => {
    const run = probeRunner(() => Promise.resolve(""));
    const snapshot = await readWebSearchProviders({ ompPath: OMP }, run);
    expect(snapshot).toEqual({
      providers: [],
      discovered: false,
      error: "this omp did not publish a provider list",
    });
  });

  it("keeps omp's raw stderr out of the result when the probe fails for another reason", async () => {
    const run = probeRunner(() =>
      Promise.reject(new Error("Error: command search not found\nUSAGE\n$ omp search")),
    );
    const snapshot = await readWebSearchProviders({ ompPath: OMP }, run);
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.discovered).toBe(false);
    expect(snapshot.error).not.toContain("USAGE");
    expect(snapshot.error).not.toContain("command search not found");
  });

  it("spawns nothing without an omp binary", async () => {
    const run = probeRunner(() => Promise.reject(new Error(ENUM_STDERR)));
    expect(await readWebSearchProviders({ ompPath: null }, run)).toEqual({
      providers: [],
      discovered: false,
      error: "omp binary not found",
    });
    expect(run.calls).toEqual([]);
  });

  it("carries providers.webSearchOrder in the settings snapshot", async () => {
    const order = entry(["brave"], "array", "Prioritized providers for the web_search tool");
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: { "providers.webSearchOrder": order },
          pristine: { "providers.webSearchOrder": entry([], "array", "") },
        },
        null,
      ),
    );
    expect(snapshot.entries.find((e) => e.key === "providers.webSearchOrder")).toMatchObject({
      type: "array",
      description: "Prioritized providers for the web_search tool",
      value: ["brave"],
      layer: "global",
    });
  });

  it("drops the key when a fictional omp stops publishing it", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner({ global: { "advisor.enabled": entry(true) }, pristine: {} }, null),
    );
    expect(snapshot.entries.some((e) => e.key === "providers.webSearchOrder")).toBe(false);
  });

  it("parity with the live omp binary — skipped when there is none", async () => {
    const ompPath = resolveOmpBinary();
    if (ompPath === null) return;
    const snapshot = await readOmpSettings({ ompPath, projectCwd: null });
    if (snapshot.error !== null) return;
    const published = new Set(snapshot.entries.map((e) => e.key));
    for (const key of ["providers.webSearchOrder", "providers.webSearchExclude"]) {
      expect(published.has(key), `omp no longer publishes ${key}`).toBe(true);
    }
    const discovered = await readWebSearchProviders({ ompPath });
    expect(discovered.providers.length, "omp published no web-search provider list").toBeGreaterThan(0);
  }, 30_000);
});
