import * as path from "node:path";
import { isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DekTimeout } from "./host-key-cipher";

/**
 * Runs one native credential-store call on a `worker_threads` Worker with a
 * hard deadline (issue #442 §10.3). The keyring bindings are synchronous
 * native calls: libsecret blocks on D-Bus while the desktop shows an unlock
 * prompt, the macOS keychain blocks behind its own dialog, and DPAPI can stall
 * on a roaming profile. On the main thread any of those would wedge the whole
 * host; on a Worker, `terminate()` at the deadline kills the call and the host
 * carries on with a degraded cipher.
 *
 * `dek-worker-entry.cjs` is the entry: CommonJS so the Worker loads it with no
 * TS loader, and the only file in the credentials module that requires a
 * native binding. It receives `{ backend, dataRoot, op }` as `workerData`,
 * runs the named op for that backend, and posts one message back.
 */

export type NativeBackend = "linux-secret-service" | "macos-keychain" | "windows-dpapi";

export interface ProtectorSpec {
  backend: NativeBackend;
  /** The keyring account/attribute the DEK is filed under — one DEK per data root. */
  dataRoot: string;
}

/** A native op by name; `args` must survive structured clone (Buffers arrive as Uint8Array). */
export interface ProtectorOp {
  name: string;
  args: readonly unknown[];
}

/** The real entry, or an inline script for tests (`eval: true`). */
export type WorkerEntry = { url: URL } | { source: string };

/**
 * Where the worker entry lives. From source the `.cjs` sits beside this
 * module; inside the single-executable (`package-host.mjs`) it is laid out at
 * `<install>/lib/dek-worker-entry.cjs`, beside the natives it requires, and
 * the bundle has no module URL of its own. Resolved lazily so importing this
 * module never touches `import.meta` under the SEA.
 */
export function defaultWorkerEntry(): WorkerEntry {
  if (isSea()) {
    const lib = path.join(path.dirname(process.execPath), "..", "lib");
    return { url: pathToFileURL(path.join(lib, "dek-worker-entry.cjs")) };
  }
  return { url: new URL("./dek-worker-entry.cjs", import.meta.url) };
}

/** Long enough for a keyring unlock the user is already typing into; short enough to notice a wedge. */
export const DEK_WORKER_TIMEOUT_MS = 5000;

/** What the entry posts back: exactly one of these per Worker. */
type WorkerReply = { ok: true; value: unknown } | { ok: false; message: string };

function isWorkerReply(value: unknown): value is WorkerReply {
  if (value === null || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") return false;
  return value.ok || ("message" in value && typeof value.message === "string");
}

/**
 * Resolves with the op's structured-cloned result, rejects with the entry's
 * error (message preserved), or rejects with {@link DekTimeout} after
 * terminating the Worker at the deadline. One Worker per call: a DEK is read
 * once at boot and written once ever, so a pool would only add lifecycle.
 */
export function runProtectorInWorker(
  spec: ProtectorSpec,
  op: ProtectorOp,
  timeoutMs: number,
  entry: WorkerEntry = defaultWorkerEntry(),
): Promise<unknown> {
  // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
  return new Promise((resolve, reject) => {
    const workerData = { backend: spec.backend, dataRoot: spec.dataRoot, op };
    const worker =
      "url" in entry
        ? new Worker(entry.url, { workerData })
        : new Worker(entry.source, { workerData, eval: true });
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new DekTimeout(timeoutMs)));
      void worker.terminate();
    }, timeoutMs);
    worker.once("message", (reply: unknown) => {
      settle(() => {
        if (!isWorkerReply(reply)) reject(new Error(`credential worker posted an unexpected reply`));
        else if (reply.ok) resolve(reply.value);
        else reject(new Error(reply.message));
      });
      void worker.terminate();
    });
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) => {
      settle(() => reject(new Error(`credential worker exited with code ${code} before answering`)));
    });
  });
}

/** Structured clone turns a Buffer into a Uint8Array; the protectors want Buffers back. */
export function asBuffer(value: unknown, what: string): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`credential worker returned a ${typeof value} for ${what}, expected bytes`);
}
