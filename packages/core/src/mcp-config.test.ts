import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicWrite from "./atomic-write";
import { resolveMcpServers, setMcpServerEnabled } from "./mcp-config";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mcp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(byName.get("denied")!.enabledBy).toBeUndefined();
    // The allowlist force-enables a source's `enabled: false`, and that pin is
    // the only thing holding the row on — the flag the UI warns from.
    expect(byName.get("forced")!.state).toBe("enabled");
    expect(byName.get("forced")!.disabledBy).toBeUndefined();
    expect(byName.get("forced")!.enabledBy).toBe("allowlist");
    // …but never overrides the denylist.
    expect(byName.get("both")).toMatchObject({ state: "disabled", disabledBy: "denylist" });
    expect(byName.get("both")!.enabledBy).toBeUndefined();
    expect(byName.get("plainOff")).toMatchObject({ state: "disabled", disabledBy: "config" });
    expect(byName.get("plainOff")!.enabledBy).toBeUndefined();
  });

  it("leaves enabledBy unset when the allowlist pin is redundant", async () => {
    const { env, agent, project } = fixture();
    writeJson(path.join(agent, "mcp.json"), {
      mcpServers: { u: { command: "u" } },
      enabledServers: ["u"],
    });
    const { servers } = await resolveMcpServers(project, env);
    // The source never said `enabled: false`, so the pin changes nothing and
    // clearing it on a project disable costs other projects nothing either.
    expect(servers.find((s) => s.name === "u")).toMatchObject({ state: "enabled" });
    expect(servers.find((s) => s.name === "u")!.enabledBy).toBeUndefined();
  });

  it("reports how far a project disable of a pinned row reaches", async () => {
    const { env, home, agent, project } = fixture();
    // toolOwned's global winner is cursor's user file — omp-ui never writes
    // it, so dropping the pin is the only lever and it costs every project.
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: { toolOwned: { command: "t", enabled: false } },
    });
    // writable's winner is omp's own user file: the writer flips it on there
    // first, so only the toggling project loses the server (#326).
    writeJson(path.join(agent, "mcp.json"), {
      mcpServers: { writable: { command: "w", enabled: false }, plain: { command: "p" } },
      enabledServers: ["toolOwned", "writable"],
    });
    const { servers } = await resolveMcpServers(project, env);
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect(byName.get("toolOwned")).toMatchObject({
      enabledBy: "allowlist",
      disableReach: "global",
    });
    expect(byName.get("writable")).toMatchObject({
      enabledBy: "allowlist",
      disableReach: "project",
    });
    // The field is pinned-row-only: an unpinned row carries no reach.
    expect(byName.get("plain")!.disableReach).toBeUndefined();
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

  it("resolves user-scope sources only for null projectCwd", async () => {
    const { env, home, agent, project } = fixture();
    writeJson(path.join(project, ".omp", "mcp.json"), { mcpServers: { proj: { command: "p" } } });
    writeJson(path.join(agent, "mcp.json"), { mcpServers: { user: { command: "u" } } });
    writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { cur: { command: "c" } } });
    const { servers } = await resolveMcpServers(null, env);
    expect(servers.map((s) => s.name)).toEqual(["user", "cur"]);
    for (const s of servers) expect(s.scope).toBe("user");
  });

  it("skips claude's per-project map in global scope", async () => {
    const { env, home, project } = fixture();
    writeJson(path.join(home, ".claude.json"), {
      mcpServers: { global: { command: "g" } },
      projects: { [project]: { mcpServers: { perProject: { command: "p" } } } },
    });
    const { servers } = await resolveMcpServers(null, env);
    const names = servers.map((s) => s.name);
    expect(names).toContain("global");
    expect(names).not.toContain("perProject");
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

  it("force-enables via the allowlist, then drops it once a writable source says on", async () => {
    const { env, home, agent } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: { x: { command: "x-bin", enabled: false } },
    });
    const userFile = path.join(agent, "mcp.json");

    await setMcpServerEnabled({ projectCwd: null, name: "x", enabled: true }, env);
    expect(JSON.parse(fs.readFileSync(userFile, "utf8")).enabledServers).toEqual(["x"]);

    // The same name now appears in a writable native file; enabling there
    // makes the allowlist override redundant, so it is dropped.
    const nativeFile = path.join(agent, ".mcp.json");
    writeJson(nativeFile, { mcpServers: { x: { command: "x-bin" } } });
    const result = await setMcpServerEnabled(
      { projectCwd: null, name: "x", sourcePath: nativeFile, enabled: true },
      env,
    );
    expect(JSON.parse(fs.readFileSync(userFile, "utf8"))).not.toHaveProperty("enabledServers");
    expect(JSON.parse(fs.readFileSync(nativeFile, "utf8")).mcpServers.x.enabled).toBe(true);
    expect(result.servers.find((s) => s.name === "x")).toMatchObject({ state: "enabled" });
  });

  it("clears a stale allowlist entry when disabling", async () => {
    const { env, home, agent } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: { x: { command: "x-bin", enabled: false } },
    });
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, { enabledServers: ["x"] });

    await setMcpServerEnabled({ projectCwd: null, name: "x", enabled: false }, env);
    const written = JSON.parse(fs.readFileSync(userFile, "utf8"));
    expect(written).not.toHaveProperty("enabledServers");
    expect(written.disabledServers).toEqual(["x"]);
  });

  it("global toggle routes a tool-owned server through the user denylist", async () => {
    const { env, home, agent } = fixture();
    const cursorFile = path.join(home, ".cursor", "mcp.json");
    writeJson(cursorFile, { mcpServers: { x: { command: "x-bin" } } });
    const before = fs.readFileSync(cursorFile, "utf8");

    const off = await setMcpServerEnabled({ projectCwd: null, name: "x", enabled: false }, env);
    const userFile = path.join(agent, "mcp.json");
    expect(JSON.parse(fs.readFileSync(userFile, "utf8")).disabledServers).toEqual(["x"]);
    expect(fs.readFileSync(cursorFile, "utf8")).toBe(before);
    for (const s of off.servers) expect(s.scope).toBe("user");
    expect(off.servers.find((s) => s.name === "x")).toMatchObject({
      state: "disabled",
      disabledBy: "denylist",
    });
  });

  it("global toggle writes the user native file in place", async () => {
    const { env, agent } = fixture();
    const file = path.join(agent, "mcp.json");
    writeJson(file, { mcpServers: { u: { command: "u-bin" } } });
    const result = await setMcpServerEnabled(
      { projectCwd: null, name: "u", sourcePath: file, enabled: false },
      env,
    );
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.u.enabled).toBe(false);
    for (const s of result.servers) expect(s.scope).toBe("user");
    expect(result.servers.find((s) => s.name === "u")).toMatchObject({
      state: "disabled",
      disabledBy: "config",
    });
  });
});

