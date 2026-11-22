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
});
