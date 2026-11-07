import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStatsSource } from "./stats-source";
import type { StatsSourceInfo } from "./types";

const directories: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stats-source-"));
  directories.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "neutral");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return { root, home, cwd };
}
function dotenv(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function expected(profile: string | null, databaseRoot: string, agentRoot: string): StatsSourceInfo {
  return {
    profile,
    databasePath: path.join(databaseRoot, "stats.db"),
    sessionsRoot: path.join(agentRoot, "sessions"),
    archiveRoot: path.join(agentRoot, "archive", "sessions"),
  };
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveStatsSource", () => {
  it("returns the intended default target before any database exists without mutating env", () => {
    const { home, cwd } = fixture();
    const env = { KEEP: "secret" };
    expect(resolveStatsSource({ env, cwd, home, platform: "linux" })).toEqual(
      expected(null, path.join(home, ".omp"), path.join(home, ".omp", "agent")),
    );
    expect(env).toEqual({ KEEP: "secret" });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it.each(["", "  ", "default", " default "])("canonical %j selects default over legacy named", (profile) => {
    const { home, cwd } = fixture();
    const env = { OMP_PROFILE: profile, PI_PROFILE: "work", PI_CODING_AGENT_DIR: path.join(home, ".omp", "profiles", "work", "agent") };
    expect(resolveStatsSource({ env, cwd, home, platform: "linux" })).toEqual(
      expected(null, path.join(home, ".omp"), path.join(home, ".omp", "agent")),
    );
  });

  it("normalizes a named profile, prefers canonical and ignores a custom agent", () => {
    const { home, cwd, root } = fixture();
    const source = resolveStatsSource({
      env: { OMP_PROFILE: " work ", PI_PROFILE: "other", PI_CODING_AGENT_DIR: path.join(root, "custom") },
      cwd, home, platform: "linux",
    });
    const config = path.join(home, ".omp", "profiles", "work");
    expect(source).toEqual(expected("work", config, path.join(config, "agent")));
  });

  it.each(["WORK", "work.", "con", "con.txt", "com0", "lpt9.bak", "../work", "a".repeat(65)])("rejects invalid profile %s instead of silently selecting default", (profile) => {
    const { home, cwd } = fixture();
    expect(() => resolveStatsSource({ env: { OMP_PROFILE: profile }, cwd, home })).toThrow("Invalid OMP profile");
  });

  it.each(["linux", "darwin"] as const)("uses only an existing selected XDG path on %s", (platform) => {
    const { home, cwd, root } = fixture();
    const xdg = path.join(root, "data");
    const env = { XDG_DATA_HOME: xdg };
    expect(resolveStatsSource({ env, cwd, home, platform }).databasePath).toBe(path.join(home, ".omp", "stats.db"));
    fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
    expect(resolveStatsSource({ env, cwd, home, platform })).toEqual(expected(null, path.join(xdg, "omp"), path.join(xdg, "omp")));
    const named = { ...env, OMP_PROFILE: "work" };
    const config = path.join(home, ".omp", "profiles", "work");
    expect(resolveStatsSource({ env: named, cwd, home, platform })).toEqual(expected("work", config, path.join(config, "agent")));
    fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), { recursive: true });
    expect(resolveStatsSource({ env: named, cwd, home, platform })).toEqual(expected("work", path.join(xdg, "omp", "profiles", "work"), path.join(xdg, "omp", "profiles", "work")));
  });

  it("matches OMP's existence gate even when the XDG app path is a regular file", () => {
    const { home, cwd, root } = fixture();
    const xdg = path.join(root, "data");
    fs.mkdirSync(xdg);
    fs.writeFileSync(path.join(xdg, "omp"), "");
    const options = { env: { XDG_DATA_HOME: xdg }, home, cwd, platform: "linux" as const };
    expect(resolveStatsSource(options).databasePath).toBe(path.join(xdg, "omp", "stats.db"));
  });

  it("custom agents suppress both XDG roots but do not relocate the database", () => {
    const { home, cwd, root } = fixture();
    const xdg = path.join(root, "data");
    fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
    const env = { XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: "relative-agent" };
    expect(resolveStatsSource({ env, home, cwd, platform: "linux" })).toEqual(
      expected(null, path.join(home, ".omp"), path.join(cwd, "relative-agent")),
    );
    env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent");
    expect(resolveStatsSource({ env, home, cwd, platform: "linux" })).toEqual(expected(null, path.join(xdg, "omp"), path.join(xdg, "omp")));
  });

  it("ignores inherited OMP directory aliases and state/cache XDG roots", () => {
    const { home, cwd, root } = fixture();
    fs.mkdirSync(path.join(root, "omp"));
    const env = { OMP_CONFIG_DIR: "not-used", OMP_CODING_AGENT_DIR: "not-used", XDG_STATE_HOME: root, XDG_CACHE_HOME: root };
    expect(resolveStatsSource({ env, home, cwd, platform: "linux" })).toEqual(expected(null, path.join(home, ".omp"), path.join(home, ".omp", "agent")));
  });

  it("uses native Windows paths, case-insensitive env lookup, and no XDG redirection", () => {
    expect(resolveStatsSource({
      env: { omp_profile: " work ", pi_config_dir: "custom", XDG_DATA_HOME: "D:\\data", PI_CODING_AGENT_DIR: "D:\\agent" },
      home: "C:\\Users\\alice", cwd: "C:\\Users\\alice", platform: "win32",
    })).toEqual({ profile: "work", databasePath: "C:\\Users\\alice\\custom\\profiles\\work\\stats.db", sessionsRoot: "C:\\Users\\alice\\custom\\profiles\\work\\agent\\sessions", archiveRoot: "C:\\Users\\alice\\custom\\profiles\\work\\agent\\archive\\sessions" });
  });

  it("merges captured dotenv files per key with truthiness and file-local OMP aliases", () => {
    const { home, cwd, root } = fixture();
    const originalAgent = path.join(home, ".omp", "agent");
    dotenv(path.join(home, ".env"), 'PI_CONFIG_DIR="home-config"\nPI_CODING_AGENT_DIR="home-agent"');
    dotenv(path.join(home, ".omp", ".env"), 'PI_CONFIG_DIR="config-config"\nPI_CODING_AGENT_DIR="config-agent"');
    dotenv(path.join(originalAgent, ".env"), 'PI_CONFIG_DIR="agent-config"\nPI_CODING_AGENT_DIR="agent-agent"');
    dotenv(path.join(cwd, ".env"), 'export OMP_CONFIG_DIR="project-config" # comment\nPI_CONFIG_DIR="loses-to-alias"\nPI_CODING_AGENT_DIR=""\nOMP_PROFILE="work"\nAPI_KEY="secret"');
    const source = resolveStatsSource({ env: { PI_CONFIG_DIR: "" }, cwd, home, platform: "linux" });
    expect(source).toEqual(expected(null, path.join(home, "project-config"), path.join(cwd, "agent-agent")));
    expect(JSON.stringify(source)).not.toContain("secret");
    // A relocated dotenv is never read in a second pass.
    dotenv(path.join(home, "project-config", ".env"), `PI_CODING_AGENT_DIR="${path.join(root, "wrong")}"`);
    expect(resolveStatsSource({ env: {}, cwd, home, platform: "linux" })).toEqual(source);
  });

  it("lets nonempty inherited PI independently block a dotenv OMP alias", () => {
    const { home, cwd } = fixture();
    dotenv(path.join(cwd, ".env"), 'OMP_CONFIG_DIR="dotenv"\nPI_CONFIG_DIR="explicit-pi"');
    expect(resolveStatsSource({ env: { PI_CONFIG_DIR: "inherited" }, home, cwd, platform: "linux" }).databasePath).toBe(path.join(home, "inherited", "stats.db"));
  });

  it("refreshes named XDG data from the original profile agent dotenv without reselecting profile", () => {
    const { home, cwd, root } = fixture();
    const xdg = path.join(root, "data");
    fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), { recursive: true });
    dotenv(path.join(home, ".omp", "profiles", "work", "agent", ".env"), `XDG_DATA_HOME="${xdg}"\nOMP_PROFILE="other"`);
    dotenv(path.join(home, ".omp", ".env"), 'PI_CONFIG_DIR="not-loaded"');
    expect(resolveStatsSource({ env: { OMP_PROFILE: "work" }, home, cwd, platform: "linux" })).toEqual(expected("work", path.join(xdg, "omp", "profiles", "work"), path.join(xdg, "omp", "profiles", "work")));
  });

  it("uses parseEnv quoting/multiline grammar without expansion and ignores NUL values", () => {
    const { home, cwd } = fixture();
    dotenv(path.join(cwd, ".env"), 'OMP_CONFIG_DIR="literal-$HOME"\nPI_CODING_AGENT_DIR="line\none"\nXDG_DATA_HOME="bad\0value"');
    expect(resolveStatsSource({ env: {}, home, cwd, platform: "linux" })).toEqual(expected(null, path.join(home, "literal-$HOME"), path.join(cwd, "line\none")));
  });

  it("scrubs invalid inherited directory values only after initial dotenv capture", () => {
    const { home, cwd } = fixture();
    dotenv(path.join(home, ".omp", ".env"), 'PI_CONFIG_DIR="must-not-load"');
    const source = resolveStatsSource({ env: { PI_CONFIG_DIR: "bad\0config" }, home, cwd, platform: "linux" });
    expect(source).toEqual(expected(null, path.join(home, ".omp"), path.join(home, ".omp", "agent")));
  });
});
