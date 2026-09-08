import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { session, BrowserWindow, type Session } from "electron";
import { PLAN_ARTIFACT_BYTE_LIMIT, PLAN_PREPARED_BYTE_LIMIT } from "./plan-file";
import type { PlanDiagnostic, PlanRenderResult } from "@omp-ui/core";

/**
 * The main-process plan verification service (issue #312 follow-up;
 * ADR-0022 amended). ONE hidden window owns a bundled verification surface
 * and runs the same parser, transforms, structural checks, and real layout
 * probe the surfaces use — so the submission gate applies to every owned
 * native session whether a desktop client, a remote browser, or NO client is
 * watching.
 *
 * Trust model (§4): the top-level page is OURS (bundled `plan-verifier.html`,
 * no preload, no `ompBackend`); authored HTML enters only as a JSON-serialized
 * argument to the trusted `window.ompPlanVerifier.verify` function — never as
 * the top-level URL, never interpolated as source. The authored document
 * lives only in the page's separate script-less probe iframe. The dedicated
 * session denies permissions, downloads, popups, and every request the
 * trusted page and its bundled module assets do not make themselves; the
 * child CSP independently blocks authored network resources.
 */

const TOTAL_DEADLINE_MS = 30_000;

/** Re-exported so tests can reach the constant the queue hard-codes. */
export const PLAN_VERIFY_TOTAL_DEADLINE_MS = TOTAL_DEADLINE_MS;

export interface PlanVerifierDeps {
  /** Test seam: swaps the real BrowserWindow page for a fake. */
  createPage?: () => Promise<VerifierPage>;
}

/** The page contract the queue relies on; the BrowserWindow impl wraps it. */
export interface VerifierPage {
  /** Resolves when `window.ompPlanVerifier` answers. */
  ready(): Promise<void>;
  /** Invokes the trusted function with JSON-safe data; rejects on death. */
  invoke(args: VerifyArgs): Promise<unknown>;
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
  private readonly createPage: () => Promise<VerifierPage>;

  constructor(deps: PlanVerifierDeps = {}) {
    this.createPage = deps.createPage ?? (() => BrowserVerifierPage.create());
  }

  /**
   * Serialize verification jobs; each request gets {@link TOTAL_DEADLINE_MS}
   * INCLUDING queue wait. A timeout, a crash, or a non-layout environment
   * answers `unavailable` — never `passed`. A hung page is destroyed; the
   * NEXT request gets a fresh one rather than a retry of the same document.
   * Cancellation removes queued jobs; cancelling an active job tears its
   * page down (§4).
   */
  verify(html: string, themeId: string, signal: AbortSignal): Promise<PlanRenderResult> {
    if (this.disposed) {
      return Promise.resolve(unavailable("the verifier service is disposed", "VERIFIER_UNAVAILABLE"));
    }
    if (Buffer.byteLength(html, "utf8") > PLAN_ARTIFACT_BYTE_LIMIT) {
      return Promise.resolve({
        status: "unavailable",
        diagnostics: [
          {
            code: "PLAN_RESOURCE_LIMIT",
            stage: "service",
            repair: "application",
            severity: "error",
            message: "the authored plan exceeds the verifier's input limit",
            detail: `limit ${PLAN_ARTIFACT_BYTE_LIMIT} bytes`,
          } satisfies PlanDiagnostic,
        ],
      });
    }
    const args: VerifyArgs = { html, themeId, preparedByteLimit: PLAN_PREPARED_BYTE_LIMIT };
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
    const remaining = TOTAL_DEADLINE_MS - (Date.now() - job.enqueuedAt);
    if (remaining <= 0) {
      this.active = null;
      job.resolve(unavailable("the verification queue exceeded its deadline", "VERIFIER_TIMEOUT"));
      return;
    }
    try {
      const page = await this.ensurePage();
      await page.ready();
      let settle!: (result: PlanRenderResult) => void;
      const inner = new Promise<PlanRenderResult>((res) => {
        settle = res;
      });
      const timer = setTimeout(() => {
        // A hung page cannot be trusted for the NEXT job either; tear it down
        // and let the next independent request recreate it.
        void this.teardownPage();
        settle(unavailable("the verifier did not answer within its deadline", "VERIFIER_TIMEOUT"));
      }, remaining);
      void page
        .invoke(job.args)
        .then(
          (value) => {
            clearTimeout(timer);
            settle(
              isRenderResult(value)
                ? value
                : unavailable("the verifier returned a malformed result", "VERIFIER_UNAVAILABLE"),
            );
          },
          (err: unknown) => {
            clearTimeout(timer);
            void this.teardownPage();
            settle(
              unavailable(
                err instanceof Error ? err.message : "the verifier page died",
                "VERIFIER_UNAVAILABLE",
              ),
            );
          },
        );
      job.resolve(await inner);
    } catch (err) {
      job.resolve(
        unavailable(
          err instanceof Error ? err.message : "the verifier could not start",
          "VERIFIER_UNAVAILABLE",
        ),
      );
    } finally {
      this.active = null;
    }
  }

