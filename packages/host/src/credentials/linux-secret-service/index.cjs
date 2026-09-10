"use strict";
/**
 * Loads the libsecret addon `node-gyp` builds beside this file
 * (`npm run build:secret-service` in packages/host). Required lazily so an
 * unbuilt addon is a clear error from `lookup`/`store`, which the credential
 * Worker posts back as the degraded cipher's reason, instead of a load-time
 * crash for whoever required this shim.
 *
 * Addon API (secret_service.cc):
 *   lookup(schemaName, attributes) -> Buffer | null
 *   store(schemaName, label, attributes, secret: Buffer) -> undefined
 * Both throw with libsecret's message on a missing session bus or a
 * SECRET_ERROR; there is no keyutils or file fallback.
 */
const path = require("node:path");

const ADDON = path.join(__dirname, "build", "Release", "secret_service.node");

let addon = null;

function load() {
  if (addon !== null) return addon;
  try {
    addon = require(ADDON);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`libsecret addon not built (npm run build:secret-service in packages/host): ${detail}`, {
      cause: error,
    });
  }
  return addon;
}

module.exports = {
  lookup(schemaName, attributes) {
    return load().lookup(schemaName, attributes);
  },
  store(schemaName, label, attributes, secret) {
    load().store(schemaName, label, attributes, secret);
  },
};
