import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthProviderSpecs, type LoginProvider } from "./provider-catalog";
import { readLoginProviders } from "./provider-login";
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
const scratchDirs: string[] = [];

function harness(opts: {
  ompPath?: string | null;
  signal?: AbortSignal;
  spawnError?: boolean;
  duringSpawn?: () => void;
} = {}) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-login-"));
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
  const result = readLoginProviders({
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
      id: "provider-login-discovery",
      command: "get_login_providers",
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
      { id: "future-provider", name: "Future Provider", available: true, authenticated: true },
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

describe("readLoginProviders", () => {
  it("negotiates a bare session-less child and returns only public provider metadata", async () => {
    vi.useFakeTimers();
    const h = harness();
    const args = h.spawnProcess.mock.calls[0][1];
    for (const flag of ["--no-session", "--no-tools", "--no-extensions", "--no-lsp", "--no-skills", "--no-rules"]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("--model");
    expect(args.some((arg) => arg.startsWith("--resume"))).toBe(false);
    expect(args[args.indexOf("--cwd") + 1]).toBe(h.scratchDir);
    expect(args[args.indexOf("--session-dir") + 1]).toBe(h.scratchDir);
    expect(h.commands).toEqual([]);
    h.frame(READY);
    expect(h.commands).toEqual([
      { type: "negotiate_protocol", protocolVersion: 2 },
      { type: "get_login_providers", id: "provider-login-discovery" },
    ]);
    h.respond({ providers: [{ ...FACTORY, token: "not-published", account: "not-published" }], secret: "not-published" });
    expect(await h.result).toEqual([FACTORY]);
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.exit(1);
    expect(await h.result).toEqual([FACTORY]);
  });

  it("accepts an empty roster as successful discovery", async () => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [] });
    expect(await h.result).toEqual([]);
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("accepts a protocol-v2 chunked roster through RPC reassembly", async () => {
    const h = harness();
    h.frame(READY);
    const bytes = Buffer.from(JSON.stringify({
      type: "response",
      id: "provider-login-discovery",
      command: "get_login_providers",
      success: true,
      data: { providers: [FACTORY] },
    }));
    const midpoint = Math.floor(bytes.length / 2);
    const parts = [bytes.subarray(0, midpoint), bytes.subarray(midpoint)];
    for (const [index, part] of parts.entries()) {
      h.frame({
        type: "rpc_chunk", chunkId: "roster", index, count: parts.length,
        byteLength: bytes.length, data: part.toString("base64"),
      });
    }
    expect(await h.result).toEqual([FACTORY]);
    expect(h.kill).toHaveBeenCalledOnce();
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

  it("ignores other response ids, commands, and types until the exact response arrives", async () => {
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [] }, { id: "another-request" });
    h.respond({ providers: [] }, { command: "another-command" });
    h.respond({ providers: [] }, { command: undefined });
    h.respond({ providers: [] }, { type: "event" });
    h.frame(null);
    h.frame("not a record");
    expect(h.kill).not.toHaveBeenCalled();
    h.respond({ providers: [FACTORY] });
    expect(await h.result).toEqual([FACTORY]);
  });

  it("bounds an unanswered correlation mismatch without accepting its roster", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.frame(READY);
    h.respond({ providers: [FACTORY] }, { id: "wrong-request" });
    vi.advanceTimersByTime(10_000);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null for unsupported discovery without exposing errors or stderr", async () => {
    const h = harness();
    h.frame(READY);
    h.stderr.write("synthetic private stderr");
    h.respond({ providers: [FACTORY] }, { success: false, error: "unknown command with private details" });
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    {},
    { providers: null },
    { providers: {} },
    { providers: [null] },
    { providers: [[]] },
    { providers: ["factory-droid"] },
    { providers: [{ ...FACTORY, id: "" }] },
    { providers: [{ ...FACTORY, id: "  " }] },
    { providers: [{ ...FACTORY, id: 1 }] },
    { providers: [{ ...FACTORY, name: "" }] },
    { providers: [{ ...FACTORY, name: "  " }] },
    { providers: [{ ...FACTORY, name: null }] },
    { providers: [{ ...FACTORY, available: "true" }] },
    { providers: [{ ...FACTORY, authenticated: undefined }] },
    { providers: [FACTORY, { ...FACTORY, authenticated: 1 }] },
  ].map((data) => ({ data })))("rejects the whole malformed payload: %j", async ({ data }) => {
    const h = harness();
    h.frame(READY);
    h.respond(data);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it("requires boolean success and preserves valid ids verbatim", async () => {
    const failed = harness();
    failed.frame(READY);
    failed.respond({ providers: [FACTORY] }, { success: "true" });
    expect(await failed.result).toBeNull();
    const h = harness();
    h.frame(READY);
    const provider = { ...FACTORY, id: " Factory-ID ", name: " Factory Name " };
    h.respond({ providers: [provider] });
    expect(await h.result).toEqual([provider]);
  });

  it("times out the whole read even if ready arrives just before the deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    vi.advanceTimersByTime(9_999);
    expect(h.kill).not.toHaveBeenCalled();
    h.frame(READY);
    vi.advanceTimersByTime(1);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.respond({ providers: [FACTORY] });
    expect(await h.result).toBeNull();
  });

  it("times out and reaps a child that never announces ready", async () => {
    vi.useFakeTimers();
    const h = harness();
    vi.advanceTimersByTime(10_000);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
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
    vi.useFakeTimers();
    const h = harness();
    h.failSpawn();
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, null])("settles and cleans up premature exit %s", async (code) => {
    vi.useFakeTimers();
    const h = harness();
    h.exit(code);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "not JSON\n",
    `${JSON.stringify({ type: "rpc_chunk", chunkId: "bad", index: 1, count: 2, byteLength: 10, data: "" })}\n`,
    "x".repeat(1_048_577),
  ])("settles and reaps framing failures %#", async (raw) => {
    vi.useFakeTimers();
    const h = harness();
    h.frame(READY);
    h.stdout.write(raw);
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts in-flight discovery and detaches its abort listener", async () => {
    vi.useFakeTimers();
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
    expect(vi.getTimerCount()).toBe(0);
    h.respond({ providers: [FACTORY] });
    expect(await h.result).toBeNull();
  });

  it("reaps discovery when ownership aborts synchronously during construction", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ signal: controller.signal, duringSpawn: () => controller.abort() });
    expect(await h.result).toBeNull();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detaches abort ownership after success so later teardown cannot alter it", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ signal: controller.signal });
    h.frame(READY);
    h.respond({ providers: [FACTORY] });
    expect(await h.result).toEqual([FACTORY]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(await h.result).toEqual([FACTORY]);
  });

  it("declines incidental human requests without waiting or starting login", async () => {
    const h = harness();
    h.frame(READY);
    for (const method of ["open_url", "input", "select"]) {
      h.frame({ type: "extension_ui_request", id: method, method, url: "https://example.invalid/auth" });
    }
    h.frame({ type: "extension_ui_request", id: 42, method: "input" });
    expect(h.commands.slice(2)).toEqual([
      { type: "extension_ui_response", id: "open_url", cancelled: true },
      { type: "extension_ui_response", id: "input", cancelled: true },
      { type: "extension_ui_response", id: "select", cancelled: true },
    ]);
    expect(h.commands.some((command) => command.type === "login" || command.type === "prompt")).toBe(false);
    h.respond({ providers: [FACTORY] });
    expect(await h.result).toEqual([FACTORY]);
    expect(h.kill).toHaveBeenCalledOnce();
  });
});
