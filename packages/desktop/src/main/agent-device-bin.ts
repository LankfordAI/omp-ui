import * as fs from "node:fs";
import * as path from "node:path";

const BIN = path.join("node_modules", "agent-device", "bin", "agent-device.mjs");
/** The `app.asar` path segment; its files are unpacked beside it (electron-builder asarUnpack). */
const ASAR_SEGMENT = /([\\/])app\.asar(?=[\\/])/;

/**
 * Walks up from __dirname for node_modules/agent-device/bin/agent-device.mjs; maps app.asar → app.asar.unpacked.
 * A package-name require.resolve cannot work: agent-device's `exports` has only
 * an import condition and no ./package.json. The walk covers the dev workspace
 * (hoisted to the repo-root node_modules) and the packaged app, whose child
 * process and adb need real files rather than asar members.
 */
export function resolveAgentDeviceBin(
  exists: (p: string) => boolean = fs.existsSync,
  start = __dirname,
): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, BIN).replace(ASAR_SEGMENT, "$1app.asar.unpacked");
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
