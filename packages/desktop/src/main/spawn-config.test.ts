import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentModelOverlayPath } from "@omp-ui/core";
import {
  RPC_BRIDGE_IDS,
  writeRpcExtensions,
  writeSessionOverlays,
  type RpcBridgeWriters,
} from "./spawn-config";
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
function bridgeWriters(write: (id: (typeof RPC_BRIDGE_IDS)[number]) => string): RpcBridgeWriters {
  return {
    plan: () => write("plan"),
    advisorStats: () => write("advisorStats"),
    mcpStatus: () => write("mcpStatus"),
    capabilities: () => write("capabilities"),
    goal: () => write("goal"),
    browserPane: () => write("browserPane"),
    autoresearch: () => write("autoresearch"),
  };
}

describe("writeRpcExtensions", () => {
  it("reports every bridge independently, including plan and advisor stats", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writers = bridgeWriters((id) => {
      if (id === "plan" || id === "advisorStats") throw new Error(`${id} failed`);
      return `/${id}.ts`;
    });

    expect(writeRpcExtensions(tmp(), true, writers)).toEqual({
      paths: [
        "/mcpStatus.ts",
        "/capabilities.ts",
        "/goal.ts",
        "/browserPane.ts",
        "/autoresearch.ts",
      ],
      loaded: {
        plan: false,
        advisorStats: false,
        mcpStatus: true,
        capabilities: true,
        goal: true,
        browserPane: true,
        autoresearch: true,
      },
    });
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("records a disabled autoresearch bridge without invoking it", () => {
    const autoresearch = vi.fn(() => "/autoresearch.ts");
    const writers = bridgeWriters((id) =>
      id === "autoresearch" ? autoresearch() : `/${id}.ts`,
    );
    const result = writeRpcExtensions(tmp(), false, writers);
    expect(result.loaded.autoresearch).toBe(false);
    expect(autoresearch).not.toHaveBeenCalled();
  });
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
