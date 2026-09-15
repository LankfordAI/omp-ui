// PROTOTYPE (#526) — throwaway; not product code.
//
// Electron main process: one offscreen BrowserWindow (the "pane"), a loopback
// CDP bridge that lets puppeteer-core / omp drive that page through
// webContents.debugger, a JPEG frame writer fed by `paint`, and an input
// self-test that pushes mouse/keyboard events into the hidden window.
//
//   npx electron packages/desktop/scripts/prototype-cdp-bridge-526/main.cjs [flags]
//
// Flags: --size=WxH --dsf=N --fps=N --frames=N|all --software --url=http://…
//        --anim --out=DIR --no-input-test
"use strict";

const { app, BrowserWindow, session } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { WebSocketServer, WebSocket } = require("ws");

// ---------------------------------------------------------------- flags

function flag(name, def) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? def : hit.slice(prefix.length);
}
const has = (name) => process.argv.includes(`--${name}`);

const [WIDTH, HEIGHT] = flag("size", "1280x800").split("x").map(Number);
const dsfArg = flag("dsf", null);
const DSF = dsfArg === null ? 1 : Number(dsfArg);
const FPS = Number(flag("fps", "30"));
const framesArg = flag("frames", "60");
const WRITE_ALL = framesArg === "all";
const FRAMES_TO_WRITE = WRITE_ALL ? Infinity : Number(framesArg);
const SOFTWARE = has("software");
const EXTERNAL_URL = flag("url", null);
const ANIM = has("anim");
const OUT_DIR = path.resolve(flag("out", path.join(__dirname, "out")));
const NO_INPUT_TEST = has("no-input-test");
const PARTITION = "browser-pane-526";

if (SOFTWARE) app.disableHardwareAcceleration();

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_DIR, "frames"), { recursive: true });

// ---------------------------------------------------------------- traffic log

const T0 = Date.now();
const traffic = fs.createWriteStream(path.join(OUT_DIR, "cdp-traffic.jsonl"));

function trunc(value) {
  if (value === undefined) return undefined;
  const s = JSON.stringify(value);
  if (s === undefined || s.length <= 2000) return value;
  return `${s.slice(0, 2000)}…(+${s.length - 2000} chars)`;
}

function log(entry) {
  traffic.write(`${JSON.stringify({ ts: Date.now() - T0, ...entry })}\n`);
}

const round = (n) => (n === null || n === undefined ? n : Math.round(n * 100) / 100);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- state

const bridge = {
  port: 0,
  tokenPathHits: 0,
  rootPathHits: 0,
  tokenToRootGapMs: [],
  upgradeRejected: 0,
  connections: 0,
  appQuitLeak: false,
  debuggerDetach: null,
};
const frames = {
  count: 0,
  written: 0,
  size: null,
  sizes: [],
  encodeMs: [],
  gapMs: [],
  bytes: [],
  dirtyFraction: [],
  lastAt: 0,
  idlePaintsIn3s: null,
  firstFrameIsJpeg: null,
};
const inputTest = [];

/** @type {Map<number, object>} client n -> Client */
const clients = new Map();
/** @type {Map<string, object>} sessionId -> owning Client */
const owner = new Map();
/** @type {Map<string, object>} root attach events seen before their attachToTarget reply */
const unownedAttach = new Map();
/** @type {Map<string, {targetInfo: object, parentSid: string|null}>} */
const attachInfo = new Map();
let nextClientN = 0;

let win, wc, dbg, token, pageId, tabId, browserVersion, devUrl, dprReported = null;
let pendingLatency = null;
let contextMenuCount = 0;
let finishing = false;

// ---------------------------------------------------------------- bridge helpers

function tally(obj, method) {
  obj[method] = (obj[method] ?? 0) + 1;
}

function newClient(ws) {
  const c = {
    n: ++nextClientN,
    ws,
    discover: false,
    owned: new Set(),
    firstMethod: null,
    rootIntercepted: {},
    rootForwarded: {},
    sessionIntercepted: {},
    sessionForwarded: {},
    errors: {},
    createTargetCalls: 0,
    closeTargetCalls: 0,
    browserCloseCalls: 0,
    sessionsOwnedMax: 0,
  };
  clients.set(c.n, c);
  return c;
}

function send(c, msg) {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  log({
    kind: "out",
    client: c.n,
    sessionId: msg.sessionId,
    id: msg.id,
    method: msg.method,
    params: trunc(msg.params),
    result: trunc(msg.result),
    error: msg.error,
  });
  c.ws.send(JSON.stringify(msg));
}

