// Boots the dev app with no OS window for agent verification runs
// (docs/development.md, "Verification runs"). Linux only: Chromium's headless
// Ozone platform does not exist elsewhere. Caller-provided OMP_UI_* values win
// over every default below; extra argv are forwarded to Electron as Chromium
// switches (`npm run dev:headless --workspace @omp-ui/desktop -- --no-sandbox`).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The hoisted workspace bin, so `node scripts/dev-headless.mjs` works outside npm too.
const electronVite = fileURLToPath(
  new URL("../../../node_modules/.bin/electron-vite", import.meta.url),
);

if (process.platform !== "linux") {
  console.error("dev:headless: headless Ozone is Linux-only; use `npm run dev`.");
  process.exit(1);
}

const env = { ...process.env, OMP_UI_HEADLESS: "1" };

if (!env.OMP_UI_REGISTRY_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "omp-ui-headless-"));
  env.OMP_UI_REGISTRY_PATH = join(dir, "registry.json");
  // A headless instance must never post OS notifications onto the developer's desktop.
  writeFileSync(
    env.OMP_UI_REGISTRY_PATH,
    JSON.stringify({ schemaVersion: 1, settings: { desktopNotifications: false } }),
  );
}
if (!env.OMP_UI_CDP_PORT) env.OMP_UI_CDP_PORT = "9223";
if (!env.OMP_UI_TEST_MODEL) {
  console.warn(
    "dev:headless: OMP_UI_TEST_MODEL is unset; sessions run at the project's default model (see docs/development.md, Verification runs).",
  );
}

console.log(
  `dev:headless: cdp=http://127.0.0.1:${env.OMP_UI_CDP_PORT} registry=${env.OMP_UI_REGISTRY_PATH} userData=@omp-ui/desktop-dev-headless`,
);

// Headless Ozone's default screen is 1x1, which clamps the BrowserWindow to 1x1
// (observed on Electron's headless platform); the override sizes the virtual
// screen so the 1600x1000 default window bounds apply.
const child = spawn(
  electronVite,
  [
    "dev",
    "--watch",
    "--",
    "--ozone-platform=headless",
    "--ozone-override-screen-size=1600,1000",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
