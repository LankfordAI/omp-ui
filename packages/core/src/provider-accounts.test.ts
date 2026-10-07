import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthProviderSpecs, type LoginProvider } from "./provider-catalog";
import {
  LOGOUT_ACCOUNTS_MIN_OMP,
  logoutCredential,
  readProviderAccounts,
} from "./provider-accounts";
import type { RpcChildProcess, RpcSpawnFn } from "./rpc/client";

const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
};
const FACTORY: LoginProvider = {
  id: "factory-droid",
  name: "Factory Droid",
  available: true,
  authenticated: false,
};
const FUTURE: LoginProvider = {
  id: "future-provider",
  name: "Future Provider",
  available: true,
  authenticated: true,
};
/** The shape omp v18.7.0's `get_logout_accounts` answers. */
const ACCOUNT = {
  credentialId: 11,
  provider: "factory-droid",
  label: "me@example.com (Org)",
  detail: "Codex subscription",
  type: "oauth",
  active: true,
};

const scratchDirs: string[] = [];

function harness(opts: {
  ompPath?: string | null;
  signal?: AbortSignal;
  spawnError?: boolean;
  duringSpawn?: () => void;
} = {}) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-accounts-"));
  scratchDirs.push(scratchDir);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: Record<string, unknown>[] = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line !== "") commands.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const kill = vi.fn();
  let exit: ((code: number | null) => void) | undefined;
  let spawnError: ((error: Error) => void) | undefined;
  const proc: RpcChildProcess = {
    stdin,
    stdout,
    stderr,
    kill,
    onExit: (cb) => { exit = cb; },
    onSpawnError: (cb) => { spawnError = cb; },
  };
  const spawnProcess = vi.fn<RpcSpawnFn>(() => {
    if (opts.spawnError) throw new Error("synthetic private spawn diagnostic");
    opts.duringSpawn?.();
    return proc;
  });
  const result = readProviderAccounts({
    ompPath: opts.ompPath === undefined ? "/opt/omp" : opts.ompPath,
    scratchDir,
    spawnProcess,
    signal: opts.signal,
  });
  return {
    result,
    scratchDir,
    spawnProcess,
    commands,
    kill,
    stdout,
    stderr,
    frame: (frame: unknown) => stdout.write(`${JSON.stringify(frame)}\n`),
    respond: (data: unknown, overrides: Record<string, unknown> = {}) => stdout.write(`${JSON.stringify({
      type: "response",
      id: "provider-accounts-roster",
      command: "get_login_providers",
      success: true,
      data,
      ...overrides,
    })}\n`),
    /** One roster entry's `get_logout_accounts` answer; the id follows the roster index. */
    respondAccounts: (
      index: number,
      data: unknown,
      overrides: Record<string, unknown> = {},
    ) => stdout.write(`${JSON.stringify({
      type: "response",
      id: `provider-accounts-${index}`,
      command: "get_logout_accounts",
      success: true,
      data,
      ...overrides,
    })}\n`),
    exit: (code: number | null) => exit?.(code),
    failSpawn: () => spawnError?.(new Error("synthetic private child diagnostic")),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveOAuthProviderSpecs", () => {
  it("keeps curated overlaps first and appends unique available ids in omp order", () => {
    const specs = resolveOAuthProviderSpecs([
      FACTORY,
      { ...FUTURE },
      { id: "unavailable", name: "Unavailable", available: false, authenticated: true },
      { id: "openai-codex", name: "Upstream Codex", available: true, authenticated: false },
      { ...FACTORY, name: "Duplicate Factory" },
    ]);
    expect(specs).toEqual([
      {
        id: "openai-codex",
        providerId: "openai-codex",
        label: "ChatGPT Plus/Pro",
        hint: "Codex subscription — models appear as openai-codex/…",
      },
      { id: "factory-droid", providerId: "factory-droid", label: "Factory Droid", hint: "factory-droid" },
      { id: "future-provider", providerId: "future-provider", label: "Future Provider", hint: "future-provider" },
    ]);
  });

  it("honors an unavailable first occurrence even when later duplicates are available", () => {
    expect(resolveOAuthProviderSpecs([
      { ...FACTORY, available: false },
      FACTORY,
      { id: "openai-codex", name: "Unavailable Codex", available: false, authenticated: false },
      { id: "openai-codex", name: "Available duplicate", available: true, authenticated: true },
    ])).toEqual([]);
  });

  it("does not resurrect curated rows absent from a valid roster", () => {
    expect(resolveOAuthProviderSpecs([])).toEqual([]);
    expect(resolveOAuthProviderSpecs([FACTORY]).map((spec) => spec.id)).toEqual(["factory-droid"]);
  });

  it("retains exact unknown ids and does not treat object prototype names as duplicates", () => {
    const providers = ["__proto__", "constructor", "Case-Sensitive", "case-sensitive", " padded "].map((id) => ({
      id, name: `Provider ${id}`, available: true, authenticated: false,
    }));
    expect(resolveOAuthProviderSpecs(providers)).toEqual(providers.map((provider) => ({
      id: provider.id, providerId: provider.id, label: provider.name, hint: provider.id,
    })));
  });
});