describe("setMcpServerEnabled (project scope)", () => {
  it("disables a user-native server via a skeleton in the project override, leaving the user file alone", async () => {
    const { env, agent, project } = fixture();
    const otherProject = tmpDir();
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, { mcpServers: { ctx: { command: "user-bin", args: ["--x"] } } });
    const before = fs.readFileSync(userFile, "utf8");

    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "ctx", enabled: false },
      env,
    );

    const override = JSON.parse(
      fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8"),
    );
    // Secret-free suppression skeleton: no args copied.
    expect(override.mcpServers.ctx).toEqual({ command: "user-bin", enabled: false });
    expect(fs.readFileSync(userFile, "utf8")).toBe(before);

    expect(result.servers.find((s) => s.name === "ctx" && s.effective)).toMatchObject({
      state: "disabled",
      disabledBy: "config",
      scope: "project",
    });

    // The blast radius is this project only.
    const elsewhere = await resolveMcpServers(otherProject, env);
    expect(elsewhere.servers.find((s) => s.name === "ctx")).toMatchObject({ state: "enabled" });
  });

  it("writes a redacted http skeleton and never touches the user override lists", async () => {
    const { env, home, agent, project } = fixture();
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://user:url-secret@api.example.com/mcp?key=query-secret",
          headers: { Authorization: "Bearer header-secret" },
        },
      },
    });

    await setMcpServerEnabled({ projectCwd: project, name: "remote", enabled: false }, env);

    const overrideText = fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8");
    for (const secret of ["url-secret", "query-secret", "header-secret"]) {
      expect(overrideText).not.toContain(secret);
    }
    expect(JSON.parse(overrideText).mcpServers.remote).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      enabled: false,
    });
    // No user-level state of any kind was written.
    expect(fs.existsSync(path.join(agent, "mcp.json"))).toBe(false);
  });

  it("re-enabling deletes the skeleton and falls back to the source definition", async () => {
    const { env, agent, project } = fixture();
    writeJson(path.join(agent, "mcp.json"), { mcpServers: { ctx: { command: "user-bin" } } });
    const overrideFile = path.join(project, ".omp", "mcp.json");
    writeJson(overrideFile, {
      mcpServers: { keep: { command: "keep-bin" } },
      otherRootKey: { nested: true },
    });

    await setMcpServerEnabled({ projectCwd: project, name: "ctx", enabled: false }, env);
    expect(
      JSON.parse(fs.readFileSync(overrideFile, "utf8")).mcpServers.ctx,
    ).toEqual({ command: "user-bin", enabled: false });

    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "ctx", enabled: true },
      env,
    );
    const written = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
    expect(written.mcpServers).toEqual({ keep: { command: "keep-bin" } });
    expect(written.otherRootKey).toEqual({ nested: true });
    expect(result.servers.find((s) => s.name === "ctx" && s.effective)).toMatchObject({
      state: "enabled",
      scope: "user",
      source: "native",
    });
  });

  it("re-enabling a non-skeleton project entry flips it in place, preserving its keys", async () => {
    const { env, agent, project } = fixture();
    writeJson(path.join(agent, "mcp.json"), { mcpServers: { ctx: { command: "user-bin" } } });
    const overrideFile = path.join(project, ".omp", "mcp.json");
    writeJson(overrideFile, {
      mcpServers: {
        ctx: { command: "proj-bin", args: ["--p"], env: { K: "v" }, enabled: false },
      },
    });

    await setMcpServerEnabled({ projectCwd: project, name: "ctx", enabled: true }, env);
    expect(JSON.parse(fs.readFileSync(overrideFile, "utf8")).mcpServers.ctx).toEqual({
      command: "proj-bin",
      args: ["--p"],
      env: { K: "v" },
      enabled: true,
    });
  });

  it("flips a root mcp.json winner in place instead of writing a skeleton", async () => {
    const { env, project } = fixture();
    const rootFile = path.join(project, "mcp.json");
    writeJson(rootFile, { mcpServers: { ctx: { command: "root-bin" } } });

    await setMcpServerEnabled({ projectCwd: project, name: "ctx", enabled: false }, env);
    expect(JSON.parse(fs.readFileSync(rootFile, "utf8")).mcpServers.ctx.enabled).toBe(false);
    expect(fs.existsSync(path.join(project, ".omp", "mcp.json"))).toBe(false);
  });

  it("suppresses the real winner, not a shadowed project entry", async () => {
    const { env, agent, project } = fixture();
    writeJson(path.join(agent, "mcp.json"), { mcpServers: { ctx: { command: "user-bin" } } });
    const rootFile = path.join(project, "mcp.json");
    writeJson(rootFile, { mcpServers: { ctx: { command: "root-bin" } } });
    const rootBefore = fs.readFileSync(rootFile, "utf8");

    await setMcpServerEnabled({ projectCwd: project, name: "ctx", enabled: false }, env);
    expect(
      JSON.parse(fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8")).mcpServers.ctx,
    ).toEqual({ command: "user-bin", enabled: false });
    // The shadowed root entry must not be flipped (the old candidate-loop flaw).
    expect(fs.readFileSync(rootFile, "utf8")).toBe(rootBefore);
  });

  it("rejects enabling a denylisted server and leaves every file untouched", async () => {
    const { env, agent, project } = fixture();
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, {
      mcpServers: { ctx: { command: "user-bin" } },
      disabledServers: ["ctx"],
    });
    const before = fs.readFileSync(userFile, "utf8");

    await expect(
      setMcpServerEnabled({ projectCwd: project, name: "ctx", enabled: true }, env),
    ).rejects.toThrow(/denylist — enable it globally from Settings/);
    expect(fs.readFileSync(userFile, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(project, ".omp", "mcp.json"))).toBe(false);
  });

  it("rejects a project-scope enable of a source-disabled tool server", async () => {
    const { env, home, project } = fixture();
    const cursorFile = path.join(home, ".cursor", "mcp.json");
    writeJson(cursorFile, { mcpServers: { x: { command: "x-bin", enabled: false } } });
    const before = fs.readFileSync(cursorFile, "utf8");

    await expect(
      setMcpServerEnabled({ projectCwd: project, name: "x", enabled: true }, env),
    ).rejects.toThrow(/disabled in its source config/);
    expect(fs.readFileSync(cursorFile, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(project, ".omp", "mcp.json"))).toBe(false);
  });

  it("disables an allowlist-pinned server by clearing the pin, and keeps other projects on", async () => {
    const { env, agent, project } = fixture();
    const otherProject = tmpDir();
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, {
      mcpServers: { u: { command: "u" } },
      enabledServers: ["u"],
    });

    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "u", enabled: false },
      env,
    );

    // omp ignores `enabled: false` for any allowlisted name, so the pin has to
    // go for the project write to decide anything at all (#324).
    const userAfter = JSON.parse(fs.readFileSync(userFile, "utf8"));
    expect(userAfter.enabledServers).toBeUndefined();
    expect(userAfter.mcpServers).toEqual({ u: { command: "u" } });
    expect(
      JSON.parse(fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8")).mcpServers.u,
    ).toEqual({ command: "u", enabled: false });
    expect(result.servers.find((s) => s.name === "u" && s.effective)).toMatchObject({
      state: "disabled",
      disabledBy: "config",
      scope: "project",
    });

    // The pin was redundant here (the source never said off), so no other
    // project changes: the blast radius is this project only.
    const elsewhere = await resolveMcpServers(otherProject, env);
    expect(elsewhere.servers.find((s) => s.name === "u")).toMatchObject({ state: "enabled" });
  });

  it("clearing the pin keeps the denylist and every unrelated key intact", async () => {
    const { env, agent, project } = fixture();
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, {
      mcpServers: { u: { command: "u" }, other: { command: "o" } },
      disabledServers: ["gone"],
      enabledServers: ["keep", "u"],
      someOtherRootKey: { nested: true },
    });

    await setMcpServerEnabled({ projectCwd: project, name: "u", enabled: false }, env);

    const userAfter = JSON.parse(fs.readFileSync(userFile, "utf8"));
    expect(userAfter.enabledServers).toEqual(["keep"]);
    expect(userAfter.disabledServers).toEqual(["gone"]);
    expect(userAfter.someOtherRootKey).toEqual({ nested: true });
    expect(Object.keys(userAfter.mcpServers)).toEqual(["u", "other"]);
  });

  it("disables a load-bearing allowlist pin, flipping the tool row off everywhere", async () => {
    const { env, home, agent, project } = fixture();
    const otherProject = tmpDir();
    const cursorFile = path.join(home, ".cursor", "mcp.json");
    writeJson(cursorFile, {
      mcpServers: { x: { command: "x-bin", enabled: false } },
    });
    const cursorBefore = fs.readFileSync(cursorFile, "utf8");
    writeJson(path.join(agent, "mcp.json"), { enabledServers: ["x"] });

    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "x", enabled: false },
      env,
    );

    expect(result.servers.find((s) => s.name === "x" && s.effective)).toMatchObject({
      state: "disabled",
    });
    // A tool-owned winner offers no lever — omp-ui never mutates another
    // tool's config, so the file is byte-identical afterwards…
    expect(fs.readFileSync(cursorFile, "utf8")).toBe(cursorBefore);
    // …and the honest consequence, documented in setProjectServerEnabled and
    // surfaced as disableReach: "global", is that other projects go off too.
    const elsewhere = await resolveMcpServers(otherProject, env);
    expect(elsewhere.servers.find((s) => s.name === "x")).toMatchObject({
      state: "disabled",
      disabledBy: "config",
    });
  });

  it("flips a writable global winner on before dropping the pin, keeping other projects served", async () => {
    const { env, agent, project } = fixture();
    const otherProject = tmpDir();
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, {
      mcpServers: { u: { command: "u", enabled: false } },
      enabledServers: ["u"],
      someOtherRootKey: { nested: true },
    });

    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "u", enabled: false },
      env,
    );

    // The pin was load-bearing, but omp-ui may write its source: enabling it
    // there makes the pin redundant, so clearing it costs nobody (#326).
    const userAfter = JSON.parse(fs.readFileSync(userFile, "utf8"));
    expect(userAfter.mcpServers.u).toEqual({ command: "u", enabled: true });
    expect(userAfter.enabledServers).toBeUndefined();
    expect(userAfter.someOtherRootKey).toEqual({ nested: true });
    // This project is still decided inside itself, by a suppression entry.
    expect(
      JSON.parse(fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8")).mcpServers.u,
    ).toEqual({ command: "u", enabled: false });
    expect(result.servers.find((s) => s.name === "u" && s.effective)).toMatchObject({
      state: "disabled",
      disabledBy: "config",
      scope: "project",
    });
    const elsewhere = await resolveMcpServers(otherProject, env);
    expect(elsewhere.servers.find((s) => s.name === "u")).toMatchObject({ state: "enabled" });
  });

  it("flips the winner in the user's .mcp.json — every writable global source has the lever", async () => {
    const { env, agent, project } = fixture();
    const otherProject = tmpDir();
    const userFile = path.join(agent, "mcp.json");
    const altFile = path.join(agent, ".mcp.json");
    // The pin lives in the file omp reads its lists from; the definition lives
    // in the lower-priority native user file, which is writable all the same.
    writeJson(userFile, { enabledServers: ["v"] });
    writeJson(altFile, { mcpServers: { v: { command: "v", enabled: false } } });

    await setMcpServerEnabled({ projectCwd: project, name: "v", enabled: false }, env);

    expect(JSON.parse(fs.readFileSync(altFile, "utf8")).mcpServers.v).toEqual({
      command: "v",
      enabled: true,
    });
    expect(JSON.parse(fs.readFileSync(userFile, "utf8")).enabledServers).toBeUndefined();
    const elsewhere = await resolveMcpServers(otherProject, env);
    expect(elsewhere.servers.find((s) => s.name === "v")).toMatchObject({ state: "enabled" });
  });

  it("restores an existing first file when the second atomic commit fails", async () => {
    const { env, agent, project } = fixture();
    const userFile = path.join(agent, "mcp.json");
    const projectFile = path.join(project, ".omp", "mcp.json");
    writeJson(userFile, { enabledServers: ["p"] });
    writeJson(projectFile, { mcpServers: { p: { command: "p-bin" } } });
    const userBefore = fs.readFileSync(userFile, "utf8");
    const projectBefore = fs.readFileSync(projectFile, "utf8");
    const originalWrite = atomicWrite.writeTextAtomic;
    const commitFailure = new Error("second commit failed");
    const write = vi
      .spyOn(atomicWrite, "writeTextAtomic")
      .mockImplementationOnce(originalWrite)
      .mockImplementationOnce(() => {
        throw commitFailure;
      });

    await expect(
      setMcpServerEnabled({ projectCwd: project, name: "p", enabled: false }, env),
    ).rejects.toBe(commitFailure);

    expect(fs.readFileSync(projectFile, "utf8")).toBe(projectBefore);
    expect(fs.readFileSync(userFile, "utf8")).toBe(userBefore);
    expect(write).toHaveBeenNthCalledWith(3, projectFile, projectBefore);
  });

  it("removes an originally absent first file when the second atomic commit fails", async () => {
    const { env, agent, project } = fixture();
    const userFile = path.join(agent, "mcp.json");
    const overrideFile = path.join(project, ".omp", "mcp.json");
    writeJson(userFile, {
      mcpServers: { x: { command: "x-bin", enabled: false } },
      enabledServers: ["x"],
    });
    const userBefore = fs.readFileSync(userFile, "utf8");
    const originalWrite = atomicWrite.writeTextAtomic;
    const commitFailure = new Error("second commit failed");
    vi.spyOn(atomicWrite, "writeTextAtomic")
      .mockImplementationOnce(originalWrite)
      .mockImplementationOnce(() => {
        throw commitFailure;
      });

    await expect(
      setMcpServerEnabled({ projectCwd: project, name: "x", enabled: false }, env),
    ).rejects.toBe(commitFailure);

    expect(fs.existsSync(overrideFile)).toBe(false);
    expect(fs.readFileSync(userFile, "utf8")).toBe(userBefore);
  });

  it("reports rollback failures as an AggregateError caused by the commit failure", async () => {
    const { env, agent, project } = fixture();
    const userFile = path.join(agent, "mcp.json");
    const projectFile = path.join(project, ".omp", "mcp.json");
    writeJson(userFile, { enabledServers: ["p"] });
    writeJson(projectFile, { mcpServers: { p: { command: "p-bin" } } });
    const originalWrite = atomicWrite.writeTextAtomic;
    const commitFailure = new Error("second commit failed");
    const rollbackFailure = new Error("rollback write failed");
    vi.spyOn(atomicWrite, "writeTextAtomic")
      .mockImplementationOnce(originalWrite)
      .mockImplementationOnce(() => {
        throw commitFailure;
      })
      .mockImplementationOnce(() => {
        throw rollbackFailure;
      });

    let caught: unknown;
    try {
      await setMcpServerEnabled({ projectCwd: project, name: "p", enabled: false }, env);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.cause).toBe(commitFailure);
    expect(aggregate.errors).toEqual([rollbackFailure]);
    expect(aggregate.message).toContain(projectFile);
    expect(aggregate.message).toContain("rollback write failed");
  });

  it("keeps successful multi-file output byte-for-byte compatible", async () => {
    const { env, agent, project } = fixture();
    const userFile = path.join(agent, "mcp.json");
    const projectFile = path.join(project, ".omp", "mcp.json");
    writeJson(userFile, { enabledServers: ["p"] });
    writeJson(projectFile, { mcpServers: { p: { command: "p-bin" } } });

    await setMcpServerEnabled({ projectCwd: project, name: "p", enabled: false }, env);

    const schema =
      "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
    expect(fs.readFileSync(projectFile, "utf8")).toBe(
      JSON.stringify(
        {
          $schema: schema,
          mcpServers: { p: { command: "p-bin", enabled: false } },
        },
        null,
        2,
      ),
    );
    expect(fs.readFileSync(userFile, "utf8")).toBe(JSON.stringify({ $schema: schema }, null, 2));
  });

  it("clears the pin when the winner is a project file flipped in place", async () => {
    const { env, agent, project } = fixture();
    const userFile = path.join(agent, "mcp.json");
    writeJson(userFile, { enabledServers: ["p"] });
    const projectFile = path.join(project, ".omp", "mcp.json");
    writeJson(projectFile, { mcpServers: { p: { command: "p-bin" } } });

    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "p", enabled: false },
      env,
    );

    // An in-place flip is just as powerless against the pin as a skeleton is.
    expect(JSON.parse(fs.readFileSync(projectFile, "utf8")).mcpServers.p.enabled).toBe(false);
    expect(JSON.parse(fs.readFileSync(userFile, "utf8")).enabledServers).toBeUndefined();
    // No global-scope definition exists, so there is nothing to flip on: the
    // writer must not mint a user-level definition to release the pin.
    expect(JSON.parse(fs.readFileSync(userFile, "utf8")).mcpServers).toBeUndefined();
    expect(result.servers.find((s) => s.name === "p" && s.effective)).toMatchObject({
      state: "disabled",
      disabledBy: "config",
    });
  });

  it("enabling an already-enabled outside server is an idempotent no-op", async () => {
    const { env, agent, project } = fixture();
    writeJson(path.join(agent, "mcp.json"), { mcpServers: { ctx: { command: "user-bin" } } });

    const result = await setMcpServerEnabled(
      { projectCwd: project, name: "ctx", enabled: true },
      env,
    );
    expect(result.servers.find((s) => s.name === "ctx")).toMatchObject({ state: "enabled" });
    expect(fs.existsSync(path.join(project, ".omp"))).toBe(false);
  });

  it("skeletons an opencode array command down to argv[0], copying no args", async () => {
    const { env, project } = fixture();
    writeJson(path.join(project, "opencode.json"), {
      mcp: {
        srv: { type: "local", command: ["bunx", "srv", "--x"], environment: { K: "oc-secret" } },
      },
    });

    await setMcpServerEnabled({ projectCwd: project, name: "srv", enabled: false }, env);
    const overrideText = fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8");
    expect(overrideText).not.toContain("oc-secret");
    expect(overrideText).not.toContain("--x");
    expect(JSON.parse(overrideText).mcpServers.srv).toEqual({ command: "bunx", enabled: false });
  });

  it("rejects a toggle for a name no source defines", async () => {
    const { env, project } = fixture();
    await expect(
      setMcpServerEnabled({ projectCwd: project, name: "ghost", enabled: false }, env),
    ).rejects.toThrow('Server "ghost" is not defined in any config source.');
  });
});
