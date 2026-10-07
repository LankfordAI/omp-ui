import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcChildProcess } from "./rpc/client";
import {
  IDLE_PROVIDER_OAUTH_STATE,
  OAUTH_FLOW_TIMEOUT_MS,
  ProviderOAuth,
} from "./provider-oauth";
import type { ProviderCredential, ProviderOAuthState } from "./types";
import type { LoginProvider } from "./provider-catalog";

interface FakeProc {
  proc: RpcChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: () => boolean;
  exit: (code: number | void) => void;
}

function fakeProc(): FakeProc {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  let exitCb: ((code: number | null) => void) | undefined;
  return {
    proc: {
      stdin,
      stdout,
      stderr,
      kill: () => {
        killed = true;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      onSpawnError: () => {},
    },
    stdin,
    stdout,
    stderr,
    killed: () => killed,
    exit: (code) => exitCb?.(code ?? null),
  };
}

/** The transport's own handshake answer, mirroring omp v18.1.0. */
const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
};

const nextTick = (): Promise<void> => tick();

function credential(label: string, provider: string): ProviderCredential {
  return { credentialId: 11, provider, label, detail: "stored credential", type: "oauth", active: true };
}

type AccountsAnswer = { accounts: ProviderCredential[] } | { error: string };
type LogoutAnswer = { ok: true; remainingSource?: string } | { error: string };

/** The curated row answered as an available roster entry: what refresh() commits by default. */
const CODEX: LoginProvider = {
  id: "openai-codex",
  name: "ChatGPT Plus/Pro",
  available: true,
  authenticated: false,
};

interface Harness {
  oauth: ProviderOAuth;
  states: ProviderOAuthState[];
  /** Ordered log: `state:<phase>` publishes and `accounts` one answered accounts errand, for ordering assertions. */
  events: string[];
  spawnArgs: string[];
  stdinLines: object[];
  openedUrls: string[];
  /** Provider ids the discovery child was asked for via `get_logout_accounts`, in command order. */
  accountCalls: string[];
  logoutCalls: Array<{ providerId: string; credentialId: number }>;
  frame: (f: unknown) => void;
  /** Write a raw stdout line (no frame validation) — e.g. an oversized one. */
  raw: (line: string) => void;
  exit: (code: number) => void;
  scratchDir: string;
  /** Make the next start() throw at spawn; later spawns succeed. */
  failNextSpawn: boolean;
  /** null answers the roster as a failed command — a transport failure for the read. */
  setProviders: (providers: LoginProvider[] | null) => void;
  /** Answer the per-id `get_logout_accounts` errands; defaults to empty lists. */
  setAccounts: (fn: (providerId: string) => AccountsAnswer) => void;
  /** Answer the rpc `logout` command; defaults to a plain success. */
  setLogout: (fn: (call: { providerId: string; credentialId: number }) => LogoutAnswer) => void;
  setOmpPath: (ompPath: string | null) => void;
  spawnCount: () => number;
  discoveryCount: () => number;
  discoveryKilled: () => boolean;
  /** Hold the next roster answer; the returned function delivers it. */
  deferDiscovery: () => (providers: LoginProvider[] | null) => void;
  /** Hold every `get_logout_accounts` answer; the returned function delivers them. */
  deferAccounts: () => () => void;
}