function claim(c, sid) {
  owner.set(sid, c);
  c.owned.add(sid);
  c.sessionsOwnedMax = Math.max(c.sessionsOwnedMax, c.owned.size);
}

function release(sid) {
  const c = owner.get(sid);
  if (c) c.owned.delete(sid);
  owner.delete(sid);
  attachInfo.delete(sid);
}

function ownedOfType(c, type) {
  for (const sid of c.owned) {
    if (attachInfo.get(sid)?.targetInfo?.type === type) return sid;
  }
  return null;
}

/** Forward a command to Electron's debugger; sessionId undefined = root. */
function cmd(method, params = {}, sessionId) {
  log({ kind: "electron-cmd", sessionId, method, params: trunc(params) });
  return sessionId === undefined ? dbg.sendCommand(method, params) : dbg.sendCommand(method, params, sessionId);
}

/** Deliver the buffered root attach event for `sid` to its new owner. */
function flushAttach(c, sid) {
  const params = unownedAttach.get(sid);
  if (!params) return;
  unownedAttach.delete(sid);
  attachInfo.set(sid, { targetInfo: params.targetInfo, parentSid: null });
  send(c, { method: "Target.attachedToTarget", params });
}

async function detachAll(c) {
  for (const sid of [...c.owned]) {
    await cmd("Target.detachFromTarget", { sessionId: sid }).catch((err) => log({ kind: "note", detachError: err.message, sid }));
    release(sid);
  }
}

/** Shared by Target.closeTarget and Page.close: fake the close for one client, keep the pane. */
async function closeForClient(c) {
  c.closeTargetCalls += 1;
  const tabSid = ownedOfType(c, "tab");
  const pageSid = ownedOfType(c, "page");
  if (pageSid) {
    const envelope = attachInfo.get(pageSid)?.parentSid ?? undefined;
    send(c, { method: "Target.detachedFromTarget", params: { sessionId: pageSid, targetId: pageId }, sessionId: envelope });
  }
  if (tabSid) send(c, { method: "Target.detachedFromTarget", params: { sessionId: tabSid, targetId: tabId } });
  send(c, { method: "Target.targetDestroyed", params: { targetId: pageId } });
  send(c, { method: "Target.targetDestroyed", params: { targetId: tabId } });
  await detachAll(c);
  wc.loadURL("about:blank").catch((err) => log({ kind: "note", loadError: err.message }));
}

async function onClientMessage(c, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    log({ kind: "note", client: c.n, badJson: String(raw).slice(0, 200) });
    return;
  }
  const { id, method, params, sessionId } = msg;
  log({ kind: "in", client: c.n, sessionId, id, method, params: trunc(params) });
  if (c.firstMethod === null) c.firstMethod = method;

  const reply = (result) => send(c, sessionId ? { id, result, sessionId } : { id, result });
  const fail = (err) => {
    tally(c.errors, method);
    const error = { code: -32000, message: err?.message ?? String(err) };
    send(c, sessionId ? { id, error, sessionId } : { id, error });
  };
  const forward = async (sid) => {
    tally(sid ? c.sessionForwarded : c.rootForwarded, method);
    try {
      reply(await cmd(method, params ?? {}, sid));
    } catch (err) {
      fail(err);
    }
  };

  // ---- session-scoped
  if (sessionId) {
    if (method === "Page.close" || method === "Target.closeTarget") {
      tally(c.sessionIntercepted, method);
      await closeForClient(c);
      reply(method === "Target.closeTarget" ? { success: true } : {});
      return;
    }
    await forward(sessionId);
    return;
  }

  // ---- root
  switch (method) {
    case "Target.getBrowserContexts":
      tally(c.rootIntercepted, method);
      reply({ browserContextIds: [] });
      return;

    case "Target.setDiscoverTargets": {
      tally(c.rootIntercepted, method);
      c.discover = params?.discover === true;
      if (c.discover) {
        send(c, {
          method: "Target.targetCreated",
          params: {
            targetInfo: {
              targetId: "omp-ui-bridge-browser",
              type: "browser",
              title: "",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          },
        });
        try {
          const { targetInfos } = await cmd("Target.getTargets");
          const rank = (t) => (t.type === "tab" ? 0 : t.type === "page" ? 1 : 2);
          for (const targetInfo of [...targetInfos].sort((a, b) => rank(a) - rank(b))) {
            send(c, { method: "Target.targetCreated", params: { targetInfo } });
          }
        } catch (err) {
          fail(err);
          return;
        }
      }
      reply({});
      return;
    }

    case "Target.setAutoAttach": {
      tally(c.rootIntercepted, method);
      if (params?.autoAttach) {
        let tabSid = ownedOfType(c, "tab");
        if (tabSid === null) {
          try {
            ({ sessionId: tabSid } = await cmd("Target.attachToTarget", { targetId: tabId, flatten: true }));
          } catch (err) {
            fail(err);
            return;
          }
          claim(c, tabSid);
          flushAttach(c, tabSid);
        }
        reply({});
      } else {
        await detachAll(c);
        reply({});
      }
      return;
    }

    case "Target.attachToTarget": {
      tally(c.rootForwarded, method);
      try {
        const result = await cmd(method, params ?? {});
        claim(c, result.sessionId);
        flushAttach(c, result.sessionId);
        reply(result);
      } catch (err) {
        fail(err);
      }
      return;
    }

    case "Target.detachFromTarget": {
      tally(c.rootForwarded, method);
      try {
        const result = await cmd(method, params ?? {});
        if (params?.sessionId) release(params.sessionId);
        reply(result);
      } catch (err) {
        fail(err);
      }
      return;
    }

    case "Target.createTarget":
      tally(c.rootIntercepted, method);
      c.createTargetCalls += 1;
      reply({ targetId: pageId });
      return;

    case "Target.closeTarget":
      tally(c.rootIntercepted, method);
      await closeForClient(c);
      reply({ success: true });
      return;

    case "Browser.close":
      tally(c.rootIntercepted, method);
      c.browserCloseCalls += 1;
      reply({});
      c.ws.close();
      return;

    default:
      await forward(undefined);
  }
}

