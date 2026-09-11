#!/usr/bin/env node
// Restore the executable bit on node-pty's spawn-helper (issue #489).
//
// The node-pty npm tarball stores prebuilds/darwin-*/spawn-helper with mode
// 0644. On macOS node-pty spawns every PTY through that helper: PtyFork passes
// helperPath as argv[0] to posix_spawnp (src/unix/pty.cc), so an installed
// but non-executable helper fails every spawn with "posix_spawnp failed."
// Since the lanes ship the prebuild unrebuilt (issue #484), nothing repairs
// the mode: node-gyp used to produce an executable build/Release/spawn-helper
// instead. The copied tree keeps the source mode everywhere it travels —
// into node_modules and into the packed app.asar.unpacked — so every consumer
// repairs it the same way: OR in 0o755, leave the data untouched.
//
// Three entry points share this module:
//   - smoke-node-pty.cjs requires ensureSpawnHelperExecBits() before spawning
//     under Electron (every packaging lane and CI run smoke first);
//   - electron-builder.yml wires this file as the afterPack hook, so the
//     packed app carries an executable helper even when packaging skips the
//     smoke (a local `npm run package:mac`);
//   - `node scripts/ensure-node-pty-exec.cjs` repairs the installed tree.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const HELPER = "spawn-helper";

function helperFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...helperFiles(file));
    else if (entry.isFile() && entry.name === HELPER) found.push(file);
  }
  return found;
}

function fixHelpersUnder(root) {
  const fixed = [];
  for (const file of helperFiles(root)) {
    const mode = fs.statSync(file).mode;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(file, mode | 0o755);
      fixed.push(file);
    }
  }
  return fixed;
}

// The node-pty copy npm actually resolved (hoisted or nested — resolution is
// by real path, not by layout). No node-pty in the tree, nothing to repair.
function ensureSpawnHelperExecBits() {
  let pkg;
  try {
    pkg = require.resolve("node-pty/package.json");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return [];
    throw error;
  }
  return fixHelpersUnder(path.dirname(pkg));
}

// electron-builder afterPack hook: runs on the packed application directory,
// before signing and before any target (DMG/ZIP/AppImage/NSIS) is produced.
// Linux compiles its helper executable and Windows has ConPTY instead, so
// those platforms find nothing here; on macOS this is the artifact guarantee.
module.exports = async function afterPack(context) {
  const fixed = fixHelpersUnder(context.appOutDir);
  for (const file of fixed) {
    console.log(`afterPack: restored exec bit on ${path.relative(context.appOutDir, file)} (issue #489)`);
  }
};
module.exports.ensureSpawnHelperExecBits = ensureSpawnHelperExecBits;

if (require.main === module) {
  const fixed = ensureSpawnHelperExecBits();
  console.log(fixed.length ? `repaired spawn-helper: ${fixed.join(", ")}` : "spawn-helper already executable");
}
