// Boots the dev app with no OS window for agent verification runs
// (docs/development.md, "Verification runs"). Linux only: Chromium's headless
// Ozone platform does not exist elsewhere. Caller-provided OMP_UI_* values win
// over every default below; extra argv are forwarded to Electron as Chromium
// switches (`npm run dev:headless --workspace @omp-ui/desktop -- --no-sandbox`).
// `--pane` is a script switch, not a Chromium switch: it serves the app over
// loopback HTTP (seeded remote settings + a web-bundle watcher) and prints a
// URL another omp-ui instance can load in its browser pane.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

const argv = process.argv.slice(2);
// --pane is consumed here; it must not reach Chromium.
const pane = argv.includes("--pane");
const chromiumArgs = argv.filter((a) => a !== "--pane");

/** OS-chosen free loopback port; mirrors availablePort() in remote-server.test.ts. */
async function freePort() {
  const srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const { port } = srv.address();
  await new Promise((res) => srv.close(res));
  return port;
}

// Same format as mintRemoteToken() in packages/server/src/token.ts; inlined
// to keep this launcher independent of the workspace build graph.
const paneToken = pane ? randomBytes(32).toString("base64url") : "";

// A headless instance must never post OS notifications onto the developer's
// desktop, and --pane additionally needs a served instance. These keys win
// even in a user-supplied OMP_UI_REGISTRY_PATH (dev artifacts only either way).
const seeded = { desktopNotifications: false };
if (pane) {
  seeded.remoteEnabled = true;
  seeded.remoteBind = "localhost";
  seeded.remotePort = await freePort();
  seeded.remoteToken = paneToken;
}
if (!env.OMP_UI_REGISTRY_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "omp-ui-headless-"));
  env.OMP_UI_REGISTRY_PATH = join(dir, "registry.json");
}
// An existing registry keeps everything it has; the seeded keys above win.
let doc = { schemaVersion: 1 };
try {
  doc = JSON.parse(readFileSync(env.OMP_UI_REGISTRY_PATH, "utf8"));
} catch {
  // Missing or malformed file: start from a fresh document.
}
doc.settings = { ...(doc.settings ?? {}), ...seeded };
writeFileSync(env.OMP_UI_REGISTRY_PATH, JSON.stringify(doc));
if (!env.OMP_UI_CDP_PORT) env.OMP_UI_CDP_PORT = "9223";
if (!env.OMP_UI_TEST_MODEL) {
  console.warn(
    "dev:headless: OMP_UI_TEST_MODEL is unset; sessions run at the project's default model (see docs/development.md, Verification runs).",
  );
}

console.log(
  `dev:headless: cdp=http://127.0.0.1:${env.OMP_UI_CDP_PORT} registry=${env.OMP_UI_REGISTRY_PATH} userData=@omp-ui/desktop-dev-headless`,
);
if (pane) {
  console.log(`dev:headless: pane=http://127.0.0.1:${seeded.remotePort}/?t=${paneToken}`);
}

// electron-vite dev rebuilds out/main|preload|renderer only; the remote server
// serves out/web, so a watcher keeps that bundle current for the pane.
const viteBin = fileURLToPath(new URL("../../../node_modules/.bin/vite", import.meta.url));
let viteChild = null;
if (pane) {
  viteChild = spawn(
    viteBin,
    ["build", "--watch", "--config", "vite.web.config.ts"],
    // cwd = packages/desktop: the config resolves via __dirname and Tailwind
    // content detection starts from cwd (see vite.web.config.ts header).
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "ignore", "inherit"],
      env,
    },
  );
  viteChild.on("exit", (code) =>
    console.warn(
      `dev:headless: web watcher exited (${code ?? "signal"}); the pane serves the last built bundle`,
    ),
  );
}

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
    ...chromiumArgs,
  ],
  { stdio: "inherit", env },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    viteChild?.kill(signal);
  });
}
child.on("exit", (code, signal) => {
  viteChild?.kill();
  process.exit(code ?? (signal ? 1 : 0));
});
