import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextDurably } from "@omp-ui/core";
import { asBuffer, DEK_WORKER_TIMEOUT_MS, runProtectorInWorker } from "./dek-worker";
import type { KeyProtector } from "./host-key-cipher";

/**
 * The DEK wrapped by DPAPI (`@primno/dpapi`, CurrentUser scope) and kept in
 * `<dataRoot>/master.key` as base64 text, 0600, written durably. Windows has
 * no keyring item to file it under, so the file is the store and DPAPI ties it
 * to the user's login. File I/O stays on this thread; only the DPAPI call runs
 * on the Worker, and the binding is never imported here.
 */

export const MASTER_KEY_FILE = "master.key";

/** The slice of `@primno/dpapi`'s `Dpapi` the protector uses; async-tolerant so a Worker can stand in. */
export interface DpapiBindings {
  protectData(plain: Uint8Array, entropy: null, scope: "CurrentUser"): Uint8Array | Promise<Uint8Array>;
  unprotectData(blob: Uint8Array, entropy: null, scope: "CurrentUser"): Uint8Array | Promise<Uint8Array>;
}

export interface WindowsDpapiDeps {
  /** Test seam; the default runs the real binding on a Worker with a deadline. */
  dpapi?: DpapiBindings;
  timeoutMs?: number;
}

export function windowsDpapiProtector(dataRoot: string, deps: WindowsDpapiDeps = {}): KeyProtector {
  const dpapi = deps.dpapi ?? workerDpapi(dataRoot, deps.timeoutMs ?? DEK_WORKER_TIMEOUT_MS);
  const file = path.join(dataRoot, MASTER_KEY_FILE);
  return {
    backend: "windows-dpapi",
    async load() {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      const wrapped = Buffer.from(text.trim(), "base64");
      if (wrapped.length === 0) throw new Error(`${MASTER_KEY_FILE} is not a base64 DPAPI blob`);
      return Buffer.from(await dpapi.unprotectData(wrapped, null, "CurrentUser"));
    },
    async store(dek) {
      const wrapped = Buffer.from(await dpapi.protectData(dek, null, "CurrentUser"));
      writeTextDurably(file, `${wrapped.toString("base64")}\n`, 0o600);
    },
  };
}

function workerDpapi(dataRoot: string, timeoutMs: number): DpapiBindings {
  const spec = { backend: "windows-dpapi", dataRoot } as const;
  return {
    async protectData(plain) {
      return asBuffer(await runProtectorInWorker(spec, { name: "protect", args: [plain] }, timeoutMs), "protected key");
    },
    async unprotectData(blob) {
      return asBuffer(await runProtectorInWorker(spec, { name: "unprotect", args: [blob] }, timeoutMs), "unwrapped key");
    },
  };
}
