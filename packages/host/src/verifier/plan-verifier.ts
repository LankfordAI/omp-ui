import type { PlanDiagnostic, PlanRenderResult } from "@omp-ui/core";
import { PLAN_ARTIFACT_BYTE_LIMIT, PLAN_PREPARED_BYTE_LIMIT } from "./limits";
import type { VerifierUnavailable } from "./payload";

/**
 * The host's plan verification service (issue #312 follow-up; ADR-0022
 * amended; issue #442 §8). ONE verifier page owns a bundled verification
 * surface and runs the same parser, transforms, structural checks, and real
 * layout probe the surfaces use — so the submission gate applies to every
 * owned native session whether a desktop client, a remote browser, or NO
 * client is watching.
 *
 * Trust model (§4): the top-level page is OURS (the bundled verifier page,
 * no bridge into the host); authored HTML enters only as a JSON-serialized
 * argument to the trusted `window.ompPlanVerifier.verify` function — never as
 * the top-level URL, never interpolated as source. The authored document
 * lives only in the page's separate script-less probe iframe. The page
 * implementation denies every request the trusted page and its bundled
 * assets do not make themselves; the child CSP independently blocks authored
 * network resources.
 */

const TOTAL_DEADLINE_MS = 30_000;

/** Re-exported so tests can reach the constant the queue hard-codes. */
export const PLAN_VERIFY_TOTAL_DEADLINE_MS = TOTAL_DEADLINE_MS;

/** Where a job stood when its deadline fired; named in the timeout detail. */
export type VerifyPhase = "queued" | "launch" | "page-ready" | "invoke";

/** The verifier's own liveness, surfaced as the `verifier` breadcrumb. */
export interface VerifierHealth {
  /** The pinned Chrome for Testing version, when a payload is configured. */
  pin: string | null;
  /** The verified SHA-256 of the packaged browser binary. */
  sha256: string | null;
  state: "ready" | "degraded";
  reason: string | null;
  atMs: number;
}

export interface PlanVerifierDeps {
  /** Creates (or returns) the page the queue drives; called lazily, once per page lifetime. */
  page: () => Promise<VerifierPage> | VerifierPage;
  health?: () => VerifierHealth;
  limits?: { artifactBytes: number; preparedBytes: number };
  /** A verifier constructed degraded answers every request `unavailable`; it never falls back. */
  degraded?: VerifierUnavailable;
}

/** The page contract the queue relies on; the browser implementation wraps it. */
export interface VerifierPage {
  /** Resolves when the page can accept an invoke. */
  ready(): Promise<void>;
  /**
   * Invokes the trusted function with JSON-safe data; rejects on death. An
   * aborted signal cancels only this invocation's work.
   */
  invoke(args: VerifyArgs, signal?: AbortSignal): Promise<unknown>;
  /** Tears the page down; an active probe dies with it. */
  dispose(): void;
}

export interface VerifyArgs {
  html: string;
  themeId: string;
  preparedByteLimit: number;
}

interface Job {
  args: VerifyArgs;
  enqueuedAt: number;
  signal: AbortSignal;
  resolve: (result: PlanRenderResult) => void;
  cancel: () => void;
}

export class PlanVerifier {
  private page: VerifierPage | null = null;
  private pagePromise: Promise<VerifierPage> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private active: Job | null = null;
  private disposed = false;
  private readonly createPage: () => Promise<VerifierPage> | VerifierPage;
  private readonly healthOf: (() => VerifierHealth) | null;
  private readonly artifactBytes: number;
  private readonly preparedBytes: number;
  private readonly degraded: VerifierUnavailable | null;

  constructor(deps: PlanVerifierDeps) {
    this.createPage = deps.page;
    this.healthOf = deps.health ?? null;
    this.artifactBytes = deps.limits?.artifactBytes ?? PLAN_ARTIFACT_BYTE_LIMIT;
    this.preparedBytes = deps.limits?.preparedBytes ?? PLAN_PREPARED_BYTE_LIMIT;
    this.degraded = deps.degraded ?? null;
  }

  health(): VerifierHealth {
    if (this.healthOf !== null) return this.healthOf();
    if (this.degraded !== null) {
      return { pin: null, sha256: null, state: "degraded", reason: this.degraded.reason, atMs: Date.now() };
    }
    return { pin: null, sha256: null, state: "ready", reason: null, atMs: Date.now() };
  }

