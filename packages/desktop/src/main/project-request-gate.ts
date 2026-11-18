import {
  PROJECT_REQUESTS_PER_RUN,
  type ProjectRequestDecision,
  type ProjectRequestPrompt,
  type RpcFrame,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import type { FrameObserver } from "./frame-observer";

export interface ProjectRequestGateDeps {
  broadcast(): Promise<void>;
  attention?: Attention;
  /** SessionManager: rebases the stall clock when the session no longer awaits a human. */
  onSettled(tabId: string): void;
}

/** What one request settles to; `refused` never showed a card. */
export type ProjectRequestOutcome = ProjectRequestDecision | "cancelled" | { kind: "refused"; reason: string };

interface OpenRequest {
  prompt: ProjectRequestPrompt;
  resolve: (outcome: ProjectRequestOutcome) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/**
 * Project request cards (#1228, ADR-0099): at most one open request per tab,
 * held until the user answers, the host call is cancelled, or the session
 * exits. In memory only — a request dies with the process that raised it.
 * Every settle deletes the entry before resolving, so a late or duplicate
 * answer finds nothing and has no side effect.
 */
export class ProjectRequestGate implements FrameObserver {
  private readonly open = new Map<string, OpenRequest>();
  /** Cards raised in the tab's current agent run. */
  private readonly runCounts = new Map<string, number>();

  constructor(private readonly deps: ProjectRequestGateDeps) {}

  request(tabId: string, prompt: ProjectRequestPrompt, signal: AbortSignal): Promise<ProjectRequestOutcome> {
    if (signal.aborted) return Promise.resolve("cancelled");
    if (this.open.has(tabId)) {
      return Promise.resolve({ kind: "refused", reason: "another project request is waiting for the user" });
    }
    const count = this.runCounts.get(tabId) ?? 0;
    if (count >= PROJECT_REQUESTS_PER_RUN) {
      return Promise.resolve({ kind: "refused", reason: "too many project requests in this run" });
    }
    this.runCounts.set(tabId, count + 1);
    const { promise, resolve } = Promise.withResolvers<ProjectRequestOutcome>();
    const onAbort = (): void => this.settle(tabId, prompt.promptId, "cancelled");
    this.open.set(tabId, { prompt, resolve, signal, onAbort });
    signal.addEventListener("abort", onAbort, { once: true });
    this.deps.attention?.projectRequested(tabId);
    void this.deps.broadcast();
    return promise;
  }

  answer(tabId: string, promptId: string, decision: ProjectRequestDecision): { ok: true } | { ok: false; reason: string } {
    const entry = this.open.get(tabId);
    if (entry === undefined || entry.prompt.promptId !== promptId) {
      return { ok: false, reason: "this request is no longer pending" };
    }
    const settled: ProjectRequestDecision =
      decision.kind === "allow" && entry.prompt.verb === "register" ? { kind: "allow", parent: null } : decision;
    this.settle(tabId, promptId, settled);
    return { ok: true };
  }

  pending(tabId: string): boolean {
    return this.open.has(tabId);
  }

  prompt(tabId: string): ProjectRequestPrompt | null {
    return this.open.get(tabId)?.prompt ?? null;
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    if (frame.type === "agent_start") this.runCounts.delete(tabId);
  }

  onExit(tabId: string): void {
    const entry = this.open.get(tabId);
    if (entry !== undefined) this.settle(tabId, entry.prompt.promptId, "cancelled");
    this.runCounts.delete(tabId);
  }

  dispose(tabId: string): void {
    this.onExit(tabId);
  }

  private settle(tabId: string, promptId: string, outcome: ProjectRequestOutcome): void {
    const entry = this.open.get(tabId);
    if (entry === undefined || entry.prompt.promptId !== promptId) return;
    this.open.delete(tabId);
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(outcome);
    this.deps.attention?.projectRequestSettled(tabId);
    this.deps.onSettled(tabId);
    void this.deps.broadcast();
  }
}
