import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { resolveOmpBinary } from "./paths";
import {
  BASH_GIT_GUARD_KEY,
  execOmpConfigRunner,
  parseEnumOptions,
  readOmpCompactionMethods,
  readOmpGoalContinuationModes,
  readOmpSettings,
  readWebSearchProviders,
  resetOmpSetting,
  writeOmpSetting,
  OMP_MAX_CONCURRENCY_KEY,
  OMP_MODEL_ROLES_KEY,
  OMP_TELEMETRY_EXPORT_KEY,
  SHARE_SETTING_GROUP,
  PYTHON_INTERPRETER_KEY,
  pristineEnvironment,
  type OmpConfigRunner,
} from "./omp-settings";
import {
  COMPACTION_MODEL_THRESHOLD_SETTING_GROUP,
  CONTEXT_FILES_EXTRA_KEY,
  SESSION_MAX_COST_KEY,
  SESSION_WARN_COST_KEY,
  RESTRICTED_FOLDERS_KEY,
} from "./omp-settings-keys";

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

describe("readOmpGoalContinuationModes", () => {
  it("reads the effective project value through and rejects a malformed one", async () => {
    const read = (value: unknown) =>
      readOmpGoalContinuationModes(
        { ompPath: OMP, projectCwd: "/repo" },
        fakeRunner(
          { effective: { "goal.continuationModes": entry(value, "array") }, global: {}, pristine: {} },
          "/repo",
        ),
      );
    await expect(read(["interactive"])).resolves.toEqual(["interactive"]);
    await expect(read([])).resolves.toEqual([]);
    await expect(read("interactive")).rejects.toThrow("goal.continuationModes");
  });
});

