/* Production-composition units (issue #1010 Task A): the placement-gate wrapper
   over a fake manager, and the cipher bridge exercised through core's REAL
   ProviderKeys store — the seam my composition adds is seal→base64→unseal under
   the on-disk format, so that round trip (and the wrong-key retention) is what
   these pin. No bundle load, no SessionManager, no spawn. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderKeys, type OwnedSessionRecord } from "@omp-ui/core";
import { machineKeyProtector, openLiteKeyCipher } from "./credentials";
import { toCoreCipher, withPlacementGates } from "./production-sessions";
import type { LiteSessions } from "./seams";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lite-prod-"));
  dirs.push(dir);
  return dir;
}

function sessionRecord(tabId: string): OwnedSessionRecord {
  return { tabId } as OwnedSessionRecord;
}

interface FakeManager {
  isLive(tabId: string): boolean;
  isTurnRunning(tabId: string): boolean;
  modelProviderReady(projectCwd: string): boolean;
}

function baseBundle(manager: FakeManager): LiteSessions & { sessions: FakeManager } {
  const base: LiteSessions & { sessions: FakeManager } = {
    handlers: {},
    state: () => ({ projects: [], chats: [] }) as never,
    on: () => () => {},
    dispose: async () => {},
    sessions: manager,
  };
  return base;
}

describe("withPlacementGates (issue #1010)", () => {
  it("activity counts scan registry records through the manager, per call", () => {
    const records = [sessionRecord("a"), sessionRecord("b"), sessionRecord("c")];
    const live = new Set(["a", "c"]);
    const running = new Set(["c"]);
    const manager: FakeManager = {
      isLive: (tabId) => live.has(tabId),
      isTurnRunning: (tabId) => running.has(tabId),
      modelProviderReady: () => false,
    };
    const gated = withPlacementGates(baseBundle(manager), { sessions: records });
    expect(gated.activity?.()).toEqual({ liveSessions: 2, runningTurns: 1 });
    // Live counts follow the MANAGER's view between calls, not a snapshot.
    live.delete("a");
    expect(gated.activity?.()).toEqual({ liveSessions: 1, runningTurns: 1 });
  });

  it("providerReady delegates per path and base seam fields pass through", () => {
    const ready = new Set(["/work/alpha"]);
    const manager: FakeManager = {
      isLive: () => false,
      isTurnRunning: () => false,
      modelProviderReady: (cwd) => ready.has(cwd),
    };
    const base = baseBundle(manager);
    const gated = withPlacementGates(base, { sessions: [] });
    expect(gated.providerReady?.("/work/alpha")).toBe(true);
    expect(gated.providerReady?.("/work/beta")).toBe(false);
    // The wrapper spreads the bundle's own seam fields untouched.
    expect(gated.handlers).toBe(base.handlers);
    expect(gated.state).toBe(base.state);
    expect(gated.on).toBe(base.on);
    expect(gated.dispose).toBe(base.dispose);
  });
});

describe("cipher bridge through core's ProviderKeys store (issue #1010)", () => {
  async function openCipher(dataDir: string) {
    return openLiteKeyCipher(await machineKeyProtector(path.join(dataDir, "machine.key")));
  }

  it("a key sealed via the adapted cipher reloads intact from its base64 file", async () => {
    const dir = tempDir();
    const cipher = toCoreCipher(await openCipher(dir));
    const env: NodeJS.ProcessEnv = {};
    const keys = new ProviderKeys(path.join(dir, "provider-keys.json"), cipher, env);
    keys.setKey("OPENROUTER_API_KEY", "sk-or-v1-testvalue123");
    expect(keys.rolloutValue("OPENROUTER_API_KEY")).toBe("sk-or-v1-testvalue123");
    // The store wrote base64 of my single-line seal, not plaintext…
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "provider-keys.json"), "utf8")) as {
      keys: Record<string, string>;
    };
    const blob = raw.keys.OPENROUTER_API_KEY!;
    expect(blob.startsWith("sk-or")).toBe(false);
    expect(Buffer.from(blob, "base64").toString("utf8").startsWith("v1lite:")).toBe(true);
    // …and a fresh store instance with the same machine key unseals it.
    const reopened = new ProviderKeys(path.join(dir, "provider-keys.json"), cipher, {});
    expect(reopened.rolloutValue("OPENROUTER_API_KEY")).toBe("sk-or-v1-testvalue123");
  });

  it("a different machine key retains the blob unreadably instead of corrupting it", async () => {
    const dir = tempDir();
    const writer = toCoreCipher(await openCipher(dir));
    const keys = new ProviderKeys(path.join(dir, "provider-keys.json"), writer, {});
    keys.setKey("ANTHROPIC_API_KEY", "sk-ant-testvalue456");
    // Second protector gets a freshly generated, unrelated key (none stored yet).
    const other = toCoreCipher(await openLiteKeyCipher(await machineKeyProtector(path.join(dir, "other.key"))));
    const reopened = new ProviderKeys(path.join(dir, "provider-keys.json"), other, {});
    // Core's documented retention path: value null, file untouched (no rewrite
    // happened — no mutation was attempted), so the original owner can still read it.
    expect(reopened.rolloutValue("ANTHROPIC_API_KEY")).toBeNull();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "provider-keys.json"), "utf8")) as {
      keys: Record<string, string>;
    };
    expect(writer.decrypt(Buffer.from(raw.keys.ANTHROPIC_API_KEY!, "base64"))).toBe("sk-ant-testvalue456");
  });

  it("cipher unavailable → writes refused, never plaintext", async () => {
    const dir = tempDir();
    const file = path.join(dir, "provider-keys.json");
    const none = { available: false, backend: "none", encrypt: (): Buffer => Buffer.alloc(0), decrypt: (): string => "" };
    const keys = new ProviderKeys(file, none, {});
    expect(() => keys.setKey("OPENAI_API_KEY", "sk-test123")).toThrow(/credential store .* available|saved securely/i);
    expect(fs.existsSync(file)).toBe(false);
  });
});
