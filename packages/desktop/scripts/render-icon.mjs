// Regenerates packages/desktop/build/icon.png — the omp-ui wordmark app icon
// (issue #11). Renders the wordmark tile with the app's real Bricolage
// Grotesque variable font and the exact token colors from
// src/renderer/src/style.css, via headless Chromium.
//
//   Run from repo root:  node packages/desktop/scripts/render-icon.mjs
//   Requires: a chromium binary on PATH and `npm ci` at the repo root (the
//   fontsource woff2 lives in root node_modules).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outPng = fileURLToPath(new URL("../build/icon.png", import.meta.url));

const WOFF = join(
  repoRoot,
  "node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2",
);
const b64 = readFileSync(WOFF).toString("base64");

// Token values from src/renderer/src/style.css (computed in Step 1; do not
// guess new ones — the icon is a static artifact, so these are literals, not
// a component).
const TILE = "#0e1013"; // bg-sunken
const LINE = "#23282f"; // --color-line  (hairline)
const OM = "#e8ecf1";   // text-ink       (the "omp")
const UI = "#6f7b8a";   // text-ink-dim   (the "-ui")

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Bricolage Grotesque';font-style:normal;font-weight:100 800;src:url(data:font/woff2;base64,${b64})format('woff2')}
html,body{margin:0;width:512px;height:512px;background:transparent;overflow:hidden}
.tile{position:absolute;inset:0;background:${TILE};border:4px solid ${LINE};border-radius:64px;box-sizing:border-box;display:flex;align-items:center;justify-content:center}
.mark{font-family:'Bricolage Grotesque';font-weight:600;color:${OM};font-size:116px;letter-spacing:-0.025em;line-height:1;transform:translateY(-0.03em)}
.ui{color:${UI}}</style></head><body><div class="tile"><span class="mark">omp<span class="ui">-ui</span></span></div></body></html>`;

function chromium() {
  for (const bin of ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]) {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const bin = chromium();
if (!bin) {
  console.error("render-icon: no chromium binary on PATH (looked for chromium-browser/chromium/google-chrome)");
  process.exit(1);
}

const htmlPath = "/tmp/omp-ui-icon.html";
writeFileSync(htmlPath, HTML);

const r = spawnSync(
  bin,
  [
    "--headless=new",
    `--screenshot=${outPng}`,
    "--window-size=512,512",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000", // transparent outside the rounded tile
    "--virtual-time-budget=3000",
    `file://${htmlPath}`,
  ],
  { encoding: "utf8" },
);
if (r.status !== 0) {
  console.error(r.stderr || `chromium exited ${r.status}`);
  process.exit(1);
}

const buf = readFileSync(outPng);
if (buf.length < 24 + 8 || buf.readUInt32BE(16) !== 512 || buf.readUInt32BE(20) !== 512) {
  console.error(`render-icon: output is not 512x512 PNG (${buf.length} bytes)`);
  process.exit(1);
}
console.log(`wrote ${outPng} (${buf.length} bytes)`);
