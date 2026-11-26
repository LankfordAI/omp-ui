#!/usr/bin/env node
/**
 * End-to-end smoke test for the official @omp-ui/host-lite OCI container image (issue #1372).
 * Zero external dependencies — runs on plain Node 22 with built-in WebSocket + Docker CLI.
 *
 * Usage:
 *   node packages/host-lite/scripts/smoke-container.mjs <image-ref> <expected-version>
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const [imageRef, expectedVersion] = process.argv.slice(2);
if (!imageRef || !expectedVersion) {
  console.error("Usage: node packages/host-lite/scripts/smoke-container.mjs <image-ref> <expected-version>");
  process.exit(2);
}

const runId = `omp-ui-lite-smoke-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
const dataVol = `${runId}-data`;
const keyDataVol = `${runId}-key-data`;
const containers = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-`));

function docker(args, opts = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function dockerRaw(args, opts = {}) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForStatus(containerName, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const res = dockerRaw(["exec", containerName, "omp-ui-lite", "status"]);
    if (res.status === 0) return res.stdout.trim();
    last = `${res.stdout} ${res.stderr}`.trim();
    await sleep(350);
  }
  const logs = dockerRaw(["logs", containerName]);
  throw new Error(`Timed out waiting for ${containerName} status=0. Last: ${last}\nLogs:\n${logs.stdout}\n${logs.stderr}`);
}

/** Minimal zero-dep WebSocket client speaking @omp-ui/server's JSON-RPC protocol. */
async function connectWs(wsUrl, timeoutMs = 10_000) {
  const { promise: opened, resolve: onOpen, reject: onFail } = Promise.withResolvers();
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  let settled = false;

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      onFail(new Error(`WebSocket connect timeout for ${wsUrl}`));
      ws.close();
    }
  }, timeoutMs);

  ws.addEventListener("open", () => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      onOpen();
    }
  });
  ws.addEventListener("error", (ev) => {
    const err = new Error(`WebSocket error: ${ev.message ?? "connection failed"}`);
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      onFail(err);
    }
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });
  ws.addEventListener("close", (ev) => {
    const err = new Error(`WebSocket closed (code=${ev.code}, reason=${ev.reason})`);
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      onFail(err);
    }
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (frame && frame.t === "res" && typeof frame.id === "number") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.value);
      else entry.reject(new Error(frame.message ?? "remote error"));
    }
  });

  await opened;
  return {
    request(ch, args = []) {
      const id = nextId++;
      const { promise, resolve, reject } = Promise.withResolvers();
      const reqTimer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request ${ch} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(reqTimer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(reqTimer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ t: "req", id, ch, args }));
      return promise;
    },
    close() {
      ws.close();
    },
  };
}

function step(label) {
  console.log(`[smoke-container] ${label}`);
}