async function onClientClose(c) {
  log({ kind: "ws", event: "close", client: c.n, owned: [...c.owned] });
  clients.delete(c.n);
  closedClients.push(c);
  await detachAll(c);
}

function onElectronEvent(_event, method, params, sessionId) {
  log({ kind: "electron-event", sessionId, method, params: trunc(params) });
  if (sessionId !== "" && sessionId !== undefined) {
    const c = owner.get(sessionId);
    if (!c) {
      log({ kind: "note", droppedEvent: method, sessionId });
      return;
    }
    if (method === "Target.attachedToTarget") {
      claim(c, params.sessionId);
      attachInfo.set(params.sessionId, { targetInfo: params.targetInfo, parentSid: sessionId });
    }
    send(c, { method, params, sessionId });
    if (method === "Target.detachedFromTarget") release(params.sessionId);
    return;
  }
  switch (method) {
    case "Target.attachedToTarget": {
      const c = owner.get(params.sessionId);
      if (c) {
        attachInfo.set(params.sessionId, { targetInfo: params.targetInfo, parentSid: null });
        send(c, { method, params });
      } else {
        unownedAttach.set(params.sessionId, params);
      }
      return;
    }
    case "Target.detachedFromTarget": {
      const c = owner.get(params.sessionId);
      if (c) send(c, { method, params });
      release(params.sessionId);
      unownedAttach.delete(params.sessionId);
      return;
    }
    case "Target.targetCreated":
    case "Target.targetDestroyed":
    case "Target.targetInfoChanged":
      for (const c of clients.values()) if (c.discover) send(c, { method, params });
      return;
    default:
      return; // logged only
  }
}

// ---------------------------------------------------------------- HTTP + WS transport