describe("readOmpSettings", () => {

  it("forces plain output on every spawn (issue #812)", async () => {
    // The real execFile runner, with node standing in for omp: the child
    // prints what the environment it received carries. An inherited
    // FORCE_COLOR=1 in the caller's env must not survive into the spawn.
    const stdout = await execOmpConfigRunner(process.execPath)(
      [
        "-e",
        "process.stdout.write(JSON.stringify([process.env.NO_COLOR, process.env.FORCE_COLOR]))",
      ],
      { cwd: os.tmpdir(), env: { ...process.env, FORCE_COLOR: "1" } },
    );
    expect(JSON.parse(stdout)).toEqual(["1", "0"]);
  });
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

  it("emits the allowlisted task.maxConcurrency with omp's number schema", async () => {
    const schema = entry(32, "number", "Maximum number of subagents running concurrently");
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: "/repo" },
      fakeRunner(
        {
          effective: { [OMP_MAX_CONCURRENCY_KEY]: entry(8, "number", "Maximum number of subagents running concurrently") },
          global: { [OMP_MAX_CONCURRENCY_KEY]: schema },
          pristine: { [OMP_MAX_CONCURRENCY_KEY]: schema },
        },
        "/repo",
      ),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.entries.find((e) => e.key === OMP_MAX_CONCURRENCY_KEY)).toMatchObject({
      type: "number",
      description: "Maximum number of subagents running concurrently",
      value: 8,
      globalValue: 32,
      layer: "project",
    });
  });

  it("emits nothing for task.maxConcurrency on an omp that predates the key", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner({ global: {}, pristine: {} }, null),
    );
    expect(snapshot.entries.some((e) => e.key === OMP_MAX_CONCURRENCY_KEY)).toBe(false);
  });

  it("emits both spend caps as unset numbers when omp publishes them without a value (#952)", async () => {
    // omp 18.13 lists both keys as {type:"number", description:""} when unset.
    const unset = { type: "number", description: "" };
    const keys = { [SESSION_WARN_COST_KEY]: unset, [SESSION_MAX_COST_KEY]: unset };
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner({ global: keys, pristine: keys }, null),
    );
    expect(snapshot.error).toBeNull();
    for (const key of [SESSION_WARN_COST_KEY, SESSION_MAX_COST_KEY]) {
      const found = snapshot.entries.find((e) => e.key === key);
      expect(found).toMatchObject({ type: "number" });
      expect(found?.value).toBeUndefined();
    }
  });

  it("emits the allowlisted speech speed keys with omp's number schema (#836)", async () => {
    const schema = entry(1, "number", "Speaking rate");
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: { "speech.speed": schema, "tts.localSpeed": schema },
          pristine: { "speech.speed": schema, "tts.localSpeed": schema },
        },
        null,
      ),
    );
    expect(snapshot.error).toBeNull();
    for (const key of ["speech.speed", "tts.localSpeed"]) {
      expect(snapshot.entries.find((e) => e.key === key)).toMatchObject({
        type: "number",
        options: null,
        value: 1,
      });
    }
  });

  it("emits the allowlisted telemetry.otlpExportEnabled boolean", async () => {
    const schema = entry(true, "boolean", "Allow OMP to export traces, logs, and metrics using OTEL_* endpoints.");
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: { [OMP_TELEMETRY_EXPORT_KEY]: schema },
          pristine: { [OMP_TELEMETRY_EXPORT_KEY]: schema },
        },
        null,
      ),
    );
    expect(snapshot.error).toBeNull();
    expect(
      snapshot.entries.find((e) => e.key === OMP_TELEMETRY_EXPORT_KEY),
    ).toMatchObject({
      type: "boolean",
      value: true,
      layer: "default",
    });
  });

  it("emits the allowlisted share keys for the first-share dialog", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            "share.store": entry("blob", "enum", "Where /share uploads the encrypted session blob"),
            "share.serverUrl": entry("https://my.omp.sh/s", "string", "Share viewer/upload base"),
            "share.redactSecrets": entry(true, "boolean", "Run the secret obfuscator over /share snapshots"),
          },
          pristine: {},
        },
        null,
      ),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.entries.map((e) => e.key)).toEqual(SHARE_SETTING_GROUP.keys);
    expect(snapshot.entries.find((e) => e.key === "share.store")).toMatchObject({
      type: "enum",
      value: "blob",
      layer: "global",
    });
    expect(snapshot.entries.find((e) => e.key === "share.redactSecrets")).toMatchObject({
      type: "boolean",
      value: true,
      layer: "global",
    });
  });

  it("emits the python keys with omp's schema and scraped enum members", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            [PYTHON_INTERPRETER_KEY]: entry(
              "",
              "string",
              "Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
            ),
            "python.kernelMode": entry(
              "session",
              "enum",
              "Keep the IPython kernel alive across eval calls or start fresh each time",
            ),
          },
          pristine: {
            [PYTHON_INTERPRETER_KEY]: entry("", "string", ""),
            "python.kernelMode": entry("session", "enum", ""),
          },
          human: "python.kernelMode = session (session|per-call)",
        },
        null,
      ),
    );
    expect(snapshot.error).toBeNull();
    const python = snapshot.entries.filter((e) => e.key.startsWith("python."));
    expect(python.map((e) => e.key)).toEqual([PYTHON_INTERPRETER_KEY, "python.kernelMode"]);
    expect(python[0]).toMatchObject({
      type: "string",
      value: "",
      options: null,
      layer: "default",
    });
    expect(python[1]).toMatchObject({
      type: "enum",
      value: "session",
      options: ["session", "per-call"],
      layer: "default",
    });
  });

  it("emits the git guard key when the binary publishes it (#832)", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            [BASH_GIT_GUARD_KEY]: entry(
              false,
              "boolean",
              "Refuse git commands that discard or move shared work in the bash tool",
            ),
          },
          pristine: { [BASH_GIT_GUARD_KEY]: entry(false, "boolean", "") },
          human: "",
        },
        null,
      ),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.entries.find((e) => e.key === BASH_GIT_GUARD_KEY)).toMatchObject({
      type: "boolean",
      value: false,
      layer: "default",
    });
  });

  it("emits sharpshooter.minPromptLength and statusLine.segmentOptions when published (#887)", async () => {
    const prompt = entry(16, "number", "Minimum prompt length for extraction");
    const segments = entry({}, "record", "Status line segment options");
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            "sharpshooter.minPromptLength": prompt,
            "statusLine.segmentOptions": segments,
          },
          pristine: {
            "sharpshooter.minPromptLength": prompt,
            "statusLine.segmentOptions": segments,
          },
        },
        null,
      ),
    );
    expect(snapshot.error).toBeNull();
    expect(
      snapshot.entries.find((e) => e.key === "sharpshooter.minPromptLength"),
    ).toMatchObject({ type: "number", value: 16, options: null });
    expect(
      snapshot.entries.find((e) => e.key === "statusLine.segmentOptions"),
    ).toMatchObject({ type: "record", value: {}, options: null });
  });

  it("emits nothing for the #887 keys on an omp that predates them", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner({ global: {}, pristine: {} }, null),
    );
    expect(
      snapshot.entries.some((e) => e.key === "sharpshooter.minPromptLength"),
    ).toBe(false);
    expect(
      snapshot.entries.some((e) => e.key === "statusLine.segmentOptions"),
    ).toBe(false);
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

  it("parses enum members from colorized output (issue #812)", () => {
    // The real shape of a FORCE_COLOR=1 `omp config list` line: escapes wrap
    // the key and value, and a trailing ESC[22m sits after the closing paren
    // where LIST_LINE_RE's `\\s*$` would otherwise reject the line.
    const text =
      "\x1b[37mlive.voice\x1b[39m = \x1b[33msol\x1b[39m " +
      "\x1b[2m(arbor|breeze|cove|ember|juniper|maple|sol|spruce|vale)\x1b[22m";
    expect(parseEnumOptions(text, ["live.voice"])["live.voice"]).toEqual([
      "arbor",
      "breeze",
      "cove",
      "ember",
      "juniper",
      "maple",
      "sol",
      "spruce",
      "vale",
    ]);
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

  it("admits telemetry.otlpExportEnabled to the write boundary", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: OMP_TELEMETRY_EXPORT_KEY, value: false },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "telemetry.otlpExportEnabled",
      "false",
      "--json",
    ]);
  });

  it("admits bash.gitGuard to the write boundary (#832)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: BASH_GIT_GUARD_KEY, value: false },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", BASH_GIT_GUARD_KEY, "false", "--json"]);
  });

  it("admits advisor.continueSeverity to the write boundary (#882)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "advisor.continueSeverity", value: "blocker" },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "advisor.continueSeverity",
      "blocker",
      "--json",
    ]);
  });

  it("admits async.widgets to the write boundary (#954)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "async.widgets", value: false },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", "async.widgets", "false", "--json"]);
  });

  it("admits sharpshooter.minPromptLength and statusLine.segmentOptions to the write boundary (#887)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "sharpshooter.minPromptLength", value: 16 },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "sharpshooter.minPromptLength",
      "16",
      "--json",
    ]);
    await writeOmpSetting(
      {
        ompPath: OMP,
        key: "statusLine.segmentOptions",
        value: { pi: { showProfile: false } },
      },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "statusLine.segmentOptions",
      '{"pi":{"showProfile":false}}',
      "--json",
    ]);
    // The widened allowlist must still fail closed on strangers.
    const run = fakeRunner({ global: {}, pristine: {} }, null);
    await expect(
      writeOmpSetting(
        { ompPath: OMP, key: "statusLine.someFutureKey", value: true },
        run,
      ),
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

  it("allowlists live.voice for the realtime voice timbre (issue #802)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "live.voice", value: "juniper" },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", "live.voice", "juniper", "--json"]);
  });

  it("allowlists the speech speed keys (issue #836)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: "speech.speed", value: 1.5 },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", "speech.speed", "1.5", "--json"]);
    await writeOmpSetting(
      { ompPath: OMP, key: "tts.localSpeed", value: 0.5 },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", "tts.localSpeed", "0.5", "--json"]);
  });

  it("allowlists contextFiles.extra and serializes the array as JSON (issue #837)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: CONTEXT_FILES_EXTRA_KEY, value: ["AGENTS.local.md"] },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual([
      "config",
      "set",
      "contextFiles.extra",
      '["AGENTS.local.md"]',
      "--json",
    ]);
  });

  it("allowlists tools.restrictedFolders and serializes the array as JSON (issue #951)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: RESTRICTED_FOLDERS_KEY, value: ["~/secrets"] },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", "tools.restrictedFolders", '["~/secrets"]', "--json"]);
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

  it("allowlists task.maxConcurrency and puts the number in argv bare", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: OMP_MAX_CONCURRENCY_KEY, value: 8 },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", OMP_MAX_CONCURRENCY_KEY, "8", "--json"]);
  });

  it("puts a fractional spend cap in argv bare (#952)", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: SESSION_MAX_COST_KEY, value: 2.5 },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", SESSION_MAX_COST_KEY, "2.5", "--json"]);
  });

  it("writes the python.interpreter empty-string auto-detect sentinel verbatim", async () => {
    let seen: readonly string[] = [];
    await writeOmpSetting(
      { ompPath: OMP, key: PYTHON_INTERPRETER_KEY, value: "" },
      async (args) => {
        seen = args;
        return "";
      },
    );
    expect(seen).toEqual(["config", "set", PYTHON_INTERPRETER_KEY, "", "--json"]);
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

describe("resetOmpSetting", () => {
  it("refuses an unlisted key without invoking the runner", async () => {
    const run = fakeRunner({ global: {}, pristine: {} }, null);
    await expect(
      resetOmpSetting({ ompPath: OMP, key: "apiKeys.openai" }, run),
    ).rejects.toThrow(/refusing to reset unlisted omp setting: apiKeys\.openai/);
    expect(run.calls).toBe(0);
  });

  it("runs `omp config reset <key> --json`", async () => {
    let seen: readonly string[] = [];
    await resetOmpSetting({ ompPath: OMP, key: SESSION_MAX_COST_KEY }, async (args) => {
      seen = args;
      return "";
    });
    expect(seen).toEqual(["config", "reset", "session.maxCost", "--json"]);
  });

  it("propagates omp's stderr message unchanged", async () => {
    await expect(
      resetOmpSetting({ ompPath: OMP, key: SESSION_MAX_COST_KEY }, async () => {
        throw new Error("Unknown setting: session.maxCost");
      }),
    ).rejects.toThrow("Unknown setting: session.maxCost");
  });
});

describe("readWebSearchProviders", () => {
  /**
   * A trimmed `omp models --kind search --json` from v18.3.2 — the real
   * row shape minus the cost/context fields — plus the junk rows that
   * exercise the drop rules: wrong kind, wrong provider, non-string id,
   * and a duplicate.
   */
  const CATALOG_18_3_2 = JSON.stringify({
    models: [
      { provider: "web", kind: "search", id: "brave", selector: "web/brave", name: "Brave" },
      { provider: "web", kind: "search", id: "duckduckgo", selector: "web/duckduckgo", name: "DuckDuckGo" },
      { provider: "anthropic", kind: "chat", id: "claude", selector: "anthropic/claude", name: "Claude" },
      { provider: "web", kind: "search", id: "exa", selector: "web/exa", name: "Exa" },
      { provider: "local", kind: "search", id: "ollama-web", selector: "local/ollama-web", name: "Ollama web" },
      { provider: "web", kind: "search", id: 42, selector: "web/42", name: "Junk" },
      { provider: "web", kind: "search", id: "brave", selector: "web/brave", name: "Brave again" },
      { provider: "web", kind: "search", id: "perplexity", selector: "web/perplexity", name: "Perplexity" },
    ],
  });

  const FAILURE = {
    providers: [],
    discovered: false,
    error: "this omp did not publish a provider list",
  };

  interface Probe {
    calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[];
  }

  /**
   * A recording runner: `fakeRunner` routes on `--json`, which would send
   * this read's args down its config branch, so discovery records instead.
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

  it("reads the ids in catalog order, dropping rows that are not web/search", async () => {
    const run = probeRunner(() => Promise.resolve(CATALOG_18_3_2));
    expect(await readWebSearchProviders({ ompPath: OMP }, run)).toEqual({
      providers: ["brave", "duckduckgo", "exa", "perplexity"],
      discovered: true,
      error: null,
    });
  });

  it("probes under a replaced HOME, never a credential-carrying env", async () => {
    const run = probeRunner(() => Promise.resolve(CATALOG_18_3_2));
    await readWebSearchProviders({ ompPath: OMP }, run);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.args).toEqual(["models", "--kind", "search", "--json"]);
    expect(run.calls[0]?.env.HOME).not.toBe(process.env.HOME);
  });

  it("degrades to the synthetic reason, never omp's message, when the catalog read fails", async () => {
    const unparseable = await readWebSearchProviders(
      { ompPath: OMP },
      probeRunner(() => Promise.resolve("<html>not json</html>")),
    );
    expect(unparseable).toEqual(FAILURE);
    const rejected = await readWebSearchProviders(
      { ompPath: OMP },
      probeRunner(() =>
        Promise.reject(new Error("Error: command models not found\nUSAGE\n$ omp models")),
      ),
    );
    expect(rejected).toEqual(FAILURE);
  });

  it("spawns nothing without an omp binary", async () => {
    const run = probeRunner(() => Promise.resolve(CATALOG_18_3_2));
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

  it("carries contextFiles.extra in the settings snapshot (issue #837)", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            [CONTEXT_FILES_EXTRA_KEY]: entry(["AGENTS.local.md"], "array", ""),
          },
          pristine: { [CONTEXT_FILES_EXTRA_KEY]: entry([], "array", "") },
        },
        null,
      ),
    );
    expect(snapshot.entries.find((e) => e.key === CONTEXT_FILES_EXTRA_KEY)).toMatchObject({
      type: "array",
      value: ["AGENTS.local.md"],
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

  it("carries the compaction model-threshold keys in the settings snapshot", async () => {
    const snapshot = await readOmpSettings(
      { ompPath: OMP, projectCwd: null },
      fakeRunner(
        {
          global: {
            "compaction.modelThresholds": entry({ "anthropic/claude-sonnet-4-5": 400000 }, "record", ""),
            "compaction.modelThresholdsEnabled": entry(true, "boolean", ""),
          },
          pristine: {
            "compaction.modelThresholds": entry({}, "record", ""),
            "compaction.modelThresholdsEnabled": entry(true, "boolean", ""),
          },
        },
        null,
      ),
    );
    expect(snapshot.entries.find((e) => e.key === "compaction.modelThresholds")).toMatchObject({
      type: "record",
      value: { "anthropic/claude-sonnet-4-5": 400000 },
      layer: "global",
    });
    expect(
      snapshot.entries.find((e) => e.key === "compaction.modelThresholdsEnabled"),
    ).toMatchObject({ type: "boolean", value: true });
  });

  it("parity with the live omp binary — skipped when there is none", async () => {
    const ompPath = resolveOmpBinary();
    if (ompPath === null) return;
    const snapshot = await readOmpSettings({ ompPath, projectCwd: null });
    if (snapshot.error !== null) return;
    // The generation marker is checked against omp's designed listing, not
    // the snapshot: readOmpSettings emits only allowlisted keys, and
    // providers.webSearchTimeoutSeconds is deliberately not one of them.
    const listed = JSON.parse(
      await execOmpConfigRunner(ompPath)(["config", "list", "--json"], {
        cwd: os.tmpdir(),
        env: process.env,
      }),
    ) as Record<string, unknown>;
    expect(
      listed["providers.webSearchTimeoutSeconds"],
      "omp no longer publishes providers.webSearchTimeoutSeconds",
    ).toBeDefined();
    // The first-share dialog's effective read (issue #679).
    for (const key of SHARE_SETTING_GROUP.keys) {
      expect(listed[key], `omp no longer publishes ${key}`).toBeDefined();
    }
    // The HUD compaction notch's per-model keys (issue #831).
    for (const key of COMPACTION_MODEL_THRESHOLD_SETTING_GROUP.keys) {
      expect(listed[key], `omp no longer publishes ${key}`).toBeDefined();
    }
    const discovered = await readWebSearchProviders({ ompPath });
    expect(discovered.providers.length, "omp published no web-search provider catalog").toBeGreaterThan(0);
  }, 30_000);
});
