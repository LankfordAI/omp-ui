import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpServers, setMcpServerEnabled } from "./mcp-config";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mcp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/**
 * A fully isolated discovery root set: HOME, XDG, and the agent dir all point
 * into tmp dirs so no real machine config can leak into a result.
 */
function fixture(): { env: NodeJS.ProcessEnv; home: string; agent: string; project: string } {
  const home = tmpDir();
  const xdg = tmpDir();
  const agent = tmpDir();
  const project = tmpDir();
  return {
    env: { HOME: home, XDG_CONFIG_HOME: xdg, PI_CODING_AGENT_DIR: agent },
    home,
    agent,
    project,
  };
}

describe("resolveMcpServers", () => {
  it("lets project native shadow user native, listing both rows", async () => {
    const { env, agent, project } = fixture();
    writeJson(path.join(project, ".omp", "mcp.json"), {
      mcpServers: { ctx: { command: "project-bin" } },
    });
    writeJson(path.join(agent, "mcp.json"), {
      mcpServers: { ctx: { command: "user-bin" } },
    });
    const { servers, errors } = await resolveMcpServers(project, env);
    expect(errors).toEqual([]);
    const rows = servers.filter((s) => s.name === "ctx");
    expect(rows).toHaveLength(2);
    const [winner, loser] = rows;
    expect(winner).toMatchObject({
      effective: true,
      scope: "project",
      source: "native",
      endpoint: "project-bin",
      state: "enabled",
      writable: true,
    });
    expect(loser).toMatchObject({
      effective: false,
      scope: "user",
      endpoint: "user-bin",
      shadowedBy: `native:${path.join(project, ".omp", "mcp.json")}`,
    });
  });

  it("lets a native entry win over a same-named tool-owned entry", async () => {
    const { env, home, project } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: { brave: { url: "https://cursor.example/mcp" } },
    });
    writeJson(path.join(project, ".omp", "mcp.json"), {
      mcpServers: { brave: { command: "native-bin", args: ["--flag"] } },
    });
    const { servers } = await resolveMcpServers(project, env);
    const rows = servers.filter((s) => s.name === "brave");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      effective: true,
      source: "native",
      transport: "stdio",
      endpoint: "native-bin --flag",
    });
    expect(rows[1]).toMatchObject({
      effective: false,
      source: "cursor",
      transport: "http",
      writable: false,
    });
  });

  it("applies the denylist, the allowlist override, and denylist-beats-allowlist", async () => {
    const { env, home, agent, project } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        denied: { command: "a" },
        forced: { command: "b", enabled: false },
        both: { command: "c", enabled: false },
        plainOff: { command: "d", enabled: false },
      },
    });
    writeJson(path.join(agent, "mcp.json"), {
      disabledServers: ["denied", "both"],
      enabledServers: ["forced", "both"],
    });
    const { servers } = await resolveMcpServers(project, env);
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect(byName.get("denied")).toMatchObject({ state: "disabled", disabledBy: "denylist" });
    // The allowlist force-enables a source's `enabled: false`…
    expect(byName.get("forced")!.state).toBe("enabled");
    expect(byName.get("forced")!.disabledBy).toBeUndefined();
    // …but never overrides the denylist.
    expect(byName.get("both")).toMatchObject({ state: "disabled", disabledBy: "denylist" });
    expect(byName.get("plainOff")).toMatchObject({ state: "disabled", disabledBy: "config" });
  });

  it("reports a malformed file in errors and keeps the other providers", async () => {
    const { env, home, project } = fixture();
    const bad = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, "{ not json,");
    writeJson(path.join(project, ".omp", "mcp.json"), {
      mcpServers: { ok: { command: "ok-bin" } },
    });
    const { servers, errors } = await resolveMcpServers(project, env);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(bad);
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
  });

  it("never leaks env, headers, or URL credentials into the DTO", async () => {
    const { env, home, project } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        secretive: {
          command: "run",
          args: ["--token", "arg-secret"],
          env: { API_KEY: "env-secret" },
        },
        remote: {
          type: "http",
          url: "https://user:url-secret@api.example.com/mcp?key=query-secret",
          headers: { Authorization: "Bearer header-secret" },
        },
      },
    });
    const result = await resolveMcpServers(project, env);
    const json = JSON.stringify(result);
    for (const secret of ["env-secret", "header-secret", "url-secret", "query-secret"]) {
      expect(json).not.toContain(secret);
    }
    const remote = result.servers.find((s) => s.name === "remote")!;
    expect(remote.endpoint).toBe("https://api.example.com/mcp");
    expect(remote.endpoint).not.toContain("?");
  });

  it("maps opencode's mcp shape onto stdio/http transports", async () => {
    const { env, project } = fixture();
    writeJson(path.join(project, "opencode.json"), {
      mcp: {
        local: {
          type: "local",
          command: ["bun", "run", "server.ts"],
          environment: { K: "opencode-env-secret" },
        },
        remote: { type: "remote", url: "https://oc.example/mcp" },
      },
    });
    const { servers } = await resolveMcpServers(project, env);
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect(byName.get("local")).toMatchObject({
      source: "opencode",
      transport: "stdio",
      endpoint: "bun run server.ts",
    });
    expect(JSON.stringify(byName.get("local"))).not.toContain("opencode-env-secret");
    expect(byName.get("remote")).toMatchObject({ transport: "http" });
  });

  it("reads claude's per-project map out of ~/.claude.json", async () => {
    const { env, home, project } = fixture();
    writeJson(path.join(home, ".claude.json"), {
      mcpServers: { global: { command: "g" } },
      projects: { [project]: { mcpServers: { perProject: { command: "p" } } } },
    });
    const { servers } = await resolveMcpServers(project, env);
    const names = servers.map((s) => s.name);
    expect(names).toContain("global");
    expect(names).toContain("perProject");
  });
});

