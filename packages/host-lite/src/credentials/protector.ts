import { randomBytes } from "node:crypto";
import { constants as fsConstants, closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LiteKeyCipher, LITE_KEY_BYTES } from "./lite-key-cipher";
import { probeLiteSecretService } from "./secret-service";

/**
 * Protector selection for the lite member (issue #1010). A headless box has no
 * OS keychain assumption — no display, possibly no D-Bus session — so the
 * chain is ordered by what a machine that runs unattended can be counted on to
 * have at boot:
 *
 *  1. `OMP_UI_LITE_KEY_FILE` → an operator-provided 0600 key file. The
 *     deployment owns the secret (systemd credential, sealed mount); we only
 *     read it and enforce its mode.
 *  2. Linux Secret Service over D-Bus — V1 DEFERS this: see `secret-service.ts`.
 *     Selection still threads an injected protector so a later native binding
 *     drops in between (1) and (3) without touching this file's tests again.
 *  3. `<dataDir>/machine.key`, created 0600 on first use. Guaranteed path;
 *     OS-user-grade protection only (README.md states the trust boundary).
 */

/** Env var naming the operator-provided key file. */
export const LITE_KEY_FILE_ENV = "OMP_UI_LITE_KEY_FILE";

/** Fallback key file name under the data directory. */
export const MACHINE_KEY_FILE = "machine.key";

/** A key file exists but is readable/writable by more than its owner. */
export class LiteKeyFilePermissionError extends Error {
  constructor(path: string, mode: number) {
    super(`lite key file ${path} is mode 0o${mode.toString(8)}; must be 0600 (run: chmod 600 ${path})`);
    this.name = "LiteKeyFilePermissionError";
  }
}

/** A stored machine key does not hold exactly 32 raw bytes. */
export class LiteKeyFileFormatError extends Error {
  constructor(location: string, found: number) {
    super(`lite machine key at ${location} holds ${found} bytes; expected ${LITE_KEY_BYTES} raw bytes`);
    this.name = "LiteKeyFileFormatError";
  }
}

/** A protector stores and loads the machine key from wherever it lives. */
export interface LiteKeyProtector {
  /** Label baked into the cipher for status rows: `key-file`, `secret-service`, `machine-key`. */
  readonly backend: string;
  /** The stored key, or null when the protector's location holds none. */
  load(): Promise<Buffer | null>;
  store(key: Buffer): Promise<void>;
}

/** Minimal seam a Secret Service (or any future) protector must satisfy. */
export type SecretServiceProtector = LiteKeyProtector;

export interface SelectProtectorOptions {
  /** The lite member's data directory; holds the fallback `machine.key`. */
  dataDir: string;
  /** Env source; default `process.env`. Tests inject to drive precedence. */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /**
   * Linux Secret Service protector factory used when the platform qualifies.
   * Default is the V1 probe in this module — absent on every platform today —
   * so selection drops to the fallback file.
   */
  secretService?: () => Promise<SecretServiceProtector | null>;
}

/** Fresh machine key; the shape both protectors store. */
export function generateLiteMachineKey(): Buffer {
  return randomBytes(LITE_KEY_BYTES);
}

/**
 * Picks the protector by the documented priority. Async only because a Secret
 * Service probe may be; the file paths complete synchronously inside.
 */
export async function selectLiteKeyProtector(opts: SelectProtectorOptions): Promise<LiteKeyProtector> {
  const env = opts.env ?? process.env;
  const keyFile = env[LITE_KEY_FILE_ENV];
  if (keyFile) return keyFileProtector(keyFile);

  const platform = opts.platform ?? process.platform;
  if (platform === "linux") {
    const probe = opts.secretService ?? probeLiteSecretService;
    const protector = await probe().catch(() => null);
    if (protector) return protector;
  }
  return machineKeyProtector(join(opts.dataDir, MACHINE_KEY_FILE));
}

/** Acquire the machine key through `protector` and return its cipher. */
export async function openLiteKeyCipher(protector: LiteKeyProtector): Promise<LiteKeyCipher> {
  let key = await protector.load();
  if (key === null) {
    key = generateLiteMachineKey();
    await protector.store(key);
  } else if (key.length !== LITE_KEY_BYTES) {
    throw new LiteKeyFileFormatError(protector.backend, key.length);
  }
  return new LiteKeyCipher(key, protector.backend);
}

/** One-step: select the protector for this machine and open its cipher. */
export async function openLiteKeyCipherFor(opts: SelectProtectorOptions): Promise<LiteKeyCipher> {
  return openLiteKeyCipher(await selectLiteKeyProtector(opts));
}

/**
 * The operator-provided key file from `OMP_UI_LITE_KEY_FILE`. Reading enforces
 * owner-only mode; a missing file is created 0600 with a fresh key on first
 * store, parents included.
 */
export function keyFileProtector(path: string): LiteKeyProtector {
  return fileProtector("key-file", path);
}

/** The `<dataDir>/machine.key` fallback protector. */
export function machineKeyProtector(path: string): LiteKeyProtector {
  return fileProtector("machine-key", path);
}

function fileProtector(backend: string, path: string): LiteKeyProtector {
  return {
    backend,
    async load() {
      let key: Buffer;
      try {
        key = readFileSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      // POSIX mode check; Windows has no usable mode bits, so it passes through.
      if (process.platform !== "win32") {
        const mode = statSync(path).mode & 0o777;
        if (mode & 0o077) throw new LiteKeyFilePermissionError(path, mode);
      }
      if (key.length !== LITE_KEY_BYTES) throw new LiteKeyFileFormatError(path, key.length);
      return key;
    },
    async store(key) {
      mkdirSync(dirname(path), { recursive: true });
      try {
        // O_EXCL with the final mode so a fresh key is never briefly world-visible.
        const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        try {
          writeFileSync(fd, key);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Already present (concurrent first boot): keep the existing key — a
        // different one would orphan everything already sealed under it.
      }
    },
  };
}
