/**
 * Drift-gate test fixture (issue #1010): stands in for a future desktop leaf
 * that imports Electron at RUNTIME. Never imported by the real graph — the
 * bundle test adds it as an extra entry point and asserts the build FAILS with
 * the gate's named error, proving a new runtime electron import reaching lite
 * breaks the bundle loudly instead of shipping a broken headless host.
 */
import "electron";

export const driftLeaf = true;