describe("setMcpServerEnabled", () => {
  it("writes only the toggled entry back, preserving $schema and unrelated keys", async () => {
    const { env, project } = fixture();
    const file = path.join(project, ".omp", "mcp.json");
    writeJson(file, {
      $schema: "https://schema.example/mcp.json",
      mcpServers: {
        one: { command: "one-bin", env: { KEEP: "untouched" } },
        two: { command: "two-bin" },
      },
      otherRootKey: { nested: true },
    });
    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "one", sourcePath: file, enabled: false },
      env,
    );
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.$schema).toBe("https://schema.example/mcp.json");
    expect(written.otherRootKey).toEqual({ nested: true });
    expect(written.mcpServers.one).toEqual({ command: "one-bin", env: { KEEP: "untouched" }, enabled: false });
    expect(written.mcpServers.two).toEqual({ command: "two-bin" });
    // The resolved list comes back refreshed in the same round trip.
    expect(result.servers.find((s) => s.name === "one")).toMatchObject({
      state: "disabled",
      disabledBy: "config",
    });
  });

  it("routes a tool-owned server's toggle through the user denylist, never its file", async () => {
    const { env, home, agent, project } = fixture();
    const cursorFile = path.join(home, ".cursor", "mcp.json");
    writeJson(cursorFile, { mcpServers: { x: { command: "x-bin" } } });
    const before = fs.readFileSync(cursorFile, "utf8");

    const off = await setMcpServerEnabled({ projectCwd: project, name: "x", enabled: false }, env);
    const userFile = path.join(agent, "mcp.json");
    expect(JSON.parse(fs.readFileSync(userFile, "utf8")).disabledServers).toEqual(["x"]);
    expect(fs.readFileSync(cursorFile, "utf8")).toBe(before);
    expect(off.servers.find((s) => s.name === "x")).toMatchObject({
      state: "disabled",
      disabledBy: "denylist",
    });

    const on = await setMcpServerEnabled({ projectCwd: project, name: "x", enabled: true }, env);
    // An emptied denylist deletes the key rather than leaving [] behind.
    expect(JSON.parse(fs.readFileSync(userFile, "utf8"))).not.toHaveProperty("disabledServers");
    expect(fs.readFileSync(cursorFile, "utf8")).toBe(before);
    expect(on.servers.find((s) => s.name === "x")).toMatchObject({ state: "enabled" });
  });

  it("force-enables via the allowlist, then drops it once a writable source says on", async () => {
    const { env, home, agent, project } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: { x: { command: "x-bin", enabled: false } },
    });
    const userFile = path.join(agent, "mcp.json");

    await setMcpServerEnabled({ projectCwd: project, name: "x", enabled: true }, env);
    expect(JSON.parse(fs.readFileSync(userFile, "utf8")).enabledServers).toEqual(["x"]);

    // The same name now appears in a writable native file; enabling there
    // makes the allowlist override redundant, so it is dropped.
    const nativeFile = path.join(project, ".omp", "mcp.json");
    writeJson(nativeFile, { mcpServers: { x: { command: "x-bin" } } });
    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "x", sourcePath: nativeFile, enabled: true },
      env,
    );
    expect(JSON.parse(fs.readFileSync(userFile, "utf8"))).not.toHaveProperty("enabledServers");
    expect(JSON.parse(fs.readFileSync(nativeFile, "utf8")).mcpServers.x.enabled).toBe(true);
    expect(result.servers.find((s) => s.name === "x")).toMatchObject({ state: "enabled" });
  });

  it("clears a stale allowlist entry when disabling", async () => {
    const { env, home, agent, project } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: { x: { command: "x-bin", enabled: false } },
    });
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, { enabledServers: ["x"] });

    await setMcpServerEnabled({ projectCwd: project, name: "x", enabled: false }, env);
    const written = JSON.parse(fs.readFileSync(userFile, "utf8"));
    expect(written).not.toHaveProperty("enabledServers");
    expect(written.disabledServers).toEqual(["x"]);
  });
});
