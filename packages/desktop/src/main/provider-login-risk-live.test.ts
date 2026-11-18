import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  OAUTH_LOGIN_RISK_NAME_SUFFIX,
  ProviderOAuth,
  compareVersions,
  oauthLoginRiskFromRosterName,
  readInstalledOmpVersion,
  resolveOmpBinary,
  supportsRpcRiskLogin,
  type ProviderOAuthState,
} from "@omp-ui/core";

/**
 * Pins issue #1197 to the REAL `omp --mode rpc` wire: since upstream #19527
 * (omp 18.22.1) the account-risk warning a `login-warning` provider asks before
 * any auth URL arrives is delivered to RPC hosts as an ordinary
 * `extension_ui_request` `input`, so omp-ui can drive the whole sign-in over
 * RPC instead of shelling out to `omp login`.
 *
 * The flow runs through `ProviderOAuth` itself — the same bare child and frames
 * production uses. The answer is deliberately not "yes", so the login ends on
 * omp's own "Login cancelled": no provider account is touched and no browser
 * page is opened. omp's own risk roster row (`antigravity-cli`) supplies the
 * prompt; if upstream ever drops that row, the first test fails with a named
 * error instead of skipping quietly.
 *
 * Skips without an omp binary, and per test below omp 18.22.1, where the
 * routing landed; on an older binary the same flow is asserted to refuse.
 */

const ompPath = resolveOmpBinary();
/** The first omp whose rpc `login` answers the risk prompt for RPC hosts. */
const RPC_RISK_LOGIN_FLOOR = "18.22.1";
/** A live roster row that carries omp's login-warning rule. */
const RISK_PROVIDER_ID = "antigravity-cli";

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  // A real process is the thing waited on, so a real timer is the only clock.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls a condition an OS process drives; fake timers cannot advance it. */
async function pollUntil<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

interface Scope {
  oauth: ProviderOAuth;
  scratchDir: string;
  /** Every state main would publish to the renderer, in order. */
  states: ProviderOAuthState[];
}

/** A real sign-in flow over one bare rpc child, exactly as MainBackend runs it. */
function liveScope(): Scope {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-login-risk-live-"));
  const states: ProviderOAuthState[] = [];
  const oauth = new ProviderOAuth({
    getOmpPath: () => ompPath,
    scratchDir,
    send: (state) => states.push(state),
    // The proof stops at the risk prompt; a URL must never be launched.
    onOpenUrl: () => {
      throw new Error("the live proof must never reach a browser URL");
    },
  });
  return { oauth, scratchDir, states };
}

const isInputPrompt = (
  state: ProviderOAuthState,
): state is ProviderOAuthState & { prompt: NonNullable<ProviderOAuthState["prompt"]> } =>
  state.phase === "input" && state.prompt !== null;

let scope: Scope | null = null;
afterEach(() => {
  if (scope !== null) {
    scope.oauth.dispose();
    // rmSync retries cover the child still holding its cwd for a moment.
    fs.rmSync(scope.scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    scope = null;
  }
});

describe.skipIf(ompPath === null)("omp's rpc login risk prompt on the real runtime (#1197)", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });

  it("classifies the risk row from omp's own live roster under the version gate", async () => {
    const h = liveScope();
    scope = h;
    const rows = await h.oauth.refresh();
    const risky = rows.find((row) => row.providerId === RISK_PROVIDER_ID);
    expect(risky, `omp ${version ?? "?"} must still offer ${RISK_PROVIDER_ID}`).toBeDefined();
    // The suffix is omp-ui's classification marker; if upstream renames it, this fails.
    expect(oauthLoginRiskFromRosterName(`${risky?.label}${OAUTH_LOGIN_RISK_NAME_SUFFIX}`)).toBe(true);
    if (supportsRpcRiskLogin(version)) {
      expect(risky).not.toHaveProperty("requiresTerminalLogin");
      expect(h.oauth.terminalLoginProviderIds()).not.toContain(RISK_PROVIDER_ID);
    } else {
      expect(version === null || compareVersions(version, RPC_RISK_LOGIN_FLOOR) < 0).toBe(true);
      expect(risky?.requiresTerminalLogin).toBe(true);
      expect(h.oauth.terminalLoginProviderIds()).toContain(RISK_PROVIDER_ID);
    }
  });

  it("routes the risk prompt to this host as an input frame and cancels on a refusal", async () => {
    const h = liveScope();
    scope = h;
    await h.oauth.refresh();
    if (!supportsRpcRiskLogin(version)) {
      // Below the floor omp rejects the pre-auth prompt outright: start() must
      // refuse with the terminal command, spawning no login child.
      expect(() => h.oauth.start(RISK_PROVIDER_ID)).toThrow(/omp login/);
      return;
    }
    h.oauth.start(RISK_PROVIDER_ID);

    // omp delivers the warning as a plain input: full text as title, "yes" as
    // the placeholder (upstream rpc-mode.ts, the `login` case).
    const promptState = await pollUntil(
      () => h.states.find(isInputPrompt),
      60_000,
      "the risk-warning input frame",
    );
    expect(promptState.prompt.title).toContain("at your own risk");
    expect(promptState.prompt.placeholder).toBe("yes");

    // Refusing ends the login without a credential and without a browser page.
    // (submitInput optimistically shows the browser phase, like the paste-code
    // path does; the marker that matters is that no URL ever arrived.)
    h.oauth.submitInput("no");
    const failed = await pollUntil(
      () => h.states.find((state) => state.phase === "error"),
      30_000,
      "omp's cancelled-login response",
    );
    expect(failed.error ?? "").toMatch(/Login cancelled/i);
    expect(h.states.some((state) => state.url !== null)).toBe(false);
  });
});
