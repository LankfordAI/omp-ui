import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_DEFAULT_SEED, seedMemoryDefaults } from "./memory-defaults";
import type { OmpConfigRunner } from "./omp-settings";

const OMP = "/x/omp";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-seedmem-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An agent dir holding `config` as config.yml; null leaves no file at all. */
function agentDir(config: string | null): NodeJS.ProcessEnv {
  const agent = path.join(tmpDir(), "agent");
  fs.mkdirSync(agent, { recursive: true });
  if (config !== null) fs.writeFileSync(path.join(agent, "config.yml"), config);
  return { PI_CODING_AGENT_DIR: agent };
}

/** Records every `config set` key in call order; `failOn` rejects that write. */
function fakeRunner(failOn?: string): OmpConfigRunner & { keys: string[] } {
  const keys: string[] = [];
  const run: OmpConfigRunner & { keys: string[] } = Object.assign(
    async (args: readonly string[]): Promise<string> => {
      if (args[0] === "config" && args[1] === "set") {
        const key = args[2]!;
        keys.push(key);
        if (failOn !== undefined && key === failOn) throw new Error(`Invalid value: ${key}`);
      }
      return "";
    },
    { keys },
  );
  return run;
}

describe("seedMemoryDefaults", () => {
  it("writes every seed key, sequentially in seed order, on an empty config", async () => {
    const run = fakeRunner();
    const done = await seedMemoryDefaults(OMP, { env: agentDir(null), run });
    expect(done).toBe(true);
    // Sequential: `omp config set` rewrites the whole YAML each call, so a
    // Promise.all would race; call order pins the contract.
    expect(run.keys).toEqual(MEMORY_DEFAULT_SEED.map((s) => s.key));
  });

  it("skips a key the config already names, whatever its value", async () => {
    // An explicit `memory.backend: off` is the user turning memory back off:
    // presence, not value equality, is the test, so it must survive.
    const run = fakeRunner();
    const done = await seedMemoryDefaults(
      OMP,
      { env: agentDir("memory:\n  backend: off\n"), run },
    );
    expect(done).toBe(true);
    expect(run.keys).toEqual(["mnemopi.scoping", "autolearn.enabled"]);
  });

  it("treats an unreadable config as absent and seeds anyway", async () => {
    // A directory where config.yml belongs: readFileSync throws EISDIR.
    const agent = path.join(tmpDir(), "agent");
    fs.mkdirSync(path.join(agent, "config.yml"), { recursive: true });
    const run = fakeRunner();
    const done = await seedMemoryDefaults(OMP, {
      env: { PI_CODING_AGENT_DIR: agent },
      run,
    });
    expect(done).toBe(true);
    expect(run.keys).toEqual(MEMORY_DEFAULT_SEED.map((s) => s.key));
  });

  it("resolves false without spawning anything when omp is missing", async () => {
    const run = fakeRunner();
    expect(await seedMemoryDefaults(null, { env: agentDir(null), run })).toBe(false);
    expect(run.keys).toEqual([]);
  });

  it("keeps writing after a failed key and reports the pass as failed", async () => {
    const run = fakeRunner("mnemopi.scoping");
    const done = await seedMemoryDefaults(OMP, { env: agentDir(null), run });
    // The failure must not abort the pass: every key is still attempted, and
    // the false return leaves the caller's marker unset for a retry next boot.
    expect(done).toBe(false);
    expect(run.keys).toEqual(MEMORY_DEFAULT_SEED.map((s) => s.key));
  });
});
