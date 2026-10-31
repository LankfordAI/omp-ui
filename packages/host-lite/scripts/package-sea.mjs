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

// 1. Bundle the CLI via esbuild's JS API (the `bin/esbuild` file is a native
//    Go ELF, not a node script, so it must not be prefixed with `node`). Entry
//    is S1's; keep externals so natives resolve at runtime from NODE_PATH
//    (adjacent node_modules) exactly like the installed unit does. ESM output:
//    cli.ts uses top-level await and import.meta.url — both require esm, and
//    Node 22 SEA accepts an esm main (verified on this repo's 22.22).
const { build } = await import("esbuild");
await build({
  entryPoints: [path.join(pkgRoot, "src", "cli.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["node-pty", "node:*"],
  // CJS deps (ws) call require() for optional/native modules; esbuild's ESM
  // output routes those through a shim unless a real require exists — the
  // documented banner (createRequire over import.meta.url) makes the shim delegate.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
});

// 2. Blob + injection (postject is the documented post-Node-20 path).
fs.writeFileSync(
  configPath,
  JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2),
);
run(process.execPath, ["--experimental-sea-config", configPath]);

// The runtime binary embedded under the blob: an explicit OMP_UI_LITE_NODE wins
// (a static official Node for SEA packaging); otherwise the running one.
const baseNode = process.env.OMP_UI_LITE_NODE?.trim() || process.execPath;
if (!fs.existsSync(baseNode)) {
  console.error(`package-sea: OMP_UI_LITE_NODE path does not exist: ${baseNode}`);
  process.exit(2);
}
fs.copyFileSync(baseNode, outBin);
fs.chmodSync(outBin, 0o755);
// The sentinel lives in a SEA-capable (statically linked) node build. Distro
// packages that ship node as a thin shim over libnode.so have NO fuse anywhere
// in the executable — postject would fail cryptically, so name the real fix.
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
if (!fs.readFileSync(outBin).includes(FUSE)) {
  console.error(
    `package-sea: ${baseNode} carries no SEA fuse (it is likely a distro shim over libnode.so).\n` +
      "Packaging a SEA needs a static official Node binary:\n" +
      "  https://nodejs.org/dist/latest-v22.x/ — extract, then rerun with OMP_UI_LITE_NODE=<path-to-that-node>\n" +
      "Or skip SEA entirely: the plain-Node entry `node dist/cli.js serve` is wire-identical.",
  );
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(2);
}
const postject = path.join(pkgRoot, "..", "..", "node_modules", ".bin", "postject");
if (!fs.existsSync(postject)) {
  console.error("package-sea: postject missing from node_modules — npm i -D postject -w @omp-ui/host-lite first.");
  process.exit(2);
}
run(postject, [outBin, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", FUSE]);

console.log(`SEA binary: ${outBin}`);
console.log("Ship with: node_modules unpacked to ~/.local/lib/omp-ui-lite/node_modules (node-pty only needed); see packaging/install.sh.");
