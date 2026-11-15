// PROTOTYPE (#1168) — throwaway; not product code.
//
// Measures the GPU/CPU cost of a backdrop behind the glass chrome, checks how a
// CSS-animated SVG behaves inside an <img> (animates? pauses when hidden?
// honours reduced motion?), and captures the look variants.
//
//   node_modules/.bin/electron packages/desktop/scripts/prototype-backdrop-1168/main.cjs \
//     [--only=exp4|cost|looks] [--secs=N] [--headless]
//
// The real-display run opens one window with showInactive (never takes focus)
// because the #511 re-filter cost lives in the on-screen compositor path that
// headless Ozone does not exercise. GPU busy % comes from amdgpu's sysfs
// counter; CPU from app.getAppMetrics(). Writes out/summary-*.json, out/*.png.
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const flag = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? def : hit.slice(name.length + 3);
};
const ONLY = flag("only", "all");
const SECS = Number(flag("secs", "10"));
const HEADLESS = process.argv.includes("--headless");
const OUT = path.join(__dirname, "out");
const PAGE = path.join(__dirname, "page.html");
const GPU_BUSY = fs
  .readdirSync("/sys/class/drm")
  .map((d) => `/sys/class/drm/${d}/device/gpu_busy_percent`)
  .find((p) => fs.existsSync(p));

if (HEADLESS) {
  app.commandLine.appendSwitch("ozone-platform", "headless");
  app.commandLine.appendSwitch("ozone-override-screen-size", "1600,1000");
}
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (xs) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10);
const pct = (xs, p) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** Sample GPU busy % at 10 Hz and per-process CPU at 2 Hz for `ms`. */
async function sample(ms) {
  const gpu = [];
  const cpu = { renderer: [], gpu: [], browser: [] };
  const end = Date.now() + ms;
  let tick = 0;
  app.getAppMetrics(); // prime the CPU counters
  while (Date.now() < end) {
    if (GPU_BUSY) gpu.push(Number(fs.readFileSync(GPU_BUSY, "utf8")));
    if (++tick % 5 === 0) {
      for (const m of app.getAppMetrics()) {
        const key = m.type === "Tab" ? "renderer" : m.type === "GPU" ? "gpu" : m.type === "Browser" ? "browser" : null;
        if (key) cpu[key].push(m.cpu.percentCPUUsage);
      }
    }
    await sleep(100);
  }
  return {
    gpuBusyMean: mean(gpu),
    gpuBusyP90: pct(gpu, 90),
    cpuRenderer: mean(cpu.renderer),
    cpuGpuProcess: mean(cpu.gpu),
    cpuBrowser: mean(cpu.browser),
  };
}

async function load(win, query) {
  await win.loadURL(`file://${PAGE}?${new URLSearchParams(query)}`);
  await sleep(1500);
}

const evalJs = (win, js) => win.webContents.executeJavaScript(js, true);

/** Two captures of translucent chrome `gap` ms apart differ → the scene behind it moved. */
async function sceneMoves(win, gap = 1200) {
  const rects = [
    { x: 0, y: 0, width: 1600, height: 36 }, // title bar
    { x: 1300, y: 40, width: 300, height: 400 }, // inspector rail
  ];
  const a = await Promise.all(rects.map((r) => win.webContents.capturePage(r)));
  await sleep(gap);
  const b = await Promise.all(rects.map((r) => win.webContents.capturePage(r)));
  return a.some((img, i) => !img.toBitmap().equals(b[i].toBitmap()));
}

async function exp4(win, summary) {
  const r = {};
  await load(win, { bg: "animated", look: "chrome", blur: "today" });
  r.svgImgAnimatesVisible = await sceneMoves(win);
  r.visibleIdle = await sample(SECS * 1000);

  // Hidden: minimized, then hidden. Record what the page believes and the cost.
  win.minimize();
  await sleep(1500);
  r.minimized = { visibility: await evalJs(win, "document.visibilityState"), ...(await sample(SECS * 1000)) };
  win.restore();
  win.showInactive();
  await sleep(1500);
  win.hide();
  await sleep(1500);
  r.hidden = { visibility: await evalJs(win, "document.visibilityState"), ...(await sample(SECS * 1000)) };
  win.showInactive();
  await sleep(1500);

  // Reduced motion via CDP media emulation: does it reach inside the <img> document?
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await load(win, { bg: "animated", look: "chrome", blur: "today" });
  r.reducedMotionPageMatches = await evalJs(win, "matchMedia('(prefers-reduced-motion: reduce)').matches");
  r.svgImgAnimatesUnderReducedMotion = await sceneMoves(win);
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  win.webContents.debugger.detach();

  // Still-frame swap: replacing src with the static scene stops all motion.
  await load(win, { bg: "animated", look: "chrome", blur: "today" });
  await evalJs(win, "document.getElementById('scene').src = 'scene-static.svg'");
  await sleep(800);
  r.stillFrameSwapStopsMotion = !(await sceneMoves(win));
  summary.exp4 = r;
}

