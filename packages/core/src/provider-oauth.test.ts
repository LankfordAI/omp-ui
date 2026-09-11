import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcChildProcess } from "./rpc/client";
import {
  OAUTH_FLOW_TIMEOUT_MS,
  IDLE_PROVIDER_OAUTH_STATE,
  ProviderOAuth,
  parseOAuthAccountList,
} from "./provider-oauth";
import type { ProviderOAuthState } from "./types";

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

interface Harness {
  oauth: ProviderOAuth;
  states: ProviderOAuthState[];
  /** Ordered log: `state:<phase>` publishes and `run:<argv0>` one-shot runs, for ordering assertions. */
  events: string[];
  runCalls: Array<{ argv: string[] }>;
  spawnArgs: string[];
  stdinLines: object[];
  openedUrls: string[];
  frame: (f: unknown) => void;
  /** Write a raw stdout line (no frame validation) — e.g. an oversized one. */
  raw: (line: string) => void;
  exit: (code: number) => void;
  scratchDir: string;
  /** Set to make the next start() throw at spawn; later spawns succeed (one fake process is shared). */
  failNextSpawn: boolean;
  /** Swap the one-shot `omp token --list` runner for a deferred/rejecting one. */
  setListRun: (fn: () => Promise<string | null>) => void;
}

function harness(opts: {
  ompPath?: string | null;
  listOutput?: string | null;
  logoutOutput?: string | null;
} = {}): Harness {
  const fake = fakeProc();
  const states: ProviderOAuthState[] = [];
  const events: string[] = [];
  const runCalls: Array<{ argv: string[] }> = [];
  const openedUrls: string[] = [];
  const stdinLines: object[] = [];
  let spawnArgs: string[] = [];
  let failNext = false;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-login-"));
  fake.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() !== "") stdinLines.push(JSON.parse(line) as object);
    }
  });
  let oauthRun: (o: { argv: string[] }) => Promise<string | null> = async (o) => {
    runCalls.push({ argv: o.argv });
    events.push(`run:${o.argv[0]}`);
    return o.argv[0] === "auth-broker"
      ? (opts.logoutOutput === undefined ? "Logged out of openai-codex" : opts.logoutOutput)
      : (opts.listOutput ?? null);
  };
  const oauth = new ProviderOAuth({
    getOmpPath: () => (opts.ompPath === undefined ? "/opt/omp" : opts.ompPath),
    scratchDir,
    send: (state) => {
      states.push(state);
      events.push(`state:${state.phase}`);
    },
    onOpenUrl: (url) => openedUrls.push(url),
    run: (o) => oauthRun(o),
    spawnProcess: (_cmd, args) => {
      spawnArgs = args;
      if (failNext) {
        failNext = false;
        throw new Error("ENOENT: no such file or directory");
      }
      return fake.proc;
    },
  });
  return {
    oauth,
    states,
    events,
    runCalls,
    get spawnArgs() {
      return spawnArgs;
    },
    stdinLines,
    openedUrls,
    frame: (f) => fake.stdout.write(`${JSON.stringify(f)}\n`),
    raw: (line) => fake.stdout.write(`${line}\n`),
    exit: (code) => fake.exit(code),
    scratchDir,
    get failNextSpawn() {
      return failNext;
    },
    set failNextSpawn(v: boolean) {
      failNext = v;
    },
    setListRun(fn) {
      oauthRun = async () => {
        events.push("run:token");
        return fn();
      };
    },
  };
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
  vi.useRealTimers();
});

describe("parseOAuthAccountList", () => {
  it("keeps numbered identity lines and ignores the rest", () => {
    expect(parseOAuthAccountList("1. a@b.com (Org)\n2. c@d.com\n")).toEqual([
      "a@b.com (Org)",
      "c@d.com",
    ]);
    expect(parseOAuthAccountList("\nNo OAuth accounts found for provider \"openai-codex\"\n")).toEqual([]);
  });
});

