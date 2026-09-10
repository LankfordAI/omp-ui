"use strict";
/**
 * Worker entry for `dek-worker.ts`: the one file in the credentials module
 * that touches a native keyring binding. Receives `{ backend, dataRoot, op }`
 * as workerData, runs the named op, posts exactly one reply
 * (`{ ok: true, value }` or `{ ok: false, message }`) and exits. Bindings are
 * required lazily inside each op so a missing optional dependency is a posted
 * error for that backend, not a crash for every platform.
 *
 * Ops take `dataRoot` first, then the caller's args (structured-cloned, so
 * Buffers arrive as Uint8Array). Returned Buffers clone back the same way.
 */
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

/**
 * A native binding by name. From source it resolves through node_modules;
 * inside the packaged host (`package-host.mjs`) this file and the bindings sit
 * together under `<install>/lib/`, so a bare specifier that fails falls back
 * to the sibling directory of the same name.
 */
function native(id) {
  try {
    return require(id);
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require(path.join(__dirname, id));
  }
}

const NATIVE = {
  "macos-keychain": {
    getPassword(dataRoot, service) {
      const { Entry } = native("@napi-rs/keyring");
      return new Entry(service, dataRoot).getPassword();
    },
    setPassword(dataRoot, service, password) {
      const { Entry } = native("@napi-rs/keyring");
      new Entry(service, dataRoot).setPassword(password);
      return null;
    },
  },
  "windows-dpapi": {
    protect(_dataRoot, plain) {
      const { Dpapi } = native("@primno/dpapi");
      return Dpapi.protectData(new Uint8Array(plain), null, "CurrentUser");
    },
    unprotect(_dataRoot, blob) {
      const { Dpapi } = native("@primno/dpapi");
      return Dpapi.unprotectData(new Uint8Array(blob), null, "CurrentUser");
    },
  },
  "linux-secret-service": {
    lookup(dataRoot, schema) {
      return require("./linux-secret-service/index.cjs").lookup(schema, { dataRoot });
    },
    store(dataRoot, schema, label, secret) {
      require("./linux-secret-service/index.cjs").store(schema, label, { dataRoot }, Buffer.from(secret));
      return null;
    },
  },
};

function run({ backend, dataRoot, op }) {
  const ops = Object.hasOwn(NATIVE, backend) ? NATIVE[backend] : undefined;
  if (ops === undefined) throw new Error(`unknown credential backend: ${backend}`);
  const fn = Object.hasOwn(ops, op.name) ? ops[op.name] : undefined;
  if (fn === undefined) throw new Error(`unknown ${backend} op: ${op.name}`);
  return fn(dataRoot, ...op.args);
}

try {
  parentPort.postMessage({ ok: true, value: run(workerData) });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
