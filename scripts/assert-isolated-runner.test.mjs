import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./assert-isolated-runner.sh", import.meta.url));
const skip = process.platform === "win32" ? "bash and Unix sockets are not available on win32" : false;

// Builds <fixture>/runner/{.runner,_work/_temp} and <fixture>/home, then runs
// the guard with an environment built from scratch so the developer's shell
// cannot leak ACCESS_TOKEN or DOCKER_HOST into a case.
function fixture({ ephemeral = true, settings = true, staleDirs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-runner-"));
  const runner = path.join(dir, "runner");
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(runner, "_work", "_temp"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (settings) {
    const json = { agentId: 1, agentName: "fixture", workFolder: "_work", ...(ephemeral ? { ephemeral: true } : {}) };
    fs.writeFileSync(path.join(runner, ".runner"), JSON.stringify(json, null, 2));
  }
  for (const stale of staleDirs) fs.mkdirSync(path.join(home, stale), { recursive: true });
  return {
    dir,
    socket: path.join(dir, "docker.sock"),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      RUNNER_TEMP: path.join(runner, "_work", "_temp"),
      RUNNER_NAME: "fixture",
      OMP_UI_RUNNER_DOCKER_SOCKET: path.join(dir, "docker.sock"),
    },
    run(extraEnv = {}) {
      return spawnSync("bash", [script], { env: { ...this.env, ...extraEnv }, encoding: "utf8" });
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("an ephemeral runner on an unused filesystem passes silently", { skip }, () => {
  const fx = fixture();
  try {
    const r = fx.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  } finally {
    fx.cleanup();
  }
});

test("a persistent registration and a reused home both fail, and both are reported", { skip }, () => {
  const fx = fixture({ ephemeral: false, staleDirs: [".npm"] });
  try {
    const r = fx.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::runner 'fixture' is not an ephemeral/);
    assert.match(r.stderr, /::error::.*\/home\/\.npm exists before this job installed anything: the runner filesystem was reused/);
  } finally {
    fx.cleanup();
  }
});

test("RUNNER_TEMP outside <root>/_work/_temp fails", { skip }, () => {
  const fx = fixture();
  try {
    const r = fx.run({ RUNNER_TEMP: path.join(fx.dir, "elsewhere") });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::RUNNER_TEMP is '.*elsewhere', expected <runner-root>\/_work\/_temp/);
  } finally {
    fx.cleanup();
  }
});

test("a registration credential in the job environment fails", { skip }, () => {
  const fx = fixture();
  try {
    const r = fx.run({ ACCESS_TOKEN: "x" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::ACCESS_TOKEN is present in the job environment/);
  } finally {
    fx.cleanup();
  }
});

test("a mounted Docker socket fails", { skip }, async () => {
  const fx = fixture();
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(fx.socket, resolve);
    });
    const r = fx.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`::error::a Docker socket is mounted at ${fx.socket.replaceAll("/", "\\/")}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fx.cleanup();
  }
});
