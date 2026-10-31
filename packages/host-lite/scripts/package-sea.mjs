#!/usr/bin/env node
/* global process, console */
// SEA packaging for the lite member (issue #1010, plan step E). v1: linux-x64 only.
// Flow (verified against this repo's Node 22): esbuild single-file bundle ->
// `node --experimental-sea-config` blob -> postject injection into a copy of the
// running node binary. node-pty is NOT embedded (native .node modules cannot live
// in the SEA payload) — it ships adjacent and the systemd unit points NODE_PATH at
// it, matching packaging/install.sh and omp-ui-lite.service.
//
// Known upstream trap (from #447 research / T3 Code): on linux-arm64 with 16 KiB
// pages, Node's own --build-sea has a bug (nodejs/node#67048) that needs the
// copied-execPath workaround. v1 deliberately ships x64 only; porting to arm64
// means adopting that workaround whole, not just flipping the arch string.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const outDir = path.join(pkgRoot, "dist-sea");
const bundlePath = path.join(outDir, "cli.mjs");
const blobPath = path.join(outDir, "sea.blob");
const configPath = path.join(outDir, "sea-config.json");
const outBin = path.join(outDir, "omp-ui-lite");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

if (process.platform !== "linux" || process.arch !== "x64") {
  console.error(`package-sea: v1 supports linux-x64 only (host is ${process.platform}-${process.arch}).`);
  console.error("For other platforms run the plain-Node entry instead: node dist/cli.js serve");
  process.exit(2);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. Bundle the CLI. Entry is S1's; keep external so natives resolve at runtime
//    from NODE_PATH (adjacent node_modules) exactly like the installed unit does.
run(process.execPath, [
  path.join(pkgRoot, "..", "..", "node_modules", "esbuild", "bin", "esbuild"),
  path.join(pkgRoot, "src", "cli.ts"),
  "--bundle",
  "--platform=node",
  "--format=cjs", // SEA injection needs a CJS entry on Node 22.
  `--outfile=${bundlePath}`,
  "--external:node-pty",
  "--external:node:*",
]);

// 2. Blob + injection (postject is the documented post-Node-20 path).
fs.writeFileSync(
  configPath,
  JSON.stringify({ main: bundlePath, disableExperimentalSEAWarning: true }, null, 2),
);
run(process.execPath, ["--experimental-sea-config", configPath]);

fs.copyFileSync(process.execPath, outBin);
fs.chmodSync(outBin, 0o755);
const postject = path.join(pkgRoot, "..", "..", "node_modules", ".bin", "postject");
if (!fs.existsSync(postject)) {
  console.error("package-sea: postject missing from node_modules — npm i -D postject -w @omp-ui/host-lite first.");
  process.exit(2);
}
run(postject, [
  outBin,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
]);

console.log(`SEA binary: ${outBin}`);
console.log("Ship with: node_modules unpacked to ~/.local/lib/omp-ui-lite/node_modules (node-pty only needed); see packaging/install.sh.");
