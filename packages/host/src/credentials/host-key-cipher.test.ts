import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_STORE_UNAVAILABLE,
  HANDOFF_ENVELOPE_VERSION,
  HOST_ENVELOPE_VERSION,
  HandoffIncomplete,
  isHostEnvelope,
  KEY_LOST,
  openHostKeyCipher,
  type DegradedCipher,
  type KeyProtector,
} from "./host-key-cipher";

interface MemoryProtector extends KeyProtector {
  stored: Buffer | null;
  loads: number;
}

function memoryProtector(initial: Buffer | null): MemoryProtector {
  const p: MemoryProtector = {
    backend: "memory",
    stored: initial,
    loads: 0,
    async load() {
      p.loads += 1;
      return p.stored;
    },
    async store(dek) {
      p.stored = Buffer.from(dek);
    },
  };
  return p;
}

function isDegraded(cipher: unknown): cipher is DegradedCipher {
  return typeof cipher === "object" && cipher !== null && "reason" in cipher;
}

describe("openHostKeyCipher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips text under a stored DEK and never reuses a nonce", async () => {
    const cipher = await openHostKeyCipher(memoryProtector(randomBytes(32)), { hasCiphertext: true });
    expect(cipher.available).toBe(true);
    expect(cipher.backend).toBe("memory");
    const a = cipher.encrypt("sk-or-v1-secret ✓");
    const b = cipher.encrypt("sk-or-v1-secret ✓");
    expect(cipher.decrypt(a)).toBe("sk-or-v1-secret ✓");
    expect(cipher.decrypt(b)).toBe("sk-or-v1-secret ✓");
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  it("writes the 0x02 envelope: version, 12-byte nonce, ciphertext, 16-byte tag", async () => {
    const cipher = await openHostKeyCipher(memoryProtector(randomBytes(32)), { hasCiphertext: false });
    const blob = cipher.encrypt("abc");
    expect(blob[0]).toBe(HOST_ENVELOPE_VERSION);
    expect(blob.length).toBe(1 + 12 + 3 + 16);
    expect(isHostEnvelope(blob)).toBe(true);
    expect(isHostEnvelope(cipher.encrypt(""))).toBe(true);
    expect(isHostEnvelope(Buffer.from([HOST_ENVELOPE_VERSION, 1, 2]))).toBe(false);
    expect(isHostEnvelope(Buffer.alloc(40))).toBe(false);
  });

  it("rejects a tampered envelope", async () => {
    const cipher = await openHostKeyCipher(memoryProtector(randomBytes(32)), { hasCiphertext: false });
    const blob = cipher.encrypt("abc");
    blob[14] ^= 0xff;
    expect(() => cipher.decrypt(blob)).toThrow();
  });

  it("reports a mid-migration 0x01 envelope as HandoffIncomplete", async () => {
    const cipher = await openHostKeyCipher(memoryProtector(randomBytes(32)), { hasCiphertext: true });
    expect(() => cipher.decrypt(Buffer.from([HANDOFF_ENVELOPE_VERSION, 0, 0]))).toThrow(HandoffIncomplete);
  });

  it("refuses legacy (safeStorage) ciphertext with a distinct error", async () => {
    const cipher = await openHostKeyCipher(memoryProtector(randomBytes(32)), { hasCiphertext: true });
    expect(() => cipher.decrypt(Buffer.from("v10abcdef"))).toThrow("legacy ciphertext");
    expect(() => cipher.decrypt(Buffer.alloc(0))).toThrow("legacy ciphertext");
  });

  it("never mints over existing ciphertext: a missing DEK is key-lost", async () => {
    const protector = memoryProtector(null);
    const cipher = await openHostKeyCipher(protector, { hasCiphertext: true });
    expect(isDegraded(cipher) && cipher.reason).toBe(KEY_LOST);
    expect(cipher.available).toBe(false);
    expect(protector.stored).toBeNull();
  });

  it("mints and stores a 32-byte DEK when the store and disk are both empty", async () => {
    const protector = memoryProtector(null);
    const first = await openHostKeyCipher(protector, { hasCiphertext: false });
    expect(first.available).toBe(true);
    expect(protector.stored?.length).toBe(32);
    const blob = first.encrypt("persisted");
    const second = await openHostKeyCipher(protector, { hasCiphertext: true });
    expect(second.decrypt(blob)).toBe("persisted");
  });

  it("degrades with the reason when the protector throws", async () => {
    const protector: KeyProtector = {
      backend: "linux-secret-service",
      load: () => Promise.reject(new Error("secret service: no session bus")),
      store: () => Promise.resolve(),
    };
    const cipher = await openHostKeyCipher(protector, { hasCiphertext: false });
    expect(isDegraded(cipher) && cipher.reason).toBe("secret service: no session bus");
    expect(cipher.backend).toBe("linux-secret-service");
  });

  it("degrades when the store fails to persist a fresh DEK", async () => {
    const protector: KeyProtector = {
      backend: "memory",
      load: () => Promise.resolve(null),
      store: () => Promise.reject(new Error("read-only keyring")),
    };
    const cipher = await openHostKeyCipher(protector, { hasCiphertext: false });
    expect(isDegraded(cipher) && cipher.reason).toBe("read-only keyring");
  });

  it("degrades with a size reason for a DEK that is not 32 bytes", async () => {
    const cipher = await openHostKeyCipher(memoryProtector(Buffer.alloc(16)), { hasCiphertext: true });
    expect(isDegraded(cipher) && cipher.reason).toContain("16 bytes");
  });

  it("degrades with a timeout reason when the store never answers", async () => {
    vi.useFakeTimers();
    const protector: KeyProtector = {
      backend: "macos-keychain",
      load: () => new Promise(() => {}),
      store: () => Promise.resolve(),
    };
    const pending = openHostKeyCipher(protector, { hasCiphertext: true, timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    const cipher = await pending;
    expect(cipher.available).toBe(false);
    expect(isDegraded(cipher) && cipher.reason).toContain("did not answer within 20ms");
  });

  it("uses the injected runInWorker for load and store", async () => {
    const calls: number[] = [];
    const protector = memoryProtector(null);
    await openHostKeyCipher(protector, {
      hasCiphertext: false,
      timeoutMs: 123,
      runInWorker: (fn, timeoutMs) => {
        calls.push(timeoutMs);
        return fn();
      },
    });
    expect(calls).toEqual([123, 123]);
    expect(protector.stored?.length).toBe(32);
  });

  it("degraded encrypt/decrypt fail closed with the shared message", async () => {
    const cipher = await openHostKeyCipher(memoryProtector(null), { hasCiphertext: true });
    expect(() => cipher.encrypt("x")).toThrow(CREDENTIAL_STORE_UNAVAILABLE);
    expect(() => cipher.decrypt(Buffer.from([HOST_ENVELOPE_VERSION]))).toThrow(CREDENTIAL_STORE_UNAVAILABLE);
    expect(CREDENTIAL_STORE_UNAVAILABLE).toBe("no credential store available");
  });
});
