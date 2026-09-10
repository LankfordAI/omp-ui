import * as fs from "node:fs";
import type { Browser } from "puppeteer-core";
import type { VerifierHealth, VerifierPage, VerifyArgs } from "./plan-verifier";

/**
 * The headless Chrome for Testing page the host's verifier drives (issue
 * #442 §8.2). ONE persistent browser is launched lazily on the first invoke
 * — inside the verifier's deadline, so a slow launch is a `launch`-phase
 * timeout rather than an unobserved startup stall — and every invoke gets a
 * fresh tab: navigate to the bundled page on the loopback origin, wait for
 * the trusted global, call it with the authored HTML as a JSON argument,
 * close the tab.
 *
 * Containment: request interception aborts anything not on our origin
 * (data:/blob: carry no network), the profile is private and 0o700, cache
 * and service workers are off. A disconnect or target crash discards the
 * browser AND its profile; the next invoke relaunches from nothing.
 */
export interface ChromeVerifierPageDeps {
  executablePath: string;
  userDataDir: string;
  /** `http://127.0.0.1:<port>` from {@link startVerifierOrigin}. */
  origin: string;
  prefix: string;
  /** Browser lifetime after the last invoke; default ten minutes. */
  idleMs?: number;
  now?: () => number;
  onHealth?: (h: VerifierHealth) => void;
}

const DEFAULT_IDLE_MS = 600_000;
const NO_SANDBOX_MARKER = "No usable sandbox";

declare global {
  /** The trusted function the bundled verifier page (verifier/entry.ts) registers; page-side only. */
  var ompPlanVerifier: { verify: (args: VerifyArgs) => Promise<unknown> } | undefined;
}

export class ChromeVerifierPage implements VerifierPage {
  private current: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly pageUrl: string;

  constructor(private readonly deps: ChromeVerifierPageDeps) {
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.now = deps.now ?? Date.now;
    this.pageUrl = `${deps.origin}/${deps.prefix}/index.html`;
  }

  /** The launch happens in `invoke` so the deadline phase is observable. */
  ready(): Promise<void> {
    return Promise.resolve();
  }

  /** The warm browser, if one is up; null between launches. Inspection only (health, live proofs). */
  browser(): Browser | null {
    return this.current;
  }

  async invoke(args: VerifyArgs, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) throw new Error("the verifier page is disposed");
    this.stopIdleTimer();
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    // Abort closes ONLY this job's tab; the browser stays warm for the next.
    const onAbort = (): void => {
      void page.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) throw new Error("the verification was cancelled");
      let crashed: Error | null = null;
      page.once("error", (err) => {
        crashed = err;
        this.discardBrowser("the verifier target crashed");
      });
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) {
          void request.continue().catch(() => undefined);
          return;
        }
        let allowed: boolean;
        try {
          allowed = new URL(url).origin === this.deps.origin;
        } catch {
          allowed = false;
        }
        void (allowed ? request.continue() : request.abort("blockedbyclient")).catch(() => undefined);
      });
      await page.setCacheEnabled(false);
      await page.setBypassServiceWorker(true);
      await page.goto(this.pageUrl, { waitUntil: "load" });
      await page.waitForFunction(
        "window.ompPlanVerifier !== undefined && typeof window.ompPlanVerifier.verify === 'function'",
      );
      // The authored HTML rides as a JSON-serialized ARGUMENT to the trusted
      // function — the top-level document stays ours; authored bytes never
      // become top-level source or executable interpolation.
      const result: unknown = await page.evaluate((a: VerifyArgs) => {
        // Runs INSIDE the page: the global the bundled entry registered.
        const verifier = globalThis.ompPlanVerifier;
        if (verifier === undefined) throw new Error("the verifier page lost its entry point");
        return verifier.verify(a);
      }, args);
      if (crashed !== null) throw crashed;
      return result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await page.close().catch(() => undefined);
      this.armIdleTimer();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopIdleTimer();
    // A deliberate shutdown is not a degradation; only a crash or disconnect reports one.
    this.discardBrowser(null);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.current !== null) return this.current;
    if (this.launching === null) {
      this.launching = this.launch().then(
        (browser) => {
          this.launching = null;
          if (this.disposed) {
            void browser.close().catch(() => undefined);
            throw new Error("the verifier page is disposed");
          }
          this.current = browser;
          return browser;
        },
        (err: unknown) => {
          this.launching = null;
          throw err;
        },
      );
    }
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    fs.mkdirSync(this.deps.userDataDir, { recursive: true, mode: 0o700 });
    // Dynamic import by design: puppeteer-core is laid out beside the binary
    // under lib/ and resolved on first launch, so a static import would make
    // `omp-ui status` pay for it at boot. A host whose verifier payload is
    // absent (degraded) never loads it either.
    const { default: puppeteer } = await import("puppeteer-core");
    let browser: Browser;
    try {
      browser = await puppeteer.launch({
        executablePath: this.deps.executablePath,
        headless: true,
        userDataDir: this.deps.userDataDir,
        // Never --no-sandbox: a host without a usable sandbox degrades
        // instead (VERIFIER_UNAVAILABLE), it does not run authored HTML unsandboxed.
        args: [
          "--disable-gpu",
          "--no-first-run",
          "--disable-extensions",
          "--disable-background-networking",
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(NO_SANDBOX_MARKER)) throw new Error(NO_SANDBOX_MARKER, { cause: err });
      throw err;
    }
    browser.once("disconnected", () => {
      if (this.current === browser) this.discardBrowser("the verifier browser disconnected");
    });
    this.report("ready", null);
    return browser;
  }

  /** Drops the browser and its profile; listeners go with the Browser object. */
  private discardBrowser(reason: string | null): void {
    const browser = this.current;
    this.current = null;
    if (browser !== null) {
      browser.removeAllListeners();
      void browser.close().catch(() => undefined);
      try {
        const proc = browser.process();
        if (proc !== null && proc.exitCode === null) proc.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(this.deps.userDataDir, { recursive: true, force: true });
    } catch {
      // A profile Chrome still holds a lock on is reclaimed by the next mkdir/launch.
    }
    if (browser !== null && reason !== null) this.report("degraded", reason);
  }

  private report(state: VerifierHealth["state"], reason: string | null): void {
    this.deps.onHealth?.({ pin: null, sha256: null, state, reason, atMs: this.now() });
  }

  private armIdleTimer(): void {
    this.stopIdleTimer();
    if (this.disposed || this.current === null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const browser = this.current;
      this.current = null;
      if (browser === null) return;
      browser.removeAllListeners();
      void browser.close().catch(() => undefined);
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