const harnesses: Harness[] = [];
function harness(opts: {
  ompPath?: string | null;
  providers?: LoginProvider[] | null;
} = {}): Harness {
  let fake = fakeProc();
  let loginFake: FakeProc | null = null;
  let discoveryFake: FakeProc | null = null;
  let providers = opts.providers === undefined ? [CODEX] : opts.providers;
  let ompPath = opts.ompPath === undefined ? "/opt/omp" : opts.ompPath;
  let spawnCount = 0;
  let discoveryCount = 0;
  let holdDiscovery = false;
  let holdAccounts = false;
  let pendingDiscovery: ((rows: LoginProvider[] | null) => void) | null = null;
  const pendingAccounts: Array<() => void> = [];
  let accountsFor: (providerId: string) => AccountsAnswer = () => ({ accounts: [] });
  let logoutFor: (call: { providerId: string; credentialId: number }) => LogoutAnswer = () => ({ ok: true });
  const states: ProviderOAuthState[] = [];
  const events: string[] = [];
  const openedUrls: string[] = [];
  const accountCalls: string[] = [];
  const logoutCalls: Array<{ providerId: string; credentialId: number }> = [];
  const stdinLines: object[] = [];
  let spawnArgs: string[] = [];
  let failNext = false;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-login-"));
  const attach = (child: FakeProc): void => {
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        const command = JSON.parse(line) as {
          type: string;
          id?: string;
          providerId?: string;
          credentialId?: number;
        };
        if (command.type === "get_login_providers") {
          discoveryFake = child;
          discoveryCount++;
          const answer = (rows: LoginProvider[] | null): void => {
            queueMicrotask(() => child.stdout.write(`${JSON.stringify({
              id: command.id, type: "response", command: "get_login_providers",
              success: rows !== null,
              ...(rows === null ? { error: "unknown command" } : { data: { providers: rows } }),
            })}\n`));
          };
          if (holdDiscovery) {
            holdDiscovery = false;
            pendingDiscovery = answer;
          } else answer(providers);
        } else if (command.type === "get_logout_accounts" && typeof command.id === "string") {
          const providerId = command.providerId ?? "";
          accountCalls.push(providerId);
          const respond = (): void => {
            const answer = accountsFor(providerId);
            events.push("accounts");
            queueMicrotask(() => child.stdout.write(`${JSON.stringify({
              id: command.id, type: "response", command: "get_logout_accounts",
              success: "accounts" in answer,
              ...("accounts" in answer
                ? { data: { accounts: answer.accounts } }
                : { error: answer.error }),
            })}\n`));
          };
          if (holdAccounts) pendingAccounts.push(respond);
          else respond();
        } else if (command.type === "logout" && typeof command.id === "string") {
          const call = { providerId: command.providerId ?? "", credentialId: command.credentialId ?? 0 };
          logoutCalls.push(call);
          const answer = logoutFor(call);
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({
            id: command.id, type: "response", command: "logout",
            success: "ok" in answer,
            ...("ok" in answer
              ? { data: answer.remainingSource === undefined ? {} : { remainingSource: answer.remainingSource } }
              : { error: answer.error }),
          })}\n`));
        } else {
          if (command.type === "login") loginFake = child;
          // Discovery negotiation is not part of the human sign-in stream.
          if (command.type !== "negotiate_protocol" || child === fake) stdinLines.push(command);
        }
      }
    });
  };
  const oauth = new ProviderOAuth({
    getOmpPath: () => ompPath,
    scratchDir,
    send: (state) => {
      states.push(state);
      events.push(`state:${state.phase}`);
    },
    onOpenUrl: (url) => openedUrls.push(url),
    spawnProcess: (_cmd, args) => {
      spawnCount++;
      spawnArgs = args;
      if (failNext) {
        failNext = false;
        throw new Error("ENOENT: no such file or directory");
      }
      fake = fakeProc();
      const child = fake;
      attach(child);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(READY)}\n`));
      return child.proc;
    },
  });
  const result: Harness = {
    oauth,
    states,
    events,
    accountCalls,
    logoutCalls,
    get spawnArgs() {
      return spawnArgs;
    },
    stdinLines,
    openedUrls,
    frame: (f) => {
      const ready = f !== null && typeof f === "object" && "type" in f && f.type === "ready";
      (ready ? fake : loginFake ?? fake).stdout.write(`${JSON.stringify(f)}\n`);
    },
    raw: (line) => (loginFake ?? fake).stdout.write(`${line}\n`),
    exit: (code) => (loginFake ?? fake).exit(code),
    scratchDir,
    get failNextSpawn() {
      return failNext;
    },
    set failNextSpawn(v: boolean) {
      failNext = v;
    },
    setProviders(rows) { providers = rows; },
    setAccounts(fn) { accountsFor = fn; },
    setLogout(fn) { logoutFor = fn; },
    setOmpPath(value) { ompPath = value; },
    spawnCount: () => spawnCount,
    discoveryCount: () => discoveryCount,
    discoveryKilled: () => discoveryFake?.killed() ?? false,
    deferDiscovery() {
      holdDiscovery = true;
      return (rows) => {
        if (pendingDiscovery === null) throw new Error("discovery has not started");
        pendingDiscovery(rows);
        pendingDiscovery = null;
      };
    },
    deferAccounts() {
      holdAccounts = true;
      return () => {
        holdAccounts = false;
        for (const respond of pendingAccounts.splice(0)) respond();
      };
    },
  };
  harnesses.push(result);
  return result;
}

