#!/usr/bin/env node
// Prove the node-pty addon that ships in the package loads inside Electron's
// Node runtime and can spawn a shell (issue #484).
//
// The release lanes never rebuild node-pty for Electron: the addon is Node-API
// (binding.gyp depends on node-addon-api), so the copy npm installs — a prebuild
// on Windows and macOS, a node-gyp build on Linux — is the copy electron-builder
// packs. verify-*-package only proves that copy exists on disk; this proves it
// resolves its imports and runs under the exact Electron the package embeds.
//
// Usage: npm run smoke:pty --workspace @omp-ui/desktop
// Under plain Node the script relaunches itself as `electron` with
// ELECTRON_RUN_AS_NODE=1, which needs no display.
"use strict";
const { spawnSync } = require("node:child_process");

if (!process.versions.electron) {
  const electron = require("electron"); // the executable path when required from Node
  const result = spawnSync(electron, [__filename], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// The npm tarball stores the darwin spawn-helper 0644; restore the exec bit
// before spawning, or posix_spawnp fails on every macOS lane (issue #489).
require("./ensure-node-pty-exec.cjs").ensureSpawnHelperExecBits();
const pty = require("node-pty");

const MARKER = "omp-ui-pty-ok";
const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
const args = process.platform === "win32" ? ["/c", `echo ${MARKER}`] : ["-c", `echo ${MARKER}`];
const runtime = `Electron ${process.versions.electron} (Node ${process.versions.node}, ABI ${process.versions.modules}, ${process.platform}-${process.arch})`;

const timer = setTimeout(() => {
  console.error(`node-pty smoke: ${shell} did not exit within 20s under ${runtime}`);
  process.exit(1);
}, 20_000);

let output = "";
const term = pty.spawn(shell, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
term.onData((chunk) => {
  output += chunk;
});
term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !output.includes(MARKER)) {
    console.error(`node-pty smoke: ${shell} exited ${exitCode} without "${MARKER}" under ${runtime}:\n${output}`);
    process.exit(1);
  }
  console.log(`node-pty smoke: spawned ${shell} under ${runtime}`);
  process.exit(0);
});