describe("refresh", () => {
  it("runs `omp token <id> --list` per catalogued provider", async () => {
    const h = harness({ listOutput: "1. me@example.com\n" });
    const rows = await h.oauth.refresh();
    expect(h.runCalls).toEqual([{ argv: ["token", "openai-codex", "--list"] }]);
    expect(rows).toEqual([
      {
        id: "openai-codex",
        providerId: "openai-codex",
        label: "ChatGPT Plus/Pro",
        hint: expect.any(String),
        accounts: ["me@example.com"],
      },
    ]);
    expect(h.oauth.hasModelAccount()).toBe(true);
  });

  it("a missing list reads as no accounts", async () => {
    const h = harness({ listOutput: null });
    const rows = await h.oauth.refresh();
    expect(rows[0].accounts).toEqual([]);
    expect(h.oauth.hasModelAccount()).toBe(false);
  });

  it("without an omp binary nothing is run", async () => {
    const h = harness({ ompPath: null });
    const rows = await h.oauth.refresh();
    expect(h.runCalls).toEqual([]);
    expect(rows[0].accounts).toEqual([]);
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
    expect(() => h.oauth.start("nope")).toThrow("unknown subscription provider: nope");
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
    let resolveList: (v: string | null) => void = () => {};
    h.setListRun(() => new Promise((res) => (resolveList = res)));
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    // Flow A is settled but its account read is still in flight. Flow B's
    // spawn fails: installing no flow, it must not invalidate A's completion.
    h.failNextSpawn = true;
    expect(() => h.oauth.start("openai-codex")).toThrow("ENOENT");
    resolveList("1. me@example.com\n");
    await nextTick();
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({ phase: "done", prompt: null });
    expect(h.oauth.statuses()[0]!.accounts).toEqual(["me@example.com"]);
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
    let resolveList: (v: string | null) => void = () => {};
    h.setListRun(() => new Promise((res) => (resolveList = res)));
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    // The first flow is settled; a new sign-in may already be running while
    // the first one's account read is still in flight.
    h.oauth.start("openai-codex");
    expect(h.states.at(-1)).toMatchObject({ phase: "starting" });
    resolveList("1. me@example.com\n");
    await nextTick();
    await nextTick();
    // The stale completion must not have published done over the new flow.
    expect(h.states.at(-1)).toMatchObject({ phase: "starting" });
    h.oauth.dispose();
  });

  it("cancelling during the post-login read suppresses the late done publish", async () => {
    const h = harness();
    let resolveList: (v: string | null) => void = () => {};
    h.setListRun(() => new Promise((res) => (resolveList = res)));
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    h.oauth.cancel();
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
    resolveList("1. me@example.com\n");
    await nextTick();
    await nextTick();
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
  });

  it("a failing account read after success publishes an error, not a stuck flow", async () => {
    const h = harness();
    h.setListRun(() => Promise.reject(new Error("pipe closed")));
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    await nextTick();
    expect(h.states.at(-1)).toMatchObject({
      phase: "error",
      error: "sign-in finished, but the account read failed: pipe closed",
    });
    // The error is terminal: the page can dismiss it and start again.
    h.oauth.cancel();
    expect(h.states.at(-1)).toEqual(IDLE_PROVIDER_OAUTH_STATE);
  });
  it("success settles, refreshes accounts first, then publishes done", async () => {
    const h = harness({ listOutput: "1. me@example.com\n" });
    await startAtBrowser(h);
    h.frame({ type: "response", command: "login", success: true, data: { providerId: "openai-codex" } });
    await nextTick();
    await nextTick();
    // The refresh ran before the done publish, so a page reading statuses on done sees the account.
    expect(h.events.indexOf("run:token")).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf("run:token")).toBeLessThan(h.events.indexOf("state:done"));
    expect(h.states.at(-1)).toMatchObject({ phase: "done", prompt: null, url: "https://chatgpt.com/auth" });
    expect(h.oauth.statuses()[0].accounts).toEqual(["me@example.com"]);
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
    const h = harness({ listOutput: "1. me@example.com\n" });
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
  it("logs out via the auth broker, then refreshes", async () => {
    const h = harness({ listOutput: null });
    const rows = await h.oauth.signOut("openai-codex");
    expect(h.runCalls.map((c) => c.argv)).toEqual([
      ["auth-broker", "logout", "openai-codex"],
      ["token", "openai-codex", "--list"],
    ]);
    expect(rows[0].accounts).toEqual([]);
  });

  it("rejects when the logout fails, with an unknown id, or during a flow", async () => {
    const h = harness({ logoutOutput: null });
    await expect(h.oauth.signOut("openai-codex")).rejects.toThrow("omp could not sign out of ChatGPT Plus/Pro");
    const h2 = harness();
    await expect(h2.oauth.signOut("nope")).rejects.toThrow("unknown subscription provider: nope");
    const h3 = harness();
    h3.oauth.start("openai-codex");
    await expect(h3.oauth.signOut("openai-codex")).rejects.toThrow("finish or cancel the sign-in first");
    h3.oauth.dispose();
  });
});
