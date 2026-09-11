import { asBuffer, DEK_WORKER_TIMEOUT_MS, runProtectorInWorker } from "./dek-worker";
import type { KeyProtector } from "./host-key-cipher";

/**
 * The DEK as a Secret Service item (GNOME Keyring, KWallet's bridge, KeePassXC)
 * via libsecret, through the small N-API addon in `./linux-secret-service/`:
 * schema {@link SECRET_SCHEMA}, one attribute `dataRoot`. Secret Service only —
 * no `keyutils` or plaintext file fallback: a session with no D-Bus keyring
 * gets a degraded cipher and an honest status row, never a decodable secret on
 * disk under an "encrypted" label. The addon is never required here; the
 * Worker entry loads `index.cjs`, which requires the node-gyp output.
 */

export const SECRET_SCHEMA = "ai.lankford.omp-ui.host";

/** The addon's surface; async-tolerant so a Worker can stand in. */
export interface SecretServiceAddon {
  lookup(schema: string, attributes: Record<string, string>): Buffer | null | Promise<Buffer | null>;
  store(schema: string, label: string, attributes: Record<string, string>, secret: Buffer): void | Promise<void>;
}

/** Reads all matching legacy items in one Worker and under one shared deadline. */
export async function lookupLinuxSecretServiceMany(
  dataRoot: string,
  schema: string,
  candidates: readonly Readonly<Record<string, string>>[],
  timeoutMs: number = DEK_WORKER_TIMEOUT_MS,
  run: typeof runProtectorInWorker = runProtectorInWorker,
): Promise<Buffer[]> {
  const value = await run(
    { backend: "linux-secret-service", dataRoot },
    { name: "lookupMany", args: [schema, candidates] },
    timeoutMs,
  );
  if (!Array.isArray(value)) throw new Error("credential worker returned a non-array for legacy secrets");
  return value.map((secret, index) => asBuffer(secret, `legacy secret ${index}`));
}

export interface LinuxSecretServiceDeps {
  /** Test seam; the default runs the real addon on a Worker with a deadline. */
  addon?: SecretServiceAddon;
  timeoutMs?: number;
}

export function linuxSecretServiceProtector(dataRoot: string, deps: LinuxSecretServiceDeps = {}): KeyProtector {
  const addon = deps.addon ?? workerAddon(dataRoot, deps.timeoutMs ?? DEK_WORKER_TIMEOUT_MS);
  const attributes = { dataRoot };
  return {
    backend: "linux-secret-service",
    async load() {
      try {
        return await addon.lookup(SECRET_SCHEMA, attributes);
      } catch (error) {
        throw new Error(`secret service: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    },
    async store(dek) {
      try {
        await addon.store(SECRET_SCHEMA, `omp-ui host key (${dataRoot})`, attributes, dek);
      } catch (error) {
        throw new Error(`secret service: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    },
  };
}

function workerAddon(dataRoot: string, timeoutMs: number): SecretServiceAddon {
  const spec = { backend: "linux-secret-service", dataRoot } as const;
  return {
    async lookup(schema) {
      const value = await runProtectorInWorker(spec, { name: "lookup", args: [schema] }, timeoutMs);
      return value === null || value === undefined ? null : asBuffer(value, "stored key");
    },
    async store(schema, label, _attributes, secret) {
      await runProtectorInWorker(spec, { name: "store", args: [schema, label, secret] }, timeoutMs);
    },
  };
}