const COST_CONFIGS = [
  { name: "today: wash, chrome-only", q: { bg: "wash", look: "chrome", blur: "today" } },
  { name: "animated, chrome-only, unblurred scene", q: { bg: "animated", look: "chrome", blur: "today" } },
  { name: "animated, chrome-only, blur scene once", q: { bg: "animated", look: "chrome", blur: "scene" } },
  { name: "animated, chrome-only, blur every plane", q: { bg: "animated", look: "chrome", blur: "plane" } },
  { name: "animated, full glass, blur scene once", q: { bg: "animated", look: "full", blur: "scene" } },
  { name: "animated, full glass, blur every plane", q: { bg: "animated", look: "full", blur: "plane" } },
  { name: "static, full glass, blur scene once", q: { bg: "static", look: "full", blur: "scene" } },
  { name: "static, full glass, blur every plane", q: { bg: "static", look: "full", blur: "plane" } },
];

// Background GPU load from the rest of the desktop drifts by several percent
// over minutes, so every config gets its own hidden-window baseline taken just
// before it, and configs run in two rounds (forward, then reverse order).
async function cost(win, summary) {
  const rows = [];
  const rounds = [COST_CONFIGS, [...COST_CONFIGS].reverse()];
  for (const [round, configs] of rounds.entries()) {
    for (const c of configs) {
      await load(win, c.q);
      win.hide();
      await sleep(1500);
      const row = { round, config: c.name, hiddenBaseline: await sample(SECS * 1000) };
      win.showInactive();
      await sleep(1500);
      for (const phase of ["idle", "stream", "scroll"]) {
        await evalJs(win, `proto.phase(${JSON.stringify(phase)})`);
        await sleep(1000);
        row[phase] = await sample(SECS * 1000);
      }
      await evalJs(win, "proto.phase('idle')");
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  summary.cost = { rows };
  summary.gpuFeatureStatusAfterRun = app.getGPUFeatureStatus();
}

const LOOKS = [
  { file: "look-today.png", q: { bg: "wash", look: "chrome", blur: "today", alpha: 86 } },
  { file: "look-chrome-only.png", q: { bg: "static", look: "chrome", blur: "scene", alpha: 86 } },
  { file: "look-full-glass-a86.png", q: { bg: "static", look: "full", blur: "scene", alpha: 86 } },
  { file: "look-scrim50-glass-a70.png", q: { bg: "static", look: "full", blur: "scene", alpha: 70, scrim: 50 } },
  { file: "look-full-glass-a70-FAILS-GATE.png", q: { bg: "static", look: "full", blur: "scene", alpha: 70 } },
  { file: "look-full-glass-a86-sharp-scene.png", q: { bg: "static", look: "full", blur: "today", alpha: 86 } },
];

async function looks(win, summary) {
  summary.looks = [];
  for (const l of LOOKS) {
    await load(win, l.q);
    await sleep(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, l.file), img.toPNG());
    summary.looks.push(l);
  }
}

app.whenReady().then(async () => {
  const summary = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    headless: HEADLESS,
    gpuBusyCounter: GPU_BUSY ?? null,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    secsPerSample: SECS,
  };
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: "#0a0b0d",
    webPreferences: { contextIsolation: false, sandbox: false },
  });
  await load(win, { bg: "wash" });
  win.showInactive();
  await sleep(1500);
  try {
    if (ONLY === "all" || ONLY === "exp4") await exp4(win, summary);
    if (ONLY === "all" || ONLY === "looks") await looks(win, summary);
    if (ONLY === "all" || ONLY === "cost") await cost(win, summary);
  } catch (error) {
    summary.error = String(error?.stack ?? error);
  }
  const file = path.join(OUT, `summary-${ONLY}${HEADLESS ? "-headless" : ""}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`summary=${file}`);
  app.quit();
});