  /**
   * Serialize verification jobs; each request gets {@link TOTAL_DEADLINE_MS}
   * INCLUDING queue wait. A timeout, a crash, or a non-layout environment
   * answers `unavailable` — never `passed`. A hung page is destroyed; the
   * NEXT request gets a fresh one rather than a retry of the same document.
   * Cancellation removes queued jobs; cancelling an active job aborts its
   * invocation (§4).
   */
  verify(html: string, themeId: string, signal: AbortSignal): Promise<PlanRenderResult> {
    if (this.disposed) {
      return Promise.resolve(unavailable("the verifier service is disposed", "VERIFIER_UNAVAILABLE"));
    }
    if (this.degraded !== null) {
      return Promise.resolve(unavailable(this.degraded.reason, "VERIFIER_UNAVAILABLE"));
    }
    if (Buffer.byteLength(html, "utf8") > this.artifactBytes) {
      return Promise.resolve({
        status: "unavailable",
        diagnostics: [
          {
            code: "PLAN_RESOURCE_LIMIT",
            stage: "service",
            repair: "application",
            severity: "error",
            message: "the authored plan exceeds the verifier's input limit",
            detail: `limit ${this.artifactBytes} bytes`,
          } satisfies PlanDiagnostic,
        ],
      });
    }
    const args: VerifyArgs = { html, themeId, preparedByteLimit: this.preparedBytes };
    // Executor form (not Promise.withResolvers): the node tsconfig lib is
    // ES2022, same convention as live-entry.ts.
    let resolve!: (result: PlanRenderResult) => void;
    const promise = new Promise<PlanRenderResult>((res) => {
      resolve = res;
    });
    const job: Job = {
      args,
      enqueuedAt: Date.now(),
      signal,
      resolve,
      cancel: () => resolve(abortedResult()),
    };
    if (signal.aborted) {
      return Promise.resolve(abortedResult());
    }
    signal.addEventListener("abort", () => job.cancel(), { once: true });
    const run = this.queue.then(() => this.run(job));
    // The chain never rejects; failures answer through the job's resolver.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  private async run(job: Job): Promise<void> {
    if (job.signal.aborted) {
      return;
    }
    this.active = job;
    let phase: VerifyPhase = "queued";
    const remaining = TOTAL_DEADLINE_MS - (Date.now() - job.enqueuedAt);
    if (remaining <= 0) {
      this.active = null;
      job.resolve(unavailable(`deadline(phase=${phase})`, "VERIFIER_TIMEOUT"));
      return;
    }
    // One deadline spans launch, readiness, and the invocation itself; the
    // phase it fires in is the diagnostic's whole content.
    let settle!: (result: PlanRenderResult) => void;
    const settled = new Promise<PlanRenderResult>((res) => {
      settle = res;
    });
    const timer = setTimeout(() => {
      // A hung page cannot be trusted for the NEXT job either; tear it down
      // and let the next independent request recreate it.
      void this.teardownPage();
      settle(unavailable(`deadline(phase=${phase})`, "VERIFIER_TIMEOUT"));
    }, remaining);
    const attempt = (async (): Promise<PlanRenderResult> => {
      phase = "launch";
      const page = await this.ensurePage();
      phase = "page-ready";
      await page.ready();
      phase = "invoke";
      try {
        const value = await page.invoke(job.args, job.signal);
        return isRenderResult(value)
          ? value
          : unavailable("the verifier returned a malformed result", "VERIFIER_UNAVAILABLE");
      } catch (err) {
        void this.teardownPage();
        return unavailable(
          err instanceof Error ? err.message : "the verifier page died",
          "VERIFIER_UNAVAILABLE",
        );
      }
    })();
    void attempt.then(
      (result) => {
        clearTimeout(timer);
        settle(result);
      },
      (err: unknown) => {
        clearTimeout(timer);
        settle(
          unavailable(
            err instanceof Error ? err.message : "the verifier could not start",
            "VERIFIER_UNAVAILABLE",
          ),
        );
      },
    );
    try {
      job.resolve(await settled);
    } finally {
      this.active = null;
    }
  }

  private async ensurePage(): Promise<VerifierPage> {
    if (this.page !== null) return this.page;
    if (this.pagePromise === null) {
      this.pagePromise = Promise.resolve()
        .then(() => this.createPage())
        .then(
          (page) => {
            this.page = page;
            this.pagePromise = null;
            return page;
          },
          (err: unknown) => {
            this.pagePromise = null;
            throw err;
          },
        );
    }
    return this.pagePromise;
  }

  private async teardownPage(): Promise<void> {
    const page = this.page;
    this.page = null;
    if (page === null) return;
    try {
      page.dispose();
    } catch {
      // best effort
    }
  }

  /** Drops the page and queued work; the next verify answers disposed. */
  dispose(): void {
    this.disposed = true;
    void this.teardownPage();
    if (this.active !== null) {
      this.active.cancel();
      this.active = null;
    }
  }
}

function abortedResult(): PlanRenderResult {
  return unavailable("the held proposal was cancelled", "VERIFIER_UNAVAILABLE");
}

function unavailable(
  detail: string,
  code: "VERIFIER_TIMEOUT" | "VERIFIER_UNAVAILABLE",
): PlanRenderResult {
  const diagnostic: PlanDiagnostic = {
    code,
    stage: "service",
    repair: "application",
    severity: "error",
    message: code === "VERIFIER_TIMEOUT" ? "the verifier timed out" : "the verifier is unavailable",
    detail: detail.slice(0, 1000),
  };
  return { status: "unavailable", diagnostics: [diagnostic] };
}

function isRenderResult(value: unknown): value is PlanRenderResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.status === "passed" || record.status === "failed" || record.status === "unavailable") &&
    Array.isArray(record.diagnostics)
  );
}