describe("readProviderAccounts", () => {
  it("negotiates a bare child, reads the roster, then one accounts errand per id", async () => {
    vi.useFakeTimers();
    const h = harness();
    const args = h.spawnProcess.mock.calls[0][1];
    for (const flag of ["--no-session", "--no-tools", "--no-extensions", "--no-lsp", "--no-skills", "--no-rules"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--cwd") + 1]).toBe(h.scratchDir);
    expect(args[args.indexOf("--session-dir") + 1]).toBe(h.scratchDir);
    expect(h.commands).toEqual([]);
    h.frame(READY);
    expect(h.commands).toEqual([
      { type: "negotiate_protocol", protocolVersion: 2 },
      { type: "get_login_providers", id: "provider-accounts-roster" },
    ]);
    h.respond({ providers: [FACTORY, FUTURE] });
    await Promise.resolve();
    expect(h.commands.slice(2)).toEqual([
      { type: "get_logout_accounts", id: "provider-accounts-0", providerId: "factory-droid" },
      { type: "get_logout_accounts", id: "provider-accounts-1", providerId: "future-provider" },
    ]);
    h.respondAccounts(0, { accounts: [{ ...ACCOUNT, token: "not-published" }] });
    h.respondAccounts(1, { accounts: [] });
    const read = await h.result;
    expect(read).toEqual({
      ok: true,
      providers: [FACTORY, FUTURE],
      accounts: new Map([
        ["factory-droid", [ACCOUNT]],
        ["future-provider", []],
      ]),
    });
    expect(JSON.stringify(read)).not.toContain("not-published");
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.exit(1);
    expect(await h.result).toBe(read);
  });

  it("asks once per unique roster id", async () => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [FACTORY, { ...FACTORY, name: "Duplicate" }, FUTURE] });
    await Promise.resolve();
    expect(h.commands.slice(2).map((c) => c.id)).toEqual([
      "provider-accounts-0",
      "provider-accounts-2",
    ]);
    h.respondAccounts(0, { accounts: [ACCOUNT] });
    h.respondAccounts(2, { accounts: [] });
    const read = await h.result;
    expect(read?.ok && [...read.accounts.keys()]).toEqual(["factory-droid", "future-provider"]);
  });

  it("an empty roster completes without any accounts errand", async () => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [] });
    expect(await h.result).toEqual({ ok: true, providers: [], accounts: new Map() });
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("a binary without get_logout_accounts keeps the roster and reports unsupported", async () => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [FACTORY] });
    await Promise.resolve();
    h.respondAccounts(0, undefined, {
      success: false,
      error: "Unknown command: get_logout_accounts (private detail)",
    });
    expect(await h.result).toEqual({ ok: false, unsupported: true, providers: [FACTORY] });
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("any other accounts failure is a transport failure that hides omp's error", async () => {
    const h = harness();
    h.stderr.write("synthetic private stderr");
    h.frame(READY);
    h.respond({ providers: [FACTORY] });
    await Promise.resolve();
    h.respondAccounts(0, undefined, { success: false, error: "auth store locked" });
    const read = await h.result;
    expect(read).toBeNull();
    expect(JSON.stringify(read)).not.toContain("locked");
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("a failed roster read is a transport failure", async () => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [FACTORY] }, { success: false, error: "unknown command with private details" });
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    {},
    { providers: null },
    { providers: [null] },
    { providers: [{ ...FACTORY, id: "" }] },
    { providers: [{ ...FACTORY, available: "true" }] },
    { providers: [FACTORY, { ...FUTURE, authenticated: undefined }] },
  ].map((data) => ({ data })))("rejects the whole malformed roster payload: %j", async ({ data }) => {
    const h = harness();
    h.frame(READY);
    h.respond(data);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    { accounts: null },
    { accounts: [null] },
    { accounts: [{ ...ACCOUNT, credentialId: 0 }] },
    { accounts: [{ ...ACCOUNT, credentialId: 1.5 }] },
    { accounts: [{ ...ACCOUNT, provider: 3 }] },
    { accounts: [{ ...ACCOUNT, label: null }] },
    { accounts: [{ ...ACCOUNT, detail: undefined }] },
    { accounts: [{ ...ACCOUNT, type: "sso" }] },
    { accounts: [{ ...ACCOUNT, active: "yes" }] },
    { accounts: [ACCOUNT, { ...ACCOUNT, credentialId: 12, active: 1 }] },
  ].map((data) => ({ data })))("rejects the whole malformed accounts payload: %j", async ({ data }) => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [FACTORY] });
    await Promise.resolve();
    h.respondAccounts(0, data);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("ignores other response ids and commands until the exact responses arrive", async () => {
    const h = harness();
    h.frame(READY);
    h.respondAccounts(0, { accounts: [ACCOUNT] });
    h.respond({ providers: [FACTORY] }, { id: "another-request" });
    h.respond({ providers: [FACTORY] }, { command: "another-command" });
    h.frame(null);
    h.frame("not a record");
    h.respond({ providers: [FACTORY] });
    await Promise.resolve();
    h.respond({ accounts: [ACCOUNT] }, { id: "provider-accounts-0", command: "get_logout_accounts" });
    h.respondAccounts(0, { accounts: [ACCOUNT] }, { id: "stale-response" });
    expect(await h.result).toEqual({
      ok: true,
      providers: [FACTORY],
      accounts: new Map([["factory-droid", [ACCOUNT]]]),
    });
  });

  it("declines incidental human requests without starting login", async () => {
    const h = harness();
    h.frame(READY);
    h.frame({ type: "extension_ui_request", id: "u1", method: "open_url", url: "https://example.invalid/auth" });
    h.frame({ type: "extension_ui_request", id: 42, method: "input" });
    expect(h.commands).toContainEqual({ type: "extension_ui_response", id: "u1", cancelled: true });
    expect(h.commands.some((command) => command.type === "login" || command.type === "prompt")).toBe(false);
    h.respond({ providers: [FACTORY] });
    await Promise.resolve();
    h.respondAccounts(0, { accounts: [] });
    expect((await h.result)?.ok).toBe(true);
  });

  it("does not spawn without a binary or when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const opts of [{ ompPath: null }, { signal: controller.signal }]) {
      const h = harness(opts);
      expect(await h.result).toBeNull();
      expect(h.spawnProcess).not.toHaveBeenCalled();
      expect(h.kill).not.toHaveBeenCalled();
    }
  });

  it("accepts a protocol-v2 chunked accounts response through RPC reassembly", async () => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [FACTORY] });
    await Promise.resolve();
    const bytes = Buffer.from(JSON.stringify({
      type: "response",
      id: "provider-accounts-0",
      command: "get_logout_accounts",
      success: true,
      data: { accounts: [ACCOUNT] },
    }));
    const midpoint = Math.floor(bytes.length / 2);
    const parts = [bytes.subarray(0, midpoint), bytes.subarray(midpoint)];
    for (const [index, part] of parts.entries()) {
      h.frame({
        type: "rpc_chunk", chunkId: "accounts", index, count: parts.length,
        byteLength: bytes.length, data: part.toString("base64"),
      });
    }
    const read = await h.result;
    expect(read?.ok && read.accounts.get("factory-droid")).toEqual([ACCOUNT]);
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("bounds an unanswered errand with one timer for the whole read", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [FACTORY, FUTURE] });
    await Promise.resolve();
    h.respondAccounts(0, { accounts: [] });
    vi.advanceTimersByTime(10_000);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out and reaps a child that never announces ready", async () => {
    vi.useFakeTimers();
    const h = harness();
    vi.advanceTimersByTime(10_000);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, null])("settles and cleans up premature exit %s", async (code) => {
    const h = harness();
    h.exit(code);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("settles synchronous spawn failures and removes lifecycle resources", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ spawnError: true, signal: controller.signal });
    expect(await h.result).toBeNull();
    expect(h.spawnProcess).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles an asynchronous child spawn error without returning diagnostics", async () => {
    const h = harness();
    h.failSpawn();
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalled();
  });

  it("aborts in-flight discovery and detaches its abort listener", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ signal: controller.signal });
    h.frame(READY);
    controller.abort();
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    h.respond({ providers: [FACTORY] });
    expect(await h.result).toBeNull();
  });

  it("reaps the errand when ownership aborts synchronously during construction", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ signal: controller.signal, duringSpawn: () => controller.abort() });
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("detaches abort ownership after success so later teardown cannot alter it", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ signal: controller.signal });
    h.frame(READY);
    h.respond({ providers: [FACTORY] });
    await Promise.resolve();
    h.respondAccounts(0, { accounts: [ACCOUNT] });
    const read = await h.result;
    expect(read?.ok).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(await h.result).toBe(read);
  });
});