/** ready + sign-in URL, so the flow sits in the browser phase. */
async function startAtBrowser(h: Harness, url = "https://chatgpt.com/auth") {
  h.oauth.start("openai-codex");
  h.frame(READY);
  await nextTick();
  h.frame({
    type: "extension_ui_request",
    id: "r1",
    method: "open_url",
    url,
    instructions: "Finish signing in",
  });
  await nextTick();
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.oauth.dispose();
    fs.rmSync(h.scratchDir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe("refresh", () => {
  it("a failed roster read answers from the static catalog with no accounts", async () => {
    const h = harness({ providers: null });
    const rows = await h.oauth.refresh();
    expect(rows.map((row) => row.providerId)).toEqual(["openai-codex"]);
    expect(rows[0].credentials).toEqual([]);
    expect(rows[0].accountsUnsupported).toBe(false);
    expect(h.oauth.hasModelAccount()).toBe(false);
    expect(h.discoveryKilled()).toBe(true);
  });

  it("without an omp binary nothing spawns", async () => {
    const h = harness({ ompPath: null });
    const rows = await h.oauth.refresh();
    expect(h.spawnCount()).toBe(0);
    expect(rows[0].credentials).toEqual([]);
  });

  it("an omp without get_logout_accounts keeps the roster but reports status unknown", async () => {
    const h = harness();
    h.setAccounts(() => ({ error: "Unknown command: get_logout_accounts" }));
    const rows = await h.oauth.refresh();
    expect(rows.map((row) => row.providerId)).toEqual(["openai-codex"]);
    expect(rows[0].credentials).toEqual([]);
    expect(rows[0].accountsUnsupported).toBe(true);
  });
});

describe("start", () => {
  it("spawns a bare rpc-ui child in the scratch dir and logs in after ready", async () => {
    const h = harness();
    h.oauth.start("openai-codex");
    expect(h.states[0]).toMatchObject({ providerId: "openai-codex", phase: "starting" });
    expect(h.spawnArgs.slice(0, 5)).toEqual(["--mode=rpc-ui", "--cwd", h.scratchDir, "--session-dir", h.scratchDir]);
    expect(h.spawnArgs.slice(5)).toEqual([
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-lsp",
      "--no-skills",
      "--no-rules",
    ]);
    h.frame(READY);
    await nextTick();
    expect(h.stdinLines).toEqual([
      { type: "negotiate_protocol", protocolVersion: 2 },
      { type: "login", providerId: "openai-codex" },
    ]);
    h.oauth.dispose();
  });

  it("rejects an unknown provider before spawning and a second flow while one runs", () => {
    const h = harness();
    expect(() => h.oauth.start("nope")).toThrow();
    expect(h.spawnArgs).toEqual([]);
    h.oauth.start("openai-codex");
    expect(() => h.oauth.start("openai-codex")).toThrow("already in progress");
    h.oauth.dispose();
  });

  it("without an omp binary it rejects", () => {
    const h = harness({ ompPath: null });
    expect(() => h.oauth.start("openai-codex")).toThrow("omp binary not found");
  });

  it("a synchronous spawn failure installs no flow: retryable, and cancel() stays safe", () => {
    const h = harness();
    h.failNextSpawn = true;
    expect(() => h.oauth.start("openai-codex")).toThrow("ENOENT");
    // Nothing was published and no flow was installed: a second start
    // is not "already in progress", and cancel() must not touch the dead child.
    expect(h.states).toEqual([]);
    expect(() => h.oauth.start("openai-codex")).not.toThrow(/already in progress/);
    expect(() => h.oauth.cancel()).not.toThrow();
    h.oauth.dispose();
  });

  it("a failed restart does not suppress the previous flow's in-flight done publish", async () => {
    const h = harness();
    const finishAccounts = h.deferAccounts();
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    // Flow A is settled but its account read is still in flight. Flow B's
    // spawn fails: installing no flow, it must not invalidate A's completion.
    h.failNextSpawn = true;
    expect(() => h.oauth.start("openai-codex")).toThrow("ENOENT");
    h.setAccounts(() => ({ accounts: [credential("me@example.com", "openai-codex")] }));
    finishAccounts();
    await nextTick();
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "done", prompt: null });
    expect(h.oauth.statuses()[0].credentials).toEqual([credential("me@example.com", "openai-codex")]);
    h.oauth.dispose();
  });
});

