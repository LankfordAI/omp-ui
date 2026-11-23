import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROUTINE_GUARD_COMMAND,
  routineGuardArmMessage,
  routineGuardExtensionPath,
  writeRoutineGuardExtension,
} from "./routine-guard-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeRoutineGuardExtension (U7)", () => {
  it("writes omp-ui-routine-guard.ts with only deny'd built-ins (never MCP names)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-guard-"));
    dirs.push(dir);
    const file = writeRoutineGuardExtension(dir, [
      "eval",
      "bash",
      "mcp__gmail-work_send_message",
      "bash",
    ]);
    expect(file).toBe(routineGuardExtensionPath(dir));
    expect(routineGuardArmMessage()).toBe(`/${ROUTINE_GUARD_COMMAND}`);
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain(`const COMMAND = "${ROUTINE_GUARD_COMMAND}";`);
    expect(source).toContain('const DISABLED = ["bash","eval"];');
    expect(source).not.toContain("mcp__gmail-work_send_message");
    expect(source).toContain("setActiveToolPresentation");
    expect(source).toContain("setActiveToolsByName");
  });

  it("typechecks and reads getMountedToolCommandNames on omp 19.1+", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-guard-"));
    dirs.push(dir);
    const file = writeRoutineGuardExtension(dir, ["eval", "learn"]);
    typecheckGeneratedExtension(file);

    const js = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "cjs");
    const mod = { exports: {} as { default?: (api: unknown) => void } };
    new Function("module", "exports", js)(mod, mod.exports);

    const applies: Array<[string[], string[], boolean]> = [];
    let handler: ((args: string, ctx: { ui: { notify: (m: string) => void } }) => Promise<void>) | null = null;
    class FakeSession {
      getEnabledToolNames(): string[] { return ["read", "eval", "learn", "lsp"]; }
      getMountedToolCommandNames(): string[] { return ["learn", "lsp"]; }
      setActiveToolPresentation(enabled: string[], mounted: string[], force?: boolean): void {
        applies.push([[...enabled], [...mounted], force === true]);
      }
      prompt(): Promise<void> { return Promise.resolve(); }
    }
    mod.exports.default!({
      pi: { AgentSession: { prototype: FakeSession.prototype } },
      registerCommand: (_name: string, opts: { handler: typeof handler }) => { handler = opts.handler; },
    });
    await new FakeSession().prompt();
    await handler!("", { ui: { notify: () => undefined } });

    expect(applies).toEqual([[["read", "lsp"], ["lsp"], true]]);
  });
});
