import { describe, expect, it } from "vitest";
import { CH, type RpcFrame } from "@omp-ui/core";
import { ForeignOmpTracker } from "./foreign-omp-tracker";
import type { LiveEntry } from "./live-entry";

const entry = {} as LiveEntry;

function bash(command: string): RpcFrame {
  return { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command } } as RpcFrame;
}

function makeTracker(): { tracker: ForeignOmpTracker; notices: Record<string, unknown>[] } {
  const notices: Record<string, unknown>[] = [];
  const tracker = new ForeignOmpTracker({
    send: (channel, ...args) => {
      if (channel === CH.onRpcFrame) notices.push(args[1] as Record<string, unknown>);
    },
  });
  return { tracker, notices };
}

describe("ForeignOmpTracker (#1022)", () => {
  it("posts one warn notice for a bare omp launch", () => {
    const { tracker, notices } = makeTracker();
    tracker.onFrame("tab", bash("OMP_SESSION_LOG=x omp --print 'hi'"), entry);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "omp_ui_notice", level: "warn", reason: "foreign-omp-launch" });
    expect(String(notices[0]!.message)).toContain("invisible to omp-ui");
    expect(String(notices[0]!.message)).toContain("Let agents dispatch fleet work");
  });

  it("warns once per live process, and again after the process dies", () => {
    const { tracker, notices } = makeTracker();
    tracker.onFrame("tab", bash("omp run"), entry);
    tracker.onFrame("tab", bash("omp run --again"), entry);
    expect(notices).toHaveLength(1);
    tracker.onExit("tab");
    tracker.onFrame("tab", bash("omp run"), entry);
    expect(notices).toHaveLength(2);
  });

  it("ignores commands where omp is only a substring or a path segment", () => {
    const { tracker, notices } = makeTracker();
    for (const command of [
      "npm install my-omp-helper",
      "python omp_tools.py",
      "cat /opt/omp-ui/bin/notes.md",
      "/usr/local/bin/omp --version",
    ]) {
      tracker.onFrame("tab", bash(command), entry);
    }
    expect(notices).toHaveLength(0);
  });

  it("ignores non-bash tools and frames without a usable command", () => {
    const { tracker, notices } = makeTracker();
    tracker.onFrame("tab", { type: "tool_execution_start", toolCallId: "t1", toolName: "exec", args: { command: "omp" } } as RpcFrame, entry);
    tracker.onFrame("tab", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: null } as RpcFrame, entry);
    tracker.onFrame("tab", { type: "turn_start" } as RpcFrame, entry);
    expect(notices).toHaveLength(0);
  });
});
