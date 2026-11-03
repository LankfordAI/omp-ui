import { CH, type RpcFrame } from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

/**
 * A bare `omp` launch inside an owned session's bash command (issue #1022):
 * the word `omp` at a command boundary — start, after a shell separator, or
 * inside a subshell/pipe. omp-ui's own managed children are spawned by path
 * and never through an agent's bash tool, so a bare name here is always a
 * foreign launch rather than self-invocation.
 */
const BARE_OMP_LAUNCH = /(^|[;&|(\s])omp(\s|$)/;

export interface ForeignOmpTrackerDeps {
  send: (channel: string, ...args: unknown[]) => void;
}

/**
 * Notices an agent launching a bare `omp` from inside its own session
 * (issue #1022). ADR-0003 keeps foreign sessions invisible to omp-ui — this
 * does not surface them as rows and never scrapes pty tabs, which carry only
 * raw bytes and are unobservable here. It fires the issue's "loud instead of
 * silent" option: one warn notice on the OWNING session's transcript, naming
 * the orphaned-session symptom and the supported route (fleet dispatch).
 */
export class ForeignOmpTracker implements FrameObserver {
  /** Tabs already warned for the CURRENT live process; cleared on every exit. */
  private readonly warnedTabs = new Set<string>();

  constructor(private readonly deps: ForeignOmpTrackerDeps) {}

  onFrame(tabId: string, frame: RpcFrame): void {
    if (frame.type !== "tool_execution_start" || frame.toolName !== "bash") return;
    const args = frame.args;
    if (typeof args !== "object" || args === null) return;
    const command = (args as Record<string, unknown>).command;
    if (typeof command !== "string" || !BARE_OMP_LAUNCH.test(command)) return;
    if (this.warnedTabs.has(tabId)) return;
    this.warnedTabs.add(tabId);
    this.deps.send(CH.onRpcFrame, tabId, {
      type: "omp_ui_notice",
      level: "warn",
      source: "omp-ui",
      reason: "foreign-omp-launch",
      message:
        `This session launched a bare \`omp\` child. That child is invisible to omp-ui ` +
        `(ADR-0003): it spends money untracked, appears in no sidebar row, and no one ` +
        `answers its prompts. To give an agent sessions omp-ui can see, wake and manage, ` +
        `enable Settings → Remote instances → “Let agents dispatch fleet work” and use ` +
        `the fleet tools instead of spawning omp by hand.`,
    });
  }

  /** A successor process under the same tab gets its own one-shot warning. */
  onExit(tabId: string): void {
    this.warnedTabs.delete(tabId);
  }

  dispose(tabId: string): void {
    this.warnedTabs.delete(tabId);
  }
}
