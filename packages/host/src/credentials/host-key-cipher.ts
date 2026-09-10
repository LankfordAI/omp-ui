import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyCipher } from "@omp-ui/core";

/**
 * The host's credential cipher (issue #442 §10.3): AES-256-GCM under a data
 * encryption key (DEK) the OS credential store protects. The DEK is the only
 * thing the OS store holds; every provider key and remote-instance credential
 * on disk is an envelope under it, so a keyring that is slow or locked costs
 * one bounded lookup at boot instead of one per credential.
 *
 * Release P builds and tests this cipher but Electron's `safeStorage` stays the
 * active one; Release C switches the store over and migrates the ciphertext.
 */

/** Where the DEK lives: the platform keyring, or a test double. */
export interface KeyProtector {
  /** Label for status rows, e.g. `linux-secret-service`. */
  readonly backend: string;
  /** The stored DEK, or null when the store holds none for this data root. */
  load(): Promise<Buffer | null>;
  store(dek: Buffer): Promise<void>;
}

/**
 * A cipher with no key: the store was unreachable, timed out, or lost the DEK
 * while ciphertext still exists. It fails closed — nothing is written that
 * cannot later be read, and nothing is minted over ciphertext a fresh key would
 * orphan — and reports why so the settings page can say more than "unavailable".
 */
export interface DegradedCipher extends KeyCipher {
  readonly available: false;
  readonly reason: string;
}

/** Envelope layout: `0x02 || nonce[12] || ciphertext || tag[16]`. */
export const HOST_ENVELOPE_VERSION = 0x02;
/**
 * Written by Release C's migration while a credential is between ciphers.
 * Decrypting one is a bug in the migration, not a lost key, and is reported
 * as such.
 */
export const HANDOFF_ENVELOPE_VERSION = 0x01;

const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Version byte, nonce, and tag: the shortest envelope, for an empty plaintext. */
const HOST_ENVELOPE_MIN_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

/** The fail-closed message a degraded cipher throws; matches the Electron cipher. */
export const CREDENTIAL_STORE_UNAVAILABLE = "no credential store available";

/** The degraded reason when the store answers "no DEK" but ciphertext exists. */
export const KEY_LOST = "key-lost";

export class HandoffIncomplete extends Error {
  constructor() {
    super("credential handoff incomplete: envelope is mid-migration");
    this.name = "HandoffIncomplete";
  }
}

export class DekTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`credential store did not answer within ${timeoutMs}ms`);
    this.name = "DekTimeout";
  }
}

/** Runs one DEK operation under a deadline; see {@link raceDeadline}. */
export type RunInWorker = <T>(fn: () => Promise<T>, timeoutMs: number) => Promise<T>;

/**
 * The default `runInWorker`: races `fn()` against the deadline and rejects with
 * {@link DekTimeout} when the timer wins. It cannot stop a native call that has
 * hung — a `worker_threads` Worker cannot run an injected closure — so this is
 * the outer guard only. The platform protectors from `protector.ts` provide the
 * real isolation: each native keyring call runs in a Worker that
 * `dek-worker.ts`'s `runProtectorInWorker` terminates at its own deadline, so a
 * D-Bus prompt or a locked keychain never wedges the host.
 */
// Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
export const raceDeadline: RunInWorker = (fn, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DekTimeout(timeoutMs)), timeoutMs);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export function isHostEnvelope(blob: Buffer): boolean {
  return blob[0] === HOST_ENVELOPE_VERSION && blob.length >= HOST_ENVELOPE_MIN_BYTES;
}

export interface OpenHostKeyCipherOptions {
  /** Whether any envelope exists on disk. With one, a missing DEK is a lost key, never a fresh mint. */
  hasCiphertext: boolean;
  /** Deadline per DEK operation; default 5000. */
  timeoutMs?: number;
  runInWorker?: RunInWorker;
}

/**
 * Acquires the DEK and returns the cipher, or a {@link DegradedCipher} naming
 * why not. Never throws: a credential store failure is a reportable state of
 * the app, not a boot failure.
 */
export async function openHostKeyCipher(
  protector: KeyProtector,
  opts: OpenHostKeyCipherOptions,
): Promise<KeyCipher | DegradedCipher> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const run = opts.runInWorker ?? raceDeadline;
  let dek: Buffer | null;
  try {
    dek = await run(() => protector.load(), timeoutMs);
  } catch (error) {
    return degraded(protector.backend, reasonOf(error));
  }
  if (dek === null) {
    if (opts.hasCiphertext) return degraded(protector.backend, KEY_LOST);
    const fresh = randomBytes(DEK_BYTES);
    try {
      await run(() => protector.store(fresh), timeoutMs);
    } catch (error) {
      return degraded(protector.backend, reasonOf(error));
    }
    dek = fresh;
  } else if (dek.length !== DEK_BYTES) {
    return degraded(protector.backend, `stored key is ${dek.length} bytes, expected ${DEK_BYTES}`);
  }
  return new HostKeyCipher(protector.backend, dek);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function degraded(backend: string, reason: string): DegradedCipher {
  return {
    available: false,
    backend,
    reason,
    encrypt: () => {
      throw new Error(CREDENTIAL_STORE_UNAVAILABLE);
    },
    decrypt: () => {
      throw new Error(CREDENTIAL_STORE_UNAVAILABLE);
    },
  };
}

class HostKeyCipher implements KeyCipher {
  readonly available = true;

  constructor(
    readonly backend: string,
    private readonly dek: Buffer,
  ) {}

  encrypt(plain: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.dek, nonce);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.of(HOST_ENVELOPE_VERSION), nonce, body, cipher.getAuthTag()]);
  }

  decrypt(blob: Buffer): string {
    switch (blob[0]) {
      case HOST_ENVELOPE_VERSION: {
        if (blob.length < HOST_ENVELOPE_MIN_BYTES) throw new Error("truncated host envelope");
        const nonce = blob.subarray(1, 1 + NONCE_BYTES);
        const body = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", this.dek, nonce);
        decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      }
      case HANDOFF_ENVELOPE_VERSION:
        throw new HandoffIncomplete();
      default:
        throw new Error("legacy ciphertext");
    }
  }
}
