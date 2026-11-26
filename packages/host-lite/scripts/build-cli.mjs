#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
const version = process.env.HOST_LITE_VERSION?.trim() || pkg.version || "0.0.0";

const { build } = await import("esbuild");
await build({
  entryPoints: [path.join(pkgRoot, "src", "cli.ts")],
  outfile: path.join(pkgRoot, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node-pty", "ws", "js-yaml", "node:*"],
  define: {
    __OMP_UI_LITE_VERSION__: JSON.stringify(version),
  },
  // CJS deps (ws) call require() for optional/native modules; esbuild's ESM
  // output routes those through a shim unless a real require exists.
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

console.log(`[build-cli] dist/cli.js (version ${version})`);