function startBridgeServer() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ noServer: true });
    let lastVersionHitAt = null;
    let lastTokenHitAt = null;

    const server = http.createServer((req, res) => {
      const now = performance.now();
      const expectedHosts = [`127.0.0.1:${bridge.port}`, `localhost:${bridge.port}`];
      const hostOk = expectedHosts.includes(req.headers.host ?? "");
      const isRoot = req.url === "/json/version";
      const isToken = req.url === `/${token}/json/version`;
      const msSincePrevVersionHit = lastVersionHitAt === null ? null : round(now - lastVersionHitAt);
      if (isRoot || isToken) lastVersionHitAt = now;
      if (isToken) {
        bridge.tokenPathHits += 1;
        lastTokenHitAt = now;
      }
      if (isRoot) {
        bridge.rootPathHits += 1;
        if (lastTokenHitAt !== null) bridge.tokenToRootGapMs.push(round(now - lastTokenHitAt));
      }
      log({
        kind: "http",
        method: req.method,
        path: req.url,
        host: req.headers.host,
        userAgent: req.headers["user-agent"],
        hostOk,
        msSincePrevVersionHit,
      });
      if (!hostOk) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.method === "GET" && (isRoot || isToken)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            Browser: "omp-ui-bridge-526/0.0.0",
            "Protocol-Version": "1.3",
            "User-Agent": wc.getUserAgent(),
            "V8-Version": process.versions.v8,
            "WebKit-Version": browserVersion.product,
            webSocketDebuggerUrl: `ws://127.0.0.1:${bridge.port}/${token}`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.on("upgrade", (req, socket, head) => {
      const hostOk = [`127.0.0.1:${bridge.port}`, `localhost:${bridge.port}`].includes(req.headers.host ?? "");
      if (req.url !== `/${token}` || req.headers.origin !== undefined || !hostOk) {
        bridge.upgradeRejected += 1;
        log({ kind: "ws", event: "upgradeRejected", path: req.url, origin: req.headers.origin, host: req.headers.host });
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const c = newClient(ws);
        bridge.connections += 1;
        log({ kind: "ws", event: "open", client: c.n, userAgent: req.headers["user-agent"] });
        ws.on("message", (data) => {
          onClientMessage(c, data.toString()).catch((err) => log({ kind: "note", client: c.n, handlerError: err.message }));
        });
        ws.on("close", () => {
          onClientClose(c).catch(() => {});
        });
        ws.on("error", (err) => log({ kind: "ws", event: "error", client: c.n, message: err.message }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      bridge.port = server.address().port;
      resolve(server);
    });
  });
}

function startDevServer() {
  return new Promise((resolve) => {
    const html = fs.readFileSync(path.join(__dirname, "test-page.html"));
    const server = http.createServer((req, res) => {
      const url = req.url.split("?")[0];
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

// ---------------------------------------------------------------- frames

function onPaint(_event, dirtyRect, image) {
  const now = performance.now();
  const jpeg = image.toJPEG(70);
  const encodeMs = performance.now() - now;
  frames.count += 1;
  frames.encodeMs.push(encodeMs);
  frames.bytes.push(jpeg.length);
  if (frames.lastAt) frames.gapMs.push(now - frames.lastAt);
  frames.lastAt = now;
  const size = image.getSize();
  frames.size = [size.width, size.height];
  const key = `${size.width}x${size.height}`;
  if (!frames.sizes.includes(key)) frames.sizes.push(key);
  frames.dirtyFraction.push((dirtyRect.width * dirtyRect.height) / (size.width * size.height));
  if (pendingLatency) {
    pendingLatency.resolve(now - pendingLatency.sentAt);
    pendingLatency = null;
  }
  if (WRITE_ALL || frames.written < FRAMES_TO_WRITE) {
    frames.written += 1;
    if (frames.written === 1) {
      frames.firstFrameIsJpeg =
        jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
    }
    fs.promises
      .writeFile(path.join(OUT_DIR, "frames", `${String(frames.written).padStart(4, "0")}.jpg`), jpeg)
      .catch((err) => log({ kind: "note", frameWriteError: err.message }));
  }
}

function nextPaintLatency(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const entry = {
      sentAt: performance.now(),
      resolve: (v) => {
        clearTimeout(timer);
        resolve(round(v));
      },
    };
    const timer = setTimeout(() => {
      if (pendingLatency === entry) pendingLatency = null;
      resolve(null);
    }, timeoutMs);
    pendingLatency = entry;
  });
}

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
}

// ---------------------------------------------------------------- input self-test

const js = (code) => wc.executeJavaScript(code, true);

async function center(selector) {
  const [x, y] = await js(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  );
  return { x: Math.round(x), y: Math.round(y) };
}

async function clickAt({ x, y }, button = "left") {
  wc.sendInputEvent({ type: "mouseMove", x, y });
  await sleep(50);
  const latency = nextPaintLatency();
  wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
  return latency;
}

function recordStep(step, ok, detail, latencyMs) {
  const entry = { step, ok, detail, latencyMs: latencyMs ?? null, winFocused: win.isFocused(), wcFocused: wc.isFocused() };
  inputTest.push(entry);
  console.log(`INPUT ${step} ok=${ok} latencyMs=${entry.latencyMs} winFocused=${entry.winFocused} detail=${JSON.stringify(detail)}`);
}

async function runInputTest() {
  await sleep(300);
  if (EXTERNAL_URL) {
    const latency = await clickAt({ x: Math.round(WIDTH / 2), y: Math.round(HEIGHT / 2) });
    recordStep("click-centre", latency !== null, "external --url: DOM assertions skipped", latency);
  } else {
    try {
      const btn = await center("#btn");
      let latency = await clickAt(btn);
      await sleep(100);
      let events = await js("window.__events");
      let out = await js("document.querySelector('#out').textContent");
      recordStep(
        "click-button",
        events.some((e) => e[0] === "click" && e[1] === "btn") && out.startsWith("clicks=1"),
        { out, events: events.length },
        latency,
      );

      await clickAt(await center("#input"));
      await sleep(100);
      latency = nextPaintLatency();
      for (const keyCode of "user") {
        wc.sendInputEvent({ type: "keyDown", keyCode });
        wc.sendInputEvent({ type: "char", keyCode });
        wc.sendInputEvent({ type: "keyUp", keyCode });
      }
      latency = await latency;
      await sleep(100);
      let value = await js("document.querySelector('#input').value");
      recordStep("type-keys", value === "user", { value }, latency);

      latency = nextPaintLatency();
      await wc.insertText("한🙂");
      latency = await latency;
      await sleep(100);
      value = await js("document.querySelector('#input').value");
      recordStep("insert-text", value === "user한🙂", { value }, latency);

      const mid = { x: Math.round(WIDTH / 2), y: Math.round(HEIGHT / 2) };
      latency = nextPaintLatency();
      wc.sendInputEvent({ type: "mouseWheel", x: mid.x, y: mid.y, deltaX: 0, deltaY: -120, hasPreciseScrollingDeltas: true, canScroll: true });
      latency = await latency;
      await sleep(250);
      const scrollY = await js("window.scrollY");
      recordStep("wheel", scrollY > 0, { scrollY, deltaY: -120 }, latency);

      await js("window.scrollTo(0, 0)"); // the wheel step scrolled #btn out of the viewport
      await sleep(100);
      const before = contextMenuCount;
      latency = await clickAt(await center("#btn"), "right");
      await sleep(100);
      events = await js("window.__events");
      recordStep(
        "right-click",
        events.some((e) => e[0] === "contextmenu" && e[1] === "btn") && contextMenuCount - before === 1,
        { electronContextMenuEvents: contextMenuCount - before, domEvents: events.slice(-4) },
        latency,
      );
    } catch (err) {
      recordStep("self-test", false, { error: err.message }, null);
    }
  }
  const before = frames.count;
  await sleep(3000);
  frames.idlePaintsIn3s = frames.count - before;
  recordStep("idle-paints", ANIM ? true : frames.idlePaintsIn3s === 0, { idlePaintsIn3s: frames.idlePaintsIn3s, anim: ANIM }, null);
}

// ---------------------------------------------------------------- summary / exit

function summary() {
  let contentSize = null;
  try {
    contentSize = win.getContentSize();
  } catch {
    /* window gone */
  }
  return {
    platform: {
      os: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      hardwareAcceleration: !SOFTWARE,
      sandbox: !app.commandLine.hasSwitch("no-sandbox"),
      ozone:
        process.platform === "linux"
          ? app.commandLine.getSwitchValue("ozone-platform") || (process.env.WAYLAND_DISPLAY ? "auto(WAYLAND_DISPLAY set)" : "auto(x11)")
          : "n/a",
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
      userAgent: browserVersion?.userAgent ?? null,
    },
    flags: { size: [WIDTH, HEIGHT], dsf: DSF, fps: FPS, frames: framesArg, software: SOFTWARE, url: EXTERNAL_URL, anim: ANIM },
    window: { contentSize, dsfRequested: DSF, dprReported },
    bridge,
    clients: [...clients.values(), ...closedClients].map((c) => ({
      n: c.n,
      firstMethod: c.firstMethod,
      rootIntercepted: c.rootIntercepted,
      rootForwarded: c.rootForwarded,
      sessionIntercepted: c.sessionIntercepted,
      sessionForwarded: c.sessionForwarded,
      errors: c.errors,
      createTargetCalls: c.createTargetCalls,
      closeTargetCalls: c.closeTargetCalls,
      browserCloseCalls: c.browserCloseCalls,
      sessionsOwnedMax: c.sessionsOwnedMax,
    })).sort((a, b) => a.n - b.n),
    frames: {
      count: frames.count,
      written: frames.written,
      size: frames.size,
      sizesSeen: frames.sizes,
      encodeMs: { p50: pct(frames.encodeMs, 0.5), p90: pct(frames.encodeMs, 0.9) },
      gapMs: { p50: pct(frames.gapMs, 0.5), p90: pct(frames.gapMs, 0.9) },
      bytes: { p50: pct(frames.bytes, 0.5), p90: pct(frames.bytes, 0.9) },
      dirtyFraction: { p50: pct(frames.dirtyFraction, 0.5) },
      idlePaintsIn3s: frames.idlePaintsIn3s,
      firstFrameIsJpeg: frames.firstFrameIsJpeg,
      sizeChangedAfterSetViewport: frames.sizes.length > 1,
      uptimeS: round((Date.now() - T0) / 1000),
    },
    inputTest,
  };
}

const closedClients = [];
function writeSummary() {
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify(summary(), null, 2)}\n`);
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  console.log(`FINISH code=${code}`);
  writeSummary();
  for (const c of clients.values()) c.ws.close();
  await new Promise((resolve) => traffic.end(resolve));
  app.exit(code);
}

// ---------------------------------------------------------------- main

app.on("window-all-closed", () => {
  log({ kind: "note", event: "window-all-closed" });
});
app.on("before-quit", () => {
  if (!finishing) {
    bridge.appQuitLeak = true;
    console.log("LEAK: before-quit fired without the bridge exit path (a Browser.close leaked through?)");
    writeSummary();
  }
});
process.on("SIGINT", () => finish(0));
process.on("SIGTERM", () => finish(0));

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());

  devUrl = EXTERNAL_URL ?? (await startDevServer()) + (ANIM ? "?anim=1" : "");

  win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    webPreferences: {
      offscreen: dsfArg === null ? true : { deviceScaleFactor: DSF },
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("paint", onPaint);
  wc.on("context-menu", () => {
    contextMenuCount += 1;
  });
  wc.on("destroyed", () => log({ kind: "note", event: "webContents destroyed" }));
  await wc.loadURL("about:blank");

  dbg = wc.debugger;
  dbg.attach("1.3");
  dbg.on("message", onElectronEvent);
  dbg.on("detach", (_event, reason) => {
    bridge.debuggerDetach = reason;
    console.log(`DEBUGGER DETACHED: ${reason}`);
    finish(2);
  });
  const self = (await cmd("Target.getTargetInfo")).targetInfo;
  pageId = self.targetId;
  await cmd("Target.setDiscoverTargets", { discover: true, filter: [{}] });
  const { targetInfos } = await cmd("Target.getTargets");
  const tab = targetInfos.find((t) => t.type === "tab");
  if (!tab) {
    console.error("FATAL: Electron's root exposes no tab target; targets were", JSON.stringify(targetInfos));
    await finish(3);
    return;
  }
  tabId = tab.targetId;
  browserVersion = await cmd("Browser.getVersion");
  log({ kind: "note", pageId, tabId, browserVersion, self });

  token = crypto.randomBytes(16).toString("base64url");
  await startBridgeServer();
  const cdpUrl = `http://127.0.0.1:${bridge.port}/${token}`;
  console.log(`READY cdp_url=${cdpUrl} dev_url=${devUrl} out=${OUT_DIR}`);

  wc.setFrameRate(FPS);
  const loaded = new Promise((resolve) => wc.once("did-finish-load", resolve));
  try {
    await wc.loadURL(devUrl);
    await loaded;
    dprReported = await js("devicePixelRatio");
  } catch (err) {
    recordStep("load", false, { error: err.message, devUrl }, null);
  }
  if (!NO_INPUT_TEST) await runInputTest();
  writeSummary();
  console.log("SELF-TEST DONE; waiting for clients. Type q + Enter (or Ctrl-C) to write summary.json and exit.");

  let lastCount = frames.count;
  setInterval(() => {
    const fps5 = (frames.count - lastCount) / 5;
    lastCount = frames.count;
    console.log(
      `STATUS frames=${frames.count} fps(5s)=${fps5.toFixed(1)} encodeMs p50/p90=${pct(frames.encodeMs, 0.5)}/${pct(frames.encodeMs, 0.9)} bytes p50=${pct(frames.bytes, 0.5)} size=${frames.size?.join("x") ?? "-"} clients=${clients.size} sessions=${owner.size}`,
    );
    writeSummary();
  }, 5000);

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "q") finish(0);
  });
});
