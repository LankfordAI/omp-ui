import type { RpcFrame } from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

export type CardOutcome<A> = A | "cancelled" | { kind: "refused"; reason: string };

export interface CardRequestGateDeps {
  broadcast(): Promise<void>;
  /** SessionManager: rebases the stall clock when the session no longer awaits a human. */
  onSettled(tabId: string): void;
  /** Attention when a card opens; optional so tests can omit it. */
  onRaised?(tabId: string): void;
  /** Attention when a card settles. */
  onSettleAttention?(tabId: string): void;
  perRun: number;
}

interface OpenCard<P, A> {
  prompt: P;
  resolve: (outcome: CardOutcome<A>) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/**
 * One confirmation card per tab, held until the user answers, the host call is
 * cancelled, or the session exits (#1228, #1393). In memory only — a card dies
 * with the process that raised it. Every settle deletes the entry before
 * resolving, so a late or duplicate answer finds nothing and has no side
 * effect. The card type (prompt, answer, per-run cap) is parameterized;
 * subclasses name the card kind in the run-cap refusal.
 */
export class CardRequestGate<P extends { promptId: string }, A> implements FrameObserver {
  private readonly open = new Map<string, OpenCard<P, A>>();
  /** Cards raised in the tab's current agent run. */
  private readonly runCounts = new Map<string, number>();

  constructor(
    private readonly deps: CardRequestGateDeps,
    /** Card kind used in refusals, e.g. "project request". */
    private readonly kind: string,
    /** Normalizes an answer against its prompt before settling; optional. */
    private readonly normalize: (answer: A, prompt: P) => A = (answer) => answer,
  ) {}

  request(tabId: string, prompt: P, signal: AbortSignal): Promise<CardOutcome<A>> {
    if (signal.aborted) return Promise.resolve("cancelled");
    if (this.open.has(tabId)) {
      return Promise.resolve({ kind: "refused", reason: `another ${this.kind} is waiting for the user` });
    }
    const count = this.runCounts.get(tabId) ?? 0;
    if (count >= this.deps.perRun) {
      return Promise.resolve({ kind: "refused", reason: `too many ${this.kind}s in this run` });
    }
    this.runCounts.set(tabId, count + 1);
    const { promise, resolve } = Promise.withResolvers<CardOutcome<A>>();
    const onAbort = (): void => this.settle(tabId, prompt.promptId, "cancelled");
    this.open.set(tabId, { prompt, resolve, signal, onAbort });
    signal.addEventListener("abort", onAbort, { once: true });
    this.deps.onRaised?.(tabId);
    void this.deps.broadcast();
    return promise;
  }

  answer(tabId: string, promptId: string, answer: A): { ok: true } | { ok: false; reason: string } {
    const entry = this.open.get(tabId);
    if (entry === undefined || entry.prompt.promptId !== promptId) {
      return { ok: false, reason: "this request is no longer pending" };
    }
    this.settle(tabId, promptId, this.normalize(answer, entry.prompt));
    return { ok: true };
  }

  pending(tabId: string): boolean {
    return this.open.has(tabId);
  }

  prompt(tabId: string): P | null {
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

  private settle(tabId: string, promptId: string, outcome: CardOutcome<A>): void {
    const entry = this.open.get(tabId);
    if (entry === undefined || entry.prompt.promptId !== promptId) return;
    this.open.delete(tabId);
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(outcome);
    this.deps.onSettleAttention?.(tabId);
    this.deps.onSettled(tabId);
    void this.deps.broadcast();
  }
}