describe("open_url frame", () => {
  it("confirms, publishes the browser phase, and opens the URL once", async () => {
    const h = harness();
    await startAtBrowser(h, "https://chatgpt.com/auth?x=1");
    expect(h.stdinLines).toContainEqual({ type: "extension_ui_response", id: "r1", confirmed: true });
    expect(h.openedUrls).toEqual(["https://chatgpt.com/auth?x=1"]);
    expect(h.states.at(-1)).toMatchObject({
      phase: "browser",
      url: "https://chatgpt.com/auth?x=1",
      instructions: "Finish signing in",
    });
    h.oauth.dispose();
  });

  it("an empty URL cancels and fails the flow", async () => {
    const h = harness();
    h.oauth.start("openai-codex");
    h.frame(READY);
    await nextTick();
    h.frame({ type: "extension_ui_request", id: "r1", method: "open_url", url: "" });
    await nextTick();
    expect(h.stdinLines).toContainEqual({ type: "extension_ui_response", id: "r1", cancelled: true });
    expect(h.states.at(-1)).toMatchObject({ phase: "error", error: "omp sent no sign-in URL" });
  });
});

describe("unsolicited extension_ui_request", () => {
  it("is declined without changing state", async () => {
    const h = harness();
    await startAtBrowser(h);
    h.frame({ type: "extension_ui_request", id: "w1", method: "setWidget", widget: {} });
    await nextTick();
    expect(h.stdinLines).toContainEqual({ type: "extension_ui_response", id: "w1", cancelled: true });
    expect(h.states.at(-1)).toMatchObject({ phase: "browser" });
    h.oauth.dispose();
  });
});

describe("input prompt", () => {
  it("surfaces the prompt and submitInput answers it", async () => {
    const h = harness();
    await startAtBrowser(h);
    h.frame({
      type: "extension_ui_request",
      id: "i1",
      method: "input",
      title: "Paste the redirect URL",
      placeholder: "http://localhost:1455/…",
    });
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({
      phase: "input",
      prompt: { title: "Paste the redirect URL", placeholder: "http://localhost:1455/…" },
      url: "https://chatgpt.com/auth", // the link survives into the input phase
    });
    h.oauth.submitInput("http://localhost:1455/cb");
    expect(h.stdinLines).toContainEqual({
      type: "extension_ui_response",
      id: "i1",
      value: "http://localhost:1455/cb",
    });
    expect(h.states.at(-1)).toMatchObject({ phase: "browser", prompt: null });
    h.oauth.dispose();
  });

  it("submitInput with nothing pending throws", () => {
    const h = harness();
    expect(() => h.oauth.submitInput("x")).toThrow("omp is not waiting for input");
  });
});