  private async ensurePage(): Promise<VerifierPage> {
    if (this.page !== null) return this.page;
    if (this.pagePromise === null) {
      this.pagePromise = this.createPage().then(
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

  /** Drops the window and queued work; the next verify starts fresh. */
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

/** The BrowserWindow-backed page. Lazily created; disposable; never reused dead. */
class BrowserVerifierPage implements VerifierPage {
  private constructor(private readonly win: BrowserWindow) {}

  static async create(): Promise<VerifierPage> {
    const partition = "plan-verifier";
    const ses = session.fromPartition(partition);
    guardSession(ses);
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        partition,
        // No preload at all: this page never reaches the backend bridge.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // rAF must keep ticking in a hidden window — the layout probe waits
        // on two frames in the page's own clock.
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    // Popups cannot escape the containment.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-frame-navigate", (event) => {
      // The probe frame is created in-page by document.write; nothing may
      // navigate, and nothing may point at the top level.
      if (!event.url.startsWith("about:") && !isAllowedRequest(event.url)) {
        event.preventDefault();
      } else if (event.url.startsWith("data:") || event.url.startsWith("http")) {
        event.preventDefault();
      }
    });
    const page = new BrowserVerifierPage(win);
    await page.load();
    return page;
  }

  private async load(): Promise<void> {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl !== undefined && devUrl !== "") {
      await this.win.loadURL(`${devUrl.replace(/\/$/, "")}/plan-verifier.html`);
    } else {
      await this.win.loadFile(path.join(__dirname, "../renderer/plan-verifier.html"));
    }
    // The entry registers the trusted global during module evaluation; by
    // 'dom-ready' deferred module scripts may still be pending, so probe.
    for (let i = 0; i < 100; i += 1) {
      const present = await this.win.webContents.executeJavaScript(
        "window.ompPlanVerifier !== undefined && typeof window.ompPlanVerifier.verify === 'function'",
        true,
      );
      if (present === true) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the verifier page never registered its entry point");
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async invoke(args: VerifyArgs): Promise<unknown> {
    // The authored HTML rides as a JSON-serialized ARGUMENT to the trusted
    // function — the top-level document stays ours; authored bytes never
    // become top-level source or executable interpolation.
    const call = "window.ompPlanVerifier.verify(" + JSON.stringify(args) + ")";
    return await this.win.webContents.executeJavaScript(call, true);
  }

  dispose(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

/** Permissions, downloads, and requests all deny except the trusted assets. */
function guardSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url) });
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      cancel: !isAllowedRequest(details.url),
      requestHeaders: details.requestHeaders,
    });
  });
  ses.on("will-download", (event) => event.preventDefault());
}

/**
 * Only the exact configured page URL and its same-origin module assets are
 * allowed: the dev origin in development, the bundled renderer directory in
 * a package. data:/blob: carry no network fetch — the child CSP governs
 * those. Everything else (file or network) is denied outright, so an
 * authored frame can never fetch or file-read its way out.
 */
export function isAllowedRequest(url: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl !== undefined && devUrl !== "") {
    try {
      return url.startsWith(`${new URL(devUrl).origin}/`);
    } catch {
      return false;
    }
  }
  const rendererDirUrl = pathToFileURL(path.join(__dirname, "../renderer")).href;
  return url === rendererDirUrl || url.startsWith(`${rendererDirUrl}/`);
}