function logoutHarness(opts: { spawnError?: boolean } = {}) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-logout-"));
  scratchDirs.push(scratchDir);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: Record<string, unknown>[] = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line !== "") commands.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const kill = vi.fn();
  let exit: ((code: number | null) => void) | undefined;
  const proc: RpcChildProcess = {
    stdin,
    stdout,
    stderr,
    kill,
    onExit: (cb) => { exit = cb; },
    onSpawnError: () => {},
  };
  const spawnProcess = vi.fn<RpcSpawnFn>(() => {
    if (opts.spawnError) throw new Error("synthetic private spawn diagnostic");
    return proc;
  });
  const result = logoutCredential({
    ompPath: "/opt/omp",
    providerId: "openai-codex-device",
    credentialId: 11,
    scratchDir,
    spawnProcess,
  });
  return {
    result,
    commands,
    kill,
    frame: (frame: unknown) => stdout.write(`${JSON.stringify(frame)}\n`),
    respond: (overrides: Record<string, unknown> = {}) => stdout.write(`${JSON.stringify({
      type: "response",
      id: "provider-accounts-logout",
      command: "logout",
      success: true,
      data: {},
      ...overrides,
    })}\n`),
    exit: (code: number | null) => exit?.(code),
  };
}

describe("logoutCredential", () => {
  it("sends one logout command with the alias id and credential id", async () => {
    const h = logoutHarness();
    h.frame(READY);
    expect(h.commands).toEqual([
      { type: "negotiate_protocol", protocolVersion: 2 },
      { type: "logout", id: "provider-accounts-logout", providerId: "openai-codex-device", credentialId: 11 },
    ]);
    h.respond();
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("resolves with omp's remaining auth source verbatim", async () => {
    const h = logoutHarness();
    h.frame(READY);
    h.respond({ data: { remainingSource: "environment variable OPENAI_API_KEY" } });
    expect(await h.result).toBe("environment variable OPENAI_API_KEY");
  });

  it("an old binary gets a version message instead of omp's private error", async () => {
    const h = logoutHarness();
    h.frame(READY);
    h.respond({ success: false, data: undefined, error: "Unknown command: logout (private detail)" });
    await expect(h.result).rejects.toThrow(
      `sign-out requires omp ${LOGOUT_ACCOUNTS_MIN_OMP} or later`,
    );
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("any other failure rejects with omp's message", async () => {
    const h = logoutHarness();
    h.frame(READY);
    h.respond({ success: false, data: undefined, error: "No credential 11 for openai-codex" });
    await expect(h.result).rejects.toThrow("No credential 11 for openai-codex");
  });

  it("a child exit before the response is a rejection, not a hang", async () => {
    const h = logoutHarness();
    h.frame(READY);
    h.exit(null);
    await expect(h.result).rejects.toThrow("omp exited (signal) before signing out");
  });

  it("rejects a synchronous spawn failure", async () => {
    const h = logoutHarness({ spawnError: true });
    await expect(h.result).rejects.toThrow("synthetic private spawn diagnostic");
    expect(h.kill).not.toHaveBeenCalled();
  });

  it("times out a child that never answers", async () => {
    vi.useFakeTimers();
    const h = logoutHarness();
    h.frame(READY);
    vi.advanceTimersByTime(10_000);
    await expect(h.result).rejects.toThrow("sign-out timed out after 10 seconds");
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