describe("login response", () => {
  it("a stale account read cannot clobber a newer flow started after the login", async () => {
    const h = harness();
    const finishAccounts = h.deferAccounts();
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    // The first flow is settled; a new sign-in may already be running while
    // the first one's account read is still in flight.
    h.oauth.start("openai-codex");
    expect(h.states.at(-1)).toMatchObject({ phase: "starting" });
    h.setAccounts(() => ({ accounts: [credential("me@example.com", "openai-codex")] }));
    finishAccounts();
    await nextTick();
    await nextTick();
    // The stale completion must not have published done over the new flow.
    expect(h.states.at(-1)).toMatchObject({ phase: "starting" });
    h.oauth.dispose();
  });

  it("cancelling during the post-login read suppresses the late done publish", async () => {
    const h = harness();
    const finishAccounts = h.deferAccounts();
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    h.oauth.cancel();
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
    h.setAccounts(() => ({ accounts: [credential("me@example.com", "openai-codex")] }));
    finishAccounts();
    await nextTick();
    await nextTick();
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
  });

  it("success settles, refreshes accounts first, then publishes done", async () => {
    const h = harness();
    h.setAccounts(() => ({ accounts: [credential("me@example.com", "openai-codex")] }));
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    await nextTick();
    // The refresh ran before the done publish, so a page reading statuses on done sees the accounts.
    expect(h.events.indexOf("accounts")).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf("accounts")).toBeLessThan(h.events.indexOf("state:done"));
    expect(h.states.at(-1)).toMatchObject({ phase: "done", prompt: null, url: "https://chatgpt.com/auth" });
    expect(h.oauth.statuses()[0].credentials).toEqual([credential("me@example.com", "openai-codex")]);
    // The child exited (killed) — the late exit must not turn done into an error.
    h.exit(0);
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "done" });
  });

  it("failure publishes the error message and settles", async () => {
    const h = harness();
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: false, error: "Unknown OAuth provider: nope" });
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "error", error: "Unknown OAuth provider: nope" });
    // The settled flow ignores a follow-up exit.
    h.exit(1);
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "error" });
  });

  it("a child exit before any response is an error", async () => {
    const h = harness();
    h.oauth.start("openai-codex");
    h.frame(READY);
    await nextTick();
    h.exit(1);
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "error" });
    expect((h.states.at(-1) as ProviderOAuthState).error).toContain("omp exited");
  });

  it("a transport error is an error", async () => {
    const h = harness();
    h.oauth.start("openai-codex");
    h.frame(READY);
    await nextTick();
    h.raw("x".repeat(2 * 1024 * 1024)); // over the 1 MiB frame cap, no newline yet
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "error" });
    expect((h.states.at(-1) as ProviderOAuthState).error).toContain("1 MiB");
  });

  it("times out after 10 minutes", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.oauth.start("openai-codex");
    h.frame(READY);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS);
    expect(h.states.at(-1)).toMatchObject({ phase: "error", error: "sign-in timed out after 10 minutes" });
  });
});

describe("cancel", () => {
  it("during input, declines the prompt, kills the child, and goes idle", async () => {
    const h = harness();
    await startAtBrowser(h);
    h.frame({ type: "extension_ui_request", id: "i1", method: "input", title: "Paste it" });
    await nextTick();
    h.oauth.cancel();
    expect(h.stdinLines).toContainEqual({ type: "extension_ui_response", id: "i1", cancelled: true });
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
  });

  it("after done, merely dismisses", async () => {
    const h = harness();
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "done" });
    h.oauth.cancel();
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
  });

  it("with no flow, publishes idle", () => {
    const h = harness();
    h.oauth.cancel();
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
  });
});

