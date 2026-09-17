import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { subagentModelOverlayPath } from "@omp-ui/core";
import { writeSessionOverlays } from "./spawn-config";
import { ownedSessionRecord } from "./test/fixtures";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spawn-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeSessionOverlays — subagent overlay (ADR-0031)", () => {
  it("umbrella on + no session choice: every roster name inherits the session model", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(ownedSessionRecord(), dir, undefined, {
      inheritByDefault: true,
      roster: ["scout", "task"],
    });
    const file = subagentModelOverlayPath(dir);
    expect(overlays).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe(
      'task:\n  agentModelOverrides:\n    "scout": "*"\n    "task": "*"\n',
    );
  });

  it("an explicit session map replaces the umbrella outright", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(
      ownedSessionRecord({ subagentModels: { task: "openai/gpt-5" } }),
      dir,
      undefined,
      { inheritByDefault: true, roster: ["scout", "task"] },
    );
    const file = subagentModelOverlayPath(dir);
    expect(overlays).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe(
      'task:\n  agentModelOverrides:\n    "task": "openai/gpt-5"\n',
    );
  });

  it("umbrella off + no session choice: no overlay, and a stale file is removed", () => {
    const dir = tmp();
    writeSessionOverlays(ownedSessionRecord({ subagentModels: { scout: "*" } }), dir, undefined, {
      inheritByDefault: false,
      roster: [],
    });
    const overlays = writeSessionOverlays(ownedSessionRecord(), dir, undefined, {
      inheritByDefault: false,
      roster: ["scout"],
    });
    expect(overlays).not.toContain(subagentModelOverlayPath(dir));
    expect(fs.existsSync(subagentModelOverlayPath(dir))).toBe(false);
  });

  it("omitted subagent config keeps a record's explicit choice", () => {
    const dir = tmp();
    const overlays = writeSessionOverlays(
      ownedSessionRecord({ subagentModels: { scout: "openai/gpt-5" } }),
      dir,
    );
    expect(overlays).toContain(subagentModelOverlayPath(dir));
  });
});
