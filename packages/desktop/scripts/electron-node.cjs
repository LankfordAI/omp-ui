#!/usr/bin/env node
// Runs a built main entry under Electron's Node runtime (ELECTRON_RUN_AS_NODE=1,
// no display) on every OS. npm runs package scripts through cmd.exe on Windows,
// where an inline `VAR=1 cmd` prefix is not a command.
//
// Usage: node scripts/electron-node.cjs <entry.js> [args...]
"use strict";
const { spawnSync } = require("node:child_process");

const [entry, ...args] = process.argv.slice(2);
if (entry === undefined) {
  console.error("usage: node scripts/electron-node.cjs <entry.js> [args...]");
  process.exit(2);
}
const electron = require("electron"); // the executable path when required from Node
const result = spawnSync(electron, [entry, ...args], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