describe("signOut", () => {
  it("removes one credential via rpc logout, then refreshes", async () => {
    const h = harness();
    const result = await h.oauth.signOut("openai-codex", 11);
    expect(h.logoutCalls).toEqual([{ providerId: "openai-codex", credentialId: 11 }]);
    expect(result.rows[0].credentials).toEqual([]);
    expect(result.remainingSource).toBeNull();
  });

  it("reports omp's remaining auth source verbatim", async () => {
    const h = harness();
    h.setLogout(() => ({ ok: true, remainingSource: "environment variable OPENAI_API_KEY" }));
    const result = await h.oauth.signOut("openai-codex", 11);
    expect(result.remainingSource).toBe("environment variable OPENAI_API_KEY");
  });

  it("rejects a failed logout with omp's message", async () => {
    const h = harness();
    h.setLogout(() => ({ error: "No credential 11 for openai-codex" }));
    await expect(h.oauth.signOut("openai-codex", 11)).rejects.toThrow("No credential 11 for openai-codex");
  });

  it("an omp without the logout verb gets a version message", async () => {
    const h = harness();
    h.setLogout(() => ({ error: "Unknown command: logout" }));
    await expect(h.oauth.signOut("openai-codex", 11)).rejects.toThrow(/requires omp .* or later/);
  });

  it("rejects with an unknown id, without a binary, or during a flow", async () => {
    const h = harness();
    await expect(h.oauth.signOut("nope", 1)).rejects.toThrow("unknown sign-in provider: nope");
    const h2 = harness({ ompPath: null });
    await expect(h2.oauth.signOut("openai-codex", 1)).rejects.toThrow("omp binary not found");
    const h3 = harness();
    h3.oauth.start("openai-codex");
    await expect(h3.oauth.signOut("openai-codex", 1)).rejects.toThrow("finish or cancel the sign-in first");
    expect(h3.logoutCalls).toEqual([]);
    h3.oauth.dispose();
  });
});

const factory: LoginProvider = { id: "factory-droid", name: "Factory Droid", available: true, authenticated: true };
const future: LoginProvider = { id: "future-provider", name: "Future Provider", available: true, authenticated: false };