try {
  // 1. Version stamp, non-root uid, pinned tools, and manager.json
  step("1/8 Checking --version, uid 1000, pinned tools, and manager.json");
  const versionOut = docker(["run", "--rm", imageRef, "omp-ui-lite", "--version"]);
  assert(
    versionOut === `omp-ui-lite ${expectedVersion}`,
    `expected "omp-ui-lite ${expectedVersion}", got ${JSON.stringify(versionOut)}`,
  );
  assert(versionOut !== "omp-ui-lite 0.0.0", "version must not report 0.0.0");

  const toolCheck = docker([
    "run",
    "--rm",
    imageRef,
    "sh",
    "-ec",
    [
      'test "$(id -u)" = "1000"',
      "omp --version >/dev/null",
      "git --version >/dev/null",
      "gh --version >/dev/null",
      "uv --version >/dev/null",
      "bun --version >/dev/null",
      "docker --version >/dev/null",
      "jq --version >/dev/null",
      "rg --version >/dev/null",
      "flock --version >/dev/null",
      'cat /opt/omp-ui-lite/omp/manager.json',
    ].join(" && "),
  ]);
  const managerJson = JSON.parse(toolCheck);
  assert(managerJson.manager === "omp-ui" && managerJson.name === "omp-ui", `unexpected manager.json: ${toolCheck}`);

  // 2. Read-only models.yml mount preserves writable /home/node/.omp/natives
  step("2/8 Checking writable /home/node/.omp/natives under read-only models.yml mount");
  const modelsFile = path.join(tmpDir, "models.yml");
  fs.writeFileSync(modelsFile, "providers: {}\n", { mode: 0o644 });
  docker([
    "run",
    "--rm",
    "-v",
    `${modelsFile}:/home/node/.omp/agent/models.yml:ro`,
    imageRef,
    "sh",
    "-ec",
    'test -r /home/node/.omp/agent/models.yml && touch /home/node/.omp/natives/.probe && rm /home/node/.omp/natives/.probe',
  ]);

  // 3. Boot primary container with seeded Full fleet ceiling so updateMember reaches handler
  step("3/8 Booting primary container with OMP_UI_LITE_ROUTINES=1 on fresh volume");
  docker(["volume", "create", dataVol]);
  // Seed fleetExecEnabled + fleetExecCeiling=full inside the fresh volume while preserving first-boot token minting.
  const seedScript = `
    const fs = require("node:fs");
    fs.writeFileSync("/data/registry.json", JSON.stringify({
      schemaVersion: 1,
      projects: [],
      sessions: [],
      settings: {
        remoteEnabled: true,
        remoteBind: "lan",
        remotePort: 4677,
        fleetExecEnabled: true,
        fleetExecCeiling: "full"
      }
    }, null, 2) + "\\n", { mode: 0o600 });
  `;
  docker(["run", "--rm", "-v", `${dataVol}:/data`, imageRef, "node", "-e", seedScript]);

  const primaryName = `${runId}-primary`;
  const hostname = "smoke-host";
  containers.push(primaryName);
  docker([
    "run",
    "-d",
    "--name",
    primaryName,
    "--hostname",
    hostname,
    "-p",
    "127.0.0.1:0:4677",
    "-e",
    "OMP_UI_LITE_ROUTINES=1",
    "-v",
    `${dataVol}:/data`,
    imageRef,
  ]);

  const statusOut = await waitForStatus(primaryName);
  assert(statusOut.includes("reachable"), `unexpected status output: ${statusOut}`);

  const token = docker(["exec", primaryName, "omp-ui-lite", "token"]);
  assert(token.length >= 16, `expected non-empty token, got ${JSON.stringify(token)}`);
  const tokenUrl = docker(["exec", primaryName, "omp-ui-lite", "token", "--url"]);
  assert(tokenUrl.includes(`/?t=${token}`), `expected tokenized URL, got ${JSON.stringify(tokenUrl)}`);

  // Verify serve logs never leak the token
  const serveLogs = docker(["logs", primaryName]);
  assert(!serveLogs.includes(token), "serve logs must never print the join token");

  // 4. Live WebSocket RPC verification
  step("4/8 Verifying live WS handshake, hostReport, routines, and container fleet:updateMember");
  const portLine = docker(["port", primaryName, "4677/tcp"]).split("\n")[0].trim();
  const hostPort = portLine.split(":").pop();
  assert(hostPort && /^\d+$/.test(hostPort), `could not parse published port from ${portLine}`);

  const client = await connectWs(`ws://127.0.0.1:${hostPort}/ws?t=${encodeURIComponent(token)}`);
  try {
    const identity = await client.request("instance:identity", []);
    assert(identity.version === expectedVersion, `instance:identity.version=${identity.version}, expected ${expectedVersion}`);

    const report = await client.request("fleet:hostReport", []);
    assert(report.version === expectedVersion, `hostReport.version=${report.version}, expected ${expectedVersion}`);
    assert(report.packageFormat === "container", `hostReport.packageFormat=${report.packageFormat}, expected "container"`);
    assert(report.ompPinned === true, `hostReport.ompPinned=${report.ompPinned}, expected true`);
    assert(typeof report.ompVersion === "string" && report.ompVersion.length > 0, `hostReport.ompVersion missing: ${JSON.stringify(report.ompVersion)}`);

    const routinesState = await client.request("routines:getState", []);
    assert(routinesState.enabled === true, `routines:getState.enabled=${routinesState.enabled}, expected true`);

    let setRoutinesRejected = false;
    try {
      await client.request("settings:setRoutinesEnabled", [false]);
    } catch (err) {
      setRoutinesRejected = /unknown channel/i.test(String(err));
    }
    assert(setRoutinesRejected, "settings:setRoutinesEnabled must reject as unknown channel");

    // Raise smoke requester to Full control so fleet:updateMember reaches the immutable-container handler.
    const requester = { instanceId: "smoke-owner", label: "smoke-owner", kind: "user", sourceTabId: null };
    const raiseRes = await client.request("fleet:grantRaise", [{ requester, targetRung: "full", credential: token }]);
    assert(raiseRes.ok === true && raiseRes.rung === "full", `fleet:grantRaise failed: ${JSON.stringify(raiseRes)}`);

    const appCheck = await client.request("fleet:updateMember", [
      { requester, target: "app", action: "check", version: null, allowLiveSessions: false },
    ]);
    assert(
      appCheck.status === "accepted" &&
        appCheck.check?.target === "app" &&
        appCheck.check?.format === "container" &&
        appCheck.check?.currentVersion === expectedVersion,
      `unexpected app/check: ${JSON.stringify(appCheck)}`,
    );

    const ompCheck = await client.request("fleet:updateMember", [
      { requester, target: "omp", action: "check", version: null, allowLiveSessions: false },
    ]);
    assert(
      ompCheck.status === "accepted" && ompCheck.check?.target === "omp" && ompCheck.check?.pinned === true,
      `unexpected omp/check: ${JSON.stringify(ompCheck)}`,
    );

    const appStage = await client.request("fleet:updateMember", [
      { requester, target: "app", action: "stage", version: null, allowLiveSessions: false },
    ]);
    assert(
      appStage.status === "refused" && /container image/i.test(appStage.reason) && /redeploy/i.test(appStage.reason),
      `unexpected app/stage refusal: ${JSON.stringify(appStage)}`,
    );

    const ompStage = await client.request("fleet:updateMember", [
      { requester, target: "omp", action: "stage", version: null, allowLiveSessions: false },
    ]);
    assert(
      ompStage.status === "refused" && /container image/i.test(ompStage.reason) && /redeploy/i.test(ompStage.reason),
      `unexpected omp/stage refusal: ${JSON.stringify(ompStage)}`,
    );
  } finally {
    client.close();
  }

  // 5. Single-writer exclusion across two containers sharing /data with identical hostname
  step("5/8 Verifying single-writer exclusion for second container on same volume and hostname");
  const contenderRes = dockerRaw([
    "run",
    "--rm",
    "--hostname",
    hostname,
    "-v",
    `${dataVol}:/data`,
    imageRef,
  ]);
  assert(contenderRes.status !== 0, "second container on the same /data volume must exit non-zero");
  const contenderText = `${contenderRes.stdout}\n${contenderRes.stderr}`;
  assert(
    /omp-ui-lite.*(locked|running and owns)/i.test(contenderText),
    `expected lock error from second container, got: ${contenderText}`,
  );

  // 6. SIGKILL crash-recovery proof (same volume + same hostname)
  step("6/8 Verifying SIGKILL crash recovery on same volume and hostname");
  docker(["kill", "-s", "SIGKILL", primaryName]);
  docker(["rm", "-f", primaryName]);

  const recoveredName = `${runId}-recovered`;
  containers.push(recoveredName);
  docker([
    "run",
    "-d",
    "--name",
    recoveredName,
    "--hostname",
    hostname,
    "-v",
    `${dataVol}:/data`,
    imageRef,
  ]);
  const recoveredStatus = await waitForStatus(recoveredName);
  assert(recoveredStatus.includes("reachable"), `recovered container failed status: ${recoveredStatus}`);

  // 7. OMP_UI_LITE_KEY_FILE bind-mount proof (0400 owned by uid 1000)
  step("7/8 Verifying OMP_UI_LITE_KEY_FILE 0400 uid-1000 mount");
  docker(["volume", "create", keyDataVol]);
  const keyFile = path.join(tmpDir, "machine.key");
  fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o400 });
  // Ensure uid/gid 1000 ownership inside the container even if host user has a different uid.
  const hostUid = process.getuid ? process.getuid() : 1000;
  let keyMountArgs;
  if (hostUid === 1000) {
    keyMountArgs = ["-v", `${keyFile}:/run/secrets/omp-ui-lite.key:ro`];
  } else {
    // Stage the key inside a named volume with uid 1000:1000 mode 0400 via root helper so the
    // bind-mount ownership check is exercised accurately on non-1000 CI runners (e.g. GitHub ubuntu-latest uid 1001).
    const keyStageVol = `${runId}-key-stage`;
    docker(["volume", "create", keyStageVol]);
    const keyB64 = fs.readFileSync(keyFile).toString("base64");
    docker([
      "run",
      "--rm",
      "--user",
      "0:0",
      "-v",
      `${keyStageVol}:/run/secrets`,
      imageRef,
      "sh",
      "-ec",
      `printf '%s' '${keyB64}' | base64 -d > /run/secrets/omp-ui-lite.key && chown 1000:1000 /run/secrets/omp-ui-lite.key && chmod 0400 /run/secrets/omp-ui-lite.key`,
    ]);
    keyMountArgs = ["-v", `${keyStageVol}:/run/secrets:ro`];
    containers.push(`__vol__:${keyStageVol}`);
  }

  const keyName = `${runId}-keyfile`;
  containers.push(keyName);
  docker([
    "run",
    "-d",
    "--name",
    keyName,
    "-e",
    "OMP_UI_LITE_KEY_FILE=/run/secrets/omp-ui-lite.key",
    "-v",
    `${keyDataVol}:/data`,
    ...keyMountArgs,
    imageRef,
  ]);
  await waitForStatus(keyName);
  const keyLogs = docker(["logs", keyName]);
  assert(
    keyLogs.includes("credential store ready (key-file)"),
    `expected key-file protector in logs, got:\n${keyLogs}`,
  );

  step("8/8 All container smoke assertions passed");
} finally {
  for (const item of containers) {
    if (item.startsWith("__vol__:")) continue;
    dockerRaw(["rm", "-f", item]);
  }
  for (const vol of [dataVol, keyDataVol, ...containers.filter((x) => x.startsWith("__vol__:")).map((x) => x.slice(8))]) {
    dockerRaw(["volume", "rm", "-f", vol]);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