describe("discovered sign-ins", () => {
  it("reads accounts for every roster id, not just authenticated ones", async () => {
    const h = harness({ providers: [factory, future] });
    const rows = await h.oauth.refresh();
    expect(rows.map((row) => [row.providerId, row.credentials])).toEqual([
      ["factory-droid", []], ["future-provider", []],
    ]);
    expect(h.accountCalls).toEqual(["factory-droid", "future-provider"]);
    expect(h.oauth.hasModelAccount()).toBe(false);
    h.setAccounts((providerId) =>
      providerId === "factory-droid" ? { accounts: [credential("factory@example.com", "factory-droid")] } : { accounts: [] },
    );
    await h.oauth.refresh();
    expect(h.oauth.statuses()[0].credentials).toEqual([credential("factory@example.com", "factory-droid")]);
    expect(h.oauth.hasModelAccount()).toBe(true);
  });

  it("an alias roster row shows the credential omp stored under the canonical id (#779)", async () => {
    const h = harness({ providers: [{ id: "openai-codex-device", name: "ChatGPT Device", available: true, authenticated: true }] });
    h.setAccounts(() => ({ accounts: [credential("me@example.com", "openai-codex")] }));
    const rows = await h.oauth.refresh();
    expect(rows[0].providerId).toBe("openai-codex-device");
    expect(rows[0].credentials[0].provider).toBe("openai-codex");
    expect(h.oauth.hasModelAccount()).toBe(true);
  });

  it("an unknown-to-omp-ui provider completes a browser/input flow before publishing its identity", async () => {
    const h = harness({ providers: [future] });
    h.setAccounts(() => ({ accounts: [credential("future@example.com", "future-provider")] }));
    await h.oauth.refresh();
    h.oauth.start(future.id);
    await nextTick();
    h.frame({ type: "extension_ui_request", id: "url", method: "open_url", url: "https://example.com/device", instructions: "Enter code" });
    h.frame({ type: "extension_ui_request", id: "input", method: "input", title: "Paste code" });
    expect(h.oauth.state).toMatchObject({ providerId: future.id, phase: "input", instructions: "Enter code" });
    h.oauth.submitInput("response");
    expect(h.oauth.state.phase).toBe("browser");
    h.frame({ type: "response", command: "login", success: true });
    await nextTick();
    await nextTick();
    expect(h.oauth.state.phase).toBe("done");
    expect(h.oauth.statuses()[0].credentials).toEqual([credential("future@example.com", "future-provider")]);
    expect(h.events.indexOf("accounts")).toBeLessThan(h.events.indexOf("state:done"));
    expect(h.accountCalls).toContain(future.id);
    expect(() => h.oauth.start("unlisted")).toThrow();
  });

  it("signs Factory out through the discovered lookup and replaces its account snapshot", async () => {
    const h = harness({ providers: [factory] });
    let signedOut = false;
    h.setAccounts((providerId) =>
      !signedOut && providerId === "factory-droid"
        ? { accounts: [credential("factory@example.com", "factory-droid")] }
        : { accounts: [] },
    );
    await h.oauth.refresh();
    expect(h.oauth.hasModelAccount()).toBe(true);
    h.setLogout(() => {
      signedOut = true;
      h.setProviders([{ ...factory, authenticated: false }]);
      return { ok: true };
    });
    const result = await h.oauth.signOut(factory.id, 11);
    expect(result.rows[0].credentials).toEqual([]);
    expect(h.oauth.hasModelAccount()).toBe(false);
    expect(h.logoutCalls).toEqual([{ providerId: "factory-droid", credentialId: 11 }]);
  });

  it("retains same-binary discovery on failure but removes disappeared rows on a valid roster", async () => {
    const h = harness({ providers: [factory] });
    await h.oauth.refresh();
    h.setProviders(null);
    expect((await h.oauth.refresh())[0].providerId).toBe(factory.id);
    h.oauth.start(factory.id);
    h.oauth.cancel();
    h.setProviders([]);
    expect(await h.oauth.refresh()).toEqual([]);
    expect(h.oauth.hasModelAccount()).toBe(false);
    expect(() => h.oauth.start(factory.id)).toThrow();
  });

  it("never inherits another binary's discovered catalog", async () => {
    const h = harness({ providers: [factory] });
    await h.oauth.refresh();
    h.setOmpPath("/other/omp");
    h.setProviders(null);
    const rows = await h.oauth.refresh();
    expect(rows.map((row) => row.providerId)).toEqual(["openai-codex"]);
    expect(() => h.oauth.start(factory.id)).toThrow();
  });

  it("shares concurrent reads while preserving atomic account publication", async () => {
    const h = harness({ providers: [factory] });
    h.setAccounts(() => ({ accounts: [credential("factory@example.com", "factory-droid")] }));
    const finishAccounts = h.deferAccounts();
    const first = h.oauth.refresh();
    const second = h.oauth.refresh();
    await nextTick();
    expect(h.discoveryCount()).toBe(1);
    expect(h.oauth.statuses().some((row) => row.providerId === factory.id)).toBe(false);
    finishAccounts();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a[0].credentials).toEqual([credential("factory@example.com", "factory-droid")]);
  });

  it("a newer binary read wins over an old delayed read", async () => {
    const h = harness({ providers: [factory] });
    h.setAccounts((providerId) =>
      providerId === "factory-droid" ? { accounts: [credential("stale@example.com", "factory-droid")] } : { accounts: [] },
    );
    const finishOld = h.deferDiscovery();
    const older = h.oauth.refresh();
    await nextTick();
    h.setOmpPath("/new/omp");
    h.setProviders([future]);
    await h.oauth.refresh();
    finishOld([factory]);
    await older;
    expect(h.oauth.statuses().map((row) => row.providerId)).toEqual([future.id]);
    expect(h.oauth.hasModelAccount()).toBe(false);
  });

  it("login completion drains the pre-login read then samples fresh accounts", async () => {
    const h = harness({ providers: [{ ...factory, authenticated: false }] });
    await h.oauth.refresh();
    h.setAccounts(() => ({ accounts: [credential("before@example.com", "factory-droid")] }));
    const finishOld = h.deferDiscovery();
    const older = h.oauth.refresh();
    await nextTick();
    h.oauth.start(factory.id);
    await nextTick();
    h.frame({ type: "response", command: "login", success: true });
    await nextTick();
    expect(h.oauth.state.phase).toBe("starting");
    h.setAccounts(() => ({ accounts: [credential("fresh@example.com", "factory-droid")] }));
    finishOld([{ ...factory, authenticated: false }]);
    await older;
    await nextTick();
    expect(h.oauth.state.phase).toBe("done");
    expect(h.oauth.statuses()[0].credentials).toEqual([credential("fresh@example.com", "factory-droid")]);
    expect(h.discoveryCount()).toBe(3);
  });

  it("a superseded mutation refresh cannot publish done before a forced identity snapshot", async () => {
    const h = harness({ providers: [{ ...factory, authenticated: false }] });
    h.setAccounts(() => ({ accounts: [credential("fresh@example.com", "factory-droid")] }));
    await h.oauth.refresh();
    h.oauth.start(factory.id);
    await nextTick();
    h.deferDiscovery();
    h.frame({ type: "response", command: "login", success: true });
    await nextTick();
    h.setOmpPath("/new/omp");
    const finishReplacement = h.deferDiscovery();
    const replacement = h.oauth.refresh();
    await nextTick();
    expect(h.oauth.state.phase).not.toBe("done");
    finishReplacement([{ ...factory, authenticated: false }]);
    await replacement;
    await nextTick();
    expect(h.oauth.state.phase).toBe("done");
    expect(h.oauth.statuses()[0].credentials).toEqual([credential("fresh@example.com", "factory-droid")]);
  });

  it("logout does not reuse an older account read", async () => {
    const h = harness({ providers: [factory] });
    let signedOut = false;
    h.setAccounts((providerId) =>
      !signedOut && providerId === "factory-droid"
        ? { accounts: [credential("before@example.com", "factory-droid")] }
        : { accounts: [] },
    );
    await h.oauth.refresh();
    expect(h.oauth.hasModelAccount()).toBe(true);
    const finishOld = h.deferDiscovery();
    const finishAccounts = h.deferAccounts();
    const older = h.oauth.refresh();
    await nextTick();
    h.setLogout(() => {
      signedOut = true;
      h.setProviders([{ ...factory, authenticated: false }]);
      return { ok: true };
    });
    const logout = h.oauth.signOut(factory.id, 11);
    finishOld([factory]);
    await nextTick();
    finishAccounts();
    await older;
    expect((await logout).rows[0].credentials).toEqual([]);
    expect(h.oauth.hasModelAccount()).toBe(false);
  });

  it("teardown aborts discovery and prevents later publication or new flows", async () => {
    const h = harness({ providers: [factory] });
    const finish = h.deferDiscovery();
    const pending = h.oauth.refresh();
    await nextTick();
    h.oauth.dispose();
    expect(h.discoveryKilled()).toBe(true);
    finish([factory]);
    await pending;
    expect(h.oauth.statuses().map((row) => row.providerId)).toEqual(["openai-codex"]);
    await expect(h.oauth.refresh()).rejects.toThrow();
    expect(() => h.oauth.start(factory.id)).toThrow();
  });
});
